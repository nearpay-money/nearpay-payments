/** Stage 2 pure modules: refund signing payloads, reconciliation, review decisions, links, filters, customers. */
import { describe, expect, it } from "vitest";
import { dedupeWallets, isUsable, normalizeEmail } from "../../src/domain/customer/customer.js";
import { amountFilters, fiatPredicate } from "../../src/domain/payment-intent/filters.js";
import { reviewOutcome } from "../../src/domain/payment-intent/review.js";
import { acceptsPayers } from "../../src/domain/payment-link/link.js";
import {
  dayBounds,
  type EvidenceItem,
  isCompletedDay,
  reconcile,
  type StatementLine,
  utcDay,
} from "../../src/domain/reconciliation/reconcile.js";
import {
  matchesIssued,
  shortAddress,
  signAndSendAction,
  signIntentAction,
  standardsFor,
} from "../../src/domain/refund/next-action.js";

const NONCE = `WgK+EQ${"A".repeat(37)}=`;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const transfer = {
  signer_id: "acme.near",
  receiver_id: "payer.near",
  token: USDC,
  amount: "2000000",
  memo: `np1:${"1".repeat(44)}`,
  deadline: "2026-11-08T12:00:00.000Z",
};

describe("refund next actions", () => {
  it("builds the exact sign_intent payload: one transfer, memo = binding, the given deadline and nonce", () => {
    const a = signIntentAction(transfer, NONCE, { symbol: "USDC", decimals: 6 });
    expect(a.message).toEqual({
      signer_id: "acme.near",
      verifying_contract: "intents.near",
      deadline: transfer.deadline,
      nonce: NONCE,
      intents: [{ intent: "transfer", receiver_id: "payer.near", tokens: { [USDC]: "2000000" }, memo: transfer.memo }],
    });
    expect(JSON.parse(a.payload)).toEqual(a.message);
    expect(JSON.parse(a.nep413.message)).toEqual({
      signer_id: "acme.near",
      deadline: transfer.deadline,
      intents: a.message.intents,
    });
    expect(a.nep413).toMatchObject({ recipient: "intents.near", nonce: NONCE });
    expect(a.standards).toEqual(["nep413", "raw_ed25519"]);
    expect(a.deadline).toBe(Date.parse(transfer.deadline) / 1000);
    expect(a.display).toBe("Transfer 2 USDC to payer.near");
    expect(() => signIntentAction({ ...transfer, amount: "0" }, NONCE, { symbol: "USDC", decimals: 6 })).toThrow();
  });

  it("accepts only the issued payload", () => {
    const a = signIntentAction(transfer, NONCE, { symbol: "USDC", decimals: 6 });
    const nep = {
      standard: "nep413",
      payload: { ...a.nep413 },
      public_key: "ed25519:x",
      signature: "ed25519:y",
    } as never;
    expect(matchesIssued(a, nep)).toBe(true);
    const otherNonce = { standard: "nep413", payload: { ...a.nep413, nonce: `B${NONCE.slice(1)}` } } as never;
    expect(matchesIssued(a, otherNonce)).toBe(false);
    const callback = { standard: "nep413", payload: { ...a.nep413, callbackUrl: "https://x" } } as never;
    expect(matchesIssued(a, callback)).toBe(false);
    const altered = JSON.stringify({ ...a.message, intents: [{ ...a.message.intents[0], receiver_id: "evil.near" }] });
    expect(matchesIssued(a, { standard: "raw_ed25519", payload: a.payload } as never)).toBe(true);
    expect(matchesIssued(a, { standard: "raw_ed25519", payload: altered } as never)).toBe(false);
    // a NEAR account cannot use ERC-191; an EVM implicit account only can
    expect(matchesIssued(a, { standard: "erc191", payload: a.payload } as never)).toBe(false);
    const evm = signIntentAction({ ...transfer, signer_id: `0x${"a".repeat(40)}` }, NONCE, {
      symbol: "USDC",
      decimals: 6,
    });
    expect(evm.standards).toEqual(["erc191"]);
    expect(matchesIssued(evm, { standard: "erc191", payload: evm.payload } as never)).toBe(true);
    expect(standardsFor("bob.near")).toEqual(["nep413", "raw_ed25519"]);
  });

  it("builds sign_and_send from the deposit", () => {
    const a = signAndSendAction({
      chain: "eip155:8453",
      chainName: "Base",
      from: `0x${"b".repeat(40)}`,
      to: `0x${"c".repeat(40)}`,
      assetId: "nep141:base-usdc",
      token: { standard: "erc20", address: `0x${"d".repeat(40)}` },
      symbol: "USDC",
      decimals: 6,
      amount: "2500000",
      memo: null,
      deadline: transfer.deadline,
    });
    expect(a).toMatchObject({ type: "sign_and_send", amount: "2500000", memo: null, token: { standard: "erc20" } });
    expect(a.display).toBe(`Send 2.5 USDC on Base to ${shortAddress(`0x${"c".repeat(40)}`)}`);
    const noToken = signAndSendAction({
      ...a,
      chainName: "Base",
      assetId: a.asset_id,
      token: null,
      memo: "42",
      deadline: transfer.deadline,
    } as never);
    expect(noToken.token).toEqual({ standard: "other", address: null });
    expect(noToken.display).toContain("(memo 42)");
    expect(shortAddress("short")).toBe("short");
  });
});

// --------------------------------------------------------------------------------------------- reconciliation

const line = (o: Partial<StatementLine>): StatementLine => ({
  id: "txn_1",
  type: "payment",
  assetId: USDC,
  settled: 100n,
  received: null,
  feeEst: null,
  feeAssetId: null,
  executionId: "ex_1",
  paymentIntent: "pi_1",
  refund: null,
  ...o,
});
const ev = (o: Partial<EvidenceItem>): EvidenceItem => ({
  executionId: "ex_1",
  kind: "payment",
  assetId: USDC,
  amount: 100n,
  received: null,
  observedFee: null,
  paymentIntent: "pi_1",
  refund: null,
  ...o,
});

describe("reconciliation", () => {
  it("consistent data reconciles to zero diffs with totals per asset", () => {
    const r = reconcile(
      [
        line({ feeEst: 30n, feeAssetId: "nep141:base-usdc" }),
        line({ id: "txn_2", type: "overpayment", executionId: "ex_2", settled: 5n }),
        line({ id: "txn_3", type: "refund", executionId: "ex_3", settled: 50n, received: 49n, refund: "re_1" }),
      ],
      [
        ev({}),
        ev({ executionId: "ex_2", amount: 5n }),
        ev({ executionId: "ex_3", kind: "refund", amount: 50n, received: 49n }),
      ],
    );
    expect(r.diffs).toEqual([]);
    const usdc = r.totals.find((t) => t.asset_id === USDC);
    expect(usdc?.inflow).toEqual({ statement: "105", evidence: "105", statement_lines: 2, executions: 2 });
    expect(usdc?.outflow).toEqual({ statement: "50", evidence: "50", statement_lines: 1, executions: 1 });
    expect(r.totals.find((t) => t.asset_id === "nep141:base-usdc")?.fees).toEqual({ expected: "30", observed: null });
  });

  it("detects missing lines, missing evidence, amount and asset mismatches, duplicates and unlinked lines", () => {
    const r = reconcile(
      [
        line({ id: "txn_a", executionId: "ex_a", settled: 99n }),
        line({ id: "txn_b", executionId: "ex_b", assetId: "nep141:other" }),
        line({ id: "txn_c", executionId: "ex_c" }),
        line({ id: "txn_c2", type: "overpayment", executionId: "ex_c" }),
        line({ id: "txn_d", executionId: "ex_gone" }),
        line({ id: "txn_e", executionId: null }),
        line({ id: "txn_f", type: "refund", executionId: "ex_f", settled: 10n, received: 9n }),
        line({ id: "txn_fee", type: "fee_adjustment", executionId: null }),
      ],
      [
        ev({ executionId: "ex_a" }),
        ev({ executionId: "ex_b" }),
        ev({ executionId: "ex_c" }),
        ev({ executionId: "ex_missing" }),
        ev({ executionId: "ex_f", kind: "refund", amount: 10n, received: 8n }),
      ],
    );
    const kinds = r.diffs.map((d) => `${d.kind}:${d.balance_transaction ?? d.execution_id}`).sort();
    expect(kinds).toEqual(
      [
        "amount_mismatch:txn_a",
        "asset_mismatch:txn_b",
        "duplicate_line:txn_c2",
        "missing_evidence:txn_d",
        "missing_evidence:txn_e",
        "missing_statement_line:ex_missing",
        "amount_mismatch:txn_f",
      ].sort(),
    );
  });

  it("compares fees only when every payment execution reports one", () => {
    const fee = { amount: 30n, assetId: "nep141:base-usdc" };
    const ok = reconcile([line({ feeEst: 30n, feeAssetId: fee.assetId })], [ev({ observedFee: fee })]);
    expect(ok.diffs).toEqual([]);
    expect(ok.totals.find((t) => t.asset_id === fee.assetId)?.fees.observed).toBe("30");
    const off = reconcile(
      [line({ feeEst: 30n, feeAssetId: fee.assetId })],
      [ev({ observedFee: { ...fee, amount: 31n } })],
    );
    expect(off.diffs.map((d) => d.kind)).toEqual(["fee_mismatch"]);
  });

  it("days: completed, bounds, UTC", () => {
    const now = Date.parse("2026-11-08T01:00:00Z");
    expect(isCompletedDay("2026-11-07", now)).toBe(true);
    expect(isCompletedDay("2026-11-08", now)).toBe(false);
    expect(isCompletedDay("nope", now)).toBe(false);
    expect(utcDay(now)).toBe("2026-11-08");
    expect(dayBounds("2026-11-07").end.toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });
});

// --------------------------------------------------------------------------------------------- review

describe("review decisions", () => {
  const short = { status: "requires_review" as const, reviewReason: "short_settlement" as const, settled: 90n };
  it("accepts a short settlement and completes the session; never a held verification (INV-2)", () => {
    expect(reviewOutcome(short, "open", "accept", undefined)).toMatchObject({
      status: "succeeded",
      session: { status: "complete", late: false },
      countsUse: true,
      intentEvents: ["evt.payments.payment_intent.succeeded"],
    });
    expect(reviewOutcome(short, "expiring", "accept", undefined)).toMatchObject({ session: { late: true } });
    expect(reviewOutcome(short, null, "accept", undefined)).toMatchObject({ session: null });
    expect(reviewOutcome({ ...short, reviewReason: "verification_held" }, "open", "accept", undefined)).toBe(
      "review_requires_evidence",
    );
    expect(reviewOutcome({ ...short, status: "succeeded" }, "open", "accept", undefined)).toBe("state_conflict");
  });
  it("rejects back to requires_payment (open) or expired, drafting a refund of a short settlement", () => {
    expect(reviewOutcome(short, "open", "reject", undefined)).toMatchObject({
      status: "requires_payment",
      session: null,
      releaseSettlement: true,
      refund: true,
      intentEvents: ["evt.payments.payment_intent.payment_failed"],
    });
    expect(reviewOutcome(short, "expiring", "reject", false)).toMatchObject({
      status: "expired",
      session: { status: "expired" },
      refund: false,
      sessionEvents: ["evt.payments.checkout_session.expired"],
    });
    expect(
      reviewOutcome({ ...short, reviewReason: "verification_held", settled: 0n }, "open", "reject", true),
    ).toMatchObject({
      releaseSettlement: false,
      refund: false,
    });
    expect(reviewOutcome(short, "complete", "reject", undefined)).toMatchObject({ status: "expired", session: null });
  });
});

describe("links, filters, customers", () => {
  it("links accept payers while active and below max_uses", () => {
    expect(acceptsPayers({ active: true, uses: 0, maxUses: null })).toBe(true);
    expect(acceptsPayers({ active: true, uses: 2, maxUses: 3 })).toBe(true);
    expect(acceptsPayers({ active: true, uses: 3, maxUses: 3 })).toBe(false);
    expect(acceptsPayers({ active: false, uses: 0, maxUses: null })).toBe(false);
  });
  it("fiat amount predicates stay inside the bigint column", () => {
    const max = 2n ** 63n - 1n;
    expect(fiatPredicate("gte", 10n)).toEqual({ op: "gte", value: 10n });
    expect(fiatPredicate("gte", max + 1n)).toBe("none");
    expect(fiatPredicate("gt", max)).toBe("none");
    expect(fiatPredicate("lte", max + 1n)).toBe("all");
    expect(fiatPredicate("lt", -1n)).toBe("none");
    expect(fiatPredicate("gt", -1n)).toBe("all");
    expect(amountFilters({ "amount[gte]": "5", "amount[lt]": "9", other: 1 })).toEqual([
      { op: "gte", value: 5n },
      { op: "lt", value: 9n },
    ]);
  });
  it("customers: email lookup form, wallet dedupe, deletion", () => {
    expect(normalizeEmail("  Ann@Example.COM ")).toBe("ann@example.com");
    expect(
      dedupeWallets([
        { chain: "eip155:1", address: "0xAB" },
        { chain: "eip155:1", address: "0xab" },
        { chain: "near:mainnet", address: "a.near" },
      ]),
    ).toHaveLength(2);
    expect(isUsable({ deletedAt: null })).toBe(true);
    expect(isUsable({ deletedAt: new Date() })).toBe(false);
  });
});
