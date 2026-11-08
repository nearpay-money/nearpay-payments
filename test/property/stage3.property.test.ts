/**
 * Stage 3 property tests (lld/payments.md §16.1, §20):
 * - executions of other owners (agentpay's cross-chain x402) never reach payments' reconciliation: with any mix
 *   of owners, the owner-filtered summary and listing (spec 0.3.1) agree and payments' own evidence reconciles
 *   against its statement to zero diffs;
 * - any gap in rails' pages (a missing or extra owned execution) or a leaked row of another owner is reported.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ownedByPayments } from "../../src/domain/payment-attempt/attempt.js";
import {
  type EvidenceItem,
  evidenceCountProblem,
  reconcile,
  type StatementLine,
} from "../../src/domain/reconciliation/reconcile.js";

const owner = fc.constantFrom<string | undefined>(undefined, "payments", "agentpay", "future_owner");
const execution = fc.record({ owner, amount: fc.bigInt({ min: 1n, max: 10n ** 24n }) });

/**
 * What the run sees for the truth `xs` (spec 0.3.1: rails' summary and listing are both `owner=payments`, so the
 * summary counts payments' executions only): the owner-filtered listing is `ownedDelta` off the truth (a paging gap
 * or an extra row) and carries `leaked` rows of other owners (a broken rails filter).
 */
function check(xs: { owner: string | undefined }[], ownedDelta = 0, leaked = 0) {
  const ownedTruth = xs.filter((x) => ownedByPayments(x.owner)).length;
  const owned = ownedTruth + ownedDelta;
  return evidenceCountProblem(owned + leaked, owned, ownedTruth);
}

describe("stage 3 (property)", () => {
  it("other owners' executions are excluded and never make a consistent day fail", () => {
    fc.assert(
      fc.property(fc.array(execution, { maxLength: 40 }), (xs) => {
        expect(check(xs)).toBeNull();
        const mine = xs.map((x, k) => ({ ...x, k })).filter((x) => ownedByPayments(x.owner));
        const lines: StatementLine[] = mine.map((x) => ({
          id: `txn_${x.k}`,
          type: "payment",
          assetId: "nep141:usdc.near",
          settled: x.amount,
          received: null,
          feeEst: null,
          feeAssetId: null,
          executionId: `ex_${x.k}`,
          paymentIntent: `pi_${x.k}`,
          refund: null,
        }));
        const evidence: EvidenceItem[] = mine.map((x) => ({
          executionId: `ex_${x.k}`,
          kind: "payment",
          assetId: "nep141:usdc.near",
          amount: x.amount,
          received: null,
          observedFee: null,
          paymentIntent: `pi_${x.k}`,
          refund: null,
        }));
        expect(reconcile(lines, evidence).diffs).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });

  it("a missing or extra row in the owner-filtered listing is always reported, whatever other owners settled", () => {
    fc.assert(
      fc.property(fc.array(execution, { maxLength: 30 }), fc.integer({ min: -3, max: 3 }), (xs, d) => {
        const ownedTruth = xs.filter((x) => ownedByPayments(x.owner)).length;
        fc.pre(d !== 0 && ownedTruth + d >= 0);
        expect(check(xs, d, 0)).not.toBeNull();
      }),
      { numRuns: 1000 },
    );
  });

  it("a row of another owner in the owner=payments listing fails the run closed", () => {
    fc.assert(
      fc.property(fc.array(execution, { maxLength: 30 }), fc.integer({ min: 1, max: 3 }), (xs, k) => {
        expect(check(xs, 0, k)).toMatch(/other owners/);
      }),
      { numRuns: 500 },
    );
  });
});
