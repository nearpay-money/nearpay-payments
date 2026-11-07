/**
 * Shared rate-limit counters (audit finding 3): Valkey when configured and reachable, so every api
 * replica counts the same windows; otherwise (no Valkey, connection down, command error) an in-process
 * LRU of the same counts. Both apply `take` from the domain: all limits are checked, and the request is
 * counted in all of them only when every limit allows it.
 */
import { Redis } from "ioredis";
import { type Limit, take, type WindowCounts } from "../domain/payment-link/rate-limit.js";

export type TakeResult = { ok: true } | { ok: false; retryAfter: number };

export interface RateLimiter {
  take(limits: readonly Limit[], now: number, windowMs: number): Promise<TakeResult>;
  close(): Promise<void>;
}

/** In-process counts with least-recently-used eviction (a hot key is never the one evicted). */
export function memoryLimiter(capacity = 50_000): RateLimiter & { readonly size: number } {
  const counts = new Map<string, WindowCounts>();
  const touch = (k: string, v: WindowCounts) => {
    counts.delete(k);
    counts.set(k, v);
    while (counts.size > capacity) counts.delete(counts.keys().next().value as string);
  };
  return {
    get size() {
      return counts.size;
    },
    async take(limits, now, windowMs) {
      const r = take(
        limits.map((l) => counts.get(l.key)),
        limits,
        now,
        windowMs,
      );
      if (!r.ok) {
        // a refused request still marks its keys as recently used
        for (const l of limits) {
          const c = counts.get(l.key);
          if (c) touch(l.key, c);
        }
        return r;
      }
      limits.forEach((l, i) => {
        touch(l.key, r.counts[i] as WindowCounts);
      });
      return { ok: true };
    },
    async close() {
      counts.clear();
    },
  };
}

/**
 * KEYS: per limit, the current and the previous window's counter. ARGV: now, windowMs, then one max per
 * limit. Same arithmetic as the domain `take` (two-window sliding estimate, all-or-nothing).
 */
const TAKE = `
local now = tonumber(ARGV[1])
local w = tonumber(ARGV[2])
local elapsed = (now % w) / w
local start = now - (now % w)
local n = #KEYS / 2
local wait = 0
for i = 1, n do
  local cur = tonumber(redis.call('GET', KEYS[2 * i - 1]) or '0')
  local prev = tonumber(redis.call('GET', KEYS[2 * i]) or '0')
  local max = tonumber(ARGV[2 + i])
  if prev * (1 - elapsed) + cur + 1 > max then
    local t
    if cur + 1 > max or prev == 0 then t = start + w - now
    else t = start + w * (1 - (max - 1 - cur) / prev) - now end
    local s = math.max(1, math.ceil(t / 1000))
    if s > wait then wait = s end
  end
end
if wait > 0 then return wait end
for i = 1, n do
  redis.call('INCR', KEYS[2 * i - 1])
  redis.call('PEXPIRE', KEYS[2 * i - 1], 2 * w)
end
return 0
`;

export function valkeyLimiter(
  url: string,
  fallback: RateLimiter = memoryLimiter(),
): RateLimiter & { backend(): "valkey" | "memory" } {
  const redis = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 500,
  });
  redis.on("error", () => {});
  return {
    backend: () => (redis.status === "ready" ? "valkey" : "memory"),
    async take(limits, now, windowMs) {
      if (redis.status !== "ready") return fallback.take(limits, now, windowMs);
      const window = Math.floor(now / windowMs);
      const keys = limits.flatMap((l) => [
        `np:payments:rl:${l.key}:${window}`,
        `np:payments:rl:${l.key}:${window - 1}`,
      ]);
      try {
        const wait = Number(
          await redis.eval(
            TAKE,
            keys.length,
            ...keys,
            String(now),
            String(windowMs),
            ...limits.map((l) => String(l.max)),
          ),
        );
        return wait > 0 ? { ok: false, retryAfter: wait } : { ok: true };
      } catch {
        return fallback.take(limits, now, windowMs);
      }
    },
    async close() {
      redis.disconnect();
      await fallback.close();
    },
  };
}

export const rateLimiter = (valkeyUrl: string | undefined): RateLimiter =>
  valkeyUrl ? valkeyLimiter(valkeyUrl) : memoryLimiter();
