/**
 * Payment-link rate limits (property, audit finding 3): within any fixed window a key never admits more
 * than its max; a refused request is counted nowhere; distinct keys never share a count.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { take, type WindowCounts } from "../../src/domain/payment-link/rate-limit.js";

const W = 60_000;

describe("sliding-window limits (property)", () => {
  it("admits at most max per fixed window per key, all-or-nothing across keys", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.record({ dt: fc.integer({ min: 0, max: 20_000 }), client: fc.constantFrom("A", "B", "C") }), {
          maxLength: 120,
        }),
        (perClient, perLink, reqs) => {
          const state = new Map<string, WindowCounts>();
          const admitted = new Map<string, number>(); // `${key}@${window}` → admitted
          let now = 1_700_000_000_000;
          for (const r of reqs) {
            now += r.dt;
            const limits = [
              { key: `c:${r.client}`, max: perClient },
              { key: "link", max: perLink },
            ];
            const res = take(
              limits.map((l) => state.get(l.key)),
              limits,
              now,
              W,
            );
            if (!res.ok) {
              expect(res.retryAfter).toBeGreaterThanOrEqual(1);
              continue;
            }
            limits.forEach((l, i) => {
              state.set(l.key, res.counts[i] as WindowCounts);
              const k = `${l.key}@${Math.floor(now / W)}`;
              admitted.set(k, (admitted.get(k) ?? 0) + 1);
            });
          }
          for (const [k, n] of admitted) expect(n).toBeLessThanOrEqual(k.startsWith("c:") ? perClient : perLink);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
