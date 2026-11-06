/**
 * Jobs (lld/payments.md §9), run by `payments-worker` (leases, backoff, dead letters):
 *
 * | kind                     | when                                    | what                               |
 * |--------------------------|-----------------------------------------|------------------------------------|
 * | session.expire           | at the session's `expires_at`           | open → expiring / expired (INV-3)  |
 * | attempt.quoting_recovery | every 15 s                              | re-ask rails for attempts stuck in `quoting` > 20 s; fail after 2 min |
 * | context.refresh          | on identity events; sweep every 5 min   | refresh settlement contexts (backstop to events) |
 * | kit.purge                | hourly                                  | published outbox, old inbox, expired idempotency keys |
 */
import { type JobHandler, purgeKitTables, type RecurringJob } from "@nearpay-internal/db";
import { QUOTING_RECOVER_AFTER_MS, recoverQuoting } from "../app/attempts.js";
import type { Payments } from "../app/context.js";
import { expireAtDeadline, SESSION_EXPIRE_JOB } from "../app/sessions.js";
import { refreshContext } from "../app/settlement-context.js";
import { CONTEXT_REFRESH_JOB } from "../consumers/handlers.js";

export const QUOTING_RECOVERY_JOB = "attempt.quoting_recovery";
export const CONTEXT_SWEEP_JOB = "context.sweep";

const HOUR = 3_600_000;
/** Contexts of accounts with open sessions are re-read at least this often (§9). */
const CONTEXT_MAX_AGE_MS = 5 * 60_000;

export const RECURRING: readonly RecurringJob[] = [
  { kind: QUOTING_RECOVERY_JOB, everyMs: 15_000 },
  { kind: CONTEXT_SWEEP_JOB, everyMs: 5 * 60_000 },
  { kind: "kit.purge", everyMs: HOUR },
];

async function notify(p: Payments, ids: readonly (string | null)[]): Promise<void> {
  for (const id of new Set(ids)) if (id) await p.notifier.publish(id);
}

export function jobHandlers(p: Payments): Record<string, JobHandler> {
  return {
    [SESSION_EXPIRE_JOB]: async (payload) => {
      const session = (payload as { session?: unknown } | null)?.session;
      if (typeof session !== "string") throw new Error("session.expire payload without a session");
      await notify(p, [await expireAtDeadline(p, session)]);
    },

    [QUOTING_RECOVERY_JOB]: async () => {
      const stuck = await p.db
        .selectFrom("payment_attempts")
        .select("id")
        .where("status", "=", "quoting")
        .where("created_at", "<", new Date(p.now() - QUOTING_RECOVER_AFTER_MS))
        .orderBy("created_at", "asc")
        .limit(50)
        .execute();
      const touched: (string | null)[] = [];
      for (const a of stuck) {
        try {
          touched.push(await recoverQuoting(p, a.id));
        } catch (e) {
          p.log.warn({ attempt: a.id, err: e instanceof Error ? e.message : String(e) }, "quoting recovery failed");
        }
      }
      await notify(p, touched);
    },

    [CONTEXT_REFRESH_JOB]: async (payload) => {
      const o = payload as { account?: unknown; livemode?: unknown } | null;
      if (typeof o?.account !== "string") throw new Error("context.refresh payload without an account");
      const modes = typeof o.livemode === "boolean" ? [o.livemode] : [false, true];
      for (const lm of modes) await refreshContext(p, o.account, lm);
    },

    [CONTEXT_SWEEP_JOB]: async () => {
      // stale contexts, and contexts of accounts that are taking payments, older than 5 minutes
      const rows = await p.db
        .selectFrom("settlement_contexts as c")
        .select(["c.account_id", "c.livemode"])
        .where((eb) =>
          eb.or([
            eb("c.stale", "=", true),
            eb.and([
              eb("c.refreshed_at", "<", new Date(p.now() - CONTEXT_MAX_AGE_MS)),
              eb.exists(
                eb
                  .selectFrom("checkout_sessions as s")
                  .select("s.id")
                  .whereRef("s.account_id", "=", "c.account_id")
                  .whereRef("s.livemode", "=", "c.livemode")
                  .where("s.status", "in", ["open", "expiring"]),
              ),
            ]),
          ]),
        )
        .limit(200)
        .execute();
      for (const r of rows) {
        try {
          await refreshContext(p, r.account_id, r.livemode);
        } catch (e) {
          p.log.warn(
            { account: r.account_id, err: e instanceof Error ? e.message : String(e) },
            "context refresh failed",
          );
        }
      }
    },

    "kit.purge": async () => {
      p.log.info(await purgeKitTables(p.db), "kit tables purged");
    },
  };
}
