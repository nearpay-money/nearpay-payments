/**
 * Payer reads (lld/payments.md §6.2): the public session for the checkout page and indicative payment
 * options. Authenticated by the client secret only; never PII, never the raw destination address. The
 * merchant name here is unverified display data — the co-signed name comes from sentinel (ADR-0010).
 */
import { fromUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { type Pricing, settlementEstimate } from "../domain/pricing/pricing.js";
import { type InternalOption, upstreamCode } from "../infra/clients/peers.js";
import { payerSession, payerView } from "./attempts.js";
import type { Payments } from "./context.js";
import { assetInfo, pricingAssetDisplay, railsSettlementEstimate } from "./pricing.js";
import { settlementContext } from "./settlement-context.js";
import { type AttemptRow, type IntentRow, newestFirst, publicSession, type SessionRow } from "./views.js";

/** The merchant's display name (verified legal name once KYB set one) from the context read model. */
export async function merchantName(p: Payments, accountUuid: string, livemode: boolean): Promise<string> {
  const row = await p.db
    .selectFrom("settlement_contexts")
    .select("context")
    .where("account_id", "=", accountUuid)
    .where("livemode", "=", livemode)
    .executeTakeFirst();
  const ctx = (row?.context ?? (await settlementContext(p, accountUuid, livemode))) as {
    account: { display_name: string; verified_legal_name: string | null };
  };
  return ctx.account.verified_legal_name ?? ctx.account.display_name;
}

/** The attempt the payer should see: the newest visible one. */
export function currentAttempt(attempts: readonly AttemptRow[]): AttemptRow | null {
  return newestFirst(attempts).find((a) => a.visible) ?? null;
}

export async function publicSnapshot(p: Payments, s: SessionRow, i: IntentRow) {
  const [attempts, name, pricingAsset] = await Promise.all([
    p.db.selectFrom("payment_attempts").selectAll().where("payment_intent_id", "=", i.id).execute(),
    merchantName(p, s.account_id, s.livemode),
    pricingAssetDisplay(p, i.currency, i.pricing_asset_id, s.livemode),
  ]);
  const a = currentAttempt(attempts);
  return { session: publicSession(s, i, name, a ? payerView(p, a) : null, pricingAsset), attempt: a };
}

/** `GET /v1/checkout/sessions/{id}/public`. */
export async function getPublicSession(p: Payments, sessionId: string, secret: string | undefined) {
  const { s, i } = await payerSession(p, sessionId, secret);
  return (await publicSnapshot(p, s, i)).session;
}

/**
 * `GET /internal/checkout_sessions/{id}/payer` (agentpay, CR-15-15): verifies the payer's client secret
 * exactly like the public route and adds the session's account and mode.
 */
export async function getPayerSession(p: Payments, sessionId: string, secret: string | undefined) {
  const { s, i } = await payerSession(p, sessionId, secret);
  return {
    account_id: fromUuid("acct", s.account_id),
    livemode: s.livemode,
    session: (await publicSnapshot(p, s, i)).session,
  };
}

const REASONS = new Set(["route_too_slow", "amount_too_low", "route_unavailable", "pricing_unavailable"]);
type Reason = "route_too_slow" | "amount_too_low" | "route_unavailable" | "pricing_unavailable";

/**
 * Rails' routing-health codes about prices (rails `domain/routing/health.ts`): the settlement asset has no reliable
 * price. The payer sees `pricing_unavailable`; every other code (kill switch, treasury, cross-chain pause…) stays
 * `route_unavailable`. Rails before the codes sent a sentence ("no reliable price for the settlement asset").
 */
const PRICE_CODES = new Set([
  "settlement_price_stale",
  "settlement_price_missing",
  "settlement_price_depeg",
  "settlement_price_disagree",
  "fx_unavailable",
]);

/** Rails' (free-text) option reason as the public enum (spec `PaymentOption.reason`, unchanged). */
export function payerReason(raw: string | null | undefined): Reason {
  if (raw && REASONS.has(raw)) return raw as Reason;
  if (raw && (PRICE_CODES.has(raw) || raw.startsWith("settlement_price_") || raw.startsWith("no reliable price")))
    return "pricing_unavailable";
  return "route_unavailable";
}

/** Rails' option as the payer sees it; the session window decides `route_too_slow`. */
export function payerOption(o: InternalOption, remainingS: number, latePayments: boolean) {
  const tooSlow = !latePayments && remainingS < o.min_deadline_s;
  const reason: Reason | null = tooSlow ? "route_too_slow" : o.available ? null : payerReason(o.reason);
  return {
    method: o.method,
    origin_asset_id: o.origin_asset_id,
    chain: o.chain,
    symbol: o.symbol,
    decimals: o.decimals,
    estimated_amount_in: o.estimated_amount_in,
    route_class: o.route_class,
    min_deadline_s: o.min_deadline_s,
    available: o.available && !tooSlow,
    reason,
    // CR-15-06: the token contract to pay with, passed through from rails
    token: o.token ?? null,
  };
}

/**
 * `GET /v1/checkout/sessions/{id}/public/payment_options` (indicative, from rails; §10: 2 s, 1 retry,
 * breaker). Rails answers for an estimated settlement amount; when the price cannot be estimated or
 * rails does not answer, there are no options to show (the page offers the manual path).
 */
export async function paymentOptions(
  p: Payments,
  sessionId: string,
  secret: string | undefined,
  q: { chain?: string | undefined; wallet?: string | undefined },
) {
  const { s, i } = await payerSession(p, sessionId, secret);
  if (s.status !== "open" || (i.status !== "requires_payment" && i.status !== "processing"))
    throw new ApiError("session_not_open");
  return sessionOptions(p, s, i, q);
}

/** The session's payment options (rails, indicative; usable first). Empty when rails cannot answer. */
export async function sessionOptions(
  p: Payments,
  s: SessionRow,
  i: IntentRow,
  q: { chain?: string | undefined; wallet?: string | undefined } = {},
) {
  const d = i.destination_snapshot;
  const pricing: Pricing =
    i.currency === "asset"
      ? { kind: "asset", assetId: i.pricing_asset_id as string, amount: BigInt(i.pricing_asset_amount as string) }
      : { kind: "fiat", currency: i.currency, amount: BigInt(i.amount as string) };
  let amountOut: bigint | null;
  if (pricing.kind === "fiat" && pricing.currency !== "usd")
    // non-USD prices are valued by rails (FX, ADR-0020 d5); no estimate → no options (manual path)
    amountOut = await railsSettlementEstimate(p, pricing, d.asset_id, i.livemode);
  else
    try {
      const dest = await assetInfo(p, d.asset_id, i.livemode);
      const pa =
        pricing.kind === "asset" && pricing.assetId !== d.asset_id
          ? await assetInfo(p, pricing.assetId, i.livemode)
          : null;
      const info = (a: typeof dest) => ({ decimals: a.decimals, priceUsd: a.price_usd, isUsdStable: a.is_usd_stable });
      amountOut = settlementEstimate(pricing, { ...info(dest), assetId: d.asset_id }, pa ? info(pa) : null);
    } catch {
      amountOut = null;
    }
  if (amountOut === null || amountOut <= 0n) {
    warnNoRoute(p, s, i, { cause: "settlement_estimate_unavailable", rails_reasons: [] });
    return { object: "payment_options" as const, options: [] };
  }
  let options: InternalOption[];
  try {
    options = await p.rails.options({
      destination_asset: d.asset_id,
      destination_type: d.type,
      amount_out: amountOut.toString(),
      ...(q.chain ? { chain: q.chain } : {}),
      ...(q.wallet ? { wallet: q.wallet } : {}),
      livemode: i.livemode ? "true" : "false",
    } as never);
  } catch (e) {
    p.log.warn({ session: s.id, err: upstreamCode(e) }, "rails options unavailable");
    return { object: "payment_options" as const, options: [] };
  }
  const remainingS = (s.expires_at.getTime() - p.now()) / 1000;
  const late = i.settings_snapshot.late_payments;
  const mapped = options.map((o) => payerOption(o, remainingS, late));
  if (options.every((o) => !o.available))
    warnNoRoute(p, s, i, {
      cause: options.length ? "every_option_unavailable" : "no_options",
      rails_reasons: [...new Set(options.map((o) => o.reason ?? "none"))],
      payer_reasons: [...new Set(mapped.map((o) => o.reason ?? "none"))],
      options: options.length,
    });
  // usable options first, rails' ranking kept within each group
  return {
    object: "payment_options" as const,
    options: [...mapped.filter((o) => o.available), ...mapped.filter((o) => !o.available)],
  };
}

/** Sessions already reported by {@link warnNoRoute}, per process (bounded: cleared past the cap). */
const reported = new WeakMap<object, Set<string>>();
const REPORTED_CAP = 10_000;

/**
 * The payer sees "Payments are temporarily unavailable": logs it once per session (WARN) with rails' own reason
 * codes, so the cause is visible (rails also exports `nearpay_rails_routing_blocked{reason}`).
 */
function warnNoRoute(p: Payments, s: SessionRow, i: IntentRow, detail: Record<string, unknown>): void {
  let seen = reported.get(p);
  if (!seen) {
    seen = new Set();
    reported.set(p, seen);
  }
  if (seen.has(s.id)) return;
  if (seen.size >= REPORTED_CAP) seen.clear();
  seen.add(s.id);
  p.log.warn(
    {
      session: fromUuid("cs", s.id),
      livemode: i.livemode,
      destination_asset: i.destination_snapshot.asset_id,
      ...detail,
    },
    "no payment option available for a checkout session: the payer sees 'Payments are temporarily unavailable'",
  );
}
