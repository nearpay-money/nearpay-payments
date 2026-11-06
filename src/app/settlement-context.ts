/**
 * Settlement context (lld/payments.md §8.1, §9 `context.refresh`): a read model of identity's account,
 * fee schedule and active destinations per mode. Fresh for 5 minutes; identity events mark it stale;
 * a stale or old context is refreshed synchronously (1 s). When identity is unreachable a context up
 * to 1 hour old is used — never one an identity event has marked stale (a destination may have been
 * disabled).
 */
import { fromUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { SettlementContext } from "@nearpay-internal/spec";
import type { Db, Payments } from "./context.js";

export type Context = SettlementContext;

const FRESH_MS = 5 * 60_000;
const USABLE_MS = 60 * 60_000;

export async function refreshContext(
  p: Payments,
  accountUuid: string,
  livemode: boolean,
  db: Db = p.db,
): Promise<Context> {
  const ctx = await p.identity.settlementContext(fromUuid("acct", accountUuid), livemode);
  await db
    .insertInto("settlement_contexts")
    .values({
      account_id: accountUuid,
      livemode,
      context: JSON.stringify(ctx),
      context_version: ctx.context_version,
      refreshed_at: new Date(p.now()),
      stale: false,
    })
    .onConflict((oc) =>
      oc.columns(["account_id", "livemode"]).doUpdateSet({
        context: JSON.stringify(ctx),
        context_version: ctx.context_version,
        refreshed_at: new Date(p.now()),
        stale: false,
      }),
    )
    .execute();
  return ctx;
}

export async function settlementContext(p: Payments, accountUuid: string, livemode: boolean): Promise<Context> {
  const row = await p.db
    .selectFrom("settlement_contexts")
    .selectAll()
    .where("account_id", "=", accountUuid)
    .where("livemode", "=", livemode)
    .executeTakeFirst();
  const age = row ? p.now() - row.refreshed_at.getTime() : Number.POSITIVE_INFINITY;
  if (row && !row.stale && age < FRESH_MS) return SettlementContext.parse(row.context);
  try {
    return await refreshContext(p, accountUuid, livemode);
  } catch (e) {
    if (row && !row.stale && age < USABLE_MS) {
      p.log.warn(
        { err: e instanceof Error ? e.message : String(e), account: accountUuid },
        "identity unreachable: using the cached settlement context",
      );
      return SettlementContext.parse(row.context);
    }
    p.log.error(
      { err: e instanceof Error ? e.message : String(e), account: accountUuid },
      "settlement context unavailable",
    );
    throw new ApiError("rail_unavailable", { params: { reason: "settlement context unavailable" } });
  }
}

/** Marks the context stale (an identity event changed it) inside the consumer's transaction. */
export async function markStale(db: Db, accountUuid: string, livemode: boolean | null): Promise<void> {
  let q = db.updateTable("settlement_contexts").set({ stale: true }).where("account_id", "=", accountUuid);
  if (livemode !== null) q = q.where("livemode", "=", livemode);
  await q.execute();
}
