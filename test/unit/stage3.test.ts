/** Stage 3 domain rules (lld/payments.md §16.1, §20). */
import { validateAddress } from "@nearpay-internal/chains";
import { describe, expect, it } from "vitest";
import { billingIdempotencyKey } from "../../src/app/invoice-sessions.js";
import {
  INVOICE_SESSION_MAX_S,
  INVOICE_SESSION_MIN_S,
  invoiceExpiryProblem,
} from "../../src/domain/checkout-session/session.js";
import { ownedByPayments } from "../../src/domain/payment-attempt/attempt.js";
import {
  defaultOrigin,
  SANDBOX_REFUND_ADDRESSES,
  sandboxStepOf,
} from "../../src/domain/payment-attempt/test-helper.js";
import { evidenceCountProblem } from "../../src/domain/reconciliation/reconcile.js";

describe("invoice session expiry (§20 item 1)", () => {
  const now = 1_800_000_000_000;
  it("accepts 5 minutes … 30 days ahead, inclusive", () => {
    expect(invoiceExpiryProblem(now + INVOICE_SESSION_MIN_S * 1000, now)).toBeNull();
    expect(invoiceExpiryProblem(now + INVOICE_SESSION_MAX_S * 1000, now)).toBeNull();
    expect(invoiceExpiryProblem(now + 86_400_000, now)).toBeNull();
  });
  it("refuses too soon, too late, past and invalid deadlines", () => {
    expect(invoiceExpiryProblem(now + INVOICE_SESSION_MIN_S * 1000 - 1, now)).toMatch(/5 minutes/);
    expect(invoiceExpiryProblem(now - 1, now)).toMatch(/5 minutes/);
    expect(invoiceExpiryProblem(now + INVOICE_SESSION_MAX_S * 1000 + 1, now)).toMatch(/30 days/);
    expect(invoiceExpiryProblem(Number.NaN, now)).toMatch(/valid/);
  });
});

describe("execution owner (§16.1)", () => {
  it("payments owns unlabelled executions (rails < 0.3.0) and its own; never another service's", () => {
    expect(ownedByPayments(undefined)).toBe(true);
    expect(ownedByPayments(null)).toBe(true);
    expect(ownedByPayments("payments")).toBe(true);
    expect(ownedByPayments("agentpay")).toBe(false);
    expect(ownedByPayments("something_new")).toBe(false);
    expect(ownedByPayments("")).toBe(false);
  });
});

describe("test helper (§16.1)", () => {
  it("maps each outcome to its sandbox step", () => {
    expect(sandboxStepOf("succeeded")).toBe("success");
    expect(sandboxStepOf("payment_failed")).toBe("fail");
    expect(sandboxStepOf("refunded")).toBe("refund");
    expect(sandboxStepOf("none")).toBeNull();
  });
  it("defaults to the first available route_quote option", () => {
    const o = (method: string, asset: string, available: boolean) => ({
      method,
      origin_asset_id: asset,
      chain: "eip155:8453",
      available,
    });
    expect(
      defaultOrigin([o("intents_transfer", "a", true), o("route_quote", "b", false), o("route_quote", "c", true)]),
    ).toEqual({ asset: "c", chain: "eip155:8453" });
    expect(defaultOrigin([o("intents_transfer", "a", true), o("route_quote", "b", false)])).toBeNull();
    expect(defaultOrigin([])).toBeNull();
  });
  it("simulated payer refund addresses are valid for a chain of each family and avoid magic words", () => {
    const chainOf = {
      evm: "eip155:8453",
      near: "near:mainnet",
      solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      bitcoin: "bip122:000000000019d6689c085ae165831e93",
    };
    for (const [family, address] of Object.entries(SANDBOX_REFUND_ADDRESSES)) {
      expect(validateAddress(chainOf[family as keyof typeof chainOf], address).ok, family).toBe(true);
      expect(address).not.toMatch(/sanctioned/i);
    }
  });
});

describe("reconciliation evidence count (spec 0.3.1 owner-filtered summary)", () => {
  it("accepts equal owned counts; agentpay executions are in neither the summary nor the listing", () => {
    expect(evidenceCountProblem(3, 3, 3)).toBeNull();
    expect(evidenceCountProblem(0, 0, 0)).toBeNull();
  });
  it("reports a gap or an extra row, and fails closed on rows of other owners", () => {
    expect(evidenceCountProblem(3, 3, 5)).toMatch(/disagree/);
    expect(evidenceCountProblem(6, 6, 5)).toMatch(/disagree/);
    expect(evidenceCountProblem(4, 3, 3)).toMatch(/1 execution\(s\) of other owners/);
  });
});

describe("billing idempotency keys", () => {
  it("are namespaced and stay within 255 characters", () => {
    expect(billingIdempotencyKey("in:in_x:s1")).toBe("billing:in:in_x:s1");
    const long = billingIdempotencyKey("k".repeat(255));
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long).toMatch(/^billing:sha256:[0-9a-f]{64}$/);
    expect(billingIdempotencyKey("k".repeat(255))).toBe(long);
  });
});
