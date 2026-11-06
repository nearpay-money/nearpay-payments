/**
 * Applying rails executions to attempts (lld/payments.md §8.3): from `evt.rails.execution.*`, from the
 * create response and from the quoting-recovery job. Only a newer execution version is applied;
 * payments never infers provider state.
 */
import type { Updateable } from "@nearpay-internal/db";
import type { Execution } from "@nearpay-internal/spec";
import { isNewer, statusOfExecution } from "../domain/payment-attempt/attempt.js";
import type { PaymentAttemptsTable } from "../infra/db/schema.js";
import { type Applied, applyAttemptChange } from "./apply.js";
import type { Payments, Tx } from "./context.js";
import { attemptsOf, lockIntent, lockSessionOfIntent, updateAttempt } from "./ledger.js";
import type { AttemptRow } from "./views.js";

/** Attempt columns an execution determines. */
export function attemptPatch(x: Execution): Updateable<PaymentAttemptsTable> {
  return {
    status: statusOfExecution(x.state),
    execution_id: x.id,
    execution_version: x.version,
    applied_fee_bps: x.applied_fee_bps,
    route_class: x.route_class,
    settlement_amount: x.settlement.expected,
    amount_tag: x.settlement.tag,
    price_snapshot: x.price_snapshot ? JSON.stringify(x.price_snapshot) : null,
    deposit: x.deposit
      ? JSON.stringify({
          address: x.deposit.address,
          memo: x.deposit.memo,
          amount_in: x.deposit.amount_in,
          min_amount_in: x.deposit.min_amount_in,
          deadline: x.deposit.deadline,
          chain: x.deposit.chain,
        })
      : null,
    intents_requirement: x.intents_requirement ? JSON.stringify(x.intents_requirement) : null,
    deadline: new Date(x.deadline),
    settled_amount: x.settled_amount,
    refunded_amount: x.refunded_amount,
    evidence: x.evidence ? JSON.stringify(x.evidence) : null,
    failure_code: x.failure_code ?? x.held_reason ?? x.refund_reason ?? null,
  };
}

/**
 * Applies `x` to `attempt` (locked with its intent and session in the order intent → session →
 * attempts, the order every writer uses). Returns null when the version is not newer.
 */
export async function applyExecutionToAttempt(
  p: Payments,
  tx: Tx,
  attemptId: string,
  x: Execution,
  actor: string,
): Promise<Applied | null> {
  const head = await tx
    .selectFrom("payment_attempts")
    .select(["payment_intent_id"])
    .where("id", "=", attemptId)
    .executeTakeFirst();
  if (!head) return null;
  const intent = await lockIntent(tx, head.payment_intent_id);
  if (!intent) return null;
  const session = (await lockSessionOfIntent(tx, intent.id)) ?? null;
  const attempts = await attemptsOf(tx, intent.id, true);
  const before = attempts.find((a) => a.id === attemptId) as AttemptRow;
  if (!isNewer(x.version, before.execution_version)) return null;
  const after = await updateAttempt(tx, before, attemptPatch(x), {
    cause: `execution ${x.id} v${x.version}: ${x.state}${x.provider_status ? ` (${x.provider_status})` : ""}`,
    actor,
  });
  return applyAttemptChange(
    p,
    tx,
    { intent, session, before, after, others: attempts.filter((a) => a.id !== attemptId) },
    { cause: `execution ${x.id} ${x.state}`, actor },
  );
}

/** How long an unknown execution may be ours before it is ignored (the create response may still be in flight). */
export const UNKNOWN_GRACE_MS = 2 * 60_000;

/** Consumer path: the attempt is found by execution id; unknown recent executions are retried. */
export async function applyExecutionEvent(p: Payments, tx: Tx, x: Execution): Promise<Applied | null> {
  if (x.kind !== "payment") return null; // refunds arrive in Stage 2
  const row = await tx.selectFrom("payment_attempts").select("id").where("execution_id", "=", x.id).executeTakeFirst();
  if (!row) {
    if (p.now() - Date.parse(x.created_at) < UNKNOWN_GRACE_MS)
      throw new Error(`execution ${x.id} is not linked to an attempt yet (create response in flight)`);
    p.log.warn({ execution: x.id, account: x.account_id }, "execution of no payment attempt ignored");
    return null;
  }
  return applyExecutionToAttempt(p, tx, row.id, x, "rails");
}
