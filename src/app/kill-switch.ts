/**
 * Local copy of sentinel's kill switch (lld/payments.md §7, §17 item 16): `evt.sentinel.kill_switch.*`
 * are applied only when newer than the stored version. While engaged, payments prepares no new **live**
 * refund leg and relays no live refund payload (fail closed); legs the merchant already funded keep being
 * tracked and verified (INV-3). Test mode is unaffected; refunds resume on release. Until a state was
 * ever stored the switch counts as engaged for live refunds (fail closed, audit finding 8).
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

/**
 * Engaged, released, or `unknown` when no sentinel state was ever stored (fresh database, or the last
 * event aged out of the stream before this consumer existed). Sentinel 0.2.0 has no service route to read
 * the state (`getOpsKillSwitch` is ops-only), so it becomes known with the next
 * `evt.sentinel.kill_switch.*` (the consumer replays the stream from its start).
 */
export type KillSwitchState = "engaged" | "released" | "unknown";

export async function killSwitchState(db: Db): Promise<KillSwitchState> {
  const row = await db.selectFrom("kill_switch").select("engaged").where("id", "=", 1).executeTakeFirst();
  if (!row) return "unknown";
  return row.engaged ? "engaged" : "released";
}

/** Fail closed (finding 8): an unknown state counts as engaged for live refunds. */
export async function killSwitchEngaged(db: Db): Promise<boolean> {
  return (await killSwitchState(db)) !== "released";
}

/** At boot: says when live refunds are paused because sentinel's state is not known yet. */
export async function reportKillSwitchAtBoot(p: Pick<Payments, "db" | "log">): Promise<KillSwitchState> {
  const s = await killSwitchState(p.db);
  if (s === "unknown")
    p.log.warn(
      "kill switch state unknown (no evt.sentinel.kill_switch.* applied yet): live refund legs and relays stay paused until sentinel's state arrives",
    );
  else if (s === "engaged") p.log.warn("kill switch engaged: live refund legs and relays are paused");
  return s;
}

/** Live refunds may not start a new leg or relay while the kill switch is engaged or unknown (`503 rail_unavailable`). */
export async function assertRefundsAllowed(p: Payments, livemode: boolean): Promise<void> {
  if (!livemode) return;
  const s = await killSwitchState(p.db);
  if (s === "released") return;
  throw new ApiError("rail_unavailable", {
    message:
      s === "engaged"
        ? "Live refunds are paused while the NearPay kill switch is engaged; try again after it is released."
        : "Live refunds are paused until the NearPay kill switch state is known; try again shortly.",
    params: { reason: s === "engaged" ? "kill_switch_engaged" : "kill_switch_unknown" },
  });
}
