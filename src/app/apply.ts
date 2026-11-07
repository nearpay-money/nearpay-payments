/**
 * Applies an attempt change to its intent and session (lld/payments.md §5, §8.3) inside the caller's
 * transaction: intent and session transitions, the overpayment flag, the statement line (once per
 * attempt and type, `bt_once`) and the outbox events. The caller has locked intent, session and attempt.
 */
import { uuidv7 } from "@nearpay-internal/ids";
import { type AttemptStatus, isAttemptStatus } from "../domain/payment-attempt/attempt.js";
import { type Decision, onAttemptChange, type SessionStatus } from "../domain/payment-intent/intent.js";
import { statementLine } from "../domain/statement/statement.js";
import type { Payments, Tx } from "./context.js";
import {
  emitIntentEvents,
  emitSessionEvents,
  type Meta,
  touchIntent,
  updateAttempt,
  updateIntent,
  updateSession,
} from "./ledger.js";
import type { AttemptRow, IntentRow, SessionRow } from "./views.js";

export interface Applied {
  readonly intent: IntentRow;
  readonly session: SessionRow | null;
  readonly attempt: AttemptRow;
  readonly decision: Decision;
}

const status = (s: string): AttemptStatus => (isAttemptStatus(s) ? s : "held");

/** `uses += 1` on the intent's payment link (a succeeded payment). */
export async function countLinkUse(tx: Tx, linkId: string): Promise<void> {
  await tx
    .updateTable("payment_links")
    .set((eb) => ({ uses: eb("uses", "+", 1), version: eb("version", "+", 1), updated_at: new Date() }))
    .where("id", "=", linkId)
    .execute();
}

export async function applyAttemptChange(
  p: Payments,
  tx: Tx,
  o: {
    intent: IntentRow;
    session: SessionRow | null;
    before: AttemptRow;
    after: AttemptRow;
    others: readonly AttemptRow[];
    /** The execution behind the change, when there is one (statement lines record its terminal time). */
    terminalAt?: string | null;
  },
  meta: Meta,
): Promise<Applied> {
  let { intent, session, after: attempt } = o;
  const decision = onAttemptChange(
    {
      status: intent.status,
      reviewReason: intent.review_reason,
      succeededAttemptId: intent.succeeded_attempt_id,
      underpayToleranceBps: intent.settings_snapshot.underpay_tolerance_bps,
    },
    (session?.status ?? "open") as SessionStatus,
    {
      id: attempt.id,
      from: status(o.before.status),
      to: status(attempt.status),
      expected: attempt.settlement_amount === null ? null : BigInt(attempt.settlement_amount),
      settled: attempt.settled_amount === null ? null : BigInt(attempt.settled_amount),
    },
    o.others.map((a) => status(a.status)),
  );

  if (decision.overpayment) {
    attempt = await updateAttempt(
      tx,
      attempt,
      { is_overpayment: true, overpayment_reason: decision.overpayment },
      meta,
    );
    p.metrics.overpayment(decision.overpayment);
  }

  const now = new Date(p.now());
  const previous = { status: intent.status };
  if (decision.intent) {
    const d = decision.intent;
    intent = await updateIntent(
      tx,
      intent,
      {
        status: d.status,
        review_reason: d.reviewReason,
        ...(d.succeededAttemptId ? { succeeded_attempt_id: d.succeededAttemptId } : {}),
        ...(d.amountSettled !== undefined ? { amount_settled: d.amountSettled } : {}),
        ...(d.succeeded ? { succeeded_at: now } : {}),
        ...(d.late !== undefined ? { late: d.late } : {}),
      },
      { ...meta, cause: decision.cause },
    );
    if (d.status === "requires_review" && d.reviewReason) p.metrics.review(d.reviewReason);
  } else {
    // the intent embeds its attempts: any applied attempt change is a change of the intent
    intent = await touchIntent(tx, intent);
  }

  if (decision.session && session) {
    session = await updateSession(
      tx,
      session,
      decision.session.status === "complete"
        ? { status: "complete", completed_at: now, late: decision.session.late }
        : { status: "expired" },
      { ...meta, cause: decision.cause },
    );
  }

  if (decision.statement) {
    const line = statementLine({
      type: decision.statement,
      intent: {
        currency: intent.currency,
        amount: intent.amount === null ? null : BigInt(intent.amount),
        settlementAssetId: intent.settlement_asset_id,
        settlementDecimals: intent.settlement_decimals,
        settlementSymbol: intent.settlement_symbol,
      },
      attempt: {
        method: attempt.method,
        settled: BigInt(attempt.settled_amount ?? "0"),
        appliedFeeBps: attempt.applied_fee_bps,
        originAssetId: attempt.origin_asset_id,
        amountIn: attempt.deposit ? BigInt(attempt.deposit.amount_in) : null,
        requirementFee: attempt.intents_requirement ? BigInt(attempt.intents_requirement.fee_amount) : null,
      },
    });
    await tx
      .insertInto("balance_transactions")
      .values({
        id: uuidv7(),
        account_id: intent.account_id,
        livemode: intent.livemode,
        type: line.type,
        payment_intent_id: intent.id,
        payment_attempt_id: attempt.id,
        gross_amount: line.grossAmount,
        gross_currency: line.grossCurrency,
        settled_amount: line.settledAmount,
        settlement_asset_id: line.settlementAssetId,
        settlement_decimals: line.settlementDecimals,
        settlement_symbol: line.settlementSymbol,
        fee_bps: line.feeBps,
        fee_amount_est: line.feeAmountEst,
        fee_asset_id: line.feeAssetId,
        evidence: JSON.stringify(attempt.evidence ?? {}),
        execution_id: attempt.execution_id,
        terminal_at: o.terminalAt ? new Date(o.terminalAt) : null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  // a payment link counts succeeded payments (§17 item 11)
  if (decision.intent?.succeeded && intent.payment_link_id) await countLinkUse(tx, intent.payment_link_id);

  if (decision.intentEvents.length) intent = await emitIntentEvents(tx, intent, decision.intentEvents, previous);
  if (session && decision.sessionEvents.length) await emitSessionEvents(tx, session, intent, decision.sessionEvents);
  if (decision.intentEvents.includes("evt.payments.payment_intent.succeeded")) {
    p.metrics.timeToSuccess(attempt.route_class ?? "unknown", (p.now() - attempt.created_at.getTime()) / 1000);
  }
  return { intent, session, attempt, decision };
}
