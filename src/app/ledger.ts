/**
 * Every state change writes the aggregate row (optimistic version), a transition row and its outbox
 * events in ONE transaction (foundations §7, INV-9). The intent's `version` (= its `sequence`) bumps
 * with every change, including attempt changes it embeds, and once more per extra event, so each event
 * of an aggregate carries a distinct, increasing version.
 */

import type { Updateable } from "@nearpay-internal/db";
import { emit, sql } from "@nearpay-internal/db";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { type Contribution, totalsDelta } from "../domain/customer/totals.js";
import type { IntentEvent, SessionEvent } from "../domain/payment-intent/intent.js";
import type { CheckoutSessionsTable, PaymentAttemptsTable, PaymentIntentsTable } from "../infra/db/schema.js";
import type { Tx } from "./context.js";
import { type AttemptRow, type IntentRow, intentView, type SessionRow, sessionView } from "./views.js";

export interface Meta {
  readonly cause: string;
  readonly actor: string;
  readonly evidence?: unknown;
}

export async function lockIntent(tx: Tx, id: string): Promise<IntentRow | undefined> {
  return tx.selectFrom("payment_intents").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
}

export async function lockSessionOfIntent(tx: Tx, intentId: string): Promise<SessionRow | undefined> {
  return tx
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("payment_intent_id", "=", intentId)
    .forUpdate()
    .executeTakeFirst();
}

export async function attemptsOf(tx: Tx, intentId: string, lock = false): Promise<AttemptRow[]> {
  const q = tx
    .selectFrom("payment_attempts")
    .selectAll()
    .where("payment_intent_id", "=", intentId)
    .orderBy("created_at", "desc");
  return lock ? q.forUpdate().execute() : q.execute();
}

export async function updateIntent(
  tx: Tx,
  cur: IntentRow,
  patch: Updateable<PaymentIntentsTable>,
  meta: Meta,
): Promise<IntentRow> {
  const version = cur.version + 1;
  const next = await tx
    .updateTable("payment_intents")
    .set({ ...patch, version, sequence: version, updated_at: new Date() })
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!next) throw new Error(`payment intent ${cur.id} changed concurrently`);
  await applyCustomerTotals(tx, cur, next);
  if (next.status !== cur.status)
    await tx
      .insertInto("payment_intent_transitions")
      .values({
        id: uuidv7(),
        payment_intent_id: cur.id,
        from_state: cur.status,
        to_state: next.status,
        cause: meta.cause.slice(0, 500),
        actor: meta.actor,
        evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
      })
      .execute();
  return next;
}

/** One signed change of a customer total row (upsert: concurrent intents of one customer serialise on the row). */
async function bumpTotal(tx: Tx, i: IntentRow, c: Contribution, sign: 1 | -1): Promise<void> {
  const amount = sign === 1 ? c.amount : -c.amount;
  await tx
    .insertInto("customer_totals")
    .values({
      customer_id: c.customer,
      account_id: i.account_id,
      livemode: i.livemode,
      currency: c.currency,
      asset_id: c.assetId,
      amount: amount.toString(),
      count: sign,
    })
    .onConflict((oc) =>
      oc.columns(["customer_id", "currency", "asset_id"]).doUpdateSet({
        amount: sql`customer_totals.amount + ${amount.toString()}::numeric`,
        count: sql`customer_totals.count + ${sign}`,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/**
 * `Customer.total_paid` / `last_payment_at` (spec 0.2.1), in the transaction of every intent change: the
 * intent's old contribution leaves, its new one enters (domain `totalsDelta`). Refunds never change it.
 */
export async function applyCustomerTotals(tx: Tx, before: IntentRow, after: IntentRow): Promise<void> {
  const d = totalsDelta(before, after);
  if (d.remove) await bumpTotal(tx, before, d.remove, -1);
  if (d.add) {
    await bumpTotal(tx, after, d.add, 1);
    const at = after.succeeded_at ?? new Date();
    await tx
      .updateTable("customers")
      .set({ last_payment_at: sql`greatest(coalesce(last_payment_at, ${at}::timestamptz), ${at}::timestamptz)` })
      .where("id", "=", d.add.customer)
      .execute();
  }
}

export async function updateSession(
  tx: Tx,
  cur: SessionRow,
  patch: Updateable<CheckoutSessionsTable>,
  meta: Meta,
): Promise<SessionRow> {
  const next = await tx
    .updateTable("checkout_sessions")
    .set({ ...patch, version: cur.version + 1, updated_at: new Date() })
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!next) throw new Error(`checkout session ${cur.id} changed concurrently`);
  if (next.status !== cur.status)
    await tx
      .insertInto("checkout_session_transitions")
      .values({
        id: uuidv7(),
        checkout_session_id: cur.id,
        from_state: cur.status,
        to_state: next.status,
        cause: meta.cause.slice(0, 500),
        actor: meta.actor,
        evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
      })
      .execute();
  return next;
}

export async function updateAttempt(
  tx: Tx,
  cur: AttemptRow,
  patch: Updateable<PaymentAttemptsTable>,
  meta: Meta,
): Promise<AttemptRow> {
  const next = await tx
    .updateTable("payment_attempts")
    .set({ ...patch, version: cur.version + 1, updated_at: new Date() })
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!next) throw new Error(`payment attempt ${cur.id} changed concurrently`);
  if (next.status !== cur.status) await attemptTransition(tx, cur.id, cur.status, next.status, meta);
  return next;
}

export async function attemptTransition(
  tx: Tx,
  id: string,
  from: string | null,
  to: string,
  meta: Meta,
): Promise<void> {
  await tx
    .insertInto("payment_attempt_transitions")
    .values({
      id: uuidv7(),
      payment_attempt_id: id,
      from_state: from,
      to_state: to,
      cause: meta.cause.slice(0, 500),
      actor: meta.actor,
      evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
    })
    .execute();
}

/** Bumps the intent's version/sequence without other changes (one more event, or an embedded attempt change). */
export async function touchIntent(tx: Tx, cur: IntentRow): Promise<IntentRow> {
  return updateIntent(tx, cur, {}, { cause: "touch", actor: "system" });
}

/**
 * Emits the intent's events, newest object each; every event after the first bumps the version so each
 * carries its own. Returns the final row.
 */
export async function emitIntentEvents(
  tx: Tx,
  row: IntentRow,
  subjects: readonly IntentEvent[] | readonly ("evt.payments.payment_intent.created" | IntentEvent)[],
  previous?: Record<string, unknown>,
): Promise<IntentRow> {
  let cur = row;
  for (const [k, subject] of subjects.entries()) {
    if (k > 0) cur = await touchIntent(tx, cur);
    const [attempts, session, refunds] = await Promise.all([
      attemptsOf(tx, cur.id),
      tx.selectFrom("checkout_sessions").select("id").where("payment_intent_id", "=", cur.id).executeTakeFirst(),
      tx.selectFrom("refunds").select(["id", "created_at"]).where("payment_intent_id", "=", cur.id).execute(),
    ]);
    await emit(tx, {
      subject,
      aggregate: { type: "payment_intent", id: fromUuid("pi", cur.id), version: Math.max(1, cur.version) },
      accountId: cur.account_id,
      livemode: cur.livemode,
      data: { object: intentView(cur, attempts, session?.id ?? null, refunds), ...(previous ? { previous } : {}) },
    });
  }
  return cur;
}

export async function emitSessionEvents(
  tx: Tx,
  s: SessionRow,
  i: IntentRow,
  subjects: readonly SessionEvent[],
  previous?: Record<string, unknown>,
): Promise<void> {
  for (const subject of subjects) {
    await emit(tx, {
      subject,
      aggregate: { type: "checkout_session", id: fromUuid("cs", s.id), version: Math.max(1, s.version) },
      accountId: s.account_id,
      livemode: s.livemode,
      data: { object: sessionView(s, i), ...(previous ? { previous } : {}) },
    });
  }
}

/** Hides every visible attempt of an intent ("don't send again"). */
export async function hideAttempts(tx: Tx, intentId: string, except?: string): Promise<void> {
  let q = tx
    .updateTable("payment_attempts")
    .set({ visible: false, updated_at: new Date() })
    .where("payment_intent_id", "=", intentId)
    .where("visible", "=", true);
  if (except) q = q.where("id", "<>", except);
  await q.execute();
}
