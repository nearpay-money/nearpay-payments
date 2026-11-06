/**
 * Indicative values payments needs before rails quotes (lld/payments.md §8.1): USD value of a price
 * for the destination minimum and the unverified-destination cap, and the settlement estimate for
 * payment options. Rails computes the binding settlement amount (INV-6); nothing here is charged.
 * Pure, bigint/rational only.
 */
import { minorUnits, mulDivFloor, parseDecimal } from "@nearpay-internal/money";

export interface AssetInfo {
  readonly decimals: number;
  readonly priceUsd: string | null;
  readonly isUsdStable: boolean;
}

export type Pricing =
  | { readonly kind: "fiat"; readonly currency: string; readonly amount: bigint }
  | { readonly kind: "asset"; readonly assetId: string; readonly amount: bigint };

const MICROS = 1_000_000n;

/** USD micros of a fiat amount; null for a currency without a Stage 1 rate (only `usd`). */
export function fiatUsdMicros(amount: bigint, currency: string): bigint | null {
  if (currency !== "usd") return null;
  return amount * 10n ** BigInt(6 - minorUnits(currency));
}

/** USD micros of `amount` base units at `priceUsd` (floor); null without a usable price. */
export function assetUsdMicros(amount: bigint, asset: AssetInfo): bigint | null {
  if (asset.priceUsd === null) return null;
  let price: { num: bigint; den: bigint };
  try {
    price = parseDecimal(asset.priceUsd);
  } catch {
    return null;
  }
  if (price.num <= 0n) return null;
  return mulDivFloor(amount * price.num, MICROS, price.den * 10n ** BigInt(asset.decimals));
}

/** USD micros of a price (fiat or asset); null when unknown. */
export function pricingUsdMicros(p: Pricing, pricingAsset: AssetInfo | null): bigint | null {
  if (p.kind === "fiat") return fiatUsdMicros(p.amount, p.currency);
  return pricingAsset ? assetUsdMicros(p.amount, pricingAsset) : null;
}

/**
 * Indicative settlement amount in the destination asset: USD stablecoins at par, otherwise at the
 * asset's USD price; the same asset as priced settles exactly. Null when it cannot be estimated.
 */
export function settlementEstimate(
  p: Pricing,
  destination: AssetInfo & { readonly assetId: string },
  pricingAsset: AssetInfo | null,
): bigint | null {
  if (p.kind === "asset" && p.assetId === destination.assetId) return p.amount;
  const usd = pricingUsdMicros(p, pricingAsset);
  if (usd === null) return null;
  if (destination.isUsdStable) return mulDivFloor(usd, 10n ** BigInt(destination.decimals), MICROS);
  if (destination.priceUsd === null) return null;
  let price: { num: bigint; den: bigint };
  try {
    price = parseDecimal(destination.priceUsd);
  } catch {
    return null;
  }
  if (price.num <= 0n) return null;
  return mulDivFloor(usd * price.den, 10n ** BigInt(destination.decimals), price.num * MICROS);
}
