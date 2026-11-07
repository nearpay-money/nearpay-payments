/**
 * Property tests for reconciliation (lld/payments.md §9, §15; domain-model §6): consistent statement
 * and evidence always reconcile to zero diffs with equal totals; any single injected discrepancy (a
 * dropped line, dropped evidence, a changed amount, a changed asset, a duplicated line, an unlinked
 * line) is always detected.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type EvidenceItem, reconcile, type StatementLine } from "../../src/domain/reconciliation/reconcile.js";

const ASSETS = ["nep141:usdc.near", "nep141:usdt.near", "nep141:base-usdc.omft.near"];

const item = fc.record({
  kind: fc.constantFrom("payment", "overpayment", "refund"),
  asset: fc.constantFrom(...ASSETS),
  amount: fc.bigInt({ min: 1n, max: 10n ** 30n }),
  received: fc.bigInt({ min: 1n, max: 10n ** 30n }),
});

function consistent(items: { kind: string; asset: string; amount: bigint; received: bigint }[]) {
  const lines: StatementLine[] = [];
  const evidence: EvidenceItem[] = [];
  items.forEach((it, k) => {
    const ex = `ex_${k}`;
    const refund = it.kind === "refund";
    lines.push({
      id: `txn_${k}`,
      type: it.kind as StatementLine["type"],
      assetId: it.asset,
      settled: it.amount,
      received: refund ? it.received : null,
      feeEst: null,
      feeAssetId: null,
      executionId: ex,
      paymentIntent: `pi_${k}`,
      refund: refund ? `re_${k}` : null,
    });
    evidence.push({
      executionId: ex,
      kind: refund ? "refund" : "payment",
      assetId: it.asset,
      amount: it.amount,
      received: refund ? it.received : null,
      observedFee: null,
      paymentIntent: `pi_${k}`,
      refund: refund ? `re_${k}` : null,
    });
  });
  return { lines, evidence };
}

const injection = fc.constantFrom(
  "drop_line",
  "drop_evidence",
  "line_amount",
  "evidence_amount",
  "asset",
  "duplicate_line",
  "unlink_line",
  "received",
);

describe("reconciliation (property)", () => {
  it("consistent data → zero diffs, Σ statement = Σ evidence per asset and direction", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 40 }), (items) => {
        const { lines, evidence } = consistent(items);
        const r = reconcile(lines, evidence);
        expect(r.diffs).toEqual([]);
        for (const t of r.totals) {
          expect(t.inflow.statement).toBe(t.inflow.evidence);
          expect(t.outflow.statement).toBe(t.outflow.evidence);
          expect(t.inflow.statement_lines).toBe(t.inflow.executions);
          expect(t.outflow.statement_lines).toBe(t.outflow.executions);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("any injected discrepancy is detected", () => {
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 30 }), injection, fc.nat(), (items, kind, pick) => {
        const { lines, evidence } = consistent(items);
        const k = pick % items.length;
        const L = lines[k] as StatementLine;
        const E = evidence[k] as EvidenceItem;
        switch (kind) {
          case "drop_line":
            lines.splice(k, 1);
            break;
          case "drop_evidence":
            evidence.splice(k, 1);
            break;
          case "line_amount":
            lines[k] = { ...L, settled: L.settled + 1n };
            break;
          case "evidence_amount":
            evidence[k] = { ...E, amount: E.amount + 1n };
            break;
          case "asset":
            lines[k] = { ...L, assetId: ASSETS.find((a) => a !== L.assetId) as string };
            break;
          case "duplicate_line":
            lines.push({ ...L, id: `${L.id}_dup` });
            break;
          case "unlink_line":
            lines[k] = { ...L, executionId: null };
            break;
          case "received":
            if (E.kind !== "refund") lines[k] = { ...L, settled: L.settled + 7n };
            else evidence[k] = { ...E, received: (E.received ?? 0n) + 1n };
            break;
        }
        expect(reconcile(lines, evidence).diffs.length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });
});
