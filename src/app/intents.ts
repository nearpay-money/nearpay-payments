/**
 * Payment intents for merchants (lld/payments.md §6.1, §5): read, list and cancel, and the internal
 * read for billing/agentpay/ops. Intents carry their attempts (newest first) and overpayments.
 */
import { metadataFilters } from "@nearpay/spec";
import { sql } from "@nearpay-internal/db";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { isAttemptStatus } from "../domain/payment-attempt/attempt.js";
import { amountFilters, fiatPredicate, SQL_OP } from "../domain/payment-intent/filters.js";
import { canCancel, type IntentStatus, type SessionStatus } from "../domain/payment-intent/intent.js";
import { reviewOutcome } from "../domain/payment-intent/review.js";
import { countLinkUse } from "./apply.js";
import type { Payments } from "./context.js";
import { assertRefundsAllowed } from "./kill-switch.js";
import {
  attemptsOf,
  emitIntentEvents,
  emitSessionEvents,
  hideAttempts,
  lockIntent,
  lockSessionOfIntent,
  updateIntent,
  updateSession,
} from "./ledger.js";
import { type PageQuery, pageOf } from "./pages.js";
import { type Actor, insertRefund, prepareAndReport } from "./refunds.js";
import type { Merchant, SessionCreate } from "./sessions.js";
import { attachableCustomer, openSession } from "./sessions.js";
import { type AttemptRow, type IntentRow, intentView } from "./views.js";

export async function withRelations(p: Payments, intents: readonly IntentRow[]) {
  const ids = intents.map((i) => i.id);
  const [attempts, sessions, refunds] = ids.length
    ? await Promise.all([
        p.db.selectFrom("payment_attempts").selectAll().where("payment_intent_id", "in", ids).execute(),
        p.db
          .selectFrom("checkout_sessions")
          .select(["id", "payment_intent_id"])
          .where("payment_intent_id", "in", ids)
          .execute(),
        p.db
          .selectFrom("refunds")
          .select(["id", "created_at", "payment_intent_id"])
          .where("payment_intent_id", "in", ids)
          .execute(),
      ])
    : [[], [], []];
  const refundsOf = new Map<string, { id: string; created_at: Date }[]>();
  for (const r of refunds) refundsOf.set(r.payment_intent_id, [...(refundsOf.get(r.payment_intent_id) ?? []), r]);
  const byIntent = new Map<string, AttemptRow[]>();
  for (const a of attempts) byIntent.set(a.payment_intent_id, [...(byIntent.get(a.payment_intent_id) ?? []), a]);
  const session = new Map(sessions.map((s) => [s.payment_intent_id, s.id]));
  return intents.map((i) =>
    intentView(i, byIntent.get(i.id) ?? [], session.get(i.id) ?? null, refundsOf.get(i.id) ?? []),
  );
}

export async function ownIntent(p: Payments, m: Merchant, id: string): Promise<IntentRow> {
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", toUuid(id, "pi"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!i) throw ApiError.missing("payment_intent", id);
  return i;
}

/** `GET /v1/payment_intents/{id}`. */
export async function getIntent(p: Payments, m: Merchant, id: string) {
  const [v] = await withRelations(p, [await ownIntent(p, m, id)]);
  return v as NonNullable<typeof v>;
}

/** `GET /internal/payment_intents/{id}` (service scope; no account predicate). */
export async function getInternalIntent(p: Payments, id: string) {
  const i = await p.db.selectFrom("payment_intents").selectAll().where("id", "=", toUuid(id, "pi")).executeTakeFirst();
  if (!i) throw ApiError.missing("payment_intent", id);
  const [v] = await withRelations(p, [i]);
  return v as NonNullable<typeof v>;
}

export interface IntentListQuery extends PageQuery {
  readonly status?: string | undefined;
  readonly currency?: string | undefined;
  readonly asset_id?: string | undefined;
  readonly settlement_asset_id?: string | undefined;
  readonly source?: string | undefined;
  readonly customer?: string | undefined;
  readonly payment_link?: string | undefined;
  readonly checkout_session?: string | undefined;
  readonly [key: string]: unknown;
}

/**
 * `GET /v1/payment_intents` with the ADR-0018 filters (AND-combined; each served by an index under
 * `(account_id, livemode)`, migration 0002): `status`, `created[…]`, `amount[gte|gt|lte|lt]`, `currency`,
 * `asset_id`, `settlement_asset_id`, `source`, `customer`, `payment_link`, `checkout_session`,
 * `metadata[key]` (exact, ≤ 10, `metadata @> {…}` on the GIN index).
 */
export async function listIntents(p: Payments, m: Merchant, q: IntentListQuery) {
  let base = p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.status) base = base.where("status", "=", q.status as IntentRow["status"]);
  if (q.currency) base = base.where("currency", "=", q.currency);
  if (q.asset_id) base = base.where("currency", "=", "asset").where("pricing_asset_id", "=", q.asset_id);
  if (q.settlement_asset_id) base = base.where("settlement_asset_id", "=", q.settlement_asset_id);
  if (q.source) base = base.where("source", "=", q.source as IntentRow["source"]);
  if (q.customer) base = base.where("customer_id", "=", toUuid(q.customer, "cus"));
  if (q.payment_link) base = base.where("payment_link_id", "=", toUuid(q.payment_link, "plink"));
  if (q.checkout_session)
    base = base.where("id", "=", (eb) =>
      eb
        .selectFrom("checkout_sessions")
        .select("payment_intent_id")
        .where("id", "=", toUuid(q.checkout_session as string, "cs"))
        .where("account_id", "=", m.account)
        .where("livemode", "=", m.livemode),
    );
  for (const f of amountFilters(q)) {
    const fiat = fiatPredicate(f.op, f.value);
    const assetCmp = sql<boolean>`pricing_asset_amount ${sql.raw(SQL_OP[f.op])} ${f.value.toString()}::numeric`;
    const fiatCmp =
      fiat === "all"
        ? sql<boolean>`true`
        : fiat === "none"
          ? sql<boolean>`false`
          : sql<boolean>`amount ${sql.raw(SQL_OP[fiat.op])} ${fiat.value.toString()}::bigint`;
    if (q.currency === "asset") base = base.where(assetCmp);
    else if (q.currency) base = base.where(fiatCmp);
    else
      base = base.where(sql<boolean>`((currency <> 'asset' and ${fiatCmp}) or (currency = 'asset' and ${assetCmp}))`);
  }
  const meta = metadataFilters(q as Record<string, unknown>);
  if (Object.keys(meta).length) base = base.where(sql<boolean>`metadata @> ${JSON.stringify(meta)}::jsonb`);
  const page = await pageOf(base, q, "pi");
  return {
    object: "list" as const,
    data: await withRelations(p, page.rows),
    has_more: page.hasMore,
    url: "/v1/payment_intents",
  };
}

/**
 * `POST /v1/payment_intents/{id}/cancel` (§5): only an unpaid intent with no deposit in flight. Its
 * attempts are hidden (a late deposit is still tracked and becomes an overpayment, `after_cancel`)
 * and its session expires.
 */
export async function cancelIntent(p: Payments, m: Merchant, id: string, reason: string | undefined) {
  const own = await ownIntent(p, m, id);
  const out = await p.db.transaction().execute(async (tx) => {
    let i = (await lockIntent(tx, own.id)) as IntentRow;
    let s = (await lockSessionOfIntent(tx, i.id)) ?? null;
    const attempts = await attemptsOf(tx, i.id, true);
    const err = canCancel(
      i.status,
      attempts.map((a) => (isAttemptStatus(a.status) ? a.status : "held")),
    );
    if (err === "attempt_in_flight") throw new ApiError("attempt_in_flight");
    if (err)
      throw new ApiError("state_conflict", {
        message: `The intent is ${i.status}; only an unpaid intent can be canceled.`,
      });
    const meta = { cause: `canceled by the merchant${reason ? `: ${reason}` : ""}`, actor: "merchant" };
    await hideAttempts(tx, i.id);
    const previous = { status: i.status };
    i = await updateIntent(
      tx,
      i,
      { status: "canceled", canceled_at: new Date(p.now()), cancellation_reason: reason ?? null },
      meta,
    );
    i = await emitIntentEvents(tx, i, ["evt.payments.payment_intent.canceled"], previous);
    if (s && (s.status === "open" || s.status === "expiring")) {
      s = await updateSession(tx, s, { status: "expired" }, meta);
      await emitSessionEvents(tx, s, i, ["evt.payments.checkout_session.expired"]);
    }
    return { i, s };
  });
  if (out.s) await p.notifier.publish(out.s.id);
  const [v] = await withRelations(p, [out.i]);
  return v as NonNullable<typeof v>;
}

// ============================================================================================ stage 2

export interface IntentCreate {
  readonly amount: number | string;
  readonly currency: string;
  readonly asset_id?: string | undefined;
  readonly settlement_destination?: string | undefined;
  readonly return_url: string;
  readonly expires_in?: number | undefined;
  readonly customer?: string | undefined;
  readonly customer_email?: string | undefined;
  readonly description?: string | undefined;
  readonly late_payments?: boolean | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/**
 * `POST /v1/payment_intents` (§17 item 10): the intent (`source: api`) with a headless checkout session
 * (`ui_mode: hosted`, `success_url` = `return_url`) whose client secret is returned once, here only.
 */
export async function createPaymentIntent(p: Payments, m: Merchant, body: IntentCreate) {
  const customerId = await attachableCustomer(p, m, body.customer);
  const spec: SessionCreate = {
    amount: body.amount,
    currency: body.currency,
    asset_id: body.asset_id,
    settlement_destination: body.settlement_destination,
    success_url: body.return_url,
    expires_in: body.expires_in,
    ui_mode: "hosted",
    customer_email: body.customer_email,
    description: body.description,
    late_payments: body.late_payments,
    metadata: body.metadata,
  };
  const o = await openSession(p, m, { ...spec, source: "api", customerId, headless: true });
  const [v] = await withRelations(p, [o.i]);
  return { ...(v as NonNullable<typeof v>), checkout_session: fromUuid("cs", o.s.id), client_secret: o.secret };
}

/**
 * `POST /v1/payment_intents/{id}/review` (§5, §17 item 9). `accept` (short settlement only) completes
 * the intent and its session; `reject` returns it to `requires_payment` (session open) or `expired` and,
 * by default, creates a `review_rejection` refund of the short settlement for the merchant to sign.
 */
export async function reviewIntent(
  p: Payments,
  m: Merchant,
  id: string,
  body: { decision: "accept" | "reject"; reason?: string | undefined; create_refund?: boolean | undefined },
  actor: Actor,
) {
  const own = await ownIntent(p, m, id);
  // a draft refund needs a new live leg: not while the kill switch is engaged (the merchant refunds later)
  let draftAllowed = true;
  if (body.decision === "reject")
    draftAllowed = await assertRefundsAllowed(p, m.livemode).then(
      () => true,
      () => false,
    );
  const out = await p.db.transaction().execute(async (tx) => {
    let i = (await lockIntent(tx, own.id)) as IntentRow;
    let s = (await lockSessionOfIntent(tx, i.id)) ?? null;
    const attempts = await attemptsOf(tx, i.id, true);
    const o = reviewOutcome(
      { status: i.status as IntentStatus, reviewReason: i.review_reason, settled: BigInt(i.amount_settled) },
      (s?.status ?? null) as SessionStatus | null,
      body.decision,
      body.create_refund,
    );
    if (o === "review_requires_evidence")
      throw new ApiError("review_requires_evidence", {
        message: "A held verification has no settlement evidence yet; it resolves itself when evidence arrives.",
      });
    if (o === "state_conflict")
      throw new ApiError("state_conflict", {
        message: `The intent is ${i.status}; only an intent in review is decided.`,
      });
    const now = new Date(p.now());
    const meta = {
      cause: `review ${body.decision} by the merchant${body.reason ? `: ${body.reason}` : ""}`,
      actor: actor.id,
    };
    const settledAttempt = attempts.find((a) => a.id === i.succeeded_attempt_id) ?? null;
    const previous = { status: i.status };
    i = await updateIntent(
      tx,
      i,
      {
        status: o.status,
        review_reason: null,
        ...(o.status === "succeeded" ? { succeeded_at: now } : {}),
        ...(o.session?.status === "complete" ? { late: o.session.late } : {}),
        // a rejected short settlement stops being the intent's settlement (refunded against its attempt)
        ...(o.releaseSettlement ? { succeeded_attempt_id: null, amount_settled: 0n } : {}),
      },
      meta,
    );
    let refundId: string | null = null;
    let legId: string | null = null;
    if (o.refund && settledAttempt && draftAllowed) {
      const settled = BigInt(settledAttempt.settled_amount ?? "0");
      const available = settled - BigInt(settledAttempt.amount_refunded) - BigInt(settledAttempt.amount_refund_pending);
      if (available > 0n) {
        const r = await insertRefund(
          p,
          tx,
          { intent: i, attempt: settledAttempt },
          {
            kind: "attempt",
            amount: available,
            feeMode: "payer_absorbs",
            reason: "other",
            source: "review_rejection",
            actor: actor.id,
            idempotencyKey: null,
            metadata: {},
          },
        );
        i = r.intent;
        refundId = r.refund.id;
        legId = r.leg.id;
      }
    }
    i = await updateIntent(
      tx,
      i,
      {
        review_decision: JSON.stringify({
          decision: body.decision,
          decided_at: now.toISOString(),
          refund: refundId,
          reason: body.reason ?? null,
          actor: actor.id,
        }),
      },
      meta,
    );
    if (o.countsUse && i.payment_link_id) await countLinkUse(tx, i.payment_link_id);
    if (s && o.session)
      s = await updateSession(
        tx,
        s,
        o.session.status === "complete"
          ? { status: "complete", completed_at: now, late: o.session.late }
          : { status: "expired" },
        meta,
      );
    if (o.session?.status === "expired") await hideAttempts(tx, i.id);
    i = await emitIntentEvents(tx, i, o.intentEvents, previous);
    if (s && o.sessionEvents.length) await emitSessionEvents(tx, s, i, o.sessionEvents);
    return { i, s, refundId, legId };
  });
  if (out.s) await p.notifier.publish(out.s.id);
  if (out.refundId && out.legId)
    await prepareAndReport(p, out.refundId, out.legId, actor.id).catch((e) =>
      p.log.warn(
        { refund: out.refundId, err: e instanceof Error ? e.message : String(e) },
        "draft refund leg not prepared",
      ),
    );
  const [v] = await withRelations(p, [out.i]);
  return v as NonNullable<typeof v>;
}
