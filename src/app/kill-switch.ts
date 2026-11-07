/**
 * Local copy of sentinel's kill switch (lld/payments.md §7, §17 item 16): `evt.sentinel.kill_switch.*`
 * are applied only when newer than the stored version. While engaged, payments prepares no new **live**
 * refund leg and relays no live refund payload (fail closed); legs the merchant already funded keep being
 * tracked and verified (INV-3). Test mode is unaffected; refunds resume on release.
 */
import { ApiError } from "@nearpay-internal/service";
import type { Db, Payments } from "./context.js";

export async function storeKillSwitch(
  db: Db,
  s: { engaged: boolean; version: number; reason: string | null },
): Promise<boolean> {
  const cur = await db.selectFrom("kill_switch").select("version").where("id", "=", 1).forUpdate().executeTakeFirst();
  if (cur && cur.version >= s.version) return false;
  await db
    .insertInto("kill_switch")
    .values({ id: 1, engaged: s.engaged, version: s.version, reason: s.reason, updated_at: new Date() })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({ engaged: s.engaged, version: s.version, reason: s.reason, updated_at: new Date() }),
    )
    .execute();
  return true;
}

export async function killSwitchEngaged(db: Db): Promise<boolean> {
  const row = await db.selectFrom("kill_switch").select("engaged").where("id", "=", 1).executeTakeFirst();
  return row?.engaged === true;
}

/** Live refunds may not start a new leg or relay while the kill switch is engaged (`503 rail_unavailable`). */
export async function assertRefundsAllowed(p: Payments, livemode: boolean): Promise<void> {
  if (!livemode) return;
  if (await killSwitchEngaged(p.db))
    throw new ApiError("rail_unavailable", {
      message: "Live refunds are paused while the NearPay kill switch is engaged; try again after it is released.",
      params: { reason: "kill_switch_engaged" },
    });
}
