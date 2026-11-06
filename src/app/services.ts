/**
 * Process wiring (lld/payments.md §2):
 * - `api`     merchant, payer (incl. SSE) and internal routes, with automatic idempotency
 * - `worker`  consumers (rails, identity, compliance), jobs (session expiry, quoting recovery,
 *             context refresh, purge) and the outbox relay
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import { hostname } from "node:os";
import type { KeySource } from "@nearpay-internal/auth";
import { serviceTokenClient } from "@nearpay-internal/auth";
import {
  type Bus,
  busReady,
  connectBus,
  consumerLag,
  domainConsumersTask,
  durablesOf,
  ensureStreams,
  publish,
} from "@nearpay-internal/bus";
import {
  createDb,
  createEnvelopeCipher,
  type Database,
  deadLettersOpen,
  type EnvelopeCipher,
  idempotencyStore,
  jobsDue,
  jobWorkerTask,
  migrationStatus,
  outboxLagSeconds,
  outboxRelayTask,
  parseKek,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { createService, type Service } from "@nearpay-internal/service";
import { STREAMS, type Subject } from "@nearpay-internal/spec";
import { paymentsRoutes } from "../api/routes.js";
import type { ApiConfig, SharedConfig, WorkerConfig } from "../config.js";
import { deadLetters, paymentsHandlers } from "../consumers/handlers.js";
import {
  type Agentpay,
  agentpayClient,
  type Compliance,
  complianceClient,
  type Identity,
  identityClient,
  type Rails,
  railsClient,
  type Sandbox,
  sandboxClient,
} from "../infra/clients/peers.js";
import { type Turnstile, turnstileClient, turnstileDisabled } from "../infra/clients/turnstile.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import { type Notifier, notifier } from "../infra/notifier.js";
import { jobHandlers, RECURRING } from "../workers/jobs.js";
import { newCaches, noMetrics, type Payments, paymentsMetrics } from "./context.js";

export interface ServiceDeps {
  database?: Database<DB>;
  keys?: KeySource;
  serviceToken?: () => Promise<string>;
  identity?: Identity;
  rails?: Rails;
  agentpay?: Agentpay;
  compliance?: Compliance;
  sandbox?: Sandbox | null;
  turnstile?: Turnstile;
  notifier?: Notifier;
  ticketKey?: KeyObject;
  cipher?: EnvelopeCipher;
  fetch?: typeof fetch;
  random?: () => number;
  now?: () => number;
}

interface Built {
  payments: Payments;
  database: Database<DB>;
}

function build(config: SharedConfig, deps: ServiceDeps, app: string): Built {
  const f = deps.fetch ? { fetch: deps.fetch } : {};
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: `payments-${app}` });
  const serviceToken =
    deps.serviceToken ??
    (() => {
      const c = serviceTokenClient({
        identityUrl: config.identityUrl,
        clientId: "payments",
        secret: config.serviceClientSecret,
        ...f,
      });
      return () => c.getToken();
    })();
  const peer = { serviceToken, ...f };
  const payments: Payments = {
    env: config.env,
    db: database.db,
    log: undefined as unknown as Payments["log"],
    metrics: noMetrics,
    identity: deps.identity ?? identityClient({ ...peer, baseUrl: config.identityUrl }),
    rails: deps.rails ?? railsClient({ ...peer, baseUrl: config.railsUrl }),
    agentpay: deps.agentpay ?? agentpayClient({ ...peer, baseUrl: config.agentpayUrl }),
    compliance: deps.compliance ?? complianceClient({ ...peer, baseUrl: config.complianceUrl }),
    sandbox:
      deps.sandbox !== undefined
        ? deps.sandbox
        : config.sandboxBaseUrl
          ? sandboxClient({ ...peer, baseUrl: config.sandboxBaseUrl })
          : null,
    turnstile:
      deps.turnstile ??
      (config.turnstileSecret
        ? turnstileClient({
            secret: config.turnstileSecret,
            ...(config.turnstileBaseUrl ? { baseUrl: config.turnstileBaseUrl } : {}),
            ...f,
          })
        : turnstileDisabled),
    notifier: deps.notifier ?? notifier(config.valkeyUrl),
    ticketKey: deps.ticketKey ?? createPrivateKey(config.ticketSigningKey),
    cipher: deps.cipher ?? createEnvelopeCipher(parseKek(config.piiKek)),
    settings: {
      payOrigin: config.payOrigin.replace(/\/$/, ""),
      maxLiveAttempts: config.maxLiveAttempts,
      underpayToleranceMaxBps: config.underpayToleranceMaxBps,
      pricingCurrencies: new Set(config.pricingCurrencies),
      turnstileOutageLimit: config.turnstileOutageLimit,
    },
    caches: newCaches(deps.now),
    random: deps.random ?? Math.random,
    now: deps.now ?? Date.now,
  };
  if (!config.turnstileSecret && !deps.turnstile && config.env === "server")
    throw new Error("NP_TURNSTILE_SECRET_FILE is required on the server");
  return { payments, database };
}

function readiness(b: Built) {
  return {
    db: () => sql`select 1`.execute(b.database.db),
    migrations: async () => {
      const s = await migrationStatus(b.database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

function attach(b: Built, service: Service, deps: ServiceDeps) {
  b.payments.log = service.log;
  b.payments.metrics = paymentsMetrics(service.metrics);
  service.onShutdown(async () => {
    if (!deps.notifier) await b.payments.notifier.close();
    if (!deps.database) await b.database.close();
  });
}

/** The payments context for the ops CLI (no listener, no background tasks). */
export function createOpsContext(
  config: SharedConfig,
  log: Payments["log"],
  deps: ServiceDeps = {},
): { payments: Payments; close(): Promise<void> } {
  const b = build(config, { notifier: notifier(undefined), ...deps }, "ops");
  b.payments.log = log;
  return {
    payments: b.payments,
    async close() {
      await b.payments.notifier.close();
      if (!deps.database) await b.database.close();
    },
  };
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; payments: Payments } {
  const b = build(config, deps, "api");
  const service = createService({
    name: "payments",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    routes: paymentsRoutes(b.payments),
    idempotency: idempotencyStore(b.database.db, b.payments.cipher),
    readiness: readiness(b),
  });
  attach(b, service, deps);
  return { service, payments: b.payments };
}

export interface WorkerDeps extends ServiceDeps {
  bus?: Bus;
  tickMs?: number;
}

export async function createWorker(
  config: WorkerConfig,
  deps: WorkerDeps = {},
): Promise<{ service: Service; payments: Payments }> {
  const b = build(config, deps, "worker");
  const p = b.payments;
  const service = createService({ name: "payments", config, readiness: readiness(b) });
  attach(b, service, deps);
  const db = b.database;

  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `payments-worker@${hostname()}` }));
  await ensureStreams(bus, [STREAMS.payments]);
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = paymentsHandlers(p, db.db);
  const durables = durablesOf("payments", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  service.metrics.collectOutboxLag(() => outboxLagSeconds(db.db));
  service.metrics.collectJobsDue(() => jobsDue(db.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(db.db));

  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    outboxRelayTask({
      db: db.db,
      pool: db.pool,
      publish: (sub, e, mid) => publish(bus, sub, e, mid).then(() => {}),
      onError,
    }),
  );
  service.addBackground(
    domainConsumersTask({ bus, consumer: "payments", handlers, onDeadLetter: deadLetters(db.db), onError }),
  );
  service.addBackground(
    jobWorkerTask({
      db: db.db,
      workerId: `payments-worker@${hostname()}:${process.pid}`,
      handlers: jobHandlers(p),
      onError: (e, job) => service.log.warn({ err: e instanceof Error ? e.message : String(e), job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "ALERT job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  service.addBackground(
    recurringJobsTask({
      db: db.db,
      pool: db.pool,
      name: "payments:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );
  if (!deps.bus) service.onShutdown(() => bus.close());
  return { service, payments: p };
}
