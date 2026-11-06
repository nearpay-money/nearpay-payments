/**
 * Integration harness: Postgres provisioned like nearpay-deploy's `postgres-init` (migrator owns the
 * database, the app role has DML only); the real `api` and `worker` from the factories `main.ts` uses;
 * identity, rails, agentpay, compliance and sandbox mocked from the spec (`mockPeer`); NATS for events
 * and Valkey for the payer-stream fan-out when a test asks for the worker.
 */
import { generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import { fromUuid, newId, toUuid } from "@nearpay-internal/ids";
import type { Service } from "@nearpay-internal/service";
import {
  createExecution,
  type Execution,
  getDestinationMinimums,
  getGeoPolicy,
  getInternalAsset,
  getSettlementContext,
  INTERNAL_ROUTES,
  listChainProfiles,
  listInternalOptions,
  relaySignedIntent,
  sandboxAdvance,
  sandboxSimulateDeposit,
  signalExecution,
  submitExecutionDepositTx,
} from "@nearpay-internal/spec";
import {
  account,
  type EventProbe,
  eventProbe,
  execution,
  internalSettlementDestination,
  type MockPeer,
  mintTestToken,
  mockPeer,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  startValkey,
  testKeySource,
  testServiceToken,
  USDC_BASE,
  USDC_NEAR,
} from "@nearpay-internal/testing";
import type { Payments } from "../../src/app/context.js";
import { createApi, createWorker, type ServiceDeps, type WorkerDeps } from "../../src/app/services.js";
import type { WorkerConfig } from "../../src/config.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";

export { USDC_BASE, USDC_NEAR };

export interface Merchant {
  readonly account: `acct_${string}`;
  readonly destination: `sd_${string}`;
}

export interface Stack {
  readonly pg: Started;
  readonly admin: Database<DB>;
  readonly api: Service;
  readonly payments: Payments;
  readonly url: string;
  readonly identity: MockPeer;
  readonly rails: MockPeer;
  readonly agentpay: MockPeer;
  readonly compliance: MockPeer;
  readonly sandbox: MockPeer;
  readonly ticketPublic: KeyObject;
  readonly worker: { service: Service; payments: Payments } | null;
  readonly nats: (Started & { monitorUrl: string }) | null;
  /** Executions rails "created", by execution id (tests move them along). */
  readonly executions: Map<string, Execution>;
  merchant(o?: {
    livemode?: boolean;
    liveEnabled?: boolean;
    verification?: "signature" | "unverified" | "test";
    capUsdMicros?: number | null;
    type?: "chain_address" | "intents_account";
  }): Merchant;
  token(m: Merchant, o?: { livemode?: boolean }): Promise<string>;
  call(
    method: "GET" | "POST",
    path: string,
    o?: { body?: unknown; token?: string | null; secret?: string; headers?: Record<string, string> },
    // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
  ): Promise<{ status: number; body: any; headers: Headers }>;
  /** Makes the next `n` rails creates fail (no answer the attempt can settle on). */
  failCreates(n: number): void;
  /** Moves a rails execution to `state` (next version) and returns it. */
  advance(executionId: string, patch: Partial<Execution>): Execution;
  publishEvent(e: Envelope): Promise<void>;
  probe(filter?: string): Promise<EventProbe>;
  stop(): Promise<void>;
}

export interface StackOptions {
  worker?: boolean | WorkerDeps;
  config?: Partial<WorkerConfig>;
  deps?: Partial<ServiceDeps>;
}

const DEPOSIT = "0x1111111111111111111111111111111111111111";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (n: number) => [...randomBytes(n)].map((b) => B58[b % 58]).join("");

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats, valkey] = await Promise.all([
    startPostgres({ database: "postgres" }),
    o.worker ? startNats() : null,
    o.worker ? startValkey() : null,
  ]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "payments");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  const admin = createDb<DB>({ url: appUrl, applicationName: "payments-test" });

  // ---- peers mocked from the spec
  const merchants = new Map<
    string,
    { live: boolean; liveEnabled: boolean; verification: string; cap: number | null; type: string; sd: string }
  >();
  const identity = await mockPeer({ service: "identity", routes: INTERNAL_ROUTES });
  identity.on(getSettlementContext, async (ctx) => {
    const m = merchants.get(ctx.params.id);
    if (!m) throw new Error(`unknown account ${ctx.params.id}`);
    const lm = ctx.query.livemode as unknown as boolean;
    const acct = account({
      id: ctx.params.id as `acct_${string}`,
      display_name: "Acme Coffee",
      verified_legal_name: null,
      live_enabled: m.liveEnabled,
      fee_bearer: "payer",
      settings: { late_payments: false, underpay_tolerance_bps: 0, session_ttl_default: 3600, email_receipts: true },
    });
    const d = internalSettlementDestination({
      id: m.sd as `sd_${string}`,
      account: ctx.params.id as `acct_${string}`,
      livemode: lm,
      asset_id: USDC_NEAR,
      type: m.type as "intents_account",
      chain: "near:mainnet",
      address: "acme.near",
      address_norm: "acme.near",
      status: "active",
      verification: m.verification as "test",
      per_payment_cap_usd_micros: m.cap,
    });
    return {
      account: acct,
      fee_schedule: {
        id: newId("fs"),
        name: "standard",
        rules: {
          same_asset: { total_bps: 30, min_fee_usd_micros: 0 },
          stable_pair: { total_bps: 50, min_fee_usd_micros: 0 },
          volatile: { total_bps: 100, min_fee_usd_micros: 0 },
          intents_transfer: { total_bps: 30, min_fee_usd_micros: 0 },
        },
        provider_split: { oneclick: { share_bps: 5000, floor_bps: 20, stable_floor_bps: 1 } },
      },
      destinations: [d],
      defaults: { "*": m.sd },
      context_version: new Date().toISOString(),
    } as never;
  });

  const executions = new Map<string, Execution>();
  let failCreates = 0;
  const rails = await mockPeer({ service: "rails", routes: INTERNAL_ROUTES });
  rails.on(getInternalAsset, async (ctx) => {
    const base = ctx.params.asset_id === USDC_BASE;
    return {
      asset_id: ctx.params.asset_id,
      chain: base ? "eip155:8453" : "near:mainnet",
      blockchain: base ? "base" : "near",
      symbol: "USDC",
      decimals: 6,
      family: "USDC",
      is_usd_stable: true,
      price_usd: "1",
      price_ok: true,
      as_of: new Date().toISOString(),
    };
  });
  rails.on(getDestinationMinimums, async (ctx) =>
    Object.fromEntries(
      ctx.query.keys
        .split(",")
        .map((k) => [k, { min_amount_base: "100000", min_usd_micros: 100_000, computed_at: new Date().toISOString() }]),
    ),
  );
  rails.on(
    listChainProfiles,
    async () =>
      ({
        profiles: [
          {
            chain: "eip155:8453",
            blockchain: "base",
            family: "evm",
            tier: "A",
            min_deadline_s: 300,
            default_deadline_s: 1800,
            finality: "finalized",
            verification_timeout_s: 3600,
            memo_mode: "none",
            explorer_tx_url: "https://basescan.org/tx/{tx}",
          },
          {
            chain: "near:mainnet",
            blockchain: "near",
            family: "near",
            tier: "A",
            min_deadline_s: 120,
            default_deadline_s: 1800,
            finality: "final",
            verification_timeout_s: 600,
            memo_mode: "none",
            explorer_tx_url: "https://nearblocks.io/txns/{tx}",
          },
        ],
      }) as never,
  );
  rails.on(
    listInternalOptions,
    async () =>
      ({
        options: [
          {
            method: "route_quote",
            origin_asset_id: USDC_BASE,
            chain: "eip155:8453",
            symbol: "USDC",
            decimals: 6,
            estimated_amount_in: "2010000",
            route_class: "stable_pair",
            applied_fee_bps: 50,
            min_deadline_s: 300,
            available: true,
            reason: null,
          },
          {
            method: "intents_transfer",
            origin_asset_id: USDC_NEAR,
            chain: "near:mainnet",
            symbol: "USDC",
            decimals: 6,
            estimated_amount_in: "2006000",
            route_class: "intents_transfer",
            applied_fee_bps: 30,
            min_deadline_s: 120,
            available: true,
            reason: null,
          },
        ],
      }) as never,
  );
  rails.on(createExecution, async (ctx) => {
    if (failCreates > 0) {
      failCreates--;
      throw new Error("rails is down");
    }
    const b = ctx.body;
    const existing = [...executions.values()].find((x) => (x as { _key?: string })._key === b.idempotency_key);
    if (existing) return existing;
    const intents = b.method === "intents_transfer";
    const x = execution({
      kind: "payment",
      method: b.method,
      account_id: b.account_id,
      livemode: b.livemode,
      state: "awaiting_deposit",
      version: 1,
      route_class: intents ? "intents_transfer" : "stable_pair",
      applied_fee_bps: intents ? 30 : 50,
      settlement: { expected: "2000042", tag: "42" },
      deposit: intents
        ? null
        : {
            address: DEPOSIT,
            memo: null,
            amount_in: "2010042",
            min_amount_in: "2010042",
            deadline: new Date(Date.now() + 1_800_000).toISOString(),
            chain: "eip155:8453",
          },
      intents_requirement: intents
        ? {
            pay_to: "acme.near",
            token: USDC_NEAR,
            amount: "2000042",
            fee_to: "treasury.nearpay.near",
            fee_amount: "6000",
            binding: `np1:${base58(44)}`,
            deadline: new Date(Date.now() + 600_000).toISOString(),
          }
        : null,
      deadline: new Date(Date.now() + 1_800_000).toISOString(),
      settled_amount: null,
      refunded_amount: null,
      evidence: null,
    } as never);
    Object.defineProperty(x, "_key", { value: b.idempotency_key, enumerable: false });
    executions.set(x.id, x);
    return x;
  });
  rails.on(submitExecutionDepositTx, async () => undefined as never);
  rails.on(signalExecution, async () => undefined as never);

  const agentpay = await mockPeer({ service: "agentpay", routes: INTERNAL_ROUTES });
  agentpay.on(relaySignedIntent, async () => ({ agent_payment_id: newId("ap") }));
  const compliance = await mockPeer({ service: "compliance", routes: INTERNAL_ROUTES });
  compliance.on(getGeoPolicy, async () => ({ version: "v1", blocked_countries: ["KP"], blocked_regions: ["UA-43"] }));
  const sandbox = await mockPeer({ service: "sandbox", routes: INTERNAL_ROUTES });
  sandbox.on(sandboxSimulateDeposit, async () => undefined as never);
  sandbox.on(sandboxAdvance, async () => undefined as never);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config: WorkerConfig = {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    identityUrl: identity.url,
    serviceClientSecret: "unused",
    railsUrl: rails.url,
    agentpayUrl: agentpay.url,
    complianceUrl: compliance.url,
    sandboxBaseUrl: sandbox.url,
    payOrigin: "https://pay.nearpay.localhost",
    ticketSigningKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    piiKek: randomBytes(32).toString("base64"),
    maxLiveAttempts: 5,
    underpayToleranceMaxBps: 100,
    pricingCurrencies: ["usd"],
    turnstileOutageLimit: 5,
    natsUrl: nats?.url ?? "nats://127.0.0.1:9",
    ...(valkey ? { valkeyUrl: valkey.url } : {}),
    ...(o.config as object),
  } as WorkerConfig;
  const deps: ServiceDeps = { keys: testKeySource(), serviceToken: testServiceToken("payments"), ...o.deps };
  const { service: api, payments } = createApi(config, {
    ...deps,
    database: createDb<DB>({ url: appUrl, applicationName: "payments-api-test" }),
  });
  const { port } = await api.start();

  let worker: Stack["worker"] = null;
  let bus: Bus | null = null;
  if (o.worker && nats) {
    bus = await connectBus({ url: nats.url, name: "payments-test-publisher" });
    const w = await createWorker(config, {
      ...deps,
      database: createDb<DB>({ url: appUrl, applicationName: "payments-worker-test" }),
      tickMs: 50,
      ...(typeof o.worker === "object" ? o.worker : {}),
    });
    await w.service.start();
    worker = w;
  }
  const url = `http://127.0.0.1:${port}`;

  return {
    pg,
    admin,
    api,
    payments,
    url,
    identity,
    rails,
    agentpay,
    compliance,
    sandbox,
    ticketPublic: publicKey,
    worker,
    nats,
    executions,
    merchant(m = {}) {
      const acct = newId("acct");
      const sd = newId("sd");
      merchants.set(acct, {
        live: m.livemode ?? false,
        liveEnabled: m.liveEnabled ?? true,
        verification: m.verification ?? "test",
        cap: m.capUsdMicros ?? null,
        type: m.type ?? "intents_account",
        sd,
      });
      return { account: acct, destination: sd };
    },
    token: (m, t = {}) =>
      mintTestToken({ sub: newId("key"), acct: m.account, lm: t.livemode ?? false, ptype: "secret_key", scp: [] }),
    async call(method, path, c = {}) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(c.token ? { "x-nearpay-token": c.token } : {}),
          ...(c.secret ? { "x-nearpay-client-secret": c.secret } : {}),
          ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
          ...c.headers,
        },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
      return { status: res.status, body: body as any, headers: res.headers };
    },
    failCreates(n) {
      failCreates = n;
    },
    advance(id, patch) {
      const cur = executions.get(id);
      if (!cur) throw new Error(`no execution ${id}`);
      const next = { ...cur, ...patch, version: cur.version + 1, updated_at: new Date().toISOString() } as Execution;
      Object.defineProperty(next, "_key", { value: (cur as { _key?: string })._key, enumerable: false });
      executions.set(id, next);
      return next;
    },
    async publishEvent(e) {
      if (!bus) throw new Error("no bus (start the stack with a worker)");
      await publish(bus, e.subject, e, e.id);
    },
    async probe(filter = "evt.payments.>") {
      if (!nats) throw new Error("no NATS");
      return eventProbe(nats.url, filter);
    },
    async stop() {
      await worker?.service.stop().catch(() => {});
      await api.stop().catch(() => {});
      await bus?.close().catch(() => {});
      for (const m of [identity, rails, agentpay, compliance, sandbox]) await m.stop().catch(() => {});
      await admin.close();
      await valkey?.stop().catch(() => {});
      await nats?.stop().catch(() => {});
      await pg.stop().catch(() => {});
    },
  };
}

/** The uuid of a public id, for direct table reads. */
export const uuid = (id: string, prefix: Parameters<typeof toUuid>[1]) => toUuid(id, prefix);
export const pub = fromUuid;
