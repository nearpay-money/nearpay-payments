/**
 * PaymentIntent and CheckoutSession reactions to attempt changes and merchant actions
 * (lld/payments.md §5, domain-model §4.1–§4.2, §5). Pure: the use cases apply the decision in one
 * transaction (rows, transitions, statement line, outbox events).
 *
 * Principles: the first verified settlement wins; every later one is an overpayment (refund
 * recommended); a session never reports `expired` while money might still arrive (INV-3); a short
 * settlement or a held verification needs review and never succeeds on its own.
 */
import { type AttemptStatus, IN_FLIGHT, TERMINAL } from "../payment-attempt/attempt.js";

export type IntentStatus = "requires_payment" | "processing" | "requires_review" | "succeeded" | "canceled" | "expired";
export type SessionStatus = "open" | "expiring" | "complete" | "expired";
export type ReviewReason = "short_settlement" | "verification_held";
export type OverpaymentReason = "duplicate" | "after_cancel" | "after_expiry";

export type IntentEvent =
  | "evt.payments.payment_intent.processing"
  | "evt.payments.payment_intent.succeeded"
  | "evt.payments.payment_intent.payment_failed"
  | "evt.payments.payment_intent.requires_review"
  | "evt.payments.payment_intent.overpaid"
  | "evt.payments.payment_intent.canceled"
  | "evt.payments.payment_intent.expired";
export type SessionEvent = "evt.payments.checkout_session.completed" | "evt.payments.checkout_session.expired";

export interface IntentState {
  readonly status: IntentStatus;
  readonly reviewReason: ReviewReason | null;
  readonly succeededAttemptId: string | null;
  readonly underpayToleranceBps: number;
}

export interface AttemptChange {
  readonly id: string;
  readonly from: AttemptStatus;
  readonly to: AttemptStatus;
  /** Expected output including the tag (base units). */
  readonly expected: bigint | null;
  readonly settled: bigint | null;
}

export interface Decision {
  readonly intent: {
    readonly status: IntentStatus;
    readonly reviewReason: ReviewReason | null;
    readonly succeededAttemptId?: string;
    readonly amountSettled?: bigint;
    readonly succeeded?: boolean;
    readonly late?: boolean;
  } | null;
  readonly session: { readonly status: "complete" | "expired"; readonly late: boolean } | null;
  readonly overpayment: OverpaymentReason | null;
  readonly statement: "payment" | "overpayment" | null;
  readonly intentEvents: readonly IntentEvent[];
  readonly sessionEvents: readonly SessionEvent[];
  readonly cause: string;
}

const none = (cause: string): Decision => ({
  intent: null,
  session: null,
  overpayment: null,
  statement: null,
  intentEvents: [],
  sessionEvents: [],
  cause,
});

/** `settled ≥ expected × (1 − tolerance)` (§5); without an expected amount only a positive one counts. */
export function isFullSettlement(settled: bigint, expected: bigint | null, toleranceBps: number): boolean {
  if (expected === null) return settled > 0n;
  return settled * 10_000n >= expected * BigInt(10_000 - toleranceBps);
}

/**
 * What an attempt change does to its intent and session. `others` are the statuses of the intent's
 * other attempts (after any concurrent change already applied).
 */
export function onAttemptChange(
  intent: IntentState,
  session: SessionStatus,
  change: AttemptChange,
  others: readonly AttemptStatus[],
): Decision {
  const { to, from } = change;
  if (to === from) return none("no status change");
  const st = intent.status;

  if (to === "succeeded") {
    const paidAlready =
      (intent.succeededAttemptId !== null && intent.succeededAttemptId !== change.id) ||
      st === "succeeded" ||
      st === "canceled" ||
      st === "expired" ||
      (st === "requires_review" && intent.reviewReason === "short_settlement");
    if (paidAlready) {
      const reason: OverpaymentReason =
        st === "canceled" ? "after_cancel" : st === "expired" ? "after_expiry" : "duplicate";
      return {
        ...none(`attempt ${change.id} settled after the intent was ${st === "requires_review" ? "paid short" : st}`),
        overpayment: reason,
        statement: "overpayment",
        intentEvents: ["evt.payments.payment_intent.overpaid"],
      };
    }
    const settled = change.settled ?? 0n;
    const late = session !== "open";
    if (isFullSettlement(settled, change.expected, intent.underpayToleranceBps)) {
      return {
        intent: {
          status: "succeeded",
          reviewReason: null,
          succeededAttemptId: change.id,
          amountSettled: settled,
          succeeded: true,
          late,
        },
        session: session === "open" || session === "expiring" ? { status: "complete", late } : null,
        overpayment: null,
        statement: "payment",
        intentEvents: ["evt.payments.payment_intent.succeeded"],
        sessionEvents: session === "open" || session === "expiring" ? ["evt.payments.checkout_session.completed"] : [],
        cause: `attempt ${change.id} settled with evidence`,
      };
    }
    return {
      intent: {
        status: "requires_review",
        reviewReason: "short_settlement",
        succeededAttemptId: change.id,
        amountSettled: settled,
        late,
      },
      session: null,
      overpayment: null,
      statement: "payment",
      intentEvents: ["evt.payments.payment_intent.requires_review"],
      sessionEvents: [],
      cause: `attempt ${change.id} settled ${settled} < expected ${change.expected} beyond tolerance`,
    };
  }

  if (to === "held") {
    if (st !== "requires_payment" && st !== "processing") return none(`attempt held while the intent is ${st}`);
    return {
      ...none(`attempt ${change.id} held: verification did not complete`),
      intent: { status: "requires_review", reviewReason: "verification_held" },
      intentEvents: ["evt.payments.payment_intent.requires_review"],
    };
  }

  if (IN_FLIGHT.has(to)) {
    if (st === "requires_payment")
      return {
        ...none(`attempt ${change.id} detected a deposit`),
        intent: { status: "processing", reviewReason: null },
        intentEvents: ["evt.payments.payment_intent.processing"],
      };
    // a held attempt the provider resumes is back in flight
    if (
      st === "requires_review" &&
      intent.reviewReason === "verification_held" &&
      from === "held" &&
      !others.includes("held")
    )
      return { ...none(`attempt ${change.id} resumed`), intent: { status: "processing", reviewReason: null } };
    return none(`attempt ${change.id} in flight`);
  }

  if (TERMINAL.has(to)) {
    const all = [...others, to];
    const inFlight = others.some((s) => IN_FLIGHT.has(s));
    const held = others.includes("held");
    const wasOpen =
      st === "processing" ||
      (st === "requires_review" && intent.reviewReason === "verification_held" && from === "held");
    let next: IntentStatus = st;
    let reviewReason = intent.reviewReason;
    const intentEvents: IntentEvent[] = [];
    if (wasOpen && !held) {
      reviewReason = null;
      if (inFlight) next = "processing";
      else {
        // payable again: a still-live older attempt may settle (late, INV-3) until all are terminal
        next = "requires_payment";
        intentEvents.push("evt.payments.payment_intent.payment_failed");
      }
    }
    // session finalisation: expiring → expired once nothing can arrive any more (INV-3)
    let sessionDecision: Decision["session"] = null;
    const sessionEvents: SessionEvent[] = [];
    if (session === "expiring" && all.every((s) => TERMINAL.has(s)) && next === "requires_payment") {
      next = "expired";
      sessionDecision = { status: "expired", late: false };
      sessionEvents.push("evt.payments.checkout_session.expired");
    }
    if (next === "expired" && st !== "expired") intentEvents.push("evt.payments.payment_intent.expired");
    const changed = next !== st || reviewReason !== intent.reviewReason;
    return {
      intent: changed ? { status: next, reviewReason } : null,
      session: sessionDecision,
      overpayment: null,
      statement: null,
      intentEvents,
      sessionEvents,
      cause: `attempt ${change.id} ${to}`,
    };
  }

  return none(`attempt ${change.id} ${to}`);
}

export type GuardError = "state_conflict" | "attempt_in_flight";

/** Merchant cancel (§5): only an unpaid intent with nothing in flight. */
export function canCancel(intent: IntentStatus, attempts: readonly AttemptStatus[]): GuardError | null {
  if (intent !== "requires_payment") return "state_conflict";
  if (attempts.some((s) => IN_FLIGHT.has(s))) return "attempt_in_flight";
  return null;
}

/** Merchant expire of an open session (domain-model §4.1: open → expired, no attempt in flight). */
export function canExpire(
  session: SessionStatus,
  intent: IntentStatus,
  attempts: readonly AttemptStatus[],
): GuardError | null {
  if (session !== "open") return "state_conflict";
  if (attempts.some((s) => IN_FLIGHT.has(s) || s === "held")) return "attempt_in_flight";
  if (intent !== "requires_payment") return "state_conflict";
  return null;
}

/**
 * The session expiry job at `expires_at` (§9): `open → expiring`; then `expired` (with the intent)
 * when no attempt can still settle.
 */
export function onSessionDeadline(
  session: SessionStatus,
  intent: IntentStatus,
  attempts: readonly AttemptStatus[],
): { session: SessionStatus; intent: IntentStatus; sessionEvents: SessionEvent[]; intentEvents: IntentEvent[] } | null {
  if (session !== "open") return null;
  const settled = attempts.every((s) => TERMINAL.has(s));
  if (settled && intent === "requires_payment")
    return {
      session: "expired",
      intent: "expired",
      sessionEvents: ["evt.payments.checkout_session.expired"],
      intentEvents: ["evt.payments.payment_intent.expired"],
    };
  return { session: "expiring", intent, sessionEvents: [], intentEvents: [] };
}
