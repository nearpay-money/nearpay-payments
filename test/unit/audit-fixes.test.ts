/**
 * Stage 2 audit fixes (lld/payments.md §18): Turnstile test secrets on local/test only (2), payer client IP
 * and network prefixes, rate-limit windows and the in-process LRU (3), the `submitting` relay state (5),
 * late execution states on legs that are over (6), `max_uses` reservations (12).
 */
import { describe, expect, it } from "vitest";
import { legViews } from "../../src/app/views.js";
import { acceptsPayers } from "../../src/domain/payment-link/link.js";
import { clientIp, estimate, ipPrefix, rolled, take } from "../../src/domain/payment-link/rate-limit.js";
import {
  canCancel,
  canChangeRecipient,
  canSubmit,
  type LegStatus,
  legStatusOf,
  legUpdateOf,
  onLegChange,
  prepareMode,
} from "../../src/domain/refund/refund.js";
import { turnstileClient } from "../../src/infra/clients/turnstile.js";
import { memoryLimiter } from "../../src/infra/rate-limiter.js";

describe("finding 2: Turnstile test secrets", () => {
  it("asks siteverify for a test secret on any stage other than local and test", async () => {
    for (const env of ["server", "staging", "prod", ""]) {
      const calls: string[] = [];
      const f = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ success: false }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const t = turnstileClient({ secret: "1x0000000000000000000000000000000AA", env, fetch: f });
      expect(await t.verify("tok", null)).toBe("failed");
      expect(calls).toHaveLength(1);
    }
  });
});

describe("finding 3: payer client IP (identity L-ID-07) and client networks", () => {
  it("trusts CF-Connecting-IP only on the server stage and the first X-Forwarded-For hop elsewhere", () => {
    expect(clientIp("server", { cfConnectingIp: "1.2.3.4", xForwardedFor: "9.9.9.9" })).toBe("1.2.3.4");
    // a client-supplied X-Forwarded-For is ignored behind Cloudflare
    expect(clientIp("server", { xForwardedFor: "9.9.9.9" })).toBeNull();
    expect(clientIp("local", { cfConnectingIp: "1.2.3.4", xForwardedFor: "9.9.9.9, 10.0.0.1" })).toBe("9.9.9.9");
    expect(clientIp("test", {})).toBeNull();
    expect(clientIp("local", { xForwardedFor: "<script>" })).toBeNull();
  });
  it("groups IPv4 by /24 and IPv6 by /64 (compressed, full and IPv4-mapped forms)", () => {
    expect(ipPrefix("198.51.100.7")).toBe("198.51.100.0/24");
    expect(ipPrefix("198.51.100.250")).toBe(ipPrefix("198.51.100.7"));
    expect(ipPrefix("198.51.101.7")).not.toBe(ipPrefix("198.51.100.7"));
    expect(ipPrefix("::ffff:198.51.100.9")).toBe("198.51.100.0/24");
    expect(ipPrefix("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipPrefix("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipPrefix("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipPrefix("2001:db8:1:3::1")).not.toBe(ipPrefix("2001:db8:1:2::1"));
    expect(ipPrefix("::1")).toBe("0:0:0:0::/64");
    expect(ipPrefix(null)).toBe("unknown");
    expect(ipPrefix("not-an-ip")).toBe("unknown");
  });
});

describe("finding 3: sliding windows", () => {
  const W = 60_000;
  it("rolls windows forward and weighs the previous one by its overlap", () => {
    const c = { window: 10, current: 4, previous: 0 };
    expect(rolled(c, 10 * W + 5, W)).toBe(c);
    expect(rolled(c, 11 * W, W)).toEqual({ window: 11, current: 0, previous: 4 });
    expect(rolled(c, 12 * W, W)).toEqual({ window: 12, current: 0, previous: 0 });
    expect(estimate({ window: 11, current: 1, previous: 4 }, 11 * W + W / 2, W)).toBe(3);
  });
  it("counts a request in every limit only when all allow it", () => {
    const limits = [
      { key: "a", max: 5 },
      { key: "b", max: 1 },
    ];
    const first = take([undefined, undefined], limits, 0, W);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = take(first.counts, limits, 1_000, W);
    expect(second).toEqual({ ok: false, retryAfter: 59 });
  });
  it("one client cannot use up another client's limit on the same link (in-process limiter)", async () => {
    const l = memoryLimiter();
    const lim = (client: string) => [
      { key: `link:L:${client}`, max: 2 },
      { key: "link:L", max: 100 },
    ];
    expect((await l.take(lim("A"), 0, W)).ok).toBe(true);
    expect((await l.take(lim("A"), 1, W)).ok).toBe(true);
    expect(await l.take(lim("A"), 2, W)).toMatchObject({ ok: false });
    expect((await l.take(lim("B"), 3, W)).ok).toBe(true);
  });
  it("evicts the least recently used key, never a hot one", async () => {
    const l = memoryLimiter(3);
    const one = (key: string) => [{ key, max: 2 }];
    await l.take(one("hot"), 0, W);
    await l.take(one("x1"), 1, W);
    await l.take(one("x2"), 2, W);
    await l.take(one("hot"), 3, W); // hot is used again: x1 is now the oldest
    await l.take(one("x3"), 4, W);
    expect(l.size).toBe(3);
    // hot kept its count (2 of 2): a third request is refused
    expect(await l.take(one("hot"), 5, W)).toMatchObject({ ok: false });
  });
});

describe("finding 5: a leg being relayed", () => {
  const cur = (status: LegStatus) => ({ status, deadline: new Date(Date.now() + 60_000), submittedTx: null });
  it("cannot be canceled, re-prepared or re-routed while the payload is with agentpay", () => {
    expect(canCancel("requires_action", cur("submitting"), ["submitting"])).toBe("state_conflict");
    expect(prepareMode("requires_action", cur("submitting"), ["submitting"], Date.now())).toBe("state_conflict");
    expect(canChangeRecipient("requires_action", cur("submitting"), ["submitting"])).toBe("state_conflict");
    expect(canCancel("requires_action", cur("awaiting_signature"), ["awaiting_signature"])).toBeNull();
  });
  it("takes the same payload again (lost relay answer) and changes the refund only once relayed", () => {
    expect(canSubmit("requires_action", cur("submitting"), Date.now())).toBeNull();
    const ra = { status: "requires_action" as const, currentLegId: "L1" };
    expect(onLegChange(ra, { id: "L1", from: "awaiting_signature", to: "submitting" }, []).status).toBeNull();
    expect(onLegChange(ra, { id: "L1", from: "submitting", to: "submitted" }, []).status).toBe("pending");
    expect(onLegChange(ra, { id: "L1", from: "submitting", to: "awaiting_signature" }, []).status).toBeNull();
    // rails' pre-deposit states do not undo it
    expect(legStatusOf("awaiting_deposit", false, "submitting")).toBe("submitting");
  });
  it("is shown as submitted (the public enum has no `submitting`)", () => {
    const leg = {
      id: "x",
      number: 1,
      status: "submitting",
      method: "intents_transfer",
      swap_type: null,
      amount: "1",
      amount_out_expected: null,
      deadline: new Date(),
      submitted_tx: null,
      duplicate: false,
      evidence: null,
      failure_code: null,
      created_at: new Date(),
    };
    expect(legViews([leg as never])[0]?.status).toBe("submitted");
  });
});

describe("finding 6: late execution states on a leg that is over", () => {
  it("a late create response does not revive a canceled, superseded or failed leg", () => {
    expect(legStatusOf("awaiting_deposit", false, "failed")).toBe("failed");
    expect(legStatusOf("quoting", false, "failed")).toBe("failed");
    expect(legUpdateOf("awaiting_deposit", false, "failed")).toEqual({ status: "failed", ignored: true });
    expect(legStatusOf("expired_unpaid", false, "failed")).toBe("failed");
    expect(legStatusOf("awaiting_deposit", false, "succeeded")).toBe("succeeded");
    expect(legStatusOf("failed", false, "succeeded")).toBe("succeeded");
  });
  it("money that moved through it is still followed (truth wins, INV-3)", () => {
    for (const s of ["deposit_detected", "settling"]) expect(legStatusOf(s, false, "failed")).toBe("processing");
    expect(legStatusOf("succeeded", true, "failed")).toBe("succeeded");
    expect(legStatusOf("succeeded", false, "failed")).toBe("held");
    expect(legStatusOf("refunded", false, "failed")).toBe("returned");
    expect(legUpdateOf("settling", false, "failed").ignored).toBe(false);
  });
});

describe("finding 12: max_uses reservations", () => {
  it("counts sessions whose intent can still succeed", () => {
    expect(acceptsPayers({ active: true, uses: 0, maxUses: 2 }, 1)).toBe(true);
    expect(acceptsPayers({ active: true, uses: 1, maxUses: 2 }, 1)).toBe(false);
    expect(acceptsPayers({ active: true, uses: 0, maxUses: 2 }, 2)).toBe(false);
    expect(acceptsPayers({ active: true, uses: 5, maxUses: null }, 100)).toBe(true);
    expect(acceptsPayers({ active: false, uses: 0, maxUses: null })).toBe(false);
  });
});
