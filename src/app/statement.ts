/**
 * The statement (domain-model §6, lld/payments.md §6.1): `GET /v1/balance_transactions`. NearPay
 * holds no balances; each line records what settled where, with its evidence.
 */
import { toUuid } from "@nearpay-internal/ids";
import type { Payments } from "./context.js";
import { type PageQuery, pageOf } from "./pages.js";
import type { Merchant } from "./sessions.js";
import { type LineRow, lineView } from "./views.js";

export interface LineQuery extends PageQuery {
  readonly payment_intent?: string | undefined;
  readonly type?: string | undefined;
  /** Stage 2: lines of one refund. */
  readonly refund?: string | undefined;
}

export async function listLines(p: Payments, m: Merchant, q: LineQuery) {
  let base = p.db
    .selectFrom("balance_transactions")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.payment_intent) base = base.where("payment_intent_id", "=", toUuid(q.payment_intent, "pi"));
  if (q.type) base = base.where("type", "=", q.type as LineRow["type"]);
  if (q.refund) base = base.where("refund_id", "=", toUuid(q.refund, "re"));
  const page = await pageOf(base, q, "txn");
  return {
    object: "list" as const,
    data: page.rows.map(lineView),
    has_more: page.hasMore,
    url: "/v1/balance_transactions",
  };
}
