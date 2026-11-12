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
 *
 * Periodic read (audit PAYMENTS-1): the api and worker re-read sentinel every {@link RESYNC_MS} even while the
 * state is known ({@link killSwitchSyncTask}), so a missed `released` (or `engaged`) event repairs itself within a
 * minute; the version guard means an older read or event never overrides a newer state. After each read the copy is
 * compared with sentinel's answer: a missed event the read repaired, or a difference it cannot repair (sentinel
 * behind the copy), logs `ALERT kill_switch_copy_diverged`; gauges `nearpay_payments_kill_switch_*` let deploy
 * alert `KillSwitchCopyDiverged`. Refund paths never wait for sentinel while the state is known.
 */
import { ApiError } from "@nearpay-internal/service";
import { compareKillSwitchCopy, DIVERGENCE_FIX, type KillSwitchCopy } from "../domain/kill-switch-copy.js";
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

/** The stored copy with its version (no row = unknown). */
export async function killSwitchCopy(db: Db): Promise<KillSwitchCopy> {
  const row = await db.selectFrom("kill_switch").select(["engaged", "version"]).where("id", "=", 1).executeTakeFirst();
  if (!row) return { known: false, engaged: true, version: 0 };
  return { known: true, engaged: row.engaged, version: Number(row.version) };
}

/** While the state stays unknown, sentinel is asked again at most this often per process. */
export const READ_RETRY_MS = 10_000;
/** While the state is known, sentinel is re-read this often per process (periodic read, audit PAYMENTS-1). */
export const RESYNC_MS = 60_000;
/** A divergence the read cannot repair (or a failing re-read) logs at most this often while it lasts. */
export const DIVERGED_ALERT_EVERY_MS = 5 * 60_000;
/** A read that applies a newer state within this long of sentinel's change is ahead of its event (no ALERT). */
export const EVENT_IN_FLIGHT_MS = 30_000;
const lastRead = new WeakMap<Payments, number>();
const lastResync = new WeakMap<Payments, number>();
interface AlertState {
  cause: string | null;
  loggedAt: number | null;
  failedAt: number | null;
  failures: number;
}
const alertStates = new WeakMap<Payments, AlertState>();
function alertState(p: Payments): AlertState {
  let a = alertStates.get(p);
  if (!a) {
    a = { cause: null, loggedAt: null, failedAt: null, failures: 0 };
    alertStates.set(p, a);
  }
  return a;
}

async function publishCopy(p: Payments): Promise<KillSwitchCopy> {
  const c = await killSwitchCopy(p.db);
  p.metrics.killSwitchCopy({ engaged: !c.known || c.engaged, version: c.known ? c.version : null });
  return c;
}

/** One read of sentinel: stores the answer (version-guarded), compares, logs and exports. Throws on a failed read. */
async function readFromSentinel(p: Payments, sentinel: NonNullable<Payments["sentinel"]>): Promise<void> {
  const before = await killSwitchCopy(p.db);
  const k = await sentinel.killSwitch();
  const version = k.version ?? null;
  const applied = await storeKillSwitch(p.db, { engaged: k.engaged, version: version ?? 0, reason: k.reason ?? null });
  const after = await publishCopy(p);
  const divergence = compareKillSwitchCopy(after, { engaged: k.engaged, version });
  p.metrics.killSwitchSource({ engaged: k.engaged, version, readAtMs: p.now(), diverged: divergence !== null });
  const a = alertState(p);
  if (applied && before.known) {
    const changedAt = Date.parse(k.updated_at ?? "");
    const inFlight = Number.isFinite(changedAt) && p.now() - changedAt < EVENT_IN_FLIGHT_MS;
    const fields = {
      cause: "copy_behind",
      resolved: true,
      from: { engaged: before.engaged, version: before.version },
      to: { engaged: k.engaged, version },
    };
    if (inFlight) p.log.info(fields, "kill switch state applied from sentinel's read ahead of its event");
    else
      p.log.warn(
        fields,
        `ALERT kill_switch_copy_diverged: payments' kill-switch copy was behind sentinel (an evt.sentinel.kill_switch.* event was missed); sentinel's newer state is applied now (live refund legs and relays ${k.engaged ? "paused" : "resumed"}) — check the payments-worker consumer and dead letters`,
      );
  } else if (applied) {
    p.log.warn(
      { engaged: k.engaged, version },
      "kill switch state read from sentinel: live refund legs and relays follow it",
    );
  }
  if (divergence) {
    const due = a.loggedAt === null || p.now() - a.loggedAt >= DIVERGED_ALERT_EVERY_MS;
    if (due || a.cause !== divergence)
      p.log.warn(
        {
          cause: divergence,
          copy: after,
          sentinel: { engaged: k.engaged, version },
          fix: DIVERGENCE_FIX[divergence],
        },
        `ALERT kill_switch_copy_diverged: payments' kill-switch copy differs from sentinel after a read (${divergence}); live refunds follow the copy`,
      );
    if (due || a.cause !== divergence) a.loggedAt = p.now();
    a.cause = divergence;
  } else if (a.cause !== null) {
    p.log.info({ engaged: k.engaged, version }, "kill switch copy agrees with sentinel again");
    a.cause = null;
    a.loggedAt = null;
  }
}

/**
 * Reads sentinel's state and stores it when the stored state is unknown. Never throws: a failed read
 * leaves the state unknown (fail closed). Returns the state afterwards. While the state is known it returns at once;
 * {@link syncKillSwitch} re-reads it periodically.
 */
export async function readKillSwitch(p: Payments, o: { force?: boolean } = {}): Promise<KillSwitchState> {
  const cur = await killSwitchState(p.db);
  if (cur !== "unknown" || !p.sentinel) return cur;
  const last = lastRead.get(p);
  if (!o.force && last !== undefined && p.now() - last < READ_RETRY_MS) return cur;
  lastRead.set(p, p.now());
  try {
    await readFromSentinel(p, p.sentinel);
  } catch (e) {
    p.log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "kill switch state could not be read from sentinel: live refunds stay paused while it is unknown",
    );
  }
  return killSwitchState(p.db);
}

/**
 * Periodic read (audit PAYMENTS-1): re-reads sentinel at most every {@link RESYNC_MS} (unless `force`) even while
 * the state is known, stores a newer answer (never an older one) and reports a divergence. While unknown it is
 * {@link readKillSwitch}. Never throws; a failed re-read keeps the known state and logs a rate-limited warning.
 */
export async function syncKillSwitch(p: Payments, o: { force?: boolean } = {}): Promise<KillSwitchState> {
  const cur = await killSwitchState(p.db);
  if (cur === "unknown" || !p.sentinel) {
    const st = await readKillSwitch(p, o);
    await publishCopy(p);
    return st;
  }
  const last = lastResync.get(p);
  if (!o.force && last !== undefined && p.now() - last < RESYNC_MS) {
    await publishCopy(p);
    return cur;
  }
  lastResync.set(p, p.now());
  const a = alertState(p);
  try {
    await readFromSentinel(p, p.sentinel);
    if (a.failures > 0) {
      p.log.info({ failed_reads: a.failures }, "kill switch re-read from sentinel works again");
      a.failures = 0;
      a.failedAt = null;
    }
  } catch (e) {
    await publishCopy(p);
    a.failures++;
    if (a.failedAt === null || p.now() - a.failedAt >= DIVERGED_ALERT_EVERY_MS) {
      a.failedAt = p.now();
      p.log.warn(
        { err: e instanceof Error ? e.message : String(e), failed_reads: a.failures, state: cur },
        "kill switch could not be re-read from sentinel: payments keeps its copy and retries (a missed event cannot be repaired until sentinel answers)",
      );
    }
  }
  return killSwitchState(p.db);
}

/**
 * Background task (api and worker): retries every {@link READ_RETRY_MS} while the state is unknown, then re-reads
 * every {@link RESYNC_MS} (periodic read) and refreshes the copy's gauges. The boot read itself is
 * {@link syncKillSwitchAtBoot}.
 */
export function killSwitchSyncTask(p: Payments, o: { tickMs?: number } = {}) {
  return {
    name: "kill-switch-sync",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      const tick = async () => {
        if (stopped) return;
        await syncKillSwitch(p).catch(() => "unknown" as const);
        if (!stopped) timer = setTimeout(tick, o.tickMs ?? READ_RETRY_MS);
      };
      timer = setTimeout(tick, o.tickMs ?? READ_RETRY_MS);
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
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
