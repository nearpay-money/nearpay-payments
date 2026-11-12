/**
 * Payments' copy of sentinel's kill switch compared with what sentinel answered (pure; lld/payments.md §7 "periodic
 * read"). The copy (`kill_switch` row, `version`) only ever moves forward in version: a read or event older than the
 * stored version never replaces it. After each read of sentinel the copy is compared with the answer; a difference
 * the read could not repair is reported (`ALERT kill_switch_copy_diverged`, gauge
 * `nearpay_payments_kill_switch_diverged`).
 */

export interface KillSwitchCopy {
  /** False until a sentinel state was stored (read or event); an unknown copy pauses live refunds. */
  readonly known: boolean;
  readonly engaged: boolean;
  /** Sentinel version the copy came from (`kill_switch.version`). */
  readonly version: number;
}

export interface KillSwitchSource {
  readonly engaged: boolean;
  /** Envelope `aggregate.version` of sentinel's latest kill-switch event; null when sentinel sent none (0.2.0). */
  readonly version: number | null;
}

/**
 * - `copy_unknown`: no state stored although sentinel answered (the store did not apply);
 * - `sentinel_behind`: sentinel answered an older version than the copy holds (sentinel's database restored or
 *   reset) — the copy never goes backwards, an operator must look;
 * - `copy_behind`: sentinel is newer but the store did not apply (a concurrent writer; repairs at the next read);
 * - `value_overridden`: same version, different state (a hand-edited row); the next newer sentinel state replaces it.
 */
export type KillSwitchDivergence = "copy_unknown" | "sentinel_behind" | "copy_behind" | "value_overridden";

/** Null when the copy agrees with sentinel's answer. An unversioned answer is compared by state only. */
export function compareKillSwitchCopy(copy: KillSwitchCopy, source: KillSwitchSource): KillSwitchDivergence | null {
  if (!copy.known) return "copy_unknown";
  if (source.version !== null) {
    if (copy.version > source.version) return "sentinel_behind";
    if (copy.version < source.version) return "copy_behind";
  }
  return copy.engaged === source.engaged ? null : "value_overridden";
}

/** What an operator should check for each divergence (log line). */
export const DIVERGENCE_FIX: Readonly<Record<KillSwitchDivergence, string>> = {
  copy_unknown: "payments could not store sentinel's answer: check payments logs and the database",
  sentinel_behind:
    "sentinel reports an older kill-switch version than payments holds (sentinel database restored or reset?): compare `ops sentinel kill-switch` with the payments kill_switch row; payments never moves back to an older version",
  copy_behind: "a concurrent write raced the read: payments repairs it at the next read (60 s)",
  value_overridden:
    "the payments kill_switch row was changed by hand at the same version; the next sentinel change replaces it",
};
