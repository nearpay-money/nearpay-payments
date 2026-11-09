/** Public beta (Cloudflare → cloudflared → Traefik): payer IP trust and server-stage configuration. */
import { describe, expect, it } from "vitest";
import { checkServerConfig, isTurnstileTestSecret } from "../../src/config.js";
import { clientIpRule, fromTrustedProxy, resolveClientIp, trustedProxies } from "../../src/domain/client-ip.js";
import { clientIp, ipPrefix } from "../../src/domain/payment-link/rate-limit.js";

describe("payer IP behind the gateway", () => {
  it("server: CF-Connecting-IP only from a trusted proxy peer; a direct peer is the client", () => {
    expect(clientIp("server", { peer: "172.18.0.4", cfConnectingIp: "203.0.113.7", xForwardedFor: "6.6.6.6" })).toBe(
      "203.0.113.7",
    );
    expect(clientIp("server", { peer: "198.51.100.2", cfConnectingIp: "203.0.113.7" })).toBe("198.51.100.2");
    expect(ipPrefix(clientIp("server", { peer: "172.18.0.4", cfConnectingIp: "203.0.113.7" }))).toBe("203.0.113.0/24");
  });
  it("local: the rightmost untrusted X-Forwarded-For hop, so a forged leftmost hop cannot rotate the limiter key", () => {
    expect(clientIp("local", { peer: "127.0.0.1", xForwardedFor: "1.1.1.1, 203.0.113.7, 172.18.0.3" })).toBe(
      "203.0.113.7",
    );
    expect(clientIp("local", { peer: "127.0.0.1", xForwardedFor: "2.2.2.2, 203.0.113.7, 172.18.0.3" })).toBe(
      "203.0.113.7",
    );
  });
  it("configurable proxy list; geo headers only through a trusted proxy", () => {
    const rule = clientIpRule("server", { trustedProxies: ["172.30.0.2/32"] });
    expect(resolveClientIp(rule, { peer: "172.30.0.2", cfConnectingIp: "203.0.113.9" })).toBe("203.0.113.9");
    expect(resolveClientIp(rule, { peer: "172.30.0.7", cfConnectingIp: "203.0.113.9" })).toBe("172.30.0.7");
    expect(fromTrustedProxy(rule, "172.30.0.2")).toBe(true);
    expect(fromTrustedProxy(rule, "172.30.0.7")).toBe(false);
    expect(fromTrustedProxy(rule, undefined)).toBe(true);
    expect(() => trustedProxies(["bad/8"])).toThrow(/NP_TRUSTED_PROXIES/);
  });
});

describe("server-stage configuration", () => {
  const ok = {
    env: "server" as const,
    turnstileSecret: "0x4AAAAAAAreal",
    payOrigin: "https://pay.nearpay.money",
    clientIpHeader: undefined,
    trustedProxies: undefined,
  };
  it("accepts a real secret and a public pay origin; local/test may run without a secret", () => {
    expect(checkServerConfig(ok)).toBe(ok);
    expect(() =>
      checkServerConfig({
        ...ok,
        env: "local",
        turnstileSecret: undefined,
        payOrigin: "https://pay.nearpay.localhost",
      }),
    ).not.toThrow();
  });
  it("refuses a missing or test Turnstile secret, a localhost pay origin, a bad proxy list", () => {
    expect(isTurnstileTestSecret("1x0000000000000000000000000000000AA")).toBe(true);
    expect(() => checkServerConfig({ ...ok, turnstileSecret: undefined })).toThrow(/required/);
    expect(() => checkServerConfig({ ...ok, turnstileSecret: "1x0000000000000000000000000000000AA" })).toThrow(
      /test secret/,
    );
    expect(() => checkServerConfig({ ...ok, payOrigin: "https://pay.nearpay.localhost" })).toThrow(/NP_PAY_ORIGIN/);
    expect(() => checkServerConfig({ ...ok, trustedProxies: ["x"] })).toThrow(/NP_TRUSTED_PROXIES/);
  });
});
