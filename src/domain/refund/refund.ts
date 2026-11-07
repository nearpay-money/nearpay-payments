/**
 * Refunds and their legs (lld/payments.md §5, §8.4, §17; domain-model §4.4). Pure: the use cases apply
 * each decision in one transaction (rows, transitions, statement line, outbox events).
 *
 * Money rules (INV-2, INV-3, INV-5):
 * - A refund reserves its `amount` in a **budget** — the intent's (`amount_settled`, `amount_refunded`,
 *   `amount_refund_pending`) when it refunds the attempt that paid the intent, otherwise the attempt's own
 *   (overpayments, a rejected short settlement). `refunded + pending ≤ settled` always holds.
 * - A refund succeeds only on payer-side evidence; a provider status alone makes the leg `held`.
 * - Truth wins: a leg that still settles after the refund was canceled or failed makes it `succeeded`; the
 *   part that no longer fits the budget (another refund reserved it meanwhile) is recorded as
 *   `extra_amount_sent`, as is every duplicate leg — never as `amount_refunded`, so Σ refunded ≤ settled.
 */

export type RefundStatus = "requires_action" | "pending" | "succeeded" | "failed" | "canceled";
export type LegStatus =
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "processing"
  | "succeeded"
  | "returned"
  | "failed"
  | "expired"
  | "held";
export type FeeMode = "payer_absorbs" | "merchant_absorbs";
export type RefundEvent =
  | "evt.payments.refund.created"
  | "evt.payments.refund.requires_action"
  | "evt.payments.refund.pending"
  | "evt.payments.refund.succeeded"
  | "evt.payments.refund.failed"
  | "evt.payments.refund.canceled";

// ------------------------------------------------------------------------------------------- budget

export interface Budget {
  readonly settled: bigint;
  readonly refunded: bigint;
  readonly pending: bigint;
}

/** What can still be refunded (never negative). */
export function refundable(b: Budget): bigint {
  const r = b.settled - b.refunded - b.pending;
  return r > 0n ? r : 0n;
}

export function isConsistent(b: Budget): boolean {
  return b.settled >= 0n && b.refunded >= 0n && b.pending >= 0n && b.refunded + b.pending <= b.settled;
}

/** Reserves `amount`; null when it is not positive or exceeds what is refundable. */
export function reserve(b: Budget, amount: bigint): Budget | null {
  if (amount <= 0n || amount > refundable(b)) return null;
  return { ...b, pending: b.pending + amount };
}

/** Releases a reservation (cancel, failure). */
export function release(b: Budget, amount: bigint): Budget {
  if (amount > b.pending) throw new RangeError(`release ${amount} > pending ${b.pending}`);
  return { ...b, pending: b.pending - amount };
}

/** A reserved refund succeeded: its reservation becomes refunded. */
export function commit(b: Budget, amount: bigint): Budget {
  if (amount > b.pending) throw new RangeError(`commit ${amount} > pending ${b.pending}`);
  return { ...b, pending: b.pending - amount, refunded: b.refunded + amount };
}

/**
 * A refund that held no reservation (canceled or failed) succeeded anyway (INV-3): what still fits the
 * budget is counted as refunded, the rest is extra money the merchant sent.
 */
export function lateCommit(b: Budget, amount: bigint): { budget: Budget; counted: bigint; extra: bigint } {
  const room = refundable(b);
  const counted = amount < room ? amount : room;
  return { budget: { ...b, refunded: b.refunded + counted }, counted, extra: amount - counted };
}

// ------------------------------------------------------------------------------------------- creation

export type CreateError = "intent_not_succeeded" | "attempt_not_settled";

/**
 * Which budget a refund of `attempt` uses (§5, §17 item 4): the intent's for the attempt that paid a
 * succeeded intent; the attempt's own for any other settled attempt (an overpayment, or a short
 * settlement the merchant rejected).
 */
export function budgetOf(
  intent: { readonly status: string; readonly succeededAttemptId: string | null },
  attempt: { readonly id: string; readonly status: string; readonly settled: bigint | null },
): "intent" | "attempt" | CreateError {
  if (attempt.status !== "succeeded" || attempt.settled === null || attempt.settled <= 0n) return "attempt_not_settled";
  if (attempt.id === intent.succeededAttemptId) return intent.status === "succeeded" ? "intent" : "intent_not_succeeded";
  return "attempt";
}

export function swapTypeOf(mode: FeeMode): "EXACT_INPUT" | "EXACT_OUTPUT" {
  return mode === "payer_absorbs" ? "EXACT_INPUT" : "EXACT_OUTPUT";
}

export const legIdempotencyKey = (refundId: string, leg: number) => `refund:${refundId}:leg:${leg}`;

// ------------------------------------------------------------------------------------------- legs

/** The merchant's money may be moving through this leg (blocks cancel, prepare and recipient changes). */
export const MONEY_MOVING: ReadonlySet<LegStatus> = new Set(["submitted", "processing", "held"]);
/** Nothing more happens through this leg. `expired` is not final: a late deposit may still settle. */
export const LEG_TERMINAL: ReadonlySet<LegStatus> = new Set(["succeeded", "returned", "failed"]);

const LEG_IN_FLIGHT = new Set(["deposit_detected", "incomplete_deposit", "settling", "verifying"]);

/**
 * The leg status for an execution state. A success without evidence is `held` (INV-2); anything
 * unknown is `held` (never assumed terminal). A leg the merchant already submitted stays `submitted`
 * until the execution shows the deposit.
 */
export function legStatusOf(state: string, hasEvidence: boolean, current: LegStatus): LegStatus {
  if (state === "quoting" || state === "awaiting_deposit")
    return current === "submitted" ? "submitted" : "awaiting_signature";
  if (LEG_IN_FLIGHT.has(state)) return "processing";
  if (state === "succeeded") return hasEvidence ? "succeeded" : "held";
  if (state === "refunded") return "returned";
  if (state === "failed") return "failed";
  if (state === "expired_unpaid") return "expired";
  return "held";
}

export interface RefundState {
  readonly status: RefundStatus;
  readonly currentLegId: string | null;
}

export interface LegChange {
  readonly id: string;
  readonly from: LegStatus;
  readonly to: LegStatus;
}

export interface RefundDecision {
  readonly status: RefundStatus | null;
  /** Budget effect of the change. */
  readonly budget: "none" | "commit" | "release" | "late_commit";
  /** The leg settled after another leg had refunded the payer. */
  readonly duplicate: boolean;
  /** A `refund` statement line for this leg. */
  readonly statement: boolean;
  readonly events: readonly RefundEvent[];
  readonly cause: string;
}

const none = (cause: string): RefundDecision => ({
  status: null,
  budget: "none",
  duplicate: false,
  statement: false,
  events: [],
  cause,
});

/**
 * What a leg change does to its refund. `others` are the statuses of the refund's other legs.
 */
export function onLegChange(refund: RefundState, leg: LegChange, others: readonly LegStatus[]): RefundDecision {
  const { from, to } = leg;
  if (to === from) return none("no leg status change");
  const st = refund.status;

  if (to === "succeeded") {
    if (st === "succeeded")
      return {
        ...none(`leg ${leg.id} settled after another leg had refunded the payer`),
        duplicate: true,
        statement: true,
      };
    const late = st === "canceled" || st === "failed";
    return {
      status: "succeeded",
      budget: late ? "late_commit" : "commit",
      duplicate: false,
      statement: true,
      events: ["evt.payments.refund.succeeded"],
      cause: late
        ? `leg ${leg.id} settled with payer-side evidence after the refund was ${st} (INV-3)`
        : `leg ${leg.id} settled with payer-side evidence`,
    };
  }

  if (MONEY_MOVING.has(to)) {
    if (st === "requires_action")
      return {
        ...none(`leg ${leg.id} ${to}: the merchant's funds are on their way`),
        status: "pending",
        events: ["evt.payments.refund.pending"],
      };
    return none(`leg ${leg.id} ${to}`);
  }

  if (to === "returned" || to === "failed" || to === "expired") {
    if (st !== "requires_action" && st !== "pending") return none(`leg ${leg.id} ${to} while the refund is ${st}`);
    if (others.some((s) => MONEY_MOVING.has(s))) return none(`leg ${leg.id} ${to}; another leg is in flight`);
    const isCurrent = refund.currentLegId === leg.id;
    // an expired current leg waits for `prepare`; a pending refund whose money stopped moving fails
    const fails = st === "pending" || (isCurrent && to !== "expired");
    if (!fails) return none(`leg ${leg.id} ${to}`);
    return {
      status: "failed",
      budget: "release",
      duplicate: false,
      statement: false,
      events: ["evt.payments.refund.failed"],
      cause: `leg ${leg.id} ${to}`,
    };
  }

  return none(`leg ${leg.id} ${to}`);
}

// ------------------------------------------------------------------------------------------- merchant actions

export interface CurrentLeg {
  readonly status: LegStatus;
  readonly deadline: Date | null;
  readonly submittedTx: string | null;
}

export type ActionError = "state_conflict" | "leg_expired";

const conflictFree = (legs: readonly LegStatus[]) => !legs.some((s) => MONEY_MOVING.has(s));

/** `POST /v1/refunds/{id}/cancel` (§17 item 7): only before anything was submitted for the current leg. */
export function canCancel(
  status: RefundStatus,
  current: CurrentLeg | null,
  legs: readonly LegStatus[],
): ActionError | null {
  if (status !== "requires_action") return "state_conflict";
  if (!conflictFree(legs)) return "state_conflict";
  if (current?.submittedTx) return "state_conflict";
  return null;
}

/**
 * `POST /v1/refunds/{id}/prepare`: `retry` re-asks rails for the current leg (never prepared yet, same
 * idempotency key); `new_leg` prepares the next leg (current one expired or failed); `reserve` also
 * re-reserves the amount (from `failed`).
 */
export function prepareMode(
  status: RefundStatus,
  current: CurrentLeg | null,
  legs: readonly LegStatus[],
  now: number,
): "retry" | "new_leg" | "reserve" | ActionError {
  if (!conflictFree(legs)) return "state_conflict";
  if (status === "failed") return "reserve";
  if (status !== "requires_action") return "state_conflict";
  if (!current) return "new_leg";
  if (current.status === "preparing") return "retry";
  if (current.status === "expired" || current.status === "failed" || current.status === "returned") return "new_leg";
  if (current.status === "awaiting_signature" && !current.submittedTx && current.deadline && current.deadline.getTime() <= now)
    return "new_leg";
  return "state_conflict";
}

/** `POST /v1/refunds/{id}/submit_tx`: the current leg must be awaiting its signature and still open. */
export function canSubmit(status: RefundStatus, current: CurrentLeg | null, now: number): ActionError | null {
  if (status !== "requires_action" || !current) return "state_conflict";
  if (current.status === "expired") return "leg_expired";
  if (current.status !== "awaiting_signature" && current.status !== "submitted") return "state_conflict";
  if (!current.deadline || current.deadline.getTime() <= now) return "leg_expired";
  return null;
}

/** `POST /v1/refunds/{id}/recipient` (INV-7): `requires_action` or `failed`, nothing submitted or in flight. */
export function canChangeRecipient(
  status: RefundStatus,
  current: CurrentLeg | null,
  legs: readonly LegStatus[],
): "ok" | "reserve" | ActionError {
  if (status !== "requires_action" && status !== "failed") return "state_conflict";
  if (!conflictFree(legs)) return "state_conflict";
  if (current?.submittedTx && status === "requires_action") return "state_conflict";
  return status === "failed" ? "reserve" : "ok";
}

/** The definitive answer of a leg preparation, or null when it is transient (the recovery job retries). */
export function isTransientRailError(code: string | null): boolean {
  return (
    code === null ||
    code === "api_error" ||
    code === "idempotency_in_progress" ||
    code === "rate_limited" ||
    code === "rail_unavailable"
  );
}

/** Rails' answer → the preparation error payments returns (createRefund / prepare / recipient). */
export function prepareErrorOf(code: string, param: string | null): string {
  if (code === "deadline_too_short") return "route_unavailable";
  if (code === "quote_integrity_failed") return "quote_rejected";
  if (code === "invalid_request" && param?.startsWith("recipient")) return "refund_address_invalid";
  return code;
}

// ------------------------------------------------------------------------------------------- applying a decision

/** The money fields of a refund. */
export interface RefundBook {
  readonly status: RefundStatus;
  /** Reserved / counted value, settlement-asset base units. */
  readonly amount: bigint;
  /** Part of a success counted in the budget (`amount` normally; less after a late success, INV-3). */
  readonly counted: bigint;
  /** Money the merchant sent beyond the counted refund (duplicate legs, late success beyond the budget). */
  readonly extra: bigint;
}

/**
 * Applies a leg decision to the refund's money fields and its budget. The single place both the use
 * cases and the property tests take the arithmetic from.
 */
export function applyDecision(
  book: RefundBook,
  budget: Budget,
  d: RefundDecision,
  legAmount: bigint,
): { book: RefundBook; budget: Budget } {
  let b = budget;
  let next: RefundBook = { ...book, status: d.status ?? book.status };
  switch (d.budget) {
    case "commit":
      b = commit(b, book.amount);
      next = { ...next, counted: book.amount };
      break;
    case "late_commit": {
      const r = lateCommit(b, book.amount);
      b = r.budget;
      next = { ...next, counted: r.counted, extra: next.extra + r.extra };
      break;
    }
    case "release":
      b = release(b, book.amount);
      break;
    case "none":
      break;
  }
  if (d.duplicate) next = { ...next, extra: next.extra + legAmount };
  return { book: next, budget: b };
}
