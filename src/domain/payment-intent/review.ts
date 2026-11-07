/**
 * Merchant review decisions on a `requires_review` intent (lld/payments.md §5, §17 item 9). Pure.
 *
 * - `accept` only for a short settlement: the evidence shows what settled and the merchant waives the
 *   shortfall. A held verification has no evidence, so accepting it would mark it paid without evidence
 *   (INV-2) → `review_requires_evidence`; it resolves itself when evidence arrives.
 * - `reject`: the intent is not paid. It returns to `requires_payment` while its session is open, else it
 *   expires with the session. A short settlement stops being the intent's settlement: it is refunded
 *   against the attempt's own budget (by default a `review_rejection` refund for the merchant to sign).
 */
import type { IntentEvent, IntentStatus, ReviewReason, SessionEvent, SessionStatus } from "./intent.js";

export type ReviewError = "state_conflict" | "review_requires_evidence";

export interface ReviewOutcome {
  readonly status: IntentStatus;
  /** The session follows: `complete` on accept, `expired` on a reject of a non-open session. */
  readonly session: { readonly status: "complete" | "expired"; readonly late: boolean } | null;
  /** The short-settled attempt stops being the intent's settlement (reject). */
  readonly releaseSettlement: boolean;
  /** Draft refund of the rejected settlement. */
  readonly refund: boolean;
  readonly intentEvents: readonly IntentEvent[];
  readonly sessionEvents: readonly SessionEvent[];
  /** A payment link counts a succeeded payment. */
  readonly countsUse: boolean;
}

export function reviewOutcome(
  intent: { readonly status: IntentStatus; readonly reviewReason: ReviewReason | null; readonly settled: bigint },
  session: SessionStatus | null,
  decision: "accept" | "reject",
  createRefund: boolean | undefined,
): ReviewOutcome | ReviewError {
  if (intent.status !== "requires_review") return "state_conflict";
  if (decision === "accept") {
    if (intent.reviewReason !== "short_settlement") return "review_requires_evidence";
    const sessionCompletes = session === "open" || session === "expiring";
    return {
      status: "succeeded",
      session: sessionCompletes ? { status: "complete", late: session !== "open" } : null,
      releaseSettlement: false,
      refund: false,
      intentEvents: ["evt.payments.payment_intent.succeeded"],
      sessionEvents: sessionCompletes ? ["evt.payments.checkout_session.completed"] : [],
      countsUse: true,
    };
  }
  const short = intent.reviewReason === "short_settlement";
  const open = session === "open";
  const expires = !open && (session === "expiring" || session === null);
  return {
    status: open ? "requires_payment" : "expired",
    session: expires && session !== null ? { status: "expired", late: false } : null,
    releaseSettlement: short,
    refund: short && intent.settled > 0n && createRefund !== false,
    intentEvents: open ? ["evt.payments.payment_intent.payment_failed"] : ["evt.payments.payment_intent.expired"],
    sessionEvents: expires && session !== null ? ["evt.payments.checkout_session.expired"] : [],
    countsUse: false,
  };
}
