/**
 * Configuration (lld/payments.md §11, foundations §13). `*_FILE` variables carry secrets; `secret()`
 * marks the schema object it wraps, so every secret gets a fresh schema (never a shared one).
 */
import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";
import { CLIENT_IP_HEADERS, clientIpRule } from "./domain/client-ip.js";

const http = () => url(["http:", "https:"]);
const bounded = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** Payer-stream fan-out across api replicas (optional: in-process notifications without it). */
  valkeyUrl: url(["redis:", "rediss:"]).optional(),
  identityUrl: http(),
  serviceClientSecret: secret(),
  railsUrl: http(),
  agentpayUrl: http(),
  complianceUrl: http(),
  /**
   * Sentinel (kill-switch read at boot, spec 0.2.1). Unset: the state stays unknown until the first
   * `evt.sentinel.kill_switch.*` arrives, and live refunds fail closed meanwhile.
   */
  sentinelUrl: http().optional(),
  /** Test mode (nearpay-sandbox); without it simulated deposits and test helpers are unavailable. */
  sandboxBaseUrl: http().optional(),
  /** Checkout origin; session URLs are `<origin>/c/<cs_id>#<client_secret>`. */
  payOrigin: url(["https:", "http:"]).default("https://pay.nearpay.localhost"),
  /** Ed25519 PKCS#8 PEM; its public key is configured in sentinel (attestation tickets). */
  ticketSigningKey: secret(),
  /** 32-byte KEK (base64 or hex) for PII envelope encryption (customer email). */
  piiKek: secret(),
  /** Client IP source behind the gateway (default: cf-connecting-ip on the server stage, x-forwarded-for locally). */
  clientIpHeader: z.enum(CLIENT_IP_HEADERS).optional(),
  /** CIDRs of the proxies in front of payments whose forwarding headers count (default: loopback + private ranges). */
  trustedProxies: list(z.string().min(1)).optional(),
  /** Cloudflare Turnstile secret; unset (local/test only) disables the challenge. */
  turnstileSecret: secret().optional(),
  turnstileBaseUrl: url(["https:", "http:"]).optional(),
  maxLiveAttempts: bounded(1, 50, 5),
  underpayToleranceMaxBps: bounded(0, 10_000, 100),
  /** Fiat pricing currencies payments accepts (Stage 2: rails' FX rates decide availability, ADR-0020 d5). */
  pricingCurrencies: list(z.string().regex(/^[a-z]{3}$/)).default(["usd", "eur", "gbp", "chf", "jpy", "cad", "aud"]),
  /** NEAR RPC endpoints for the Verifier's `current_salt` (live refund legs signed from an Intents account). */
  nearRpcUrls: list(http()).default(["https://free.rpc.fastnear.com"]),
  /**
   * Anonymous payment-link sessions per minute (§6.2, audit finding 3), counted by client network
   * (/24 IPv4, /64 IPv6) across links, per link and client network, and a generous ceiling per link
   * (session creation only; reads are never throttled by it). Shared through Valkey when configured.
   */
  linkSessionsPerIp: bounded(1, 1_000, 10),
  linkSessionsPerLinkClient: bounded(1, 1_000, 5),
  linkSessionsPerLink: bounded(1, 100_000, 600),
  /** Payer attempts per IP per 10 minutes while Turnstile is unavailable (F-12). */
  turnstileOutageLimit: bounded(1, 1_000, 5),
};

export const apiShape = { ...shared };
export const workerShape = { ...shared, natsUrl: url(["nats:", "tls:"]) };
export const opsShape = { ...shared };
export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type SharedConfig = z.output<z.ZodObject<typeof shared>>;
export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type WorkerConfig = z.output<z.ZodObject<typeof workerShape>>;

/** Cloudflare's documented Turnstile test secrets (always pass / fail / spent): local and test stacks only. */
export const isTurnstileTestSecret = (s: string) => /^[123]x0+AA$/.test(s.trim());

/**
 * Server-stage rules (every NP_ENV but local/test): a real Turnstile secret is required (unset disables the
 * challenge; a test secret passes every token, even through siteverify), checkout URLs use a public https
 * origin, and the client-IP proxy list parses.
 */
export function checkServerConfig<
  C extends Pick<SharedConfig, "env" | "turnstileSecret" | "payOrigin" | "clientIpHeader" | "trustedProxies">,
>(c: C): C {
  clientIpRule(c.env, { header: c.clientIpHeader, trustedProxies: c.trustedProxies });
  if (c.env === "local" || c.env === "test") return c;
  if (!c.turnstileSecret) throw new Error("NP_TURNSTILE_SECRET_FILE is required on the server stage");
  if (isTurnstileTestSecret(c.turnstileSecret))
    throw new Error(
      "NP_TURNSTILE_SECRET_FILE holds a Cloudflare test secret: allowed only when NP_ENV is local or test",
    );
  const u = new URL(c.payOrigin);
  if (u.protocol !== "https:" || u.hostname === "localhost" || u.hostname.endsWith(".localhost"))
    throw new Error(`NP_PAY_ORIGIN must be a public https origin on the server stage (got ${c.payOrigin})`);
  return c;
}

export const readApiConfig = (): ApiConfig => checkServerConfig(loadConfig(apiShape));
export const readWorkerConfig = (): WorkerConfig => checkServerConfig(loadConfig(workerShape));
export const readOpsConfig = (): SharedConfig => loadConfig(opsShape);
