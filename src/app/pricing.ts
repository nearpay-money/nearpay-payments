/**
 * Price validation shared by checkout sessions, API intents and payment links (lld/payments.md §8.1).
 *
 * Multi-currency (Stage 2, ADR-0020 d5): a fiat currency must be one payments accepts
 * (`NP_PRICING_CURRENCIES`) and one rails quotes with a fresh FX rate (`GET /internal/fx-rates`: absent →
 * `currency_unsupported`, unavailable or stale → `fx_rate_unavailable`). USD and asset prices are valued
 * locally as in Stage 1; other currencies are valued by rails (`GET /internal/settlement-estimate`) with
 * the same rules as execution pricing. Rails computes the binding settlement amount (INV-6).
 */
import { ApiError } from "@nearpay-internal/service";
import type { InternalSettlementDestination } from "@nearpay-internal/spec";
import { type AssetInfo, type Pricing, pricingUsdMicros } from "../domain/pricing/pricing.js";
import { upstreamCode } from "../infra/clients/peers.js";
import type { Payments } from "./context.js";
import type { Context } from "./settlement-context.js";

export interface PriceInput {
  readonly amount: number | string;
  readonly currency: string;
  readonly asset_id?: string | undefined;
  readonly settlement_destination?: string | undefined;
}

/** Rails' asset decimals, symbol and price (5-minute cache). */
export async function assetInfo(p: Payments, assetId: string, livemode: boolean) {
  try {
    return await p.caches.assets.get(`${livemode}|${assetId}`, () => p.rails.asset(assetId, livemode));
  } catch (e) {
    p.log.warn({ asset: assetId, err: e instanceof Error ? e.message : String(e) }, "rails asset lookup failed");
    throw new ApiError("rail_unavailable", { params: { reason: "asset lookup failed" } });
  }
}

export const toInfo = (a: { decimals: number; price_usd: string | null; is_usd_stable: boolean }): AssetInfo => ({
  decimals: a.decimals,
  priceUsd: a.price_usd,
  isUsdStable: a.is_usd_stable,
});

/** `chain|address_norm|asset_id` (rails §8.9). */
export const destinationKey = (d: { chain: string; address_norm: string; asset_id: string }) =>
  `${d.chain}|${d.address_norm}|${d.asset_id}`;

/** Accepted fiat currency with a usable FX rate; asset pricing is always accepted. */
export async function checkCurrency(p: Payments, currency: string, livemode: boolean): Promise<void> {
  if (currency === "asset") return;
  if (!p.settings.pricingCurrencies.has(currency))
    throw new ApiError("currency_unsupported", { param: "currency", params: { currency } });
  if (currency === "usd") return;
  let rates: Awaited<ReturnType<Payments["rails"]["fxRates"]>>;
  try {
    rates = await p.rails.fxRates(livemode, [currency]);
  } catch (e) {
    p.log.warn({ currency, err: upstreamCode(e) }, "rails FX rates unavailable");
    throw new ApiError("fx_rate_unavailable", { params: { currency } });
  }
  const r = rates.currencies.find((c) => c.currency === currency);
  if (!r) throw new ApiError("currency_unsupported", { param: "currency", params: { currency } });
  if (!r.available || r.stale) throw new ApiError("fx_rate_unavailable", { params: { currency } });
}

/**
 * USD micros of a price; null when it cannot be valued (the minimum check is then skipped, the
 * unverified cap fails closed). Definitive FX answers from rails are returned as errors.
 */
export async function usdValue(
  p: Payments,
  pricing: Pricing,
  livemode: boolean,
  pricingAsset: AssetInfo | null,
): Promise<bigint | null> {
  if (pricing.kind === "asset" || pricing.currency === "usd") return pricingUsdMicros(pricing, pricingAsset);
  try {
    const e = await p.rails.estimate({
      amount: pricing.amount.toString(),
      currency: pricing.currency,
      livemode: livemode ? "true" : "false",
    } as never);
    return BigInt(e.usd_micros);
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "currency_unsupported" || u.code === "fx_rate_unavailable")
      throw new ApiError(u.code, { params: { currency: pricing.currency } });
    p.log.warn({ currency: pricing.currency, err: u }, "rails settlement estimate unavailable");
    return null;
  }
}

/** Indicative settlement amount for non-USD fiat prices (payment options); null when unknown. */
export async function railsSettlementEstimate(
  p: Payments,
  pricing: Pricing,
  settlementAsset: string,
  livemode: boolean,
): Promise<bigint | null> {
  try {
    const e = await p.rails.estimate({
      amount: pricing.amount.toString(),
      currency: pricing.kind === "fiat" ? pricing.currency : "asset",
      ...(pricing.kind === "asset" ? { asset_id: pricing.assetId } : {}),
      settlement_asset: settlementAsset,
      livemode: livemode ? "true" : "false",
    } as never);
    return e.settlement ? BigInt(e.settlement.amount_base) : null;
  } catch {
    return null;
  }
}

/**
 * Rails' minimum for a destination in USD micros (1-hour cache). An unreachable rails skips the check:
 * the minimum is an economic guard (FR-SET-04), never a safety one, and rails re-checks on quote.
 */
async function minimumUsdMicros(p: Payments, d: InternalSettlementDestination): Promise<bigint | null> {
  const key = destinationKey(d);
  try {
    const m = await p.caches.minimums.get(key, async () => {
      const all = await p.rails.minimums([key]);
      const v = all[key];
      return v ? { min_usd_micros: v.min_usd_micros, min_amount_base: v.min_amount_base } : null;
    });
    return m?.min_usd_micros === null || m?.min_usd_micros === undefined ? null : BigInt(m.min_usd_micros);
  } catch (e) {
    p.log.warn({ destination: d.id, err: e instanceof Error ? e.message : String(e) }, "minimum unavailable");
    return null;
  }
}

const usd = (micros: bigint) => {
  const cents = micros / 10_000n;
  return `USD ${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

export function pickDestination(
  ctx: { destinations: readonly InternalSettlementDestination[]; defaults: Record<string, string> },
  requested: string | undefined | null,
  pricingAsset: string | null,
): InternalSettlementDestination {
  const id = requested ?? (pricingAsset ? ctx.defaults[pricingAsset] : undefined) ?? ctx.defaults["*"];
  const d = id ? ctx.destinations.find((x) => x.id === id) : undefined;
  if (d?.status !== "active")
    throw new ApiError("destination_not_active", {
      ...(requested ? { param: "settlement_destination" } : {}),
      message: requested
        ? `Settlement destination ${requested} is not active in this mode.`
        : "The account has no active default settlement destination in this mode.",
    });
  return d;
}

export const pricingOfInput = (b: PriceInput): Pricing =>
  b.currency === "asset"
    ? { kind: "asset", assetId: b.asset_id as string, amount: BigInt(b.amount) }
    : { kind: "fiat", currency: b.currency, amount: BigInt(b.amount) };

/**
 * Validates a price against the account's destination (§8.1): currency, destination active, rails
 * minimum and the unverified-destination cap. Returns the destination and its asset info.
 */
export async function validatePrice(p: Payments, livemode: boolean, ctx: Context, b: PriceInput) {
  await checkCurrency(p, b.currency, livemode);
  const pricing = pricingOfInput(b);
  const dest = pickDestination(ctx, b.settlement_destination, pricing.kind === "asset" ? pricing.assetId : null);
  const destAsset = await assetInfo(p, dest.asset_id, livemode);
  const pricingAsset =
    pricing.kind === "asset"
      ? pricing.assetId === dest.asset_id
        ? destAsset
        : await assetInfo(p, pricing.assetId, livemode)
      : null;
  const value = await usdValue(p, pricing, livemode, pricingAsset ? toInfo(pricingAsset) : null);
  const min = await minimumUsdMicros(p, dest);
  if (min !== null && value !== null && value < min)
    throw new ApiError("amount_below_destination_minimum", {
      param: "amount",
      message: `The amount (${usd(value)}) is below this destination's minimum of ${usd(min)}.`,
    });
  // an unverified destination caps each payment; a price that cannot be valued cannot be capped
  const cap = dest.verification === "unverified" ? dest.per_payment_cap_usd_micros : null;
  if (cap !== null && (value === null || value > BigInt(cap)))
    throw new ApiError("amount_above_unverified_cap", {
      param: "amount",
      message:
        value === null
          ? "This destination is unverified and the amount cannot be valued in USD to check its cap."
          : `This destination is unverified; payments are capped at ${usd(BigInt(cap))}.`,
    });
  return { dest, destAsset, pricing };
}
