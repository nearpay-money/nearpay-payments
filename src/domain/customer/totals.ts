/**
 * `Customer.total_paid` (spec 0.2.1, lld/payments.md §"Spec 0.2.1 contract changes"). Pure.
 *
 * Per pricing currency (or pricing asset): Σ priced amounts and count of the customer's **succeeded** payment
 * intents. Amounts in different currencies are never added, and refunds are not subtracted (the contract).
 * Every payment-intent change is turned into a delta (remove the old contribution, add the new one), applied
 * in the transaction of that change, so the stored totals always equal the recomputed sum.
 */

export interface PricedIntent {
  readonly status: string;
  readonly customer_id: string | null;
  /** ISO 4217 lower-case, or `asset`. */
  readonly currency: string;
  /** Fiat minor units (decimal string from the bigint column). */
  readonly amount: string | number | bigint | null;
  readonly pricing_asset_id: string | null;
  readonly pricing_asset_amount: string | bigint | null;
}

export interface Contribution {
  readonly customer: string;
  readonly currency: string;
  /** '' for fiat pricing. */
  readonly assetId: string;
  readonly amount: bigint;
}

/** What an intent adds to its customer's totals: only a succeeded intent with a customer counts. */
export function contributionOf(i: PricedIntent): Contribution | null {
  if (i.status !== "succeeded" || !i.customer_id) return null;
  const asset = i.currency === "asset";
  const raw = asset ? i.pricing_asset_amount : i.amount;
  if (raw === null || raw === undefined) return null;
  return {
    customer: i.customer_id,
    currency: i.currency,
    assetId: asset ? (i.pricing_asset_id ?? "") : "",
    amount: BigInt(raw),
  };
}

const sameKey = (a: Contribution, b: Contribution) =>
  a.customer === b.customer && a.currency === b.currency && a.assetId === b.assetId;

/** The totals change of one intent change: contributions to take away and to add (none when unchanged). */
export function totalsDelta(
  before: PricedIntent | null,
  after: PricedIntent,
): { remove: Contribution | null; add: Contribution | null } {
  const was = before ? contributionOf(before) : null;
  const is = contributionOf(after);
  if (was && is && sameKey(was, is) && was.amount === is.amount) return { remove: null, add: null };
  return { remove: was, add: is };
}

export type TotalsKey = `${string}|${string}|${string}`;
export interface Total {
  amount: bigint;
  count: number;
}

export const totalsKey = (c: Pick<Contribution, "customer" | "currency" | "assetId">): TotalsKey =>
  `${c.customer}|${c.currency}|${c.assetId}`;

/** Applies a delta to an in-memory totals map (the model the stored rows follow). */
export function applyDelta(totals: Map<TotalsKey, Total>, d: ReturnType<typeof totalsDelta>): void {
  if (d.remove) {
    const k = totalsKey(d.remove);
    const t = totals.get(k) ?? { amount: 0n, count: 0 };
    totals.set(k, { amount: t.amount - d.remove.amount, count: t.count - 1 });
  }
  if (d.add) {
    const k = totalsKey(d.add);
    const t = totals.get(k) ?? { amount: 0n, count: 0 };
    totals.set(k, { amount: t.amount + d.add.amount, count: t.count + 1 });
  }
}

/** The totals recomputed from scratch (what the stored rows must equal). */
export function recomputeTotals(intents: readonly PricedIntent[]): Map<TotalsKey, Total> {
  const out = new Map<TotalsKey, Total>();
  for (const i of intents) applyDelta(out, { remove: null, add: contributionOf(i) });
  return out;
}
