/**
 * Spec 0.2.1 `Customer.total_paid` property (lld/payments.md §"Spec 0.2.1 contract changes"): under random
 * interleavings of intent changes of several customers (payments succeeding, reviews, cancels, refunds
 * pending/succeeding/failing, repeated no-op updates), the totals maintained by per-change deltas — applied in
 * any order across intents, each intent's own changes in order (its row lock) — always equal the totals
 * recomputed from the final intents: Σ priced amounts and count of succeeded intents per customer and pricing
 * currency/asset. Refunds never change them (the contract: "refunds are not subtracted"), amounts in different
 * currencies are never added, and no stored total ever goes negative.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyDelta,
  type PricedIntent,
  recomputeTotals,
  type Total,
  type TotalsKey,
  totalsDelta,
} from "../../src/domain/customer/totals.js";

interface Intent extends PricedIntent {
  status: string;
  refunded: bigint;
}

const CUSTOMERS = ["c1", "c2", "c3", null] as const;
const PRICES = [
  { currency: "usd", amount: "1999", pricing_asset_id: null, pricing_asset_amount: null },
  { currency: "eur", amount: "500", pricing_asset_id: null, pricing_asset_amount: null },
  {
    currency: "asset",
    amount: null,
    pricing_asset_id: "nep141:usdc.near",
    pricing_asset_amount: "123456789012345678901234",
  },
  { currency: "asset", amount: null, pricing_asset_id: "nep141:wnear.near", pricing_asset_amount: "1" },
] as const;

type Op =
  | "process"
  | "succeed"
  | "review"
  | "approve"
  | "cancel"
  | "refund_pending"
  | "refund_done"
  | "refund_failed"
  | "touch";

/** The intent change an operation makes (null: not allowed in the current state). */
function step(i: Intent, op: Op, amount: bigint): Intent | null {
  switch (op) {
    case "process":
      return i.status === "requires_payment" ? { ...i, status: "processing" } : null;
    case "succeed":
      return i.status === "processing" ? { ...i, status: "succeeded" } : null;
    case "review":
      return i.status === "processing" ? { ...i, status: "requires_review" } : null;
    case "approve":
      return i.status === "requires_review" ? { ...i, status: "succeeded" } : null;
    case "cancel":
      return i.status === "requires_payment" || i.status === "requires_review" ? { ...i, status: "canceled" } : null;
    case "refund_pending":
    case "refund_failed":
      return i.status === "succeeded" ? { ...i } : null;
    case "refund_done":
      return i.status === "succeeded" ? { ...i, refunded: i.refunded + amount } : null;
    case "touch":
      return { ...i };
  }
}

const opArb = fc.constantFrom<Op>(
  "process",
  "succeed",
  "review",
  "approve",
  "cancel",
  "refund_pending",
  "refund_done",
  "refund_failed",
  "touch",
);

const nonZero = (m: Map<TotalsKey, Total>) =>
  new Map([...m].filter(([, t]) => t.count !== 0 || t.amount !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)));

describe("customer totals (spec 0.2.1)", () => {
  it("delta-maintained totals equal the recomputed sum of succeeded intents under any interleaving", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ customer: fc.constantFrom(...CUSTOMERS), price: fc.constantFrom(...PRICES) }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.record({ intent: fc.nat(), op: opArb, refund: fc.bigInt({ min: 1n, max: 10n ** 30n }) }), {
          maxLength: 60,
        }),
        fc.array(fc.nat(), { maxLength: 200 }),
        (specs, ops, picks) => {
          const intents: Intent[] = specs.map((s) => ({
            status: "requires_payment",
            customer_id: s.customer,
            refunded: 0n,
            ...s.price,
          }));
          // each intent's changes, in its own (row-locked) order
          const queues: ReturnType<typeof totalsDelta>[][] = intents.map(() => []);
          for (const o of ops) {
            const n = o.intent % intents.length;
            const cur = intents[n] as Intent;
            const next = step(cur, o.op, o.refund);
            if (!next) continue;
            queues[n]?.push(totalsDelta(cur, next));
            intents[n] = next;
          }
          // commit the intents' transactions in a random interleaving
          const stored = new Map<TotalsKey, Total>();
          let k = 0;
          while (queues.some((q) => q.length)) {
            const live = queues.filter((q) => q.length);
            const q = live[(picks[k++] ?? 0) % live.length] as ReturnType<typeof totalsDelta>[];
            applyDelta(stored, q.shift() as ReturnType<typeof totalsDelta>);
            for (const t of stored.values()) {
              expect(t.amount >= 0n).toBe(true);
              expect(t.count >= 0).toBe(true);
            }
          }
          expect(nonZero(stored)).toEqual(nonZero(recomputeTotals(intents)));
          // explicit oracle: per customer and pricing currency/asset, Σ priced amounts of succeeded intents
          const oracle = new Map<string, Total>();
          for (const i of intents) {
            if (i.status !== "succeeded" || !i.customer_id) continue;
            const key = `${i.customer_id}|${i.currency}|${i.pricing_asset_id ?? ""}`;
            const t = oracle.get(key) ?? { amount: 0n, count: 0 };
            oracle.set(key, {
              amount: t.amount + BigInt((i.currency === "asset" ? i.pricing_asset_amount : i.amount) as string),
              count: t.count + 1,
            });
          }
          expect(nonZero(stored)).toEqual(nonZero(oracle as Map<TotalsKey, Total>));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("refunds and no-op updates never change a total", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRICES), fc.bigInt({ min: 1n, max: 10n ** 30n }), (price, refund) => {
        const paid: Intent = { status: "succeeded", customer_id: "c1", refunded: 0n, ...price };
        const refunded: Intent = { ...paid, refunded: refund };
        expect(totalsDelta(paid, refunded)).toEqual({ remove: null, add: null });
        expect(totalsDelta(paid, { ...paid })).toEqual({ remove: null, add: null });
      }),
    );
  });
});
