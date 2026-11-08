/** Spec 0.2.1 domain rules: orphaned refund legs (`abandonExecution`) and customer total deltas. */
import { describe, expect, it } from "vitest";
import { contributionOf, totalsDelta } from "../../src/domain/customer/totals.js";
import { abandonReasonOf } from "../../src/domain/refund/refund.js";

const base = {
  legStatus: "failed" as const,
  failureCode: null,
  refundStatus: "requires_action" as const,
  current: true,
  executionState: "awaiting_deposit",
};

describe("abandonReasonOf", () => {
  it("late create response after cancel / override / failure (finding 6)", () => {
    expect(abandonReasonOf({ ...base, refundStatus: "canceled", failureCode: "canceled" })).toBe("refund_canceled");
    expect(abandonReasonOf({ ...base, failureCode: "superseded", current: false })).toBe("superseded");
    expect(abandonReasonOf({ ...base, failureCode: "execution_mismatch" })).toBe("execution_mismatch");
    expect(abandonReasonOf({ ...base, failureCode: "rail_timeout" })).toBe("leg_failed");
    expect(abandonReasonOf({ ...base, executionState: "quoting", failureCode: "canceled" })).toBe("refund_canceled");
  });

  it("legs canceled or replaced before any deposit", () => {
    const waiting = { ...base, legStatus: "awaiting_signature" as const, executionState: null };
    expect(abandonReasonOf({ ...waiting, refundStatus: "canceled", current: false })).toBe("refund_canceled");
    expect(abandonReasonOf({ ...waiting, current: false })).toBe("superseded");
    // the current leg waiting for its signature is still used
    expect(abandonReasonOf(waiting)).toBeNull();
  });

  it("never when money may have moved", () => {
    for (const executionState of ["deposit_detected", "settling", "succeeded", "refunded", "failed", "expired_unpaid"])
      expect(abandonReasonOf({ ...base, executionState, failureCode: "canceled" })).toBeNull();
    for (const legStatus of ["submitted", "submitting", "processing", "held", "succeeded", "returned"] as const) {
      expect(abandonReasonOf({ ...base, legStatus, executionState: null, refundStatus: "canceled" })).toBeNull();
      expect(abandonReasonOf({ ...base, legStatus, refundStatus: "canceled" })).toBeNull();
    }
    // an expired leg (rails already expired it) or a preparing leg: nothing to abandon from the leg alone
    expect(abandonReasonOf({ ...base, legStatus: "expired", executionState: null })).toBeNull();
    expect(abandonReasonOf({ ...base, legStatus: "preparing", executionState: null })).toBeNull();
    expect(abandonReasonOf({ ...base, legStatus: "expired" })).toBe("leg_failed");
    expect(abandonReasonOf({ ...base, legStatus: "preparing" })).toBeNull();
  });
});

describe("customer total deltas", () => {
  const fiat = {
    status: "succeeded",
    customer_id: "c1",
    currency: "usd",
    amount: "1999",
    pricing_asset_id: null,
    pricing_asset_amount: null,
  };
  const asset = {
    ...fiat,
    currency: "asset",
    amount: null,
    pricing_asset_id: "nep141:usdc.near",
    pricing_asset_amount: "7",
  };

  it("counts succeeded intents with a customer, per currency or pricing asset", () => {
    expect(contributionOf(fiat)).toEqual({ customer: "c1", currency: "usd", assetId: "", amount: 1999n });
    expect(contributionOf(asset)).toEqual({
      customer: "c1",
      currency: "asset",
      assetId: "nep141:usdc.near",
      amount: 7n,
    });
    expect(contributionOf({ ...fiat, customer_id: null })).toBeNull();
    expect(contributionOf({ ...fiat, status: "processing" })).toBeNull();
    expect(contributionOf({ ...fiat, amount: null })).toBeNull();
    expect(contributionOf({ ...asset, pricing_asset_id: null })).toMatchObject({ assetId: "" });
  });

  it("enters on success, leaves on a change away from it, moves with the customer", () => {
    expect(totalsDelta({ ...fiat, status: "processing" }, fiat)).toEqual({ remove: null, add: contributionOf(fiat) });
    expect(totalsDelta(null, fiat)).toEqual({ remove: null, add: contributionOf(fiat) });
    expect(totalsDelta(fiat, { ...fiat, status: "canceled" })).toEqual({ remove: contributionOf(fiat), add: null });
    const moved = { ...fiat, customer_id: "c2" };
    expect(totalsDelta(fiat, moved)).toEqual({ remove: contributionOf(fiat), add: contributionOf(moved) });
    expect(totalsDelta(fiat, { ...fiat, amount: "2000" }).remove).not.toBeNull();
  });
});
