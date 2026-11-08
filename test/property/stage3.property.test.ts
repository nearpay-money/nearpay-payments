/**
 * Stage 3 property tests (lld/payments.md §16.1, §20):
 * - executions of other owners (agentpay's cross-chain x402) never reach payments' reconciliation: with any mix
 *   of owners, filtering by owner and the summary count check accept exactly the consistent cases, and the
 *   reconciliation of payments' own evidence against its statement still reconciles to zero diffs;
 * - any gap in rails' pages (a missing or extra execution of any owner) is reported.
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
 * What the run sees for the truth `xs` (rails' summary counts every execution): the owner-filtered listing is
 * `ownedDelta` off the truth and the unfiltered listing `allDelta` off (a paging gap or an extra row).
 */
function check(xs: { owner: string | undefined }[], ownedDelta = 0, allDelta = 0) {
  const ownedTruth = xs.filter((x) => ownedByPayments(x.owner)).length;
  const owned = ownedTruth + ownedDelta;
  const all = { total: xs.length + allDelta, owned: ownedTruth + allDelta };
  return evidenceCountProblem(owned, xs.length, owned === xs.length ? undefined : all);
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

  // An extra owned row that exactly offsets other owners' executions is not visible to the count; the statement
  // match (`missing_statement_line`) still reports it, as it reports every owned execution without a line.
  it("a missing row in the owner-filtered listing is always reported; an extra one when no other owner settled", () => {
    fc.assert(
      fc.property(fc.array(execution, { maxLength: 30 }), fc.integer({ min: -3, max: 3 }), (xs, d) => {
        const ownedTruth = xs.filter((x) => ownedByPayments(x.owner)).length;
        fc.pre(d !== 0 && ownedTruth + d >= 0 && (d < 0 || ownedTruth === xs.length));
        expect(check(xs, d, 0)).not.toBeNull();
      }),
      { numRuns: 1000 },
    );
  });

  it("when other owners settled that day, a gap in the unfiltered listing is reported too", () => {
    fc.assert(
      fc.property(fc.array(execution, { maxLength: 30 }), fc.integer({ min: -3, max: 3 }), (xs, d) => {
        const ownedTruth = xs.filter((x) => ownedByPayments(x.owner)).length;
        fc.pre(ownedTruth < xs.length && d !== 0 && ownedTruth + d >= 0);
        expect(check(xs, 0, d)).not.toBeNull();
      }),
      { numRuns: 1000 },
    );
  });
});
