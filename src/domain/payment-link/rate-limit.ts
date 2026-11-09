/**
 * Anonymous payment-link limits (lld/payments.md §6.2, audit finding 3). Pure.
 *
 * - Client IP: identity's rule (L-ID-07) — `CF-Connecting-IP` on the server stage (Cloudflare-only
 *   origin), the rightmost untrusted `X-Forwarded-For` hop elsewhere; headers only from a trusted proxy peer.
 * - Clients are counted by network prefix (/24 IPv4, /64 IPv6): one host rotating addresses inside its
 *   allocation is one client.
 * - Windows are sliding, approximated from two fixed windows (the previous one weighted by how much of
 *   it still overlaps): O(1) state per key, the same arithmetic in Valkey and in the in-process fallback.
 */
import { isIPv4, isIPv6 } from "node:net";
import { type ClientIpRule, clientIpRule, resolveClientIp } from "../client-ip.js";

/**
 * Client IP (identity's rule, L-ID-07); null when absent or malformed. Forwarding headers count only from a
 * trusted proxy peer (`NP_TRUSTED_PROXIES`); see domain/client-ip.ts.
 */
export function clientIp(
  env: string,
  h: { cfConnectingIp?: string | undefined; xForwardedFor?: string | undefined; peer?: string | undefined },
  rule: ClientIpRule = clientIpRule(env),
): string | null {
  return resolveClientIp(rule, h);
}

/** The client's network: `a.b.c.0/24` (IPv4, IPv4-mapped IPv6 included) or the first 64 bits (IPv6). */
export function ipPrefix(ip: string | null): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const v4 = mapped ?? (isIPv4(ip) ? ip : null);
  if (v4) return `${v4.split(".").slice(0, 3).join(".")}.0/24`;
  if (!isIPv6(ip)) return "unknown";
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  // a trailing embedded IPv4 counts as two groups
  const groups = (xs: string[]) => xs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const full = [...h, ...Array(Math.max(0, 8 - groups(h) - groups(t))).fill("0"), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

export interface Limit {
  readonly key: string;
  readonly max: number;
}

/** Counts of one key: the current fixed window (by its index) and the previous one. */
export interface WindowCounts {
  readonly window: number;
  readonly current: number;
  readonly previous: number;
}

/** The counts as seen at `now` (rolled forward when windows passed). */
export function rolled(c: WindowCounts | undefined, now: number, windowMs: number): WindowCounts {
  const w = Math.floor(now / windowMs);
  if (!c || c.window < w - 1) return { window: w, current: 0, previous: 0 };
  if (c.window === w - 1) return { window: w, current: 0, previous: c.current };
  return c;
}

/** Requests counted in the sliding window ending at `now`. */
export function estimate(c: WindowCounts, now: number, windowMs: number): number {
  const elapsed = (now - c.window * windowMs) / windowMs;
  return c.previous * (1 - elapsed) + c.current;
}

/** Seconds until one more request fits under `max` (≥ 1). */
export function retryAfter(c: WindowCounts, max: number, now: number, windowMs: number): number {
  const start = c.window * windowMs;
  let wait: number;
  if (c.current + 1 > max || c.previous === 0) wait = start + windowMs - now;
  else {
    // previous·(1 − t/W) + current + 1 ≤ max  ⇔  t ≥ W·(1 − (max − 1 − current)/previous)
    const t = windowMs * (1 - (max - 1 - c.current) / c.previous);
    wait = start + t - now;
  }
  return Math.max(1, Math.ceil(wait / 1000));
}

/**
 * Checks every limit and counts the request in all of them only when all allow it (a refused request
 * costs nothing). Returns the new counts, or the longest wait among the limits that refuse.
 */
export function take(
  counts: readonly (WindowCounts | undefined)[],
  limits: readonly Limit[],
  now: number,
  windowMs: number,
): { ok: true; counts: WindowCounts[] } | { ok: false; retryAfter: number } {
  const r = limits.map((_, i) => rolled(counts[i], now, windowMs));
  let wait = 0;
  limits.forEach((l, i) => {
    const c = r[i] as WindowCounts;
    if (estimate(c, now, windowMs) + 1 > l.max) wait = Math.max(wait, retryAfter(c, l.max, now, windowMs));
  });
  if (wait > 0) return { ok: false, retryAfter: wait };
  return { ok: true, counts: r.map((c) => ({ ...c, current: c.current + 1 })) };
}
