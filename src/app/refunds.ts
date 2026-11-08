/**
 * Refunds (lld/payments.md §5, §6.1, §8.4, §9, §17; domain-model §4.4).
 *
 * Non-custodial (INV-1): a refund is prepared as **legs** — rails executions from the merchant's
 * destination to the payer (`POST /internal/refund_executions`). The merchant signs the leg's
 * `next_action` (a chain transfer, or a Verifier transfer payments builds with a fresh nonce); payments
 * forwards a reported tx hash to rails or relays the signed payload through agentpay (`kind: refund`).
 * A refund succeeds only on payer-side evidence (INV-2) and goes to the payer's recorded refund address
 * unless an owner overrides it with step-up (INV-7).
 *
 * Like attempts, a leg is inserted `preparing` (with the reservation) before rails is called with
 * idempotency key `refund:<re>:leg:<n>`; a transient failure leaves it to `refund.prepare_recovery`.
 * Lock order everywhere: intent → attempt → refund → legs (payment application takes the intent first
 * too, so the two never deadlock).
 */
import type { MultiPayload } from "@nearpay/spec";
import { getChain, validateAddress } from "@nearpay-internal/chains";
import type { Updateable } from "@nearpay-internal/db";
import { emit, enqueueJob } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { verifySigned } from "@nearpay-internal/intents";
import { ApiError, type ApiErrorOptions } from "@nearpay-internal/service";
import type { Execution } from "@nearpay-internal/spec";
import {
  matchesIssued,
  type SignIntentAction,
  shortAddress,
  signAndSendAction,
  signIntentAction,
} from "../domain/refund/next-action.js";
import {
  type AbandonReason,
  abandonReasonOf,
  applyDecision,
  type Budget,
  budgetOf,
  type CurrentLeg,
  canCancel,
  canChangeRecipient,
  canSubmit,
  isTransientRailError,
  type LegStatus,
  legIdempotencyKey,
  legStatusOf,
  legUpdateOf,
  onLegChange,
  prepareErrorOf,
  prepareMode,
  type RefundEvent,
  type RefundStatus,
  refundable,
  release,
  reserve,
  swapTypeOf,
} from "../domain/refund/refund.js";
import { upstreamCode } from "../infra/clients/peers.js";
import type { RefundLegsTable, RefundsTable } from "../infra/db/schema.js";
import type { Payments, Tx } from "./context.js";
import { assertRefundsAllowed, killSwitchEngaged } from "./kill-switch.js";
import { lockIntent, type Meta, updateAttempt, updateIntent } from "./ledger.js";
import { type PageQuery, pageOf } from "./pages.js";
import { merchantName } from "./payer.js";
import { assetInfo } from "./pricing.js";
import type { Merchant } from "./sessions.js";
import { settlementContext } from "./settlement-context.js";
import {
  type AttemptRow,
  type IntentRow,
  type LegRow,
  pricingOf,
  type RefundRow,
  refundView,
  settlementValue,
} from "./views.js";

export const PREPARE_RECOVERY_JOB = "refund.prepare_recovery";
/** Asks rails to abandon an orphaned refund leg's execution (spec 0.2.1 `abandonExecution`). */
export const ABANDON_LEG_JOB = "refund.abandon_leg";
/** Legs younger than this are still in their own prepare call. */
export const PREPARE_RECOVER_AFTER_MS = 20_000;
/** How long a leg may stay `preparing` before the refund fails with `rail_timeout` (§9). */
export const PREPARE_GIVE_UP_MS = 2 * 60_000;

export interface Actor {
  /** `key_…` / `usr_…` / `system` — recorded as `created_by` and on transitions. */
  readonly id: string;
  readonly source: "api" | "dashboard";
}

// ============================================================================================ rows

interface Locked {
  intent: IntentRow;
  attempt: AttemptRow;
  refund: RefundRow;
  legs: LegRow[];
}

async function lockAll(tx: Tx, refundId: string): Promise<Locked | null> {
  const head = await tx
    .selectFrom("refunds")
    .select(["payment_intent_id", "payment_attempt_id"])
    .where("id", "=", refundId)
    .executeTakeFirst();
  if (!head) return null;
  const intent = (await lockIntent(tx, head.payment_intent_id)) as IntentRow;
  const attempt = await tx
    .selectFrom("payment_attempts")
    .selectAll()
    .where("id", "=", head.payment_attempt_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const refund = await tx
    .selectFrom("refunds")
    .selectAll()
    .where("id", "=", refundId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const legs = await tx
    .selectFrom("refund_legs")
    .selectAll()
    .where("refund_id", "=", refundId)
    .orderBy("number", "asc")
    .forUpdate()
    .execute();
  return { intent, attempt, refund, legs };
}

function budgetFrom(kind: "intent" | "attempt", intent: IntentRow, attempt: AttemptRow): Budget {
  return kind === "intent"
    ? {
        settled: BigInt(intent.amount_settled),
        refunded: BigInt(intent.amount_refunded),
        pending: BigInt(intent.amount_refund_pending),
      }
    : {
        settled: BigInt(attempt.settled_amount ?? "0"),
        refunded: BigInt(attempt.amount_refunded),
        pending: BigInt(attempt.amount_refund_pending),
      };
}

/** Writes a budget back to its owner row (intent or attempt) and returns the updated rows. */
async function writeBudget(
  tx: Tx,
  kind: "intent" | "attempt",
  l: { intent: IntentRow; attempt: AttemptRow },
  before: Budget,
  after: Budget,
  meta: Meta,
): Promise<{ intent: IntentRow; attempt: AttemptRow }> {
  if (before.refunded === after.refunded && before.pending === after.pending) return l;
  if (kind === "intent") {
    const intent = await updateIntent(
      tx,
      l.intent,
      { amount_refunded: after.refunded, amount_refund_pending: after.pending },
      meta,
    );
    return { ...l, intent };
  }
  const attempt = await updateAttempt(
    tx,
    l.attempt,
    { amount_refunded: after.refunded, amount_refund_pending: after.pending },
    meta,
  );
  return { ...l, attempt };
}

async function updateRefund(tx: Tx, cur: RefundRow, patch: Updateable<RefundsTable>, meta: Meta): Promise<RefundRow> {
  const next = await tx
    .updateTable("refunds")
    .set({ ...patch, version: cur.version + 1, updated_at: new Date() })
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!next) throw new Error(`refund ${cur.id} changed concurrently`);
  if (next.status !== cur.status) await refundTransition(tx, cur.id, cur.status, next.status, meta);
  return next;
}

async function refundTransition(tx: Tx, id: string, from: string | null, to: string, meta: Meta): Promise<void> {
  await tx
    .insertInto("refund_transitions")
    .values({
      id: uuidv7(),
      refund_id: id,
      from_state: from,
      to_state: to,
      cause: meta.cause.slice(0, 500),
      actor: meta.actor,
      evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
    })
    .execute();
}

async function updateLeg(tx: Tx, cur: LegRow, patch: Updateable<RefundLegsTable>, meta: Meta): Promise<LegRow> {
  const next = await tx
    .updateTable("refund_legs")
    .set({ ...patch, version: cur.version + 1, updated_at: new Date() })
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!next) throw new Error(`refund leg ${cur.id} changed concurrently`);
  if (next.status !== cur.status) await legTransition(tx, cur.id, cur.status, next.status, meta);
  return next;
}

async function legTransition(tx: Tx, id: string, from: string | null, to: string, meta: Meta): Promise<void> {
  await tx
    .insertInto("refund_leg_transitions")
    .values({
      id: uuidv7(),
      refund_leg_id: id,
      from_state: from,
      to_state: to,
      cause: meta.cause.slice(0, 500),
      actor: meta.actor,
      evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
    })
    .execute();
}

async function insertLeg(
  tx: Tx,
  refund: RefundRow,
  number: number,
  o: { screen: boolean },
  meta: Meta,
): Promise<LegRow> {
  const leg = await tx
    .insertInto("refund_legs")
    .values({
      id: uuidv7(),
      refund_id: refund.id,
      number,
      method: refund.method,
      swap_type: refund.method === "route_quote" ? swapTypeOf(refund.fee_mode) : null,
      status: "preparing",
      amount: refund.amount,
      screen: o.screen,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await legTransition(tx, leg.id, null, "preparing", meta);
  return leg;
}

/** Emits refund events, each with its own version (every event after the first bumps the refund). */
async function emitRefundEvents(
  p: Payments,
  tx: Tx,
  refund: RefundRow,
  intent: IntentRow,
  subjects: readonly RefundEvent[],
  previous?: Record<string, unknown>,
): Promise<RefundRow> {
  let cur = refund;
  for (const [k, subject] of subjects.entries()) {
    if (k > 0) cur = await updateRefund(tx, cur, {}, { cause: "event", actor: "system" });
    const legs = await tx.selectFrom("refund_legs").selectAll().where("refund_id", "=", cur.id).execute();
    await emit(tx, {
      subject,
      aggregate: { type: "refund", id: fromUuid("re", cur.id), version: Math.max(1, cur.version) },
      accountId: cur.account_id,
      livemode: cur.livemode,
      data: {
        object: refundView(cur, legs, assetOf(intent), p.now()),
        ...(previous ? { previous } : {}),
      },
    });
  }
  return cur;
}

const assetOf = (i: IntentRow) => ({ id: i.settlement_asset_id, decimals: i.settlement_decimals });

// ============================================================================================ reads

async function viewOf(p: Payments, r: RefundRow) {
  const [legs, intent] = await Promise.all([
    p.db.selectFrom("refund_legs").selectAll().where("refund_id", "=", r.id).execute(),
    p.db
      .selectFrom("payment_intents")
      .select(["settlement_asset_id", "settlement_decimals"])
      .where("id", "=", r.payment_intent_id)
      .executeTakeFirstOrThrow(),
  ]);
  return refundView(r, legs, { id: intent.settlement_asset_id, decimals: intent.settlement_decimals }, p.now());
}

async function viewsOf(p: Payments, rows: readonly RefundRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [legs, intents] = await Promise.all([
    p.db.selectFrom("refund_legs").selectAll().where("refund_id", "in", ids).execute(),
    p.db
      .selectFrom("payment_intents")
      .select(["id", "settlement_asset_id", "settlement_decimals"])
      .where(
        "id",
        "in",
        rows.map((r) => r.payment_intent_id),
      )
      .execute(),
  ]);
  const byRefund = new Map<string, LegRow[]>();
  for (const l of legs) byRefund.set(l.refund_id, [...(byRefund.get(l.refund_id) ?? []), l]);
  const asset = new Map(intents.map((i) => [i.id, { id: i.settlement_asset_id, decimals: i.settlement_decimals }]));
  return rows.map((r) =>
    refundView(
      r,
      byRefund.get(r.id) ?? [],
      asset.get(r.payment_intent_id) as { id: string; decimals: number },
      p.now(),
    ),
  );
}

async function ownRefund(p: Payments, m: Merchant, id: string): Promise<RefundRow> {
  const r = await p.db
    .selectFrom("refunds")
    .selectAll()
    .where("id", "=", toUuid(id, "re"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!r) throw ApiError.missing("refund", id);
  return r;
}

/** `GET /v1/refunds/{id}`. */
export async function getRefund(p: Payments, m: Merchant, id: string) {
  return viewOf(p, await ownRefund(p, m, id));
}

/** `GET /internal/refunds/{id}` (services) and `GET /ops/refunds/{id}` (console): no account predicate. */
export async function getRefundById(p: Payments, id: string) {
  const r = await p.db.selectFrom("refunds").selectAll().where("id", "=", toUuid(id, "re")).executeTakeFirst();
  if (!r) throw ApiError.missing("refund", id);
  return viewOf(p, r);
}

export interface RefundListQuery extends PageQuery {
  readonly payment_intent?: string | undefined;
  readonly status?: string | undefined;
}

/** `GET /v1/refunds`. */
export async function listRefunds(p: Payments, m: Merchant, q: RefundListQuery) {
  let base = p.db
    .selectFrom("refunds")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.payment_intent) base = base.where("payment_intent_id", "=", toUuid(q.payment_intent, "pi"));
  if (q.status) base = base.where("status", "=", q.status as RefundStatus);
  const page = await pageOf(base, q, "re");
  return { object: "list" as const, data: await viewsOf(p, page.rows), has_more: page.hasMore, url: "/v1/refunds" };
}

// ============================================================================================ creation

export interface RefundCreateInput {
  readonly payment_intent: string;
  readonly payment_attempt?: string | undefined;
  readonly amount?: string | undefined;
  readonly reason?: string | undefined;
  readonly fee_mode: "payer_absorbs" | "merchant_absorbs";
  readonly metadata?: Record<string, string> | undefined;
}

/**
 * Inserts a refund in `requires_action` with leg 1 `preparing` and its reservation, inside the caller's
 * transaction (the intent and the attempt are locked). Used by `createRefund` and by a review `reject`.
 */
export async function insertRefund(
  p: Payments,
  tx: Tx,
  l: { intent: IntentRow; attempt: AttemptRow },
  o: {
    kind: "intent" | "attempt";
    amount: bigint;
    feeMode: "payer_absorbs" | "merchant_absorbs";
    reason: string | null;
    source: "api" | "dashboard" | "review_rejection";
    actor: string;
    idempotencyKey: string | null;
    metadata: Record<string, string>;
  },
): Promise<{ refund: RefundRow; leg: LegRow; intent: IntentRow; attempt: AttemptRow }> {
  const before = budgetFrom(o.kind, l.intent, l.attempt);
  const after = reserve(before, o.amount);
  if (!after)
    throw new ApiError("amount_exceeds_refundable", {
      param: "amount",
      message: `At most ${refundable(before)} base units can be refunded.`,
      params: { refundable: refundable(before).toString() },
    });
  const a = l.attempt;
  const id = uuidv7();
  const meta: Meta = { cause: `refund ${fromUuid("re", id)} created (${o.source})`, actor: o.actor };
  const rows = await writeBudget(tx, o.kind, l, before, after, meta);
  let refund = await tx
    .insertInto("refunds")
    .values({
      id,
      payment_intent_id: l.intent.id,
      payment_attempt_id: a.id,
      account_id: l.intent.account_id,
      livemode: l.intent.livemode,
      amount: o.amount,
      budget: o.kind,
      fee_mode: o.feeMode,
      reason: o.reason,
      status: "requires_action",
      method: a.method === "intents_transfer" ? "intents_transfer" : "route_quote",
      recipient: a.refund_to,
      recipient_asset_id: a.origin_asset_id,
      recipient_chain: a.origin_chain,
      recipient_type: a.refund_type,
      source: o.source,
      created_by: o.actor,
      idempotency_key: o.idempotencyKey,
      metadata: JSON.stringify(o.metadata),
      version: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await refundTransition(tx, id, null, "requires_action", meta);
  const leg = await insertLeg(tx, refund, 1, { screen: false }, meta);
  refund = await updateRefund(tx, refund, { current_leg_id: leg.id }, meta);
  refund = await emitRefundEvents(p, tx, refund, rows.intent, ["evt.payments.refund.created"]);
  p.metrics.refund("created");
  return { refund, leg, ...rows };
}

/** `POST /v1/refunds` (§8.4). */
export async function createRefund(
  p: Payments,
  m: Merchant,
  body: RefundCreateInput,
  actor: Actor,
  idempotencyKey: string | undefined,
) {
  await assertRefundsAllowed(p, m.livemode);
  const key = idempotencyKey?.slice(0, 255) ?? null;
  const replay = async () =>
    key
      ? p.db
          .selectFrom("refunds")
          .selectAll()
          .where("account_id", "=", m.account)
          .where("livemode", "=", m.livemode)
          .where("idempotency_key", "=", key)
          .executeTakeFirst()
      : undefined;
  const earlier = await replay();
  if (earlier) return viewOf(p, earlier);

  let created: { refund: RefundRow; leg: LegRow };
  try {
    created = await p.db.transaction().execute(async (tx) => {
      const own = await tx
        .selectFrom("payment_intents")
        .select("id")
        .where("id", "=", toUuid(body.payment_intent, "pi"))
        .where("account_id", "=", m.account)
        .where("livemode", "=", m.livemode)
        .executeTakeFirst();
      if (!own) throw ApiError.missing("payment_intent", body.payment_intent, "payment_intent");
      const intent = (await lockIntent(tx, own.id)) as IntentRow;
      const attemptUuid = body.payment_attempt ? toUuid(body.payment_attempt, "pa") : intent.succeeded_attempt_id;
      if (!attemptUuid)
        throw new ApiError("intent_not_succeeded", {
          message: `The payment intent is ${intent.status}; nothing settled to refund.`,
        });
      const attempt = await tx
        .selectFrom("payment_attempts")
        .selectAll()
        .where("id", "=", attemptUuid)
        .where("payment_intent_id", "=", intent.id)
        .forUpdate()
        .executeTakeFirst();
      if (!attempt) throw ApiError.missing("payment_attempt", body.payment_attempt as string, "payment_attempt");
      const kind = budgetOf(
        { status: intent.status, succeededAttemptId: intent.succeeded_attempt_id },
        {
          id: attempt.id,
          status: attempt.status,
          settled: attempt.settled_amount === null ? null : BigInt(attempt.settled_amount),
        },
      );
      if (kind === "intent_not_succeeded")
        throw new ApiError(kind, {
          message: `The payment intent is ${intent.status}; only a succeeded intent is refunded.`,
        });
      if (kind === "attempt_not_settled")
        throw new ApiError(kind, {
          param: "payment_attempt",
          message: `Attempt ${fromUuid("pa", attempt.id)} is ${attempt.status}; nothing verified settled through it.`,
        });
      const amount = body.amount !== undefined ? BigInt(body.amount) : refundable(budgetFrom(kind, intent, attempt));
      return insertRefund(
        p,
        tx,
        { intent, attempt },
        {
          kind,
          amount,
          feeMode: body.fee_mode,
          reason: body.reason ?? null,
          source: actor.source,
          actor: actor.id,
          idempotencyKey: key,
          metadata: body.metadata ?? {},
        },
      );
    });
  } catch (e) {
    // a concurrent create with the same key won the unique index: answer with its refund
    if ((e as { code?: string }).code === "23505") {
      const r = await replay();
      if (r) return viewOf(p, r);
    }
    throw e;
  }
  return prepareAndReport(p, created.refund.id, created.leg.id, actor.id);
}

// ============================================================================================ orphaned legs

/**
 * Schedules `abandonExecution` for a leg whose execution payments no longer uses (spec 0.2.1, audit finding
 * 6): in the transaction that made it orphaned, once per execution (job dedupe). The call itself happens
 * outside any lock; a late deposit still arrives as an execution event and counts as `extra_amount_sent`.
 */
async function abandonIfOrphaned(
  p: Payments,
  tx: Tx,
  o: {
    leg: LegRow;
    refundStatus: RefundStatus;
    current: boolean;
    executionId: string | null;
    executionState: string | null;
  },
): Promise<AbandonReason | null> {
  if (!o.executionId || o.leg.abandoned_at) return null;
  const reason = abandonReasonOf({
    legStatus: o.leg.status,
    failureCode: o.leg.failure_code,
    refundStatus: o.refundStatus,
    current: o.current,
    executionState: o.executionState,
  });
  if (!reason) return null;
  const r = await enqueueJob(tx, {
    kind: ABANDON_LEG_JOB,
    payload: { leg: o.leg.id, execution: o.executionId, reason },
    dedupeKey: `${ABANDON_LEG_JOB}:${o.executionId}`,
    maxAttempts: 20,
  });
  if (r.inserted) p.log.info({ leg: o.leg.id, execution: o.executionId, reason }, "orphaned refund leg: abandoning");
  return reason;
}

/** The `refund.abandon_leg` job: rails abandons the execution (idempotent); money already moved → nothing to do. */
export async function abandonLeg(
  p: Payments,
  payload: { leg: string; execution: string; reason: AbandonReason },
): Promise<void> {
  const leg = await p.db.selectFrom("refund_legs").selectAll().where("id", "=", payload.leg).executeTakeFirst();
  if (!leg || leg.abandoned_at) return;
  let note: string;
  try {
    const x = await p.rails.abandonExecution(payload.execution, {
      reason: payload.reason,
      note: `leg ${leg.number} of ${fromUuid("re", leg.refund_id)} is no longer used by payments`,
    });
    note = `execution ${x.id} abandoned at rails (${payload.reason}): ${x.state}`;
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "state_conflict") {
      // money moved through it: the execution keeps being tracked and its events apply to the leg (INV-3)
      p.log.warn({ leg: leg.id, execution: payload.execution }, "orphaned refund leg not abandoned: money moved");
      await p.db.transaction().execute(async (tx) => {
        await legTransition(tx, leg.id, leg.status, leg.status, {
          cause: `execution ${payload.execution} not abandoned (${payload.reason}): rails says money moved`,
          actor: "system",
        });
      });
      return;
    }
    if (u.code === "resource_missing") {
      p.log.error({ leg: leg.id, execution: payload.execution }, "ALERT orphaned refund leg unknown to rails");
      return;
    }
    throw e; // transient: the job retries
  }
  await p.db.transaction().execute(async (tx) => {
    const cur = await tx
      .selectFrom("refund_legs")
      .selectAll()
      .where("id", "=", leg.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (cur.abandoned_at) return;
    await updateLeg(
      tx,
      cur,
      { abandoned_at: new Date(p.now()), abandon_reason: payload.reason },
      { cause: note, actor: "system" },
    );
    await legTransition(tx, cur.id, cur.status, cur.status, { cause: note, actor: "system" });
  });
}

// ============================================================================================ legs

type Outcome =
  | { kind: "ok"; x: Execution }
  | { kind: "definitive"; code: string; message?: string; param?: string }
  | { kind: "transient"; reason: string };

/** Asks rails for the leg (idempotent per leg). Never throws. */
async function callRails(p: Payments, refundId: string, legId: string): Promise<Outcome> {
  const [r, leg] = await Promise.all([
    p.db.selectFrom("refunds").selectAll().where("id", "=", refundId).executeTakeFirstOrThrow(),
    p.db.selectFrom("refund_legs").selectAll().where("id", "=", legId).executeTakeFirstOrThrow(),
  ]);
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", r.payment_intent_id)
    .executeTakeFirstOrThrow();
  const d = i.destination_snapshot;
  const re = fromUuid("re", r.id);
  try {
    const x = await p.rails.createRefundExecution({
      idempotency_key: legIdempotencyKey(re, leg.number),
      account_id: fromUuid("acct", r.account_id),
      livemode: r.livemode,
      method: r.method,
      reference: {
        payment_intent: fromUuid("pi", r.payment_intent_id),
        payment_attempt: fromUuid("pa", r.payment_attempt_id),
        refund: re,
        refund_leg: leg.number,
      },
      source: { asset_id: d.asset_id, type: d.type, chain: d.chain, address: d.address },
      recipient: {
        asset_id: r.recipient_asset_id,
        chain: r.recipient_chain,
        address: r.recipient,
        type: r.recipient_type,
      },
      amount: r.amount,
      swap_type: leg.swap_type ?? swapTypeOf(r.fee_mode),
      ...(leg.screen ? { screen: true } : {}),
    } as never);
    return { kind: "ok", x };
  } catch (e) {
    const u = upstreamCode(e);
    if (isTransientRailError(u.code))
      return { kind: "transient", reason: u.code ?? (u.timeout ? "timeout" : "unreachable") };
    const env = (e as { error?: { message?: string; param?: string } }).error;
    return {
      kind: "definitive",
      code: u.code as string,
      ...(env?.message ? { message: env.message } : {}),
      ...(env?.param ? { param: env.param } : {}),
    };
  }
}

/** Rails answered with instructions that do not match the leg (finding 7): never shown to the merchant. */
export class ExecutionMismatch extends Error {}

/**
 * The exact next action for a prepared leg; throws when the execution lacks what the merchant must sign,
 * and `ExecutionMismatch` when its instructions differ from the leg (defence in depth against a rails or
 * provider fault): the amount of an `EXACT_INPUT` deposit or of an Intents transfer must be the leg's
 * amount, the transfer must move the refund asset from the destination, and an `intents_transfer` leg
 * must pay the refund recipient.
 */
async function nextActionOf(p: Payments, r: RefundRow, i: IntentRow, leg: LegRow, x: Execution) {
  const asset = { symbol: i.settlement_symbol, decimals: i.settlement_decimals };
  const mismatch = (what: string) =>
    new ExecutionMismatch(`execution ${x.id}: ${what} does not match leg ${leg.number}`);
  const exactInput = r.method === "intents_transfer" || leg.swap_type === "EXACT_INPUT";
  const t = x.refund?.transfer;
  if (t) {
    if (BigInt(t.amount) <= 0n || t.signer_id !== i.destination_snapshot.address) throw mismatch("transfer signer");
    if (t.token !== i.settlement_asset_id) throw mismatch(`transfer token ${t.token}`);
    if (exactInput && BigInt(t.amount) !== BigInt(leg.amount)) throw mismatch(`transfer amount ${t.amount}`);
    if (r.method === "intents_transfer" && t.receiver_id !== r.recipient)
      throw mismatch(`transfer receiver ${t.receiver_id}`);
    // spec 0.2.1: rails issues the nonce (salt ‖ 28 random bytes); the salt read is the fallback for rails 0.2.0
    const nonce = t.nonce ?? (await p.nonces.fresh(r.livemode));
    return { action: signIntentAction(t, nonce, asset), nonce, deadline: new Date(t.deadline), amount: t.amount };
  }
  const dep = x.deposit;
  if (!dep) throw new Error(`execution ${x.id}: refund leg without deposit or transfer`);
  if (BigInt(dep.amount_in) <= 0n || (exactInput && BigInt(dep.amount_in) !== BigInt(leg.amount)))
    throw mismatch(`deposit amount ${dep.amount_in}`);
  const d = i.destination_snapshot;
  const action = signAndSendAction({
    chain: d.chain,
    chainName: getChain(d.chain)?.name ?? d.chain,
    from: d.address,
    to: dep.address,
    assetId: i.settlement_asset_id,
    token: x.refund?.token ?? null,
    symbol: asset.symbol,
    decimals: asset.decimals,
    amount: dep.amount_in,
    memo: dep.memo,
    deadline: dep.deadline,
  });
  return { action, nonce: null, deadline: new Date(dep.deadline), amount: dep.amount_in };
}

/**
 * tx2 of a preparation: the execution becomes the leg (`awaiting_signature` with its exact next action)
 * and the refund announces `requires_action`. A leg that is no longer `preparing` is applied like an
 * execution event instead.
 */
async function linkLeg(p: Payments, legId: string, x: Execution, actor: string): Promise<"linked" | "mismatch"> {
  const leg0 = await p.db.selectFrom("refund_legs").selectAll().where("id", "=", legId).executeTakeFirstOrThrow();
  const head = { refund_id: leg0.refund_id };
  const r0 = await p.db.selectFrom("refunds").selectAll().where("id", "=", head.refund_id).executeTakeFirstOrThrow();
  const i0 = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", r0.payment_intent_id)
    .executeTakeFirstOrThrow();
  // the nonce/salt read happens before the transaction (no I/O under locks)
  let na: Awaited<ReturnType<typeof nextActionOf>>;
  try {
    na = await nextActionOf(p, r0, i0, leg0, x);
  } catch (e) {
    if (!(e instanceof ExecutionMismatch)) throw e;
    p.metrics.refund("execution_mismatch");
    p.log.error(
      { refund: r0.id, leg: leg0.number, execution: x.id, err: e.message },
      "ALERT refund execution mismatch",
    );
    await failPreparation(p, r0.id, legId, "execution_mismatch", actor, x);
    return "mismatch";
  }
  await p.db.transaction().execute(async (tx) => {
    const l = await lockAll(tx, head.refund_id);
    if (!l) return;
    const leg = l.legs.find((g) => g.id === legId) as LegRow;
    if (leg.status !== "preparing") {
      await applyLegExecution(p, tx, l, leg, x, actor);
      return;
    }
    const status = legStatusOf(x.state, x.evidence !== null, "awaiting_signature");
    const linked = await updateLeg(
      tx,
      leg,
      {
        status,
        execution_id: x.id,
        execution_version: x.version,
        next_action: JSON.stringify(na.action),
        deadline: na.deadline,
        amount: na.amount,
        amount_out_expected: x.refund?.amount_out_expected ?? null,
        signed_nonce: na.nonce,
      },
      { cause: `execution ${x.id} v${x.version}: ${x.state}`, actor },
    );
    if (status === "awaiting_signature") {
      if (l.refund.status === "requires_action" && l.refund.current_leg_id === legId) {
        const r = await updateRefund(tx, l.refund, {}, { cause: "leg prepared", actor });
        await emitRefundEvents(p, tx, r, l.intent, ["evt.payments.refund.requires_action"]);
      } else await updateRefund(tx, l.refund, {}, { cause: "leg prepared", actor });
      return;
    }
    // the execution already moved on (e.g. a retried create after a deposit): apply it as an event
    await applyLegChange(
      p,
      tx,
      { ...l, legs: l.legs.map((g) => (g.id === legId ? linked : g)) },
      leg,
      linked,
      x,
      actor,
    );
  });
  return "linked";
}

/** A definitive preparation error: the leg fails, and so does the refund when it was its current leg. */
async function failPreparation(
  p: Payments,
  refundId: string,
  legId: string,
  code: string,
  actor: string,
  x?: Execution,
) {
  await p.db.transaction().execute(async (tx) => {
    const l = await lockAll(tx, refundId);
    if (!l) return;
    const leg = l.legs.find((g) => g.id === legId) as LegRow;
    if (leg.status !== "preparing") return;
    const failed = await updateLeg(
      tx,
      leg,
      {
        status: "failed",
        failure_code: code.slice(0, 64),
        // a rejected execution stays linked: money that still moved through it is found (INV-3)
        ...(x ? { execution_id: x.id, execution_version: x.version } : {}),
      },
      {
        cause: `preparation failed: ${code}`,
        actor,
      },
    );
    await abandonIfOrphaned(p, tx, {
      leg: failed,
      refundStatus: l.refund.status,
      current: l.refund.current_leg_id === legId,
      executionId: x?.id ?? null,
      executionState: x?.state ?? null,
    });
    await applyLegChange(
      p,
      tx,
      { ...l, legs: l.legs.map((g) => (g.id === legId ? failed : g)) },
      leg,
      failed,
      null,
      actor,
    );
  });
}

/** Errors a merchant sees for a definitive preparation failure. */
function prepareError(o: { code: string; message?: string; param?: string }): ApiError {
  const code = prepareErrorOf(o.code, o.param ?? null);
  const opts: ApiErrorOptions = { ...(o.message ? { message: o.message } : {}) };
  const known = [
    "screening_blocked",
    "screening_unavailable",
    "asset_unsupported",
    "route_unavailable",
    "pricing_unavailable",
    "quote_rejected",
    "refund_address_invalid",
  ];
  if (known.includes(code))
    return new ApiError(code as never, code === "refund_address_invalid" ? { ...opts, param: "address" } : opts);
  if (code === "invalid_request") return ApiError.invalid(o.message ?? "the refund leg request is invalid");
  return new ApiError("rail_unavailable", { params: { reason: code } });
}

/**
 * Calls rails for a `preparing` leg and reports: the refund view (with `next_action`, or `null` while a
 * transient failure leaves the leg to the recovery job), or the definitive error (the refund is then
 * recorded `failed`).
 */
export async function prepareAndReport(p: Payments, refundId: string, legId: string, actor: string) {
  const out = await callRails(p, refundId, legId);
  if (out.kind === "ok") {
    let linked: "linked" | "mismatch" = "linked";
    try {
      linked = await linkLeg(p, legId, out.x, actor);
    } catch (e) {
      // e.g. the live salt could not be read: the leg stays preparing and the recovery job retries
      p.log.warn({ refund: refundId, err: e instanceof Error ? e.message : String(e) }, "refund leg not linked yet");
    }
    if (linked === "mismatch") throw prepareError({ code: "execution_mismatch" });
  } else if (out.kind === "definitive") {
    await failPreparation(p, refundId, legId, out.code, actor);
    p.metrics.refund(`rejected:${out.code}`);
    throw prepareError(out);
  } else p.log.warn({ refund: refundId, reason: out.reason }, "rails did not prepare the refund leg; left preparing");
  const r = await p.db.selectFrom("refunds").selectAll().where("id", "=", refundId).executeTakeFirstOrThrow();
  return viewOf(p, r);
}

/** The `refund.prepare_recovery` job for one leg (§9). */
export async function recoverPreparing(p: Payments, legId: string): Promise<void> {
  const leg = await p.db.selectFrom("refund_legs").selectAll().where("id", "=", legId).executeTakeFirst();
  if (leg?.status !== "preparing") return;
  const r = await p.db.selectFrom("refunds").selectAll().where("id", "=", leg.refund_id).executeTakeFirstOrThrow();
  if (r.status !== "requires_action" || r.current_leg_id !== leg.id) {
    await failPreparation(p, r.id, leg.id, "superseded", "system");
    return;
  }
  if (p.now() - leg.created_at.getTime() >= PREPARE_GIVE_UP_MS) {
    await failPreparation(p, r.id, leg.id, "rail_timeout", "system");
    p.metrics.refund("rail_timeout");
    return;
  }
  if (r.livemode && (await killSwitchEngaged(p))) return; // no new live legs while engaged (§17 item 16)
  const out = await callRails(p, r.id, leg.id);
  if (out.kind === "ok") await linkLeg(p, leg.id, out.x, "system");
  else if (out.kind === "definitive") {
    await failPreparation(p, r.id, leg.id, prepareErrorOf(out.code, out.param ?? null), "system");
    p.metrics.refund(`rejected:${out.code}`);
  }
}

// ============================================================================================ applying leg changes

const currentOf = (l: Locked): CurrentLeg | null => {
  const c = l.legs.find((g) => g.id === l.refund.current_leg_id);
  return c ? { status: c.status, deadline: c.deadline, submittedTx: c.submitted_tx } : null;
};

/**
 * Applies a leg status change to its refund (domain `onLegChange` + `applyDecision`): refund status,
 * budget, duplicate accounting, the per-leg statement line and the events — one transaction.
 */
async function applyLegChange(
  p: Payments,
  tx: Tx,
  l: Locked,
  before: LegRow,
  after: LegRow,
  x: Execution | null,
  actor: string,
): Promise<void> {
  const others = l.legs.filter((g) => g.id !== after.id).map((g) => g.status);
  const decision =
    before.status === "preparing" && after.status === "awaiting_signature"
      ? null
      : onLegChange(
          { status: l.refund.status, currentLegId: l.refund.current_leg_id },
          { id: after.id, from: before.status, to: after.status },
          others,
        );
  const meta: Meta = {
    cause: `leg ${after.number}: ${decision?.cause.replace(after.id, String(after.number)) ?? after.status}`,
    actor,
  };
  if (!decision || (decision.status === null && !decision.duplicate && decision.budget === "none")) {
    // the refund embeds its legs: any leg change is a change of the refund
    await updateRefund(tx, l.refund, {}, meta);
    return;
  }
  const kind = l.refund.budget;
  const before$ = budgetFrom(kind, l.intent, l.attempt);
  const applied = applyDecision(
    {
      status: l.refund.status,
      amount: BigInt(l.refund.amount),
      counted: BigInt(l.refund.amount_counted),
      extra: BigInt(l.refund.extra_amount_sent),
    },
    before$,
    decision,
    BigInt(after.amount),
  );
  const rows = await writeBudget(tx, kind, l, before$, applied.budget, meta);
  let leg = after;
  if (decision.duplicate) leg = await updateLeg(tx, leg, { duplicate: true }, meta);
  const succeeded = decision.status === "succeeded";
  const failed = decision.status === "failed";
  const previous = { status: l.refund.status };
  let refund = await updateRefund(
    tx,
    l.refund,
    {
      status: applied.book.status,
      amount_counted: applied.book.counted,
      extra_amount_sent: applied.book.extra,
      ...(succeeded && x
        ? {
            succeeded_at: new Date(p.now()),
            amount_received: x.settled_amount ?? (x.evidence?.amount as string | undefined) ?? null,
            evidence: x.evidence ? JSON.stringify(x.evidence) : null,
            failure_code: null,
          }
        : {}),
      ...(failed ? { failure_code: (after.failure_code ?? after.status).slice(0, 64) } : {}),
    },
    meta,
  );
  if (decision.statement && x) {
    await tx
      .insertInto("balance_transactions")
      .values({
        id: uuidv7(),
        account_id: refund.account_id,
        livemode: refund.livemode,
        type: "refund",
        payment_intent_id: refund.payment_intent_id,
        refund_id: refund.id,
        payment_attempt_id: null,
        refund_leg: leg.number,
        gross_amount: null,
        gross_currency: null,
        settled_amount: leg.amount,
        settlement_asset_id: rows.intent.settlement_asset_id,
        settlement_decimals: rows.intent.settlement_decimals,
        settlement_symbol: rows.intent.settlement_symbol,
        fee_bps: null,
        fee_amount_est: null,
        fee_asset_id: null,
        evidence: JSON.stringify(x.evidence ?? {}),
        received: JSON.stringify({
          amount: x.settled_amount ?? (x.evidence?.amount as string | undefined) ?? "0",
          asset_id: x.settlement.asset_id,
          chain: x.settlement.chain,
        }),
        execution_id: x.id,
        terminal_at: x.terminal_at ? new Date(x.terminal_at) : null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  if (decision.events.length) refund = await emitRefundEvents(p, tx, refund, rows.intent, decision.events, previous);
  if (decision.duplicate) {
    p.metrics.refund("duplicate_leg");
    p.log.warn({ refund: refund.id, leg: leg.number }, "ALERT refund leg settled as a duplicate (extra_amount_sent)");
  }
  if (succeeded) p.metrics.refund("succeeded");
  if (failed) p.metrics.refund("failed");
}

/** Applies a (newer) execution to a leg of a locked refund. */
async function applyLegExecution(p: Payments, tx: Tx, l: Locked, leg: LegRow, x: Execution, actor: string) {
  if (x.version <= leg.execution_version) return;
  const { status, ignored } = legUpdateOf(x.state, x.evidence !== null, leg.status);
  if (ignored) {
    // a late state that would revive a leg that is over (e.g. the create response after a cancel or a
    // recipient change, finding 6): the leg keeps its status and remembers the execution, so money that
    // still moves through it is found and applied (INV-3); the deposit instructions are never shown and an
    // execution that saw no deposit is abandoned at rails (spec 0.2.1 `abandonExecution`).
    const kept = await updateLeg(
      tx,
      leg,
      { execution_id: x.id, execution_version: x.version },
      { cause: `execution ${x.id} v${x.version}: ${x.state} ignored (leg ${leg.status})`, actor },
    );
    const reason = await abandonIfOrphaned(p, tx, {
      leg: kept,
      refundStatus: l.refund.status,
      current: l.refund.current_leg_id === leg.id,
      executionId: x.id,
      executionState: x.state,
    });
    await legTransition(tx, leg.id, leg.status, leg.status, {
      cause: `late execution ${x.id} v${x.version} (${x.state}) ignored: the leg is ${leg.status}${leg.failure_code ? ` (${leg.failure_code})` : ""}; ${reason ? `abandoning it at rails (${reason})` : "tracked for late money"}, nothing is shown to the merchant`,
      actor,
    });
    p.log.warn(
      { refund: l.refund.id, leg: leg.number, execution: x.id, state: x.state },
      "late refund execution state ignored for a leg that is over",
    );
    return;
  }
  const after = await updateLeg(
    tx,
    leg,
    {
      status,
      execution_id: x.id,
      execution_version: x.version,
      evidence: x.evidence ? JSON.stringify(x.evidence) : leg.evidence ? JSON.stringify(leg.evidence) : null,
      failure_code:
        status === "held"
          ? (x.held_reason ?? (x.state === "succeeded" ? "evidence_missing" : x.state)).slice(0, 64)
          : (x.failure_code ?? x.refund_reason ?? leg.failure_code ?? null),
    },
    {
      cause: `execution ${x.id} v${x.version}: ${x.state}${x.provider_status ? ` (${x.provider_status})` : ""}`,
      actor,
    },
  );
  await applyLegChange(p, tx, { ...l, legs: l.legs.map((g) => (g.id === leg.id ? after : g)) }, leg, after, x, actor);
}

/** How long an unknown refund execution may be ours before it is ignored (the create response may be in flight). */
const UNKNOWN_GRACE_MS = 2 * 60_000;

/** Consumer path (§8.4 "execution events"): the leg is found by execution id; version-checked. */
export async function applyRefundExecution(p: Payments, tx: Tx, x: Execution): Promise<void> {
  const row = await tx
    .selectFrom("refund_legs")
    .select(["id", "refund_id"])
    .where("execution_id", "=", x.id)
    .executeTakeFirst();
  if (!row) {
    if (p.now() - Date.parse(x.created_at) < UNKNOWN_GRACE_MS)
      throw new Error(`refund execution ${x.id} is not linked to a leg yet (create response in flight)`);
    p.log.warn({ execution: x.id, account: x.account_id }, "execution of no refund leg ignored");
    return;
  }
  const l = await lockAll(tx, row.refund_id);
  if (!l) return;
  const leg = l.legs.find((g) => g.id === row.id) as LegRow;
  if (leg.status === "preparing") {
    // the create response was lost after rails created the leg: the recovery job links it (with its
    // next action); applying the state now would skip the instructions
    throw new Error(`refund leg ${row.id} is still preparing`);
  }
  await applyLegExecution(p, tx, l, leg, x, "rails");
}

// ============================================================================================ merchant actions

async function lockOwn(tx: Tx, m: Merchant, id: string): Promise<Locked> {
  const own = await tx
    .selectFrom("refunds")
    .select("id")
    .where("id", "=", toUuid(id, "re"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!own) throw ApiError.missing("refund", id);
  return (await lockAll(tx, own.id)) as Locked;
}

const conflict = (message: string) => new ApiError("state_conflict", { message });

/** `POST /v1/refunds/{id}/prepare`. */
export async function prepareRefund(p: Payments, m: Merchant, id: string, actor: Actor) {
  await assertRefundsAllowed(p, m.livemode);
  const { refundId, legId } = await p.db.transaction().execute(async (tx) => {
    const l = await lockOwn(tx, m, id);
    const mode = prepareMode(
      l.refund.status,
      currentOf(l),
      l.legs.map((g) => g.status),
      p.now(),
    );
    if (mode === "state_conflict" || mode === "leg_expired")
      throw conflict(`The refund is ${l.refund.status}; its current leg cannot be replaced now.`);
    const meta: Meta = { cause: `prepare (${mode})`, actor: actor.id };
    if (mode === "retry") return { refundId: l.refund.id, legId: l.refund.current_leg_id as string };
    let refund = l.refund;
    let rows = { intent: l.intent, attempt: l.attempt };
    if (mode === "reserve") {
      const before = budgetFrom(refund.budget, l.intent, l.attempt);
      const after = reserve(before, BigInt(refund.amount));
      if (!after)
        throw new ApiError("amount_exceeds_refundable", {
          message: `Only ${refundable(before)} base units are refundable now.`,
          params: { refundable: refundable(before).toString() },
        });
      rows = await writeBudget(tx, refund.budget, rows, before, after, meta);
      refund = await updateRefund(tx, refund, { status: "requires_action", failure_code: null }, meta);
    }
    // the replaced current leg (expired instructions, never funded) is abandoned at rails (spec 0.2.1)
    for (const g of l.legs)
      if (g.id === l.refund.current_leg_id)
        await abandonIfOrphaned(p, tx, {
          leg: g,
          refundStatus: refund.status,
          current: false,
          executionId: g.execution_id,
          executionState: null,
        });
    const n = Math.max(0, ...l.legs.map((g) => g.number)) + 1;
    const leg = await insertLeg(tx, refund, n, { screen: refund.recipient_overridden }, meta);
    await updateRefund(tx, refund, { current_leg_id: leg.id }, meta);
    return { refundId: refund.id, legId: leg.id };
  });
  return prepareAndReport(p, refundId, legId, actor.id);
}

export type RefundSubmission = { tx_hash: string; sender?: string | undefined } | { signed_intent: unknown };

/** `POST /v1/refunds/{id}/submit_tx` (§8.4). */
export async function submitRefundTx(p: Payments, m: Merchant, id: string, body: RefundSubmission, actor: Actor) {
  const r0 = await ownRefund(p, m, id);
  const legs0 = await p.db.selectFrom("refund_legs").selectAll().where("refund_id", "=", r0.id).execute();
  const cur0 = legs0.find((g) => g.id === r0.current_leg_id) ?? null;
  const err = canSubmit(
    r0.status,
    cur0 ? { status: cur0.status, deadline: cur0.deadline, submittedTx: cur0.submitted_tx } : null,
    p.now(),
  );
  if (err === "leg_expired") throw new ApiError("leg_expired");
  if (err || !cur0?.execution_id || !cur0.next_action)
    throw conflict(`The refund is ${r0.status}; its current leg does not take a submission.`);
  const leg0 = cur0;
  const action = leg0.next_action as { type: string };

  if ("tx_hash" in body) {
    if (action.type !== "sign_and_send")
      throw conflict("This leg is signed as an Intents payload; submit `signed_intent`.");
    try {
      await p.rails.submitDepositTx(leg0.execution_id as string, body.tx_hash);
    } catch (e) {
      const u = upstreamCode(e);
      if (u.code === "state_conflict") throw conflict("The leg no longer accepts a deposit transaction.");
      throw new ApiError("rail_unavailable", { params: { reason: u.code ?? (u.timeout ? "timeout" : "unreachable") } });
    }
    await p.db.transaction().execute(async (tx) => {
      const l = await lockAll(tx, r0.id);
      const leg = l?.legs.find((g) => g.id === leg0.id);
      if (!l || !leg || leg.submitted_tx === body.tx_hash) return;
      // a reported tx speeds up detection; the refund stays requires_action until rails sees the deposit
      const after = await updateLeg(
        tx,
        leg,
        {
          submitted_tx: body.tx_hash,
          ...(leg.status === "awaiting_signature" ? { status: "submitted" as LegStatus } : {}),
        },
        { cause: `merchant reported tx ${body.tx_hash}`, actor: actor.id },
      );
      await updateRefund(tx, l.refund, {}, { cause: `leg ${after.number} tx reported`, actor: actor.id });
    });
    return viewOf(p, await ownRefund(p, m, id));
  }

  // signed Intents payload (sign_intent): exactly the issued payload, relayed as signed (INV-1)
  if (action.type !== "sign_intent") throw conflict("This leg is a chain transfer; report its `tx_hash`.");
  if (leg0.status !== "awaiting_signature" && leg0.status !== "submitting")
    throw conflict("A payload was already submitted for this leg.");
  await assertRefundsAllowed(p, m.livemode);
  const issued = action as SignIntentAction;
  const v = verifySigned(body.signed_intent);
  if (!v.ok) throw new ApiError("intent_invalid", { message: `The signed payload is not valid: ${v.detail}` });
  if (!matchesIssued(issued, body.signed_intent as MultiPayload) || v.message.signer_id !== issued.signer_id)
    throw new ApiError("signed_intent_mismatch", {
      message: "Sign exactly the payload in next_action (same signer, nonce, transfer and deadline).",
    });
  // the leg is `submitting` (under the row lock) before agentpay is called: a concurrent cancel or
  // recipient change sees money that may be moving and refuses, so the reservation stays (finding 5)
  await p.db.transaction().execute(async (tx) => {
    const l = await lockAll(tx, r0.id);
    const leg = l?.legs.find((g) => g.id === leg0.id);
    if (!l || !leg || l.refund.status !== "requires_action" || l.refund.current_leg_id !== leg.id)
      throw conflict("The refund changed meanwhile; its current leg does not take a submission.");
    if (leg.status === "submitting") return; // a retry of a relay whose answer was lost
    if (leg.status !== "awaiting_signature") throw conflict("A payload was already submitted for this leg.");
    const after = await updateLeg(
      tx,
      leg,
      { status: "submitting" },
      { cause: "merchant-signed payload being relayed (agentpay)", actor: actor.id },
    );
    await updateRefund(tx, l.refund, {}, { cause: `leg ${after.number} payload being relayed`, actor: actor.id });
  });
  try {
    await p.agentpay.relay({
      execution_id: leg0.execution_id as `ex_${string}`,
      binding: issued.transfer.memo,
      signed: body.signed_intent as never,
      kind: "refund",
      refund: fromUuid("re", r0.id) as `re_${string}`,
    } as never);
  } catch (e) {
    const u = upstreamCode(e);
    const env = (e as { error?: { message?: string } }).error;
    if (u.code === "intent_invalid" || u.code === "insufficient_balance" || u.code === "signed_intent_mismatch") {
      // agentpay refused before publishing: nothing moved, the merchant may sign again
      await settleRelay(p, r0.id, leg0.id, "awaiting_signature", `relay refused by agentpay: ${u.code}`, actor.id);
      throw new ApiError(u.code, { ...(env?.message ? { message: env.message } : {}) });
    }
    // unknown outcome (timeout, 5xx): the payload may have been published, so the leg stays `submitting`
    // (cancel refused) until rails reports the execution or the merchant retries the same payload
    p.log.warn(
      { refund: r0.id, leg: leg0.number, reason: u.code },
      "refund relay outcome unknown; leg stays submitting",
    );
    throw new ApiError("rail_unavailable", { params: { reason: u.code ?? "relay unreachable" } });
  }
  await settleRelay(p, r0.id, leg0.id, "submitted", "merchant-signed payload relayed (agentpay)", actor.id);
  return viewOf(p, await ownRefund(p, m, id));
}

/** Ends a relay: the `submitting` leg becomes `submitted` (accepted) or `awaiting_signature` (refused). */
async function settleRelay(
  p: Payments,
  refundId: string,
  legId: string,
  to: "submitted" | "awaiting_signature",
  cause: string,
  actor: string,
): Promise<void> {
  await p.db.transaction().execute(async (tx) => {
    const l = await lockAll(tx, refundId);
    const leg = l?.legs.find((g) => g.id === legId);
    // rails may already have moved the leg on (processing, …): its execution events win
    if (!l || !leg || leg.status !== "submitting") return;
    const after = await updateLeg(tx, leg, { status: to }, { cause, actor });
    await applyLegChange(
      p,
      tx,
      { ...l, legs: l.legs.map((g) => (g.id === leg.id ? after : g)) },
      leg,
      after,
      null,
      actor,
    );
  });
}

/** `POST /v1/refunds/{id}/cancel` (§17 item 7). */
export async function cancelRefund(p: Payments, m: Merchant, id: string, actor: Actor) {
  const out = await p.db.transaction().execute(async (tx) => {
    const l = await lockOwn(tx, m, id);
    const err = canCancel(
      l.refund.status,
      currentOf(l),
      l.legs.map((g) => g.status),
    );
    if (err)
      throw conflict(
        `The refund is ${l.refund.status}; only a refund waiting for a signature, with nothing submitted, can be canceled.`,
      );
    const meta: Meta = { cause: "canceled by the merchant", actor: actor.id };
    const before = budgetFrom(l.refund.budget, l.intent, l.attempt);
    const rows = await writeBudget(tx, l.refund.budget, l, before, release(before, BigInt(l.refund.amount)), meta);
    for (const g of l.legs) {
      const after =
        g.status === "preparing" ? await updateLeg(tx, g, { status: "failed", failure_code: "canceled" }, meta) : g;
      // a leg canceled before any deposit is abandoned at rails (spec 0.2.1)
      await abandonIfOrphaned(p, tx, {
        leg: after,
        refundStatus: "canceled",
        current: false,
        executionId: after.execution_id,
        executionState: null,
      });
    }
    const previous = { status: l.refund.status };
    let r = await updateRefund(tx, l.refund, { status: "canceled", canceled_at: new Date(p.now()) }, meta);
    r = await emitRefundEvents(p, tx, r, rows.intent, ["evt.payments.refund.canceled"], previous);
    return r;
  });
  p.metrics.refund("canceled");
  return viewOf(p, out);
}

/** `POST /v1/refunds/{id}/recipient` (INV-7): owner override with step-up; screened again by rails. */
export async function updateRecipient(
  p: Payments,
  m: Merchant,
  id: string,
  body: { address: string; reason: string },
  actor: Actor,
) {
  await assertRefundsAllowed(p, m.livemode);
  const r0 = await ownRefund(p, m, id);
  const check = validateAddress(r0.recipient_chain, body.address);
  if (!check.ok)
    throw new ApiError("refund_address_invalid", { param: "address", message: `Not a valid address: ${check.reason}` });
  const { legId } = await p.db.transaction().execute(async (tx) => {
    const l = await lockOwn(tx, m, id);
    const mode = canChangeRecipient(
      l.refund.status,
      currentOf(l),
      l.legs.map((g) => g.status),
    );
    if (mode === "state_conflict" || mode === "leg_expired")
      throw conflict(`The refund is ${l.refund.status}; its recipient can change only before anything is sent.`);
    const meta: Meta = {
      cause: `recipient overridden by the owner: ${body.reason}`,
      actor: actor.id,
      evidence: { from: l.refund.recipient, to: body.address },
    };
    let rows = { intent: l.intent, attempt: l.attempt };
    let refund = l.refund;
    if (mode === "reserve") {
      const before = budgetFrom(refund.budget, l.intent, l.attempt);
      const after = reserve(before, BigInt(refund.amount));
      if (!after)
        throw new ApiError("amount_exceeds_refundable", { params: { refundable: refundable(before).toString() } });
      rows = await writeBudget(tx, refund.budget, rows, before, after, meta);
    }
    for (const g of l.legs) {
      const after =
        g.status === "preparing" ? await updateLeg(tx, g, { status: "failed", failure_code: "superseded" }, meta) : g;
      // the new leg replaces every earlier one: an earlier execution that saw no deposit is abandoned (spec 0.2.1)
      await abandonIfOrphaned(p, tx, {
        leg: after,
        refundStatus: refund.status,
        current: false,
        executionId: after.execution_id,
        executionState: null,
      });
    }
    refund = await updateRefund(
      tx,
      refund,
      { recipient: check.normalized, recipient_overridden: true, status: "requires_action", failure_code: null },
      meta,
    );
    const n = Math.max(0, ...l.legs.map((g) => g.number)) + 1;
    const leg = await insertLeg(tx, refund, n, { screen: true }, meta);
    await updateRefund(tx, refund, { current_leg_id: leg.id }, meta);
    void rows;
    return { legId: leg.id };
  });
  return prepareAndReport(p, r0.id, legId, actor.id);
}

/** `POST /v1/test_helpers/refunds/{id}/simulate_deposit` (test mode). */
export async function simulateRefundDeposit(p: Payments, m: Merchant, id: string) {
  if (m.livemode) throw new ApiError("livemode_forbidden");
  const r = await ownRefund(p, m, id);
  if (!p.sandbox) throw new ApiError("rail_unavailable", { params: { reason: "sandbox not configured" } });
  const leg = r.current_leg_id
    ? await p.db.selectFrom("refund_legs").selectAll().where("id", "=", r.current_leg_id).executeTakeFirst()
    : undefined;
  if (r.status !== "requires_action" || !leg?.next_action)
    throw conflict(`The refund is ${r.status}; no leg to simulate.`);
  if (leg.status === "expired" || !leg.deadline || leg.deadline.getTime() <= p.now()) throw new ApiError("leg_expired");
  if (leg.status !== "awaiting_signature" && leg.status !== "submitted") throw conflict(`The leg is ${leg.status}.`);
  const a = leg.next_action as { type: string };
  const sb = p.sandbox;
  try {
    if (a.type === "sign_and_send") {
      const s = a as unknown as { to: string; memo: string | null; amount: string };
      await sb.simulateDeposit({ deposit_address: s.to, ...(s.memo ? { memo: s.memo } : {}), amount_in: s.amount });
    } else {
      const s = a as unknown as SignIntentAction;
      await sb.simulateIntentsTransfer({
        from: s.signer_id,
        to: s.transfer.receiver_id,
        token: s.transfer.token,
        amount: s.transfer.amount,
        memo: s.transfer.memo,
      });
    }
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "state_conflict" || u.status === 409) throw conflict("The sandbox cannot take that deposit now.");
    throw new ApiError("rail_unavailable", { params: { reason: u.code ?? "sandbox unreachable" } });
  }
}

// ============================================================================================ receipts

/** `GET /internal/refunds/{id}/receipt-context` (notify `refund.receipt`; PII, never in events). */
export async function refundReceiptContext(p: Payments, id: string) {
  const r = await p.db.selectFrom("refunds").selectAll().where("id", "=", toUuid(id, "re")).executeTakeFirst();
  if (!r) throw ApiError.missing("refund", id);
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", r.payment_intent_id)
    .executeTakeFirstOrThrow();
  const [email, ctx, name] = await Promise.all([
    receiptEmail(p, i),
    settlementContext(p, i.account_id, i.livemode),
    merchantName(p, i.account_id, i.livemode),
  ]);
  let received = null;
  if (r.amount_received !== null) {
    try {
      const a = await assetInfo(p, r.recipient_asset_id, r.livemode);
      received = settlementValue(r.amount_received, r.recipient_asset_id, a.decimals, a.symbol, r.recipient_chain);
    } catch {
      received = null;
    }
  }
  const pricing = pricingOf(i);
  const url = (r.evidence as { explorer_url?: string | null } | null)?.explorer_url ?? null;
  const chainName = getChain(r.recipient_chain)?.name ?? r.recipient_chain;
  return {
    customer_email: email,
    merchant_display_name: name,
    livemode: r.livemode,
    refund: fromUuid("re", r.id),
    payment_intent: fromUuid("pi", i.id),
    original_amount: pricing.amount,
    original_currency: pricing.currency,
    refunded: settlementValue(
      r.amount,
      i.settlement_asset_id,
      i.settlement_decimals,
      i.settlement_symbol,
      i.destination_snapshot.chain,
    ),
    received,
    recipient_display: `${shortAddress(r.recipient)} on ${chainName}`,
    evidence_links: url ? [url] : [],
    email_receipts: ctx.account.settings.email_receipts,
  };
}

/** The receipt address of an intent: its session's email, else its customer's (unless deleted). */
export async function receiptEmail(p: Payments, i: IntentRow): Promise<string | null> {
  const s = await p.db
    .selectFrom("checkout_sessions")
    .select(["id", "customer_email_enc"])
    .where("payment_intent_id", "=", i.id)
    .executeTakeFirst();
  if (s?.customer_email_enc) return p.cipher.decrypt(s.customer_email_enc, `cs:${s.id}`).toString("utf8");
  if (!i.customer_id) return null;
  const c = await p.db
    .selectFrom("customers")
    .select(["id", "email_enc", "deleted_at"])
    .where("id", "=", i.customer_id)
    .executeTakeFirst();
  if (!c?.email_enc || c.deleted_at) return null;
  return p.cipher.decrypt(c.email_enc, `cus:${c.id}`).toString("utf8");
}
