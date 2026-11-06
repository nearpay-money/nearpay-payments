/**
 * Cloudflare Turnstile siteverify (lld/payments.md §8.2, §10: 2 s, 1 retry, breaker). An outage
 * (timeout, 5xx, open breaker) is reported as `unavailable`: the attempt proceeds under a stricter
 * per-IP limit (F-12) instead of blocking every payer.
 */
import { randomUUID } from "node:crypto";
import { HttpError, httpClient } from "@nearpay-internal/http";

export type TurnstileResult = "ok" | "failed" | "unavailable";

export interface Turnstile {
  verify(token: string, remoteIp: string | null): Promise<TurnstileResult>;
}

export const SITEVERIFY = "https://challenges.cloudflare.com";

export function turnstileClient(o: { secret: string; baseUrl?: string; fetch?: typeof fetch }): Turnstile {
  const c = httpClient({
    target: "turnstile",
    baseUrl: o.baseUrl ?? SITEVERIFY,
    timeoutMs: 2_000,
    attempts: 2,
    breaker: { failureRate: 0.5, minCalls: 10, windowMs: 30_000, halfOpenAfterMs: 15_000 },
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    async verify(token, remoteIp) {
      // a token is single-use; siteverify's idempotency_key makes the one retry safe
      const key = randomUUID();
      try {
        const r = await c.request<{ success?: boolean }>({
          method: "POST",
          path: "/turnstile/v0/siteverify",
          body: {
            secret: o.secret,
            response: token,
            idempotency_key: key,
            ...(remoteIp ? { remoteip: remoteIp } : {}),
          },
          idempotencyKey: key,
        });
        return r.body?.success === true ? "ok" : "failed";
      } catch (e) {
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) return "failed";
        return "unavailable";
      }
    },
  };
}

/** No secret configured (local and test environments only): every token passes. */
export const turnstileDisabled: Turnstile = { verify: async () => "ok" };
