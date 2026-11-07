/**
 * Domain-event consumers (lld/payments.md §7), run by `payments-worker`. Each handler records the
 * event in the inbox in the same transaction as its effect (exactly-once effect); payer streams are
 * notified after the commit.
 *
 * | Subject                                         | Effect                                            |
 * |-------------------------------------------------|---------------------------------------------------|
 * | evt.rails.execution.{updated,settled,refunded,  | apply the execution to its attempt (version-checked) and the intent/session (§8.3) |
 * |   failed,held}                                  |                                                   |
 * | evt.identity.account.updated                    | settlement contexts of the account → stale + refresh job |
 * | evt.identity.settlement_destination.*           | that mode's context → stale + refresh job         |
 * | evt.compliance.review.{opened,closed}           | intent `compliance_review` (no state change; the payment stands, INV-1) |
 * | evt.compliance.policy.updated                   | cached geo policy                                 |
 * | evt.sentinel.kill_switch.{engaged,released}     | local kill-switch flag (version-checked): no new live refund legs or relays while engaged |
 *
 * Refund-leg executions (`kind: refund`) arrive on the same rails subjects and are applied to their leg.
 */
import type { Envelope, EventHandler } from "@nearpay-internal/bus";
import { deadLetterSink, enqueueJob, inboxHandler, type Kysely } from "@nearpay-internal/db";
import { isId, toUuid } from "@nearpay-internal/ids";
import { Execution, type Subject } from "@nearpay-internal/spec";
import type { Payments, Tx } from "../app/context.js";
import { applyExecutionEvent } from "../app/executions.js";
import { storePolicy } from "../app/geo.js";
import { storeKillSwitch } from "../app/kill-switch.js";
import { lockIntent, updateIntent } from "../app/ledger.js";
import { markStale } from "../app/settlement-context.js";
import type { DB } from "../infra/db/schema.js";

export const CONTEXT_REFRESH_JOB = "context.refresh";

const RAILS: readonly Subject[] = [
  "evt.rails.execution.updated",
  "evt.rails.execution.settled",
  "evt.rails.execution.refunded",
  "evt.rails.execution.failed",
  "evt.rails.execution.held",
];

const DESTINATION: readonly Subject[] = [
  "evt.identity.settlement_destination.created",
  "evt.identity.settlement_destination.cooling_off",
  "evt.identity.settlement_destination.activated",
  "evt.identity.settlement_destination.disabled",
  "evt.identity.settlement_destination.default_changed",
];

async function contextChanged(tx: Tx, e: Envelope, account: string, livemode: boolean | null): Promise<void> {
  const acct = toUuid(account, "acct");
  await markStale(tx, acct, livemode);
  await enqueueJob(tx, {
    kind: CONTEXT_REFRESH_JOB,
    payload: { account: acct, livemode },
    dedupeKey: `${CONTEXT_REFRESH_JOB}:${e.id}`,
    maxAttempts: 10,
  });
}

/** The intent a compliance review is about (a payment intent, or the intent of a rails execution). */
async function reviewedIntent(tx: Tx, subject: { type: string; id: string }): Promise<string | null> {
  if (subject.type === "payment_intent" && isId("pi", subject.id)) return toUuid(subject.id, "pi");
  if (subject.type === "execution" && isId("ex", subject.id)) {
    const a = await tx
      .selectFrom("payment_attempts")
      .select("payment_intent_id")
      .where("execution_id", "=", subject.id)
      .executeTakeFirst();
    return a?.payment_intent_id ?? null;
  }
  return null;
}

export function paymentsHandlers(p: Payments, db: Kysely<DB> = p.db): Partial<Record<Subject, EventHandler>> {
  const h = (fn: (tx: Tx, e: Envelope) => Promise<void>) => inboxHandler(db, fn);

  /** Applies a rails execution event; the payer stream hears about it after the commit. */
  const rails: EventHandler = async (e) => {
    const touched: string[] = [];
    await inboxHandler(db, async (tx: Tx, env: Envelope) => {
      const parsed = Execution.safeParse(env.data.object);
      if (!parsed.success) throw new Error(`${env.subject} without a valid execution (${env.id})`);
      const out = await applyExecutionEvent(p, tx, parsed.data);
      if (out?.session) touched.push(out.session.id);
    })(e);
    for (const id of touched) await p.notifier.publish(id);
  };

  const handlers: Partial<Record<Subject, EventHandler>> = {};
  for (const s of RAILS) handlers[s] = rails;
  for (const s of DESTINATION)
    handlers[s] = h(async (tx, e) => {
      const d = e.data.object as unknown as { account: string; livemode: boolean };
      await contextChanged(tx, e, d.account, d.livemode);
    });
  handlers["evt.identity.account.updated"] = h(async (tx, e) => {
    const a = e.data.object as unknown as { id: string };
    await contextChanged(tx, e, a.id, null);
  });
  const review = h(async (tx, e) => {
    const r = e.data.object as unknown as {
      id: string;
      subject: { type: string; id: string };
      status: string;
      reason: string;
    };
    const intentId = await reviewedIntent(tx, r.subject);
    if (!intentId) return; // not a payment of ours (agent payments, destinations)
    const i = await lockIntent(tx, intentId);
    if (!i) return;
    await updateIntent(
      tx,
      i,
      { compliance_review: JSON.stringify({ id: r.id, status: r.status, reason: r.reason }) },
      { cause: `compliance review ${r.id} ${r.status}`, actor: "compliance" },
    );
  });
  handlers["evt.compliance.review.opened"] = review;
  handlers["evt.compliance.review.closed"] = review;
  handlers["evt.compliance.policy.updated"] = h(async (tx, e) => {
    const pol = e.data.object as unknown as { version: string; blocked_countries: string[]; blocked_regions: string[] };
    await storePolicy(tx, pol);
  });
  const killSwitch = h(async (tx, e) => {
    const k = e.data.object as unknown as { engaged: boolean; reason: string };
    const applied = await storeKillSwitch(tx, {
      engaged: k.engaged,
      version: e.aggregate.version,
      reason: k.reason ?? null,
    });
    if (applied)
      p.log.warn(
        { engaged: k.engaged, version: e.aggregate.version },
        "kill switch changed: live refund legs and relays follow it",
      );
  });
  handlers["evt.sentinel.kill_switch.engaged"] = killSwitch;
  handlers["evt.sentinel.kill_switch.released"] = killSwitch;
  return handlers;
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:payments");
