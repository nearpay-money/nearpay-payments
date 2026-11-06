/**
 * lld/payments.md §15 property: random interleavings of execution events (duplicates, reordering) and
 * merchant/session actions, applied the way `app/apply.ts` applies decisions, never produce
 * - two attempts that paid the intent (the first settlement wins; later ones are overpayments),
 * - an intent or session that expired on its own while an attempt is non-terminal (INV-3),
 * - a statement whose total differs from the total of settled evidence,
 * - a succeeded intent whose amount differs from its paying attempt's settlement.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { attemptGuard } from "../../src/domain/checkout-session/session.js";
import { type AttemptStatus, IN_FLIGHT, isNewer, TERMINAL } from "../../src/domain/payment-attempt/attempt.js";
import {
  canCancel,
  canExpire,
  type IntentStatus,
  onAttemptChange,
  onSessionDeadline,
  type ReviewReason,
  type SessionStatus,
} from "../../src/domain/payment-intent/intent.js";

interface Attempt {
  id: string;
  status: AttemptStatus;
  applied: number;
  expected: bigint;
  settled: bigint | null;
  /** Execution events rails produced for this attempt (version, state, settled). */
  produced: { v: number; to: AttemptStatus; settled: bigint | null }[];
}

interface World {
  intent: { status: IntentStatus; reviewReason: ReviewReason | null; paidBy: string | null; settled: bigint };
  session: SessionStatus;
  attempts: Attempt[];
  statement: bigint;
  expiredBy: "deadline" | "merchant" | null;
  nextId: number;
}

/** Rails execution paths an attempt may follow (first state after `quoting`). */
const PATHS: AttemptStatus[][] = [
  ["awaiting_deposit", "deposit_detected", "settling", "verifying", "succeeded"],
  ["awaiting_deposit", "deposit_detected", "settling", "verifying", "held", "succeeded"],
  ["awaiting_deposit", "deposit_detected", "settling", "verifying", "held", "refunded"],
  ["awaiting_deposit", "incomplete_deposit", "refunded"],
  ["awaiting_deposit", "expired_unpaid"],
  ["awaiting_deposit", "expired_unpaid", "succeeded"], // late settlement: evidence wins (rails §5)
  ["failed"],
  ["awaiting_deposit", "deposit_detected", "settling", "failed"],
];

function apply(w: World, a: Attempt, to: AttemptStatus, settled: bigint | null) {
  const before = a.status;
  a.status = to;
  if (settled !== null) a.settled = settled;
  const others = w.attempts.filter((x) => x !== a).map((x) => x.status);
  const d = onAttemptChange(
    {
      status: w.intent.status,
      reviewReason: w.intent.reviewReason,
      succeededAttemptId: w.intent.paidBy,
      underpayToleranceBps: 50,
    },
    w.session,
    { id: a.id, from: before, to, expected: a.expected, settled: a.settled },
    others,
  );
  if (d.intent) {
    w.intent.status = d.intent.status;
    w.intent.reviewReason = d.intent.reviewReason;
    if (d.intent.succeededAttemptId) {
      expect(w.intent.paidBy === null || w.intent.paidBy === d.intent.succeededAttemptId).toBe(true);
      w.intent.paidBy = d.intent.succeededAttemptId;
    }
    if (d.intent.amountSettled !== undefined) w.intent.settled = d.intent.amountSettled;
  }
  if (d.session) {
    w.session = d.session.status;
    if (d.session.status === "expired") w.expiredBy = "deadline";
  }
  if (d.statement) w.statement += a.settled ?? 0n;
}

function step(w: World, choice: number, pick: number) {
  const live = w.attempts.filter((a) => a.produced.length > 0);
  switch (choice % 6) {
    case 0: {
      // payer starts an attempt
      const err = attemptGuard({
        session: w.session,
        intent: w.intent.status,
        attempts: w.attempts.map((a) => a.status),
        livemode: false,
        liveAttempts: 0,
        maxLiveAttempts: 5,
        remainingS: 3600,
        minDeadlineS: 0,
        latePayments: false,
      });
      if (err || w.attempts.length >= 4) return;
      const path = PATHS[pick % PATHS.length] as AttemptStatus[];
      const short = pick % 7 === 0;
      const id = `a${w.nextId++}`;
      w.attempts.push({
        id,
        status: "quoting",
        applied: 0,
        expected: 1_000_000n,
        settled: null,
        produced: path.map((to, k) => ({
          v: k + 1,
          to,
          settled: to === "succeeded" ? (short ? 800_000n : 1_000_000n) : null,
        })),
      });
      return;
    }
    case 1:
    case 2: {
      // rails delivers one of an attempt's events: in order, out of order or again (duplicates)
      if (!live.length) return;
      const a = live[pick % live.length] as Attempt;
      const e = a.produced[(pick >> 3) % a.produced.length] as Attempt["produced"][number];
      if (!isNewer(e.v, a.applied)) return; // version check: stale or duplicate → no-op
      // rails emits each version once its predecessors happened; delivering v implies its state
      a.applied = e.v;
      apply(w, a, e.to, e.settled);
      return;
    }
    case 3: {
      const err = canCancel(
        w.intent.status,
        w.attempts.map((a) => a.status),
      );
      if (err) return;
      w.intent.status = "canceled";
      if (w.session === "open" || w.session === "expiring") {
        w.session = "expired";
        w.expiredBy = "merchant";
      }
      return;
    }
    case 4: {
      const err = canExpire(
        w.session,
        w.intent.status,
        w.attempts.map((a) => a.status),
      );
      if (err) return;
      w.session = "expired";
      w.intent.status = "expired";
      w.expiredBy = "merchant";
      return;
    }
    default: {
      const d = onSessionDeadline(
        w.session,
        w.intent.status,
        w.attempts.map((a) => a.status),
      );
      if (!d) return;
      w.session = d.session;
      w.intent.status = d.intent;
      if (d.session === "expired") w.expiredBy = "deadline";
    }
  }
}

function check(w: World) {
  const succeeded = w.attempts.filter((a) => a.status === "succeeded");
  // Σ statement = Σ settled evidence
  expect(w.statement).toBe(succeeded.reduce((s, a) => s + (a.settled ?? 0n), 0n));
  // at most one attempt paid the intent
  if (w.intent.paidBy) expect(succeeded.some((a) => a.id === w.intent.paidBy)).toBe(true);
  if (w.intent.status === "succeeded") {
    const payer = w.attempts.find((a) => a.id === w.intent.paidBy) as Attempt;
    expect(w.intent.settled).toBe(payer.settled);
  }
  // INV-3: nothing expires on its own while money might still arrive
  if (w.expiredBy === "deadline") expect(w.attempts.every((a) => TERMINAL.has(a.status))).toBe(true);
  // a merchant may expire/cancel only with nothing in flight at that moment (attempts then are hidden)
  if (w.intent.status === "succeeded") expect(w.session === "complete" || w.session === "expired").toBe(true);
  if (w.session === "complete") expect(["succeeded"]).toContain(w.intent.status);
  // a deposit in flight on a payable intent always shows as processing (never requires_payment)
  if (w.attempts.some((a) => IN_FLIGHT.has(a.status)) && w.expiredBy === null && w.intent.paidBy === null)
    expect(w.intent.status).not.toBe("requires_payment");
}

describe("interleavings of execution events and actions", () => {
  it("keep the payment invariants", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 120 }), (choices) => {
        const w: World = {
          intent: { status: "requires_payment", reviewReason: null, paidBy: null, settled: 0n },
          session: "open",
          attempts: [],
          statement: 0n,
          expiredBy: null,
          nextId: 1,
        };
        for (const [c, p] of choices) {
          step(w, c, p);
          check(w);
        }
      }),
      { numRuns: 3000 },
    );
  });
});
