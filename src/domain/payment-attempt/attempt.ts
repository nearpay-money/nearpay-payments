/**
 * PaymentAttempt (lld/payments.md §5, domain-model §4.3): it mirrors the rails execution and never
 * infers provider state. Pure.
 */

export const ATTEMPT_STATUSES = [
  "quoting",
  "awaiting_deposit",
  "deposit_detected",
  "incomplete_deposit",
  "settling",
  "verifying",
  "succeeded",
  "refunded",
  "failed",
  "expired_unpaid",
  "held",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Nothing more can happen to the payer's money through this attempt (payments' view). */
export const TERMINAL: ReadonlySet<AttemptStatus> = new Set(["succeeded", "refunded", "failed", "expired_unpaid"]);

/** A deposit was seen and the outcome is still open (blocks new attempts, cancel and expire). */
export const IN_FLIGHT: ReadonlySet<AttemptStatus> = new Set([
  "deposit_detected",
  "incomplete_deposit",
  "settling",
  "verifying",
]);

/** Deposit instructions are live: the payer may still send (and checkout may ask sentinel). */
export const INSTRUCTIONS_LIVE: ReadonlySet<AttemptStatus> = new Set([
  "awaiting_deposit",
  "deposit_detected",
  "incomplete_deposit",
  "settling",
]);

export function isAttemptStatus(s: string): s is AttemptStatus {
  return (ATTEMPT_STATUSES as readonly string[]).includes(s);
}

/**
 * The attempt status for an execution state. Rails' states are the attempt's states; anything
 * unknown is held (never assumed terminal, domain-model §4.3).
 */
export function statusOfExecution(state: string): AttemptStatus {
  return isAttemptStatus(state) ? state : "held";
}

/** An execution event applies only when it is newer than what the attempt already reflects. */
export function isNewer(eventVersion: number, appliedVersion: number): boolean {
  return eventVersion > appliedVersion;
}
