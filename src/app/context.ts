/** Dependencies shared by payments use cases. */

import type { KeyObject } from "node:crypto";
import type { EnvelopeCipher, Kysely, Transaction } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { ClientIpRule } from "../domain/client-ip.js";
import type { Nonces } from "../infra/clients/near.js";
import type {
  Agentpay,
  ChainProfile,
  Compliance,
  Identity,
  InternalAsset,
  Rails,
  Sandbox,
  Sentinel,
} from "../infra/clients/peers.js";
import type { Turnstile } from "../infra/clients/turnstile.js";
import type { DB } from "../infra/db/schema.js";
import type { Notifier } from "../infra/notifier.js";
import type { RateLimiter } from "../infra/rate-limiter.js";
import { type TtlCache, ttlCache } from "./cache.js";

export type Tx = Transaction<DB>;
export type Db = Kysely<DB> | Tx;

export interface PaymentsMetrics {
  attempt(method: string, routeClass: string, outcome: string): void;
  overpayment(reason: string): void;
  review(reason: string): void;
  timeToSuccess(routeClass: string, seconds: number): void;
  refund(outcome: string): void;
  reconciliation(status: string, diffs: number): void;
  /**
   * Kill-switch copy (app/kill-switch.ts, lld/payments.md §7 periodic read): `kill_switch_engaged` (1 = live refund
   * legs paused by the copy: engaged or unknown), `kill_switch_version` (-1 = unknown).
   */
  killSwitchCopy(c: { engaged: boolean; version: number | null }): void;
  /**
   * Sentinel's answer at the last successful read: `kill_switch_source_engaged`, `kill_switch_source_version` (-1 =
   * sentinel sent none), `kill_switch_last_read_timestamp_seconds`, `kill_switch_diverged` (1 when the copy still
   * differs after the read was applied — deploy alert `KillSwitchCopyDiverged`).
   */
  killSwitchSource(s: { engaged: boolean; version: number | null; readAtMs: number; diverged: boolean }): void;
}

export const noMetrics: PaymentsMetrics = {
  attempt() {},
  overpayment() {},
  review() {},
  timeToSuccess() {},
  refund() {},
  reconciliation() {},
  killSwitchCopy() {},
  killSwitchSource() {},
};

export function paymentsMetrics(m: ServiceMetrics): PaymentsMetrics {
  const attempts = m.counter("attempts_total", "Payment attempts by method, route class and outcome.", [
    "method",
    "route_class",
    "outcome",
  ]);
  const over = m.counter("overpayments_total", "Settlements beyond the one that paid the intent.", ["reason"]);
  const review = m.counter("review_total", "Intents that entered review.", ["reason"]);
  const tts = m.histogram(
    "time_to_success_seconds",
    "Attempt creation to verified settlement.",
    ["route_class"],
    [10, 30, 60, 120, 300, 600, 1800, 3600],
  );
  const refunds = m.counter("refunds_total", "Refund outcomes (created, succeeded, failed, canceled, duplicate_leg).", [
    "outcome",
  ]);
  const runs = m.counter("reconciliation_runs_total", "Reconciliation runs by final status.", ["status"]);
  const diffs = m.counter("reconciliation_diffs_total", "Reconciliation differences found (target: zero).", []);
  // registered on first use: only the processes that keep the copy (api, worker) export them
  let ks: Record<
    "engaged" | "version" | "srcEngaged" | "srcVersion" | "diverged" | "readAt",
    ReturnType<typeof m.gauge>
  > | null = null;
  const ksGauges = () => {
    ks ??= {
      engaged: m.gauge(
        "kill_switch_engaged",
        "1 while payments' copy of sentinel's kill switch pauses live refund legs (engaged, or state unknown).",
      ),
      version: m.gauge("kill_switch_version", "Sentinel kill-switch version payments' copy came from (-1 = unknown)."),
      srcEngaged: m.gauge(
        "kill_switch_source_engaged",
        "Sentinel's kill switch at payments' last successful read (1 = engaged).",
      ),
      srcVersion: m.gauge(
        "kill_switch_source_version",
        "Sentinel's kill-switch version at payments' last successful read (-1 = sentinel sent none).",
      ),
      diverged: m.gauge(
        "kill_switch_diverged",
        "1 when payments' kill-switch copy still differs from sentinel after the last read was applied (alert).",
      ),
      readAt: m.gauge(
        "kill_switch_last_read_timestamp_seconds",
        "Unix time of payments' last successful read of sentinel's kill switch.",
      ),
    };
    return ks;
  };
  return {
    killSwitchCopy: (c) => {
      const g = ksGauges();
      g.engaged.set(c.engaged ? 1 : 0);
      g.version.set(c.version ?? -1);
    },
    killSwitchSource: (x) => {
      const g = ksGauges();
      g.srcEngaged.set(x.engaged ? 1 : 0);
      g.srcVersion.set(x.version ?? -1);
      g.diverged.set(x.diverged ? 1 : 0);
      g.readAt.set(Math.floor(x.readAtMs / 1000));
    },
    refund: (outcome) => refunds.inc({ outcome }),
    reconciliation: (status, n) => {
      runs.inc({ status });
      if (n > 0) diffs.inc(n);
    },
    attempt: (method, routeClass, outcome) => attempts.inc({ method, route_class: routeClass, outcome }),
    overpayment: (reason) => over.inc({ reason }),
    review: (reason) => review.inc({ reason }),
    timeToSuccess: (routeClass, s) => tts.observe({ route_class: routeClass }, s),
  };
}

export interface PaymentsSettings {
  /** Checkout origin; session URLs are `<payOrigin>/c/<cs_id>#<client_secret>`. */
  readonly payOrigin: string;
  readonly maxLiveAttempts: number;
  readonly underpayToleranceMaxBps: number;
  readonly pricingCurrencies: ReadonlySet<string>;
  /** Payer attempts per IP per 10 minutes while Turnstile is unavailable (F-12). */
  readonly turnstileOutageLimit: number;
  /** Anonymous payment-link sessions per IP / per link per minute. */
  readonly linkSessionsPerIp: number;
  readonly linkSessionsPerLink: number;
  readonly linkSessionsPerLinkClient: number;
  /** Test treasury / live treasury are rails' business; payments only forwards. */
}

export interface Caches {
  readonly assets: TtlCache<InternalAsset>;
  readonly profiles: TtlCache<ChainProfile[]>;
  readonly minimums: TtlCache<{ min_usd_micros: number | null; min_amount_base: string | null } | null>;
}

export function newCaches(now: () => number = Date.now): Caches {
  return {
    assets: ttlCache(5 * 60_000, now),
    profiles: ttlCache(10 * 60_000, now),
    minimums: ttlCache(60 * 60_000, now),
  };
}

export interface Payments {
  readonly env: string;
  /** Where the client IP comes from (NP_CLIENT_IP_HEADER, NP_TRUSTED_PROXIES); default: by NP_ENV. */
  readonly clientIp?: ClientIpRule;
  readonly db: Kysely<DB>;
  log: Logger;
  metrics: PaymentsMetrics;
  readonly identity: Identity;
  readonly rails: Rails;
  readonly agentpay: Agentpay;
  readonly compliance: Compliance;
  /** Kill-switch reads (spec 0.2.1); null when `NP_SENTINEL_URL` is unset. */
  readonly sentinel: Sentinel | null;
  /** Test mode only (nearpay-sandbox): simulated deposits and test helpers. */
  readonly sandbox: Sandbox | null;
  readonly turnstile: Turnstile;
  readonly notifier: Notifier;
  /** Anonymous payment-link rate limits (Valkey, in-process fallback). */
  readonly limiter: RateLimiter;
  /** Payments' attestation-ticket key (Ed25519, public key configured in sentinel). */
  readonly ticketKey: KeyObject;
  /** PII envelope cipher (customer email). */
  readonly cipher: EnvelopeCipher;
  /** Key of the customer email lookup hash (derived from the PII KEK). */
  readonly emailHashKey: Buffer;
  /** Verifier nonces for refund payloads signed from an Intents account. */
  readonly nonces: Nonces;
  readonly settings: PaymentsSettings;
  readonly caches: Caches;
  readonly random: () => number;
  readonly now: () => number;
}
