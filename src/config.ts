/**
 * Configuration (lld/payments.md §11, foundations §13). `*_FILE` variables carry secrets; `secret()`
 * marks the schema object it wraps, so every secret gets a fresh schema (never a shared one).
 */
import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

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
  /** Test mode (nearpay-sandbox); without it simulated deposits and test helpers are unavailable. */
  sandboxBaseUrl: http().optional(),
  /** Checkout origin; session URLs are `<origin>/c/<cs_id>#<client_secret>`. */
  payOrigin: url(["https:", "http:"]).default("https://pay.nearpay.localhost"),
  /** Ed25519 PKCS#8 PEM; its public key is configured in sentinel (attestation tickets). */
  ticketSigningKey: secret(),
  /** 32-byte KEK (base64 or hex) for PII envelope encryption (customer email). */
  piiKek: secret(),
  /** Cloudflare Turnstile secret; unset (local/test only) disables the challenge. */
  turnstileSecret: secret().optional(),
  turnstileBaseUrl: url(["https:", "http:"]).optional(),
  maxLiveAttempts: bounded(1, 50, 5),
  underpayToleranceMaxBps: bounded(0, 10_000, 100),
  pricingCurrencies: list(z.string().regex(/^[a-z]{3}$/)).default(["usd"]),
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

export const readApiConfig = (): ApiConfig => loadConfig(apiShape);
export const readWorkerConfig = (): WorkerConfig => loadConfig(workerShape);
export const readOpsConfig = (): SharedConfig => loadConfig(opsShape);
