/**
 * Payment intents for merchants (lld/payments.md §6.1, §5): read, list and cancel, and the internal
 * read for billing/agentpay/ops. Intents carry their attempts (newest first) and overpayments.
 */
import { toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { isAttemptStatus } from "../domain/payment-attempt/attempt.js";
import { canCancel } from "../domain/payment-intent/intent.js";
import type { Payments } from "./context.js";
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
import type { Merchant } from "./sessions.js";
import { type AttemptRow, type IntentRow, intentView } from "./views.js";

async function withRelations(p: Payments, intents: readonly IntentRow[]) {
  const ids = intents.map((i) => i.id);
  const [attempts, sessions] = ids.length
    ? await Promise.all([
        p.db.selectFrom("payment_attempts").selectAll().where("payment_intent_id", "in", ids).execute(),
        p.db
          .selectFrom("checkout_sessions")
          .select(["id", "payment_intent_id"])
          .where("payment_intent_id", "in", ids)
          .execute(),
      ])
    : [[], []];
  const byIntent = new Map<string, AttemptRow[]>();
  for (const a of attempts) byIntent.set(a.payment_intent_id, [...(byIntent.get(a.payment_intent_id) ?? []), a]);
  const session = new Map(sessions.map((s) => [s.payment_intent_id, s.id]));
  return intents.map((i) => intentView(i, byIntent.get(i.id) ?? [], session.get(i.id) ?? null));
}

async function ownIntent(p: Payments, m: Merchant, id: string): Promise<IntentRow> {
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

/** `GET /v1/payment_intents`. */
export async function listIntents(p: Payments, m: Merchant, q: PageQuery & { status?: string | undefined }) {
  let base = p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.status) base = base.where("status", "=", q.status as IntentRow["status"]);
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
