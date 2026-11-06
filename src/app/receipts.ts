/**
 * `GET /internal/payment_intents/{id}/receipt-context` (notify, `payments.receipts.read`; §6.3): what a
 * receipt email needs, including the customer email (PII: decrypted here, never put in events).
 */
import { toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Payments } from "./context.js";
import { merchantName } from "./payer.js";
import { settlementContext } from "./settlement-context.js";
import { pricingOf, settlementValue } from "./views.js";

export async function receiptContext(p: Payments, id: string) {
  const i = await p.db.selectFrom("payment_intents").selectAll().where("id", "=", toUuid(id, "pi")).executeTakeFirst();
  if (!i) throw ApiError.missing("payment_intent", id);
  const [s, paid, ctx] = await Promise.all([
    p.db
      .selectFrom("checkout_sessions")
      .select(["id", "customer_email_enc"])
      .where("payment_intent_id", "=", i.id)
      .executeTakeFirst(),
    i.succeeded_attempt_id
      ? p.db
          .selectFrom("payment_attempts")
          .select("evidence")
          .where("id", "=", i.succeeded_attempt_id)
          .executeTakeFirst()
      : undefined,
    settlementContext(p, i.account_id, i.livemode),
  ]);
  const email = s?.customer_email_enc ? p.cipher.decrypt(s.customer_email_enc, `cs:${s.id}`).toString("utf8") : null;
  const url = (paid?.evidence as { explorer_url?: string | null } | null)?.explorer_url ?? null;
  const pricing = pricingOf(i);
  return {
    customer_email: email,
    merchant_display_name: await merchantName(p, i.account_id, i.livemode),
    amount: pricing.amount,
    currency: pricing.currency,
    settled: settlementValue(
      i.amount_settled,
      i.settlement_asset_id,
      i.settlement_decimals,
      i.settlement_symbol,
      i.destination_snapshot.chain,
    ),
    evidence_links: url ? [url] : [],
    email_receipts: ctx.account.settings.email_receipts,
  };
}
