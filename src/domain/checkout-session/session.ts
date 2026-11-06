/** CheckoutSession guards (lld/payments.md §5, §8.2). Pure. */
import { type AttemptStatus, IN_FLIGHT } from "../payment-attempt/attempt.js";
import type { IntentStatus, SessionStatus } from "../payment-intent/intent.js";

export type AttemptGuardError = "session_not_open" | "attempt_in_flight" | "too_many_attempts" | "route_too_slow";

export interface AttemptGuardInput {
  readonly session: SessionStatus;
  readonly intent: IntentStatus;
  readonly attempts: readonly AttemptStatus[];
  readonly livemode: boolean;
  readonly liveAttempts: number;
  readonly maxLiveAttempts: number;
  /** Seconds until the session expires. */
  readonly remainingS: number;
  /** The origin chain's minimum deposit window (rails chain profile), seconds. */
  readonly minDeadlineS: number;
  readonly latePayments: boolean;
}

/** May the payer start another attempt? (`null` = yes.) */
export function attemptGuard(i: AttemptGuardInput): AttemptGuardError | null {
  if (i.session !== "open") return "session_not_open";
  if (i.intent !== "requires_payment" && i.intent !== "processing") return "session_not_open";
  if (i.attempts.some((s) => IN_FLIGHT.has(s) || s === "held")) return "attempt_in_flight";
  if (i.livemode && i.liveAttempts >= i.maxLiveAttempts) return "too_many_attempts";
  if (!i.latePayments && i.remainingS < i.minDeadlineS) return "route_too_slow";
  return null;
}

/** Session lifetime: the request, else the account default, within 300 s … 24 h (§6.1). */
export function sessionTtl(requested: number | undefined, accountDefault: number): number {
  const ttl = requested ?? accountDefault;
  return Math.min(86_400, Math.max(300, ttl));
}

/** Embedded sessions need explicit origins; `http://localhost` only in test mode (§8.1, L-PAY-06). */
export function originsProblem(
  uiMode: "hosted" | "embedded",
  origins: readonly string[],
  livemode: boolean,
): string | null {
  if (uiMode === "embedded" && origins.length === 0) return "allowed_origins is required for embedded sessions";
  if (livemode && origins.some((o) => o.startsWith("http://")))
    return "http://localhost origins are allowed in test mode only";
  return null;
}
