/** lld/payments.md §5: every row of the PaymentIntent / CheckoutSession tables, plus the refinements. */
import { describe, expect, it } from "vitest";
import type { AttemptStatus } from "../../src/domain/payment-attempt/attempt.js";
import {
  canCancel,
  canExpire,
  type IntentState,
  isFullSettlement,
  onAttemptChange,
  onSessionDeadline,
} from "../../src/domain/payment-intent/intent.js";

const intent = (o: Partial<IntentState> = {}): IntentState => ({
  status: "requires_payment",
  reviewReason: null,
  succeededAttemptId: null,
  underpayToleranceBps: 0,
  ...o,
});
const change = (
  from: AttemptStatus,
  to: AttemptStatus,
  o: { settled?: bigint | null; expected?: bigint | null; id?: string } = {},
) => ({
  id: o.id ?? "a1",
  from,
  to,
  expected: o.expected === undefined ? 1_000_000n : o.expected,
  settled: o.settled === undefined ? null : o.settled,
});

describe("isFullSettlement", () => {
  it("compares against expected × (1 − tolerance)", () => {
    expect(isFullSettlement(1_000_000n, 1_000_000n, 0)).toBe(true);
    expect(isFullSettlement(999_999n, 1_000_000n, 0)).toBe(false);
    expect(isFullSettlement(990_000n, 1_000_000n, 100)).toBe(true);
    expect(isFullSettlement(989_999n, 1_000_000n, 100)).toBe(false);
  });
  it("without an expected amount only a positive settlement counts", () => {
    expect(isFullSettlement(1n, null, 0)).toBe(true);
    expect(isFullSettlement(0n, null, 0)).toBe(false);
  });
});

describe("onAttemptChange", () => {
  it("ignores a change without a status change", () => {
    const d = onAttemptChange(intent(), "open", change("awaiting_deposit", "awaiting_deposit"), []);
    expect(d.intent).toBeNull();
    expect(d.intentEvents).toEqual([]);
  });

  it("requires_payment → processing when a deposit is detected (deposit_detected/settling/incomplete_deposit)", () => {
    for (const to of ["deposit_detected", "settling", "incomplete_deposit", "verifying"] as const) {
      const d = onAttemptChange(intent(), "open", change("awaiting_deposit", to), []);
      expect(d.intent).toEqual({ status: "processing", reviewReason: null });
      expect(d.intentEvents).toEqual(["evt.payments.payment_intent.processing"]);
    }
  });

  it("processing stays processing while the attempt moves within flight", () => {
    const d = onAttemptChange(intent({ status: "processing" }), "open", change("deposit_detected", "settling"), []);
    expect(d.intent).toBeNull();
  });

  it("processing → requires_payment (session open) when the attempt fails and nothing else is in flight", () => {
    for (const to of ["refunded", "failed", "expired_unpaid"] as const) {
      const d = onAttemptChange(intent({ status: "processing" }), "open", change("settling", to), ["failed"]);
      expect(d.intent).toEqual({ status: "requires_payment", reviewReason: null });
      expect(d.intentEvents).toEqual(["evt.payments.payment_intent.payment_failed"]);
      expect(d.session).toBeNull();
    }
  });

  it("processing stays processing when another attempt is still in flight", () => {
    const d = onAttemptChange(intent({ status: "processing" }), "open", change("settling", "failed"), ["verifying"]);
    expect(d.intent).toBeNull();
    expect(d.intentEvents).toEqual([]);
  });

  it("processing → expired with the session when it is expiring and every attempt is terminal (INV-3)", () => {
    const d = onAttemptChange(intent({ status: "processing" }), "expiring", change("settling", "refunded"), ["failed"]);
    expect(d.intent).toEqual({ status: "expired", reviewReason: null });
    expect(d.session).toEqual({ status: "expired", late: false });
    expect(d.intentEvents).toEqual([
      "evt.payments.payment_intent.payment_failed",
      "evt.payments.payment_intent.expired",
    ]);
    expect(d.sessionEvents).toEqual(["evt.payments.checkout_session.expired"]);
  });

  it("an expiring session stays expiring while an older attempt can still settle (late payments, INV-3)", () => {
    const d = onAttemptChange(intent({ status: "processing" }), "expiring", change("settling", "failed"), [
      "awaiting_deposit",
    ]);
    expect(d.intent).toEqual({ status: "requires_payment", reviewReason: null });
    expect(d.session).toBeNull();
  });

  it("an unpaid intent with an expiring session expires when its last live attempt lapses", () => {
    const d = onAttemptChange(intent(), "expiring", change("awaiting_deposit", "expired_unpaid"), []);
    expect(d.intent).toEqual({ status: "expired", reviewReason: null });
    expect(d.sessionEvents).toEqual(["evt.payments.checkout_session.expired"]);
  });

  it("an attempt that lapses while the session is open changes nothing", () => {
    const d = onAttemptChange(intent(), "open", change("awaiting_deposit", "expired_unpaid"), []);
    expect(d.intent).toBeNull();
    expect(d.session).toBeNull();
  });

  it("requires_payment/processing → succeeded on a full settlement; session completes", () => {
    for (const status of ["requires_payment", "processing"] as const) {
      const d = onAttemptChange(
        intent({ status }),
        "open",
        change("verifying", "succeeded", { settled: 1_000_000n }),
        [],
      );
      expect(d.intent).toMatchObject({
        status: "succeeded",
        succeededAttemptId: "a1",
        amountSettled: 1_000_000n,
        succeeded: true,
        late: false,
      });
      expect(d.session).toEqual({ status: "complete", late: false });
      expect(d.statement).toBe("payment");
      expect(d.intentEvents).toEqual(["evt.payments.payment_intent.succeeded"]);
      expect(d.sessionEvents).toEqual(["evt.payments.checkout_session.completed"]);
    }
  });

  it("a success after the session started expiring is late but honoured", () => {
    const d = onAttemptChange(intent(), "expiring", change("verifying", "succeeded", { settled: 1_000_000n }), []);
    expect(d.intent).toMatchObject({ status: "succeeded", late: true });
    expect(d.session).toEqual({ status: "complete", late: true });
  });

  it("a success with the session already expired (merchant) is late; the session is not reopened", () => {
    const d = onAttemptChange(intent(), "expired", change("verifying", "succeeded", { settled: 1_000_000n }), []);
    expect(d.intent).toMatchObject({ status: "succeeded", late: true });
    expect(d.session).toBeNull();
    expect(d.sessionEvents).toEqual([]);
  });

  it("succeeded within the underpay tolerance", () => {
    const d = onAttemptChange(
      intent({ underpayToleranceBps: 50 }),
      "open",
      change("verifying", "succeeded", { settled: 995_000n }),
      [],
    );
    expect(d.intent?.status).toBe("succeeded");
  });

  it("a short settlement → requires_review (short_settlement) with a statement line at the actual amount", () => {
    const d = onAttemptChange(
      intent({ status: "processing" }),
      "open",
      change("verifying", "succeeded", { settled: 900_000n }),
      [],
    );
    expect(d.intent).toMatchObject({
      status: "requires_review",
      reviewReason: "short_settlement",
      amountSettled: 900_000n,
      succeededAttemptId: "a1",
    });
    expect(d.session).toBeNull();
    expect(d.statement).toBe("payment");
    expect(d.intentEvents).toEqual(["evt.payments.payment_intent.requires_review"]);
  });

  it("any non-terminal intent → requires_review (verification_held) when an attempt is held", () => {
    for (const status of ["requires_payment", "processing"] as const) {
      const d = onAttemptChange(intent({ status }), "open", change("verifying", "held"), []);
      expect(d.intent).toEqual({ status: "requires_review", reviewReason: "verification_held" });
      expect(d.intentEvents).toEqual(["evt.payments.payment_intent.requires_review"]);
    }
  });

  it("a held attempt on a terminal intent changes nothing", () => {
    const d = onAttemptChange(
      intent({ status: "succeeded", succeededAttemptId: "a0" }),
      "complete",
      change("verifying", "held"),
      [],
    );
    expect(d.intent).toBeNull();
  });

  it("a held attempt the provider resumes puts the intent back in processing", () => {
    const st = intent({ status: "requires_review", reviewReason: "verification_held" });
    const d = onAttemptChange(st, "open", change("held", "settling"), []);
    expect(d.intent).toEqual({ status: "processing", reviewReason: null });
  });

  it("resuming one held attempt while another stays held keeps the review", () => {
    const st = intent({ status: "requires_review", reviewReason: "verification_held" });
    expect(onAttemptChange(st, "open", change("held", "settling"), ["held"]).intent).toBeNull();
  });

  it("a held attempt that ends refunded makes the intent payable again", () => {
    const st = intent({ status: "requires_review", reviewReason: "verification_held" });
    const d = onAttemptChange(st, "open", change("held", "refunded"), []);
    expect(d.intent).toEqual({ status: "requires_payment", reviewReason: null });
    expect(d.intentEvents).toEqual(["evt.payments.payment_intent.payment_failed"]);
  });

  it("a held review pays on the next verified success (held is not a settlement)", () => {
    const st = intent({ status: "requires_review", reviewReason: "verification_held" });
    const d = onAttemptChange(st, "open", change("verifying", "succeeded", { settled: 1_000_000n, id: "a2" }), [
      "held",
    ]);
    // requires_review is not requires_payment/processing; but held reviews are not "paid": the success counts
    expect(d.overpayment).toBeNull();
    expect(d.intent?.status).toBe("succeeded");
  });

  it("the first settlement wins: later successes are overpayments (duplicate / after_cancel / after_expiry)", () => {
    const cases = [
      [intent({ status: "succeeded", succeededAttemptId: "a0" }), "duplicate"],
      [intent({ status: "requires_review", reviewReason: "short_settlement", succeededAttemptId: "a0" }), "duplicate"],
      [intent({ status: "canceled" }), "after_cancel"],
      [intent({ status: "expired" }), "after_expiry"],
      [intent({ status: "processing", succeededAttemptId: "a0" }), "duplicate"],
    ] as const;
    for (const [st, reason] of cases) {
      const d = onAttemptChange(
        st,
        "complete",
        change("verifying", "succeeded", { settled: 1_000_000n, id: "a2" }),
        [],
      );
      expect(d.overpayment).toBe(reason);
      expect(d.statement).toBe("overpayment");
      expect(d.intent).toBeNull();
      expect(d.session).toBeNull();
      expect(d.intentEvents).toEqual(["evt.payments.payment_intent.overpaid"]);
    }
  });

  it("quoting → awaiting_deposit changes nothing on the intent", () => {
    expect(onAttemptChange(intent(), "open", change("quoting", "awaiting_deposit"), []).intent).toBeNull();
  });

  it("a quote that fails (quoting → failed) while the intent is unpaid changes nothing", () => {
    const d = onAttemptChange(intent(), "open", change("quoting", "failed"), []);
    expect(d.intent).toBeNull();
    expect(d.intentEvents).toEqual([]);
  });
});

describe("guards", () => {
  it("canCancel: only requires_payment with nothing in flight", () => {
    expect(canCancel("requires_payment", ["awaiting_deposit", "failed"])).toBeNull();
    expect(canCancel("requires_payment", ["settling"])).toBe("attempt_in_flight");
    for (const s of ["processing", "requires_review", "succeeded", "canceled", "expired"] as const)
      expect(canCancel(s, [])).toBe("state_conflict");
  });

  it("canExpire: only an open session of an unpaid intent with nothing in flight or held", () => {
    expect(canExpire("open", "requires_payment", ["awaiting_deposit"])).toBeNull();
    expect(canExpire("open", "requires_payment", ["verifying"])).toBe("attempt_in_flight");
    expect(canExpire("open", "requires_payment", ["held"])).toBe("attempt_in_flight");
    expect(canExpire("open", "requires_review", [])).toBe("state_conflict");
    for (const s of ["expiring", "complete", "expired"] as const)
      expect(canExpire(s, "requires_payment", [])).toBe("state_conflict");
  });

  it("onSessionDeadline: open → expired with the intent when nothing can arrive", () => {
    expect(onSessionDeadline("open", "requires_payment", ["failed", "expired_unpaid"])).toEqual({
      session: "expired",
      intent: "expired",
      sessionEvents: ["evt.payments.checkout_session.expired"],
      intentEvents: ["evt.payments.payment_intent.expired"],
    });
    expect(onSessionDeadline("open", "requires_payment", [])?.session).toBe("expired");
  });

  it("onSessionDeadline: open → expiring while money may still arrive or a review is pending", () => {
    expect(onSessionDeadline("open", "requires_payment", ["awaiting_deposit"])).toMatchObject({
      session: "expiring",
      intent: "requires_payment",
    });
    expect(onSessionDeadline("open", "processing", ["settling"])).toMatchObject({
      session: "expiring",
      intent: "processing",
    });
    expect(onSessionDeadline("open", "requires_review", ["held"])).toMatchObject({
      session: "expiring",
      intent: "requires_review",
    });
  });

  it("onSessionDeadline: no-op unless the session is open", () => {
    for (const s of ["expiring", "complete", "expired"] as const)
      expect(onSessionDeadline(s, "requires_payment", [])).toBeNull();
  });
});
