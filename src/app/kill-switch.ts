/**
 * Local copy of sentinel's kill switch (lld/payments.md §7, §17 item 16, §"Spec 0.2.1 contract changes"):
 * `evt.sentinel.kill_switch.*` are applied only when newer than the stored version. While engaged, payments
 * prepares no new **live** refund leg and relays no live refund payload (fail closed); legs the merchant
 * already funded keep being tracked and verified (INV-3). Test mode is unaffected; refunds resume on release.
 * Until a state was ever stored the switch counts as engaged for live refunds (fail closed, audit finding 8).
 *
 * Spec 0.2.1: when the stored state is unknown, payments reads sentinel `getKillSwitch` (at boot, and at most
 * every {@link READ_RETRY_MS} while it stays unknown) and stores it with its `version` (the envelope
 * `aggregate.version` of sentinel's latest event), so only later events win. A response without `version`
 * (sentinel 0.2.0) is stored as version 0: any event then replaces it.
 */
import { ApiError } from "@nearpay-internal/service";
import type { Db, Payments } from "./context.js";

/** Stores a state when it is newer than the stored one (conditional upsert: concurrent writers cannot regress it). */
export async function storeKillSwitch(
  db: Db,
  s: { engaged: boolean; version: number; reason: string | null },
): Promise<boolean> {
  const now = new Date();
  const r = await db
    .insertInto("kill_switch")
    .values({ id: 1, engaged: s.engaged, version: s.version, reason: s.reason, updated_at: now })
    .onConflict((oc) =>
      oc
        .column("id")
        .doUpdateSet({ engaged: s.engaged, version: s.version, reason: s.reason, updated_at: now })
        .where("kill_switch.version", "<", s.version),
    )
    .executeTakeFirst();
  return Number(r.numInsertedOrUpdatedRows ?? 0n) === 1;
}

/** Engaged, released, or `unknown` when no sentinel state was ever stored. */
export type KillSwitchState = "engaged" | "released" | "unknown";

export async function killSwitchState(db: Db): Promise<KillSwitchState> {
  const row = await db.selectFrom("kill_switch").select("engaged").where("id", "=", 1).executeTakeFirst();
  if (!row) return "unknown";
  return row.engaged ? "engaged" : "released";
}

/** While the state stays unknown, sentinel is asked again at most this often per process. */
export const READ_RETRY_MS = 10_000;
const lastRead = new WeakMap<Payments, number>();

/**
 * Reads sentinel's state and stores it when the stored state is unknown. Never throws: a failed read
 * leaves the state unknown (fail closed). Returns the state afterwards.
 */
export async function readKillSwitch(p: Payments, o: { force?: boolean } = {}): Promise<KillSwitchState> {
  const cur = await killSwitchState(p.db);
  if (cur !== "unknown" || !p.sentinel) return cur;
  const last = lastRead.get(p);
  if (!o.force && last !== undefined && p.now() - last < READ_RETRY_MS) return cur;
  lastRead.set(p, p.now());
  try {
    const k = await p.sentinel.killSwitch();
    const applied = await storeKillSwitch(p.db, {
      engaged: k.engaged,
      version: k.version ?? 0,
      reason: k.reason ?? null,
    });
    if (applied)
      p.log.warn(
        { engaged: k.engaged, version: k.version ?? null },
        "kill switch state read from sentinel: live refund legs and relays follow it",
      );
  } catch (e) {
    p.log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "kill switch state could not be read from sentinel: live refunds stay paused while it is unknown",
    );
  }
  return killSwitchState(p.db);
}

/** At boot: reads sentinel's state when the stored one is unknown and says when live refunds are paused. */
export async function syncKillSwitchAtBoot(p: Payments): Promise<KillSwitchState> {
  try {
    const s = await readKillSwitch(p, { force: true });
    if (s === "unknown")
      p.log.warn(
        "kill switch state unknown (sentinel not read, no evt.sentinel.kill_switch.* applied yet): live refund legs and relays stay paused until it is known",
      );
    else if (s === "engaged") p.log.warn("kill switch engaged: live refund legs and relays are paused");
    return s;
  } catch (e) {
    p.log.warn({ err: e instanceof Error ? e.message : String(e) }, "kill switch state not read at boot");
    return "unknown";
  }
}

/** Fail closed (finding 8): an unknown state counts as engaged for live refunds. */
export async function killSwitchEngaged(p: Payments): Promise<boolean> {
  return (await readKillSwitch(p)) !== "released";
}

/** Live refunds may not start a new leg or relay while the kill switch is engaged or unknown (`503 rail_unavailable`). */
export async function assertRefundsAllowed(p: Payments, livemode: boolean): Promise<void> {
  if (!livemode) return;
  const s = await readKillSwitch(p);
  if (s === "released") return;
  throw new ApiError("rail_unavailable", {
    message:
      s === "engaged"
        ? "Live refunds are paused while the NearPay kill switch is engaged; try again after it is released."
        : "Live refunds are paused until the NearPay kill switch state is known; try again shortly.",
    params: { reason: s === "engaged" ? "kill_switch_engaged" : "kill_switch_unknown" },
  });
}
