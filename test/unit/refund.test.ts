/** Refund domain (lld/payments.md §5, §8.4, §17): budget, leg mapping, refund reactions, guards. */
import { describe, expect, it } from "vitest";
import {
  applyDecision,
  type Budget,
  budgetOf,
  canCancel,
  canChangeRecipient,
  canSubmit,
  commit,
  isConsistent,
  isTransientRailError,
  type LegStatus,
  lateCommit,
  legIdempotencyKey,
  legStatusOf,
  onLegChange,
  prepareErrorOf,
  prepareMode,
  refundable,
  release,
  reserve,
  swapTypeOf,
} from "../../src/domain/refund/refund.js";

const B = (settled: bigint, refunded = 0n, pending = 0n): Budget => ({ settled, refunded, pending });

describe("budget", () => {
  it("reserves only what is refundable and positive", () => {
    expect(refundable(B(100n, 30n, 20n))).toBe(50n);
    expect(refundable(B(10n, 10n, 5n))).toBe(0n);
    expect(reserve(B(100n), 100n)).toEqual(B(100n, 0n, 100n));
    expect(reserve(B(100n, 50n), 51n)).toBeNull();
    expect(reserve(B(100n), 0n)).toBeNull();
    expect(reserve(B(100n), -1n)).toBeNull();
  });
  it("commits and releases reservations, refusing more than pending", () => {
    expect(commit(B(100n, 0n, 40n), 40n)).toEqual(B(100n, 40n, 0n));
    expect(release(B(100n, 0n, 40n), 40n)).toEqual(B(100n, 0n, 0n));
    expect(() => commit(B(100n, 0n, 10n), 11n)).toThrow(RangeError);
    expect(() => release(B(100n, 0n, 10n), 11n)).toThrow(RangeError);
  });
  it("a late success counts what fits and records the rest as extra (INV-3)", () => {
    expect(lateCommit(B(100n, 0n, 70n), 50n)).toEqual({ budget: B(100n, 30n, 70n), counted: 30n, extra: 20n });
    expect(lateCommit(B(100n), 40n)).toEqual({ budget: B(100n, 40n, 0n), counted: 40n, extra: 0n });
    expect(isConsistent(B(100n, 60n, 40n))).toBe(true);
    expect(isConsistent(B(100n, 61n, 40n))).toBe(false);
  });
});

describe("creation", () => {
  const paid = { status: "succeeded", succeededAttemptId: "a1" };
  it("chooses the intent budget for the paying attempt and the attempt budget otherwise", () => {
    expect(budgetOf(paid, { id: "a1", status: "succeeded", settled: 5n })).toBe("intent");
    expect(budgetOf(paid, { id: "a2", status: "succeeded", settled: 5n })).toBe("attempt");
    expect(
      budgetOf({ status: "requires_review", succeededAttemptId: "a1" }, { id: "a1", status: "succeeded", settled: 5n }),
    ).toBe("intent_not_succeeded");
    expect(budgetOf(paid, { id: "a3", status: "held", settled: 5n })).toBe("attempt_not_settled");
    expect(budgetOf(paid, { id: "a3", status: "succeeded", settled: null })).toBe("attempt_not_settled");
    expect(budgetOf(paid, { id: "a3", status: "succeeded", settled: 0n })).toBe("attempt_not_settled");
  });
  it("maps fee modes, keys and rail errors", () => {
    expect(swapTypeOf("payer_absorbs")).toBe("EXACT_INPUT");
    expect(swapTypeOf("merchant_absorbs")).toBe("EXACT_OUTPUT");
    expect(legIdempotencyKey("re_x", 2)).toBe("refund:re_x:leg:2");
    for (const c of [null, "api_error", "idempotency_in_progress", "rate_limited", "rail_unavailable"])
      expect(isTransientRailError(c)).toBe(true);
    expect(isTransientRailError("screening_blocked")).toBe(false);
    expect(prepareErrorOf("deadline_too_short", null)).toBe("route_unavailable");
    expect(prepareErrorOf("quote_integrity_failed", null)).toBe("quote_rejected");
    expect(prepareErrorOf("invalid_request", "recipient.address")).toBe("refund_address_invalid");
    expect(prepareErrorOf("invalid_request", "amount")).toBe("invalid_request");
    expect(prepareErrorOf("screening_blocked", null)).toBe("screening_blocked");
  });
});

describe("leg status from the execution", () => {
  it("never succeeds without evidence (INV-2) and keeps a submitted leg until the deposit shows", () => {
    expect(legStatusOf("awaiting_deposit", false, "preparing")).toBe("awaiting_signature");
    expect(legStatusOf("awaiting_deposit", false, "submitted")).toBe("submitted");
    expect(legStatusOf("quoting", false, "preparing")).toBe("awaiting_signature");
    for (const s of ["deposit_detected", "incomplete_deposit", "settling", "verifying"])
      expect(legStatusOf(s, false, "submitted")).toBe("processing");
    expect(legStatusOf("succeeded", true, "processing")).toBe("succeeded");
    expect(legStatusOf("succeeded", false, "processing")).toBe("held");
    expect(legStatusOf("refunded", false, "processing")).toBe("returned");
    expect(legStatusOf("failed", false, "processing")).toBe("failed");
    expect(legStatusOf("expired_unpaid", false, "awaiting_signature")).toBe("expired");
    expect(legStatusOf("held", false, "processing")).toBe("held");
    expect(legStatusOf("something_new", false, "processing")).toBe("held");
  });
});

describe("refund reactions (§5 table)", () => {
  const ra = { status: "requires_action" as const, currentLegId: "L1" };
  it("pending when the merchant's funds move; nothing more while pending", () => {
    const d = onLegChange(ra, { id: "L1", from: "awaiting_signature", to: "processing" }, []);
    expect(d).toMatchObject({ status: "pending", events: ["evt.payments.refund.pending"], budget: "none" });
    expect(
      onLegChange({ ...ra, status: "pending" }, { id: "L1", from: "processing", to: "held" }, []).status,
    ).toBeNull();
    expect(onLegChange(ra, { id: "L1", from: "awaiting_signature", to: "submitted" }, []).status).toBe("pending");
  });
  it("succeeds on payer-side evidence, committing the reservation", () => {
    const d = onLegChange({ ...ra, status: "pending" }, { id: "L1", from: "processing", to: "succeeded" }, []);
    expect(d).toMatchObject({ status: "succeeded", budget: "commit", statement: true, duplicate: false });
    expect(d.events).toEqual(["evt.payments.refund.succeeded"]);
  });
  it("a second settling leg is a duplicate with its own statement line", () => {
    const d = onLegChange(
      { status: "succeeded", currentLegId: "L2" },
      { id: "L1", from: "processing", to: "succeeded" },
      [],
    );
    expect(d).toMatchObject({ status: null, duplicate: true, statement: true, budget: "none", events: [] });
  });
  it("canceled or failed refunds still succeed when an older leg settles (INV-3)", () => {
    for (const status of ["canceled", "failed"] as const) {
      const d = onLegChange({ status, currentLegId: "L2" }, { id: "L1", from: "processing", to: "succeeded" }, []);
      expect(d).toMatchObject({ status: "succeeded", budget: "late_commit", statement: true });
    }
  });
  it("fails when the current leg is returned or failed and nothing else moves", () => {
    for (const to of ["returned", "failed"] as const) {
      expect(onLegChange({ ...ra, status: "pending" }, { id: "L1", from: "processing", to }, [])).toMatchObject({
        status: "failed",
        budget: "release",
        events: ["evt.payments.refund.failed"],
      });
      expect(onLegChange(ra, { id: "L1", from: "awaiting_signature", to }, []).status).toBe("failed");
    }
    // another leg still in flight: stay
    expect(
      onLegChange({ ...ra, status: "pending" }, { id: "L1", from: "processing", to: "returned" }, ["processing"])
        .status,
    ).toBeNull();
    // an old leg returned while the current one waits: nothing
    expect(
      onLegChange({ ...ra, currentLegId: "L2" }, { id: "L1", from: "expired", to: "returned" }, ["awaiting_signature"])
        .status,
    ).toBeNull();
    // terminal refunds ignore failures of their legs
    expect(
      onLegChange({ status: "succeeded", currentLegId: "L1" }, { id: "L2", from: "processing", to: "returned" }, [])
        .status,
    ).toBeNull();
  });
  it("an expired current leg waits for prepare; a pending refund whose payload expired fails", () => {
    expect(onLegChange(ra, { id: "L1", from: "awaiting_signature", to: "expired" }, []).status).toBeNull();
    expect(onLegChange({ ...ra, status: "pending" }, { id: "L1", from: "submitted", to: "expired" }, []).status).toBe(
      "failed",
    );
  });
  it("ignores no-ops and non-money statuses", () => {
    expect(onLegChange(ra, { id: "L1", from: "processing", to: "processing" }, []).status).toBeNull();
    expect(onLegChange(ra, { id: "L1", from: "preparing", to: "awaiting_signature" }, []).status).toBeNull();
  });
  it("applies decisions to the money fields", () => {
    const book = { status: "pending" as const, amount: 40n, counted: 0n, extra: 0n };
    const ok = applyDecision(
      book,
      B(100n, 0n, 40n),
      onLegChange({ status: "pending", currentLegId: "L1" }, { id: "L1", from: "processing", to: "succeeded" }, []),
      40n,
    );
    expect(ok).toEqual({
      book: { status: "succeeded", amount: 40n, counted: 40n, extra: 0n },
      budget: B(100n, 40n, 0n),
    });
    const dup = applyDecision(
      ok.book,
      ok.budget,
      onLegChange({ status: "succeeded", currentLegId: "L2" }, { id: "L1", from: "processing", to: "succeeded" }, []),
      41n,
    );
    expect(dup.book.extra).toBe(41n);
    expect(dup.budget).toEqual(ok.budget);
    const late = applyDecision(
      { ...book, status: "canceled" },
      B(100n, 0n, 80n),
      onLegChange({ status: "canceled", currentLegId: "L1" }, { id: "L1", from: "processing", to: "succeeded" }, []),
      40n,
    );
    expect(late.book).toEqual({ status: "succeeded", amount: 40n, counted: 20n, extra: 20n });
    const failed = applyDecision(
      book,
      B(100n, 0n, 40n),
      onLegChange({ status: "pending", currentLegId: "L1" }, { id: "L1", from: "processing", to: "failed" }, []),
      40n,
    );
    expect(failed.budget).toEqual(B(100n));
  });
});

describe("merchant actions", () => {
  const leg = (status: LegStatus, o: Partial<{ deadline: Date | null; submittedTx: string | null }> = {}) => ({
    status,
    deadline: new Date(Date.now() + 60_000),
    submittedTx: null,
    ...o,
  });
  const now = Date.now();
  it("cancel only before anything was submitted", () => {
    expect(canCancel("requires_action", leg("awaiting_signature"), ["awaiting_signature"])).toBeNull();
    expect(canCancel("requires_action", leg("preparing"), ["preparing"])).toBeNull();
    expect(canCancel("requires_action", leg("submitted", { submittedTx: "0xab" }), ["submitted"])).toBe(
      "state_conflict",
    );
    expect(canCancel("requires_action", leg("awaiting_signature"), ["awaiting_signature", "processing"])).toBe(
      "state_conflict",
    );
    expect(canCancel("pending", leg("processing"), ["processing"])).toBe("state_conflict");
    expect(canCancel("requires_action", null, [])).toBeNull();
  });
  it("prepare retries an unprepared leg, replaces an expired one, re-reserves a failed refund", () => {
    expect(prepareMode("requires_action", leg("preparing"), ["preparing"], now)).toBe("retry");
    expect(prepareMode("requires_action", leg("expired"), ["expired"], now)).toBe("new_leg");
    expect(prepareMode("requires_action", leg("failed"), ["failed"], now)).toBe("new_leg");
    expect(prepareMode("requires_action", leg("awaiting_signature", { deadline: new Date(now - 1) }), [], now)).toBe(
      "new_leg",
    );
    expect(prepareMode("requires_action", leg("awaiting_signature"), ["awaiting_signature"], now)).toBe(
      "state_conflict",
    );
    expect(prepareMode("requires_action", null, [], now)).toBe("new_leg");
    expect(prepareMode("failed", leg("returned"), ["returned"], now)).toBe("reserve");
    expect(prepareMode("failed", leg("returned"), ["returned", "held"], now)).toBe("state_conflict");
    expect(prepareMode("succeeded", leg("succeeded"), ["succeeded"], now)).toBe("state_conflict");
    expect(prepareMode("canceled", leg("expired"), ["expired"], now)).toBe("state_conflict");
  });
  it("submit needs an open leg awaiting its signature", () => {
    expect(canSubmit("requires_action", leg("awaiting_signature"), now)).toBeNull();
    expect(canSubmit("requires_action", leg("submitted"), now)).toBeNull();
    expect(canSubmit("requires_action", leg("awaiting_signature", { deadline: new Date(now - 1) }), now)).toBe(
      "leg_expired",
    );
    expect(canSubmit("requires_action", leg("awaiting_signature", { deadline: null }), now)).toBe("leg_expired");
    expect(canSubmit("requires_action", leg("expired"), now)).toBe("leg_expired");
    expect(canSubmit("requires_action", leg("preparing"), now)).toBe("state_conflict");
    expect(canSubmit("pending", leg("processing"), now)).toBe("state_conflict");
    expect(canSubmit("requires_action", null, now)).toBe("state_conflict");
  });
  it("recipient override before anything moved; failed refunds re-reserve", () => {
    expect(canChangeRecipient("requires_action", leg("awaiting_signature"), ["awaiting_signature"])).toBe("ok");
    expect(canChangeRecipient("failed", leg("returned"), ["returned"])).toBe("reserve");
    expect(canChangeRecipient("requires_action", leg("submitted", { submittedTx: "0x" }), [])).toBe("state_conflict");
    expect(canChangeRecipient("requires_action", leg("awaiting_signature"), ["processing"])).toBe("state_conflict");
    expect(canChangeRecipient("succeeded", leg("succeeded"), [])).toBe("state_conflict");
  });
});
