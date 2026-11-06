/** Attempt mapping, session guards, indicative pricing and statement lines (pure domain). */
import { describe, expect, it } from "vitest";
import { attemptGuard, originsProblem, sessionTtl } from "../../src/domain/checkout-session/session.js";
import {
  ATTEMPT_STATUSES,
  IN_FLIGHT,
  INSTRUCTIONS_LIVE,
  isAttemptStatus,
  isNewer,
  statusOfExecution,
  TERMINAL,
} from "../../src/domain/payment-attempt/attempt.js";
import {
  assetUsdMicros,
  fiatUsdMicros,
  pricingUsdMicros,
  settlementEstimate,
} from "../../src/domain/pricing/pricing.js";
import { statementLine } from "../../src/domain/statement/statement.js";

describe("payment attempt", () => {
  it("mirrors execution states and holds anything unknown (never assumed terminal)", () => {
    for (const s of ATTEMPT_STATUSES) expect(statusOfExecution(s)).toBe(s);
    expect(statusOfExecution("some_new_state")).toBe("held");
    expect(isAttemptStatus("quoting")).toBe(true);
    expect(isAttemptStatus("nope")).toBe(false);
  });
  it("applies only newer execution versions", () => {
    expect(isNewer(3, 2)).toBe(true);
    expect(isNewer(2, 2)).toBe(false);
    expect(isNewer(1, 2)).toBe(false);
  });
  it("status sets are disjoint where they must be", () => {
    for (const s of TERMINAL) expect(IN_FLIGHT.has(s)).toBe(false);
    expect(INSTRUCTIONS_LIVE.has("awaiting_deposit")).toBe(true);
    expect(INSTRUCTIONS_LIVE.has("verifying")).toBe(false);
  });
});

describe("checkout session guards", () => {
  const base = {
    session: "open" as const,
    intent: "requires_payment" as const,
    attempts: [] as never[],
    livemode: true,
    liveAttempts: 0,
    maxLiveAttempts: 5,
    remainingS: 3600,
    minDeadlineS: 300,
    latePayments: false,
  };
  it("allows a new attempt on an open session", () => {
    expect(attemptGuard(base)).toBeNull();
    expect(attemptGuard({ ...base, intent: "processing" })).toBeNull();
  });
  it("refuses when the session or intent is not open", () => {
    expect(attemptGuard({ ...base, session: "expiring" })).toBe("session_not_open");
    expect(attemptGuard({ ...base, intent: "succeeded" })).toBe("session_not_open");
  });
  it("refuses while a deposit is in flight or held", () => {
    expect(attemptGuard({ ...base, attempts: ["settling"] as never })).toBe("attempt_in_flight");
    expect(attemptGuard({ ...base, attempts: ["held"] as never })).toBe("attempt_in_flight");
  });
  it("limits live attempts, not test ones", () => {
    expect(attemptGuard({ ...base, liveAttempts: 5 })).toBe("too_many_attempts");
    expect(attemptGuard({ ...base, livemode: false, liveAttempts: 50 })).toBeNull();
  });
  it("refuses a route slower than the remaining window unless late payments are accepted", () => {
    expect(attemptGuard({ ...base, remainingS: 200 })).toBe("route_too_slow");
    expect(attemptGuard({ ...base, remainingS: 200, latePayments: true })).toBeNull();
  });
  it("session lifetime within 300 s … 24 h", () => {
    expect(sessionTtl(undefined, 3600)).toBe(3600);
    expect(sessionTtl(100, 3600)).toBe(300);
    expect(sessionTtl(999_999, 3600)).toBe(86_400);
    expect(sessionTtl(900, 3600)).toBe(900);
  });
  it("embedded sessions need origins; http://localhost only in test mode", () => {
    expect(originsProblem("hosted", [], true)).toBeNull();
    expect(originsProblem("embedded", [], false)).toMatch(/required/);
    expect(originsProblem("embedded", ["http://localhost:3000"], false)).toBeNull();
    expect(originsProblem("embedded", ["http://localhost:3000"], true)).toMatch(/test mode/);
    expect(originsProblem("embedded", ["https://shop.example"], true)).toBeNull();
  });
});

describe("indicative pricing", () => {
  const usdc = { decimals: 6, priceUsd: "1", isUsdStable: true };
  const near = { decimals: 24, priceUsd: "2.5", isUsdStable: false };
  it("USD minor units to micros; other currencies unknown in Stage 1", () => {
    expect(fiatUsdMicros(200n, "usd")).toBe(2_000_000n);
    expect(fiatUsdMicros(200n, "eur")).toBeNull();
  });
  it("asset base units to USD micros (floor); unusable prices are unknown", () => {
    expect(assetUsdMicros(10n ** 24n, near)).toBe(2_500_000n);
    expect(assetUsdMicros(1n, { ...near, priceUsd: null })).toBeNull();
    expect(assetUsdMicros(1n, { ...near, priceUsd: "x" })).toBeNull();
    expect(assetUsdMicros(1n, { ...near, priceUsd: "0" })).toBeNull();
  });
  it("pricing in fiat or asset", () => {
    expect(pricingUsdMicros({ kind: "fiat", currency: "usd", amount: 250n }, null)).toBe(2_500_000n);
    expect(pricingUsdMicros({ kind: "asset", assetId: "x", amount: 10n ** 24n }, near)).toBe(2_500_000n);
    expect(pricingUsdMicros({ kind: "asset", assetId: "x", amount: 1n }, null)).toBeNull();
  });
  it("settlement estimate: same asset exact, stables at par, others at price", () => {
    const fiat = { kind: "fiat" as const, currency: "usd", amount: 200n };
    expect(settlementEstimate({ kind: "asset", assetId: "u", amount: 7n }, { ...usdc, assetId: "u" }, usdc)).toBe(7n);
    expect(settlementEstimate(fiat, { ...usdc, assetId: "u" }, null)).toBe(2_000_000n);
    expect(settlementEstimate(fiat, { ...near, assetId: "n" }, null)).toBe(8n * 10n ** 23n);
    expect(settlementEstimate(fiat, { ...near, priceUsd: null, assetId: "n" }, null)).toBeNull();
    expect(settlementEstimate(fiat, { ...near, priceUsd: "bad", assetId: "n" }, null)).toBeNull();
    expect(settlementEstimate(fiat, { ...near, priceUsd: "0", assetId: "n" }, null)).toBeNull();
    expect(
      settlementEstimate({ kind: "fiat", currency: "eur", amount: 1n }, { ...usdc, assetId: "u" }, null),
    ).toBeNull();
  });
});

describe("statement lines", () => {
  const intent = {
    currency: "usd",
    amount: 200n,
    settlementAssetId: "usdc",
    settlementDecimals: 6,
    settlementSymbol: "USDC",
  };
  it("payment of a route quote: gross in fiat, fee in bps of amountIn in the origin asset", () => {
    const l = statementLine({
      type: "payment",
      intent,
      attempt: {
        method: "route_quote",
        settled: 2_000_123n,
        appliedFeeBps: 50,
        originAssetId: "base-usdc",
        amountIn: 2_010_000n,
        requirementFee: null,
      },
    });
    expect(l).toMatchObject({
      grossAmount: 200n,
      grossCurrency: "usd",
      settledAmount: 2_000_123n,
      feeBps: 50,
      feeAmountEst: 10_050n,
      feeAssetId: "base-usdc",
    });
  });
  it("payment of an intents transfer: the requirement's fee transfer in the settlement asset", () => {
    const l = statementLine({
      type: "payment",
      intent,
      attempt: {
        method: "intents_transfer",
        settled: 2_000_000n,
        appliedFeeBps: 30,
        originAssetId: "usdc",
        amountIn: null,
        requirementFee: 6_000n,
      },
    });
    expect(l).toMatchObject({ feeBps: 30, feeAmountEst: 6_000n, feeAssetId: "usdc" });
  });
  it("overpayments and asset-priced payments carry no gross; no fee without a quote", () => {
    const over = statementLine({
      type: "overpayment",
      intent,
      attempt: {
        method: "route_quote",
        settled: 5n,
        appliedFeeBps: 50,
        originAssetId: "o",
        amountIn: 10n,
        requirementFee: null,
      },
    });
    expect(over).toMatchObject({ grossAmount: null, grossCurrency: null, feeBps: null });
    const asset = statementLine({
      type: "payment",
      intent: { ...intent, currency: "asset", amount: null },
      attempt: {
        method: "route_quote",
        settled: 5n,
        appliedFeeBps: null,
        originAssetId: "o",
        amountIn: null,
        requirementFee: null,
      },
    });
    expect(asset).toMatchObject({ grossAmount: null, feeBps: null, feeAmountEst: null });
  });
});
