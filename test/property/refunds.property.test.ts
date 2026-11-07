/**
 * Property tests (lld/payments.md §15; INV-2, INV-3, INV-5): random interleavings of merchant actions
 * (create, cancel, prepare, relay) and leg execution events (incl. duplicates, reordering, late
 * settlements of canceled/failed refunds, duplicate legs) applied with the same domain functions the use
 * cases use. After every step:
 * - Σ refunded + Σ pending ≤ settled (never more refunded than settled), and the budget equals the
 *   refunds' own records (pending = reserved refunds, refunded = counted successes);
 * - a refund succeeds at most once (one `refund.succeeded`);
 * - every unit that left the merchant through a settled leg is accounted: Σ settled legs = counted + extra.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyDecision,
  type Budget,
  canCancel,
  isConsistent,
  LEG_TERMINAL,
  type LegStatus,
  legStatusOf,
  onLegChange,
  prepareMode,
  type RefundBook,
  release,
  reserve,
} from "../../src/domain/refund/refund.js";

interface Leg {
  id: string;
  status: LegStatus;
  deadline: Date;
}
interface R {
  book: RefundBook;
  legs: Leg[];
  current: string;
  succeededEvents: number;
}

type Cmd =
  | { t: "create"; amount: bigint }
  | { t: "leg"; r: number; l: number; to: LegStatus }
  | { t: "cancel"; r: number }
  | { t: "prepare"; r: number }
  | { t: "relay"; r: number }
  | { t: "relay_start"; r: number }
  | { t: "relay_end"; r: number; accepted: boolean };

const LEG_TARGETS: LegStatus[] = ["processing", "succeeded", "returned", "failed", "expired", "held"];
const TERMINAL = new Set<LegStatus>(["succeeded", "returned", "failed"]);

const cmd = fc.oneof(
  { weight: 2, arbitrary: fc.bigInt({ min: 1n, max: 120n }).map((amount) => ({ t: "create", amount }) as Cmd) },
  {
    weight: 6,
    arbitrary: fc
      .record({ r: fc.nat(4), l: fc.nat(3), to: fc.constantFrom(...LEG_TARGETS) })
      .map((o) => ({ t: "leg", ...o }) as Cmd),
  },
  { weight: 1, arbitrary: fc.nat(4).map((r) => ({ t: "cancel", r }) as Cmd) },
  { weight: 2, arbitrary: fc.nat(4).map((r) => ({ t: "prepare", r }) as Cmd) },
  { weight: 1, arbitrary: fc.nat(4).map((r) => ({ t: "relay", r }) as Cmd) },
  // finding 5: a relay is two steps (submitting under the lock, then agentpay's answer)
  { weight: 1, arbitrary: fc.nat(4).map((r) => ({ t: "relay_start", r }) as Cmd) },
  {
    weight: 1,
    arbitrary: fc.record({ r: fc.nat(4), accepted: fc.boolean() }).map((o) => ({ t: "relay_end", ...o }) as Cmd),
  },
);

function run(settled: bigint, cmds: Cmd[]) {
  let budget: Budget = { settled, refunded: 0n, pending: 0n };
  const refunds: R[] = [];
  let n = 0;
  const now = Date.now();
  const newLeg = (): Leg => ({ id: `L${++n}`, status: "awaiting_signature", deadline: new Date(now + 60_000) });

  const applyLeg = (r: R, leg: Leg, to: LegStatus) => {
    const from = leg.status;
    const others = r.legs.filter((g) => g !== leg).map((g) => g.status);
    leg.status = to;
    const d = onLegChange({ status: r.book.status, currentLegId: r.current }, { id: leg.id, from, to }, others);
    const out = applyDecision(r.book, budget, d, r.book.amount);
    r.book = out.book;
    budget = out.budget;
    if (d.events.includes("evt.payments.refund.succeeded")) r.succeededEvents++;
  };

  for (const c of cmds) {
    if (c.t === "create") {
      const b = reserve(budget, c.amount);
      if (!b) continue;
      budget = b;
      const leg = newLeg();
      refunds.push({
        book: { status: "requires_action", amount: c.amount, counted: 0n, extra: 0n },
        legs: [leg],
        current: leg.id,
        succeededEvents: 0,
      });
    } else {
      const r = refunds[c.r];
      if (!r) continue;
      const cur = r.legs.find((g) => g.id === r.current) as Leg;
      const statuses = r.legs.map((g) => g.status);
      if (c.t === "leg") {
        const leg = r.legs[c.l];
        if (!leg || TERMINAL.has(leg.status)) continue; // rails never leaves a terminal state
        applyLeg(r, leg, c.to);
      } else if (c.t === "cancel") {
        if (canCancel(r.book.status, { status: cur.status, deadline: cur.deadline, submittedTx: null }, statuses))
          continue;
        budget = release(budget, r.book.amount);
        r.book = { ...r.book, status: "canceled" };
      } else if (c.t === "prepare") {
        const mode = prepareMode(
          r.book.status,
          { status: cur.status, deadline: cur.deadline, submittedTx: null },
          statuses,
          now,
        );
        if (mode === "state_conflict" || mode === "leg_expired" || mode === "retry") continue;
        if (mode === "reserve") {
          const b = reserve(budget, r.book.amount);
          if (!b) continue;
          budget = b;
          r.book = { ...r.book, status: "requires_action" };
        }
        const leg = newLeg();
        r.legs.push(leg);
        r.current = leg.id;
      } else if (c.t === "relay") {
        if (r.book.status !== "requires_action" || cur.status !== "awaiting_signature") continue;
        applyLeg(r, cur, "submitted");
      } else if (c.t === "relay_start") {
        if (r.book.status !== "requires_action" || cur.status !== "awaiting_signature") continue;
        applyLeg(r, cur, "submitting");
      } else if (c.t === "relay_end") {
        const leg = r.legs.find((g) => g.status === "submitting");
        if (!leg) continue;
        // the payload left with the refund still holding its reservation: nothing canceled it meanwhile
        if (c.accepted) expect(["requires_action", "pending"]).toContain(r.book.status);
        applyLeg(r, leg, c.accepted ? "submitted" : "awaiting_signature");
      }
    }

    // ---- invariants after every step
    expect(isConsistent(budget)).toBe(true);
    const reserved = refunds
      .filter((r) => r.book.status === "requires_action" || r.book.status === "pending")
      .reduce((s, r) => s + r.book.amount, 0n);
    expect(budget.pending).toBe(reserved);
    const counted = refunds.filter((r) => r.book.status === "succeeded").reduce((s, r) => s + r.book.counted, 0n);
    expect(budget.refunded).toBe(counted);
    for (const r of refunds) {
      expect(r.succeededEvents).toBeLessThanOrEqual(1);
      expect(r.book.counted).toBeLessThanOrEqual(r.book.amount);
      const sent = r.legs.filter((g) => g.status === "succeeded").length;
      expect(BigInt(sent) * r.book.amount).toBe(r.book.counted + r.book.extra);
      if (r.book.status !== "succeeded") expect(r.book.counted).toBe(0n);
    }
  }
  return { budget, refunds };
}

describe("refund interleavings (property)", () => {
  it("Σ refunded ≤ settled, no double success, duplicate and late legs accounted", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 200n }),
        fc.array(cmd, { minLength: 1, maxLength: 80 }),
        (settled, cmds) => {
          run(settled, cmds);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it("a duplicate leg never increases the refunded total", () => {
    const { budget, refunds } = run(100n, [
      { t: "create", amount: 100n },
      { t: "leg", r: 0, l: 0, to: "expired" },
      { t: "prepare", r: 0 },
      { t: "leg", r: 0, l: 1, to: "processing" },
      { t: "leg", r: 0, l: 1, to: "succeeded" },
      { t: "leg", r: 0, l: 0, to: "succeeded" },
    ]);
    expect(budget).toEqual({ settled: 100n, refunded: 100n, pending: 0n });
    expect(refunds[0]?.book).toMatchObject({ status: "succeeded", counted: 100n, extra: 100n });
  });

  it("a cancel racing the relay is refused: the relayed refund keeps its reservation (finding 5)", () => {
    const { budget, refunds } = run(100n, [
      { t: "create", amount: 100n },
      { t: "relay_start", r: 0 },
      { t: "cancel", r: 0 },
      { t: "create", amount: 100n },
      { t: "relay_end", r: 0, accepted: true },
      { t: "leg", r: 0, l: 0, to: "succeeded" },
    ]);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.book).toMatchObject({ status: "succeeded", counted: 100n, extra: 0n });
    expect(budget).toEqual({ settled: 100n, refunded: 100n, pending: 0n });
  });

  it("a canceled refund whose leg settles after another refund took the budget counts only what fits", () => {
    const { budget, refunds } = run(100n, [
      { t: "create", amount: 60n },
      { t: "cancel", r: 0 },
      { t: "create", amount: 70n },
      { t: "leg", r: 0, l: 0, to: "succeeded" },
    ]);
    expect(budget).toEqual({ settled: 100n, refunded: 30n, pending: 70n });
    expect(refunds[0]?.book).toMatchObject({ status: "succeeded", counted: 30n, extra: 30n });
  });
});

describe("leg status from execution states (property, finding 6)", () => {
  const STATES = [
    "quoting",
    "awaiting_deposit",
    "deposit_detected",
    "incomplete_deposit",
    "settling",
    "verifying",
    "succeeded",
    "refunded",
    "failed",
    "expired_unpaid",
    "held",
  ];
  const STARTS: LegStatus[] = ["awaiting_signature", "submitting", "submitted", "processing", "failed", "succeeded"];
  it("a leg that is over only ever follows money that moved", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STARTS),
        fc.array(fc.record({ state: fc.constantFrom(...STATES), evidence: fc.boolean() }), { maxLength: 30 }),
        (start, xs) => {
          let leg = start;
          let over = LEG_TERMINAL.has(leg);
          for (const x of xs) {
            const next = legStatusOf(x.state, x.evidence, leg);
            // never back to a state where the merchant could be asked to sign or send again
            if (over) expect(["awaiting_signature", "submitting", "submitted", "preparing"]).not.toContain(next);
            if (leg !== "awaiting_signature" && leg !== "preparing") expect(next).not.toBe("awaiting_signature");
            leg = next;
            over = over || LEG_TERMINAL.has(leg);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
