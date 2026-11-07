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
import { makeNonce } from "@nearpay-internal/intents";
import type { Service } from "@nearpay-internal/service";
import {
  createExecution,
  createInternalCase,
  createRefundExecution,
  type Execution,
  estimateSettlement,
  getDestinationMinimums,
  getEvidenceSummary,
  getGeoPolicy,
  getInternalAsset,
  getSettlementContext,
  INTERNAL_ROUTES,
  listChainProfiles,
  listEvidence,
  listFxRates,
  listInternalOptions,
  relaySignedIntent,
  sandboxAdvance,
  sandboxSimulateDeposit,
  sandboxSimulateIntentsTransfer,
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
  mintOpsToken,
  mintServiceToken,
  mintTestToken,
  mockError,
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
  /** A dashboard session token (role, optional fresh step-up). */
  sessionToken(m: Merchant, o?: { livemode?: boolean; role?: string; stepUp?: boolean }): Promise<string>;
  /** A service token of `service` (its catalogue scopes). */
  serviceToken(service: string): Promise<string>;
  /** A console operator token. */
  opsToken(o?: { role?: "ops" | "ops_admin"; stepUp?: boolean }): Promise<string>;
  /** Makes the next `n` refund-leg creates fail transiently / answer a definitive error. */
  failRefundCreates(n: number, code?: string): void;
  /** Runs `fn` on every refund execution rails creates, before it answers (tamper, hold); null clears it. */
  onRefundCreate(fn: ((x: Execution) => void | Promise<void>) | null): void;
  /** Valkey of the stack (with a worker), else null. */
  readonly valkeyUrl: string | null;
  /** Day (`YYYY-MM-DD`) rails files evidence under, and whether that day is complete. */
  evidenceDay: { day: string; complete: boolean };
  call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
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
  let failRefunds = 0;
  let failRefundCode: string | undefined;
  const evidenceDay = { day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), complete: true };
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
  let refundCreateHook: ((x: Execution) => void | Promise<void>) | null = null;
  rails.on(createRefundExecution, async (ctx) => {
    const b = ctx.body;
    if (failRefunds > 0) {
      failRefunds--;
      if (failRefundCode) mockError(failRefundCode as never);
      throw new Error("rails is down");
    }
    const existing = [...executions.values()].find((x) => (x as { _key?: string })._key === b.idempotency_key);
    if (existing) return existing;
    const intentsSource = b.source.type === "intents_account";
    const binding = `np1:${base58(44)}`;
    const deadline = new Date(Date.now() + 1_800_000).toISOString();
    const x = execution({
      kind: "refund",
      method: b.method,
      account_id: b.account_id,
      livemode: b.livemode,
      state: "awaiting_deposit",
      version: 1,
      route_class: b.method === "intents_transfer" ? "intents_transfer" : "stable_pair",
      applied_fee_bps: 0,
      origin: {
        asset_id: b.source.asset_id,
        chain: b.source.chain,
        refund_to: b.source.address,
        refund_type: "intents",
      },
      settlement: {
        asset_id: b.recipient.asset_id,
        amount_base: b.amount,
        tag: "0",
        expected: b.amount,
        recipient: b.recipient.address,
        recipient_type: b.recipient.type === "intents" ? "intents" : "destination_chain",
        chain: b.recipient.chain,
      },
      deposit: intentsSource
        ? null
        : {
            address: "0x3333333333333333333333333333333333333333",
            memo: null,
            amount_in: b.amount,
            min_amount_in: b.amount,
            deadline,
            chain: b.source.chain,
          },
      intents_requirement: null,
      deadline,
      settled_amount: null,
      refunded_amount: null,
      evidence: null,
      reference: { ...b.reference, payment_attempt: b.reference.payment_attempt },
      refund: {
        swap_type: b.method === "intents_transfer" ? null : b.swap_type,
        amount: b.amount,
        amount_out_expected: b.amount,
        min_amount_out: null,
        token: intentsSource ? null : { standard: "erc20", address: "0x4444444444444444444444444444444444444444" },
        transfer: intentsSource
          ? {
              signer_id: b.source.address,
              receiver_id: b.method === "intents_transfer" ? b.recipient.address : "deposit-1click.near",
              token: b.source.asset_id,
              amount: b.amount,
              memo: binding,
              deadline,
            }
          : null,
      },
    } as never);
    Object.defineProperty(x, "_key", { value: b.idempotency_key, enumerable: false });
    executions.set(x.id, x);
    if (refundCreateHook) await refundCreateHook(x);
    return x;
  });
  rails.on(listFxRates, async (ctx) => {
    const lm = ctx.query.livemode as unknown as boolean | undefined;
    const rate = (currency: string, available: boolean, stale: boolean) => ({
      currency,
      exponent: currency === "jpy" ? 0 : 2,
      available,
      stale,
      reference_date: "2026-11-06",
      rate: available
        ? {
            base: currency,
            quote: "usd",
            kind: "fx",
            role: "reference",
            source: "fixed",
            value: { num: "11", den: "10" },
            decimal: "1.1",
            as_of: new Date().toISOString(),
            fetched_at: new Date().toISOString(),
            valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          }
        : null,
    });
    return {
      base: "usd",
      livemode: lm ?? false,
      currencies: [rate("usd", true, false), rate("eur", true, false), rate("gbp", true, true)],
      as_of: new Date().toISOString(),
    } as never;
  });
  rails.on(estimateSettlement, async (ctx) => {
    const q = ctx.query as unknown as { amount: string; currency: string; settlement_asset?: string };
    if (q.currency === "chf") mockError("currency_unsupported");
    const micros = (BigInt(q.amount) * 11n * 10_000n) / 10n; // eur cents × 1.1 → USD micros
    return {
      pricing: { amount: Number(q.amount), currency: q.currency, asset_id: null },
      usd_micros: micros.toString(),
      settlement: q.settlement_asset
        ? { asset_id: q.settlement_asset, amount_base: micros.toString(), par: true }
        : null,
      price_snapshot: { primary_usd: "1", secondary_usd: "1", fx: "1.1", par: true, as_of: new Date().toISOString() },
    } as never;
  });
  const settledOn = (accountId: string, lm: boolean, day: string) =>
    [...executions.values()].filter(
      (x) =>
        x.account_id === accountId &&
        x.livemode === lm &&
        x.state === "succeeded" &&
        (x.terminal_at ?? "").slice(0, 10) === day,
    );
  rails.on(getEvidenceSummary, async (ctx) => {
    const q = ctx.query as unknown as { account_id: string; livemode: boolean; day: string };
    const xs = settledOn(q.account_id, q.livemode, q.day);
    const totals = new Map<string, { kind: string; state: string; asset_id: string; count: number; settled: bigint }>();
    for (const x of xs) {
      const asset = x.kind === "refund" ? x.settlement.asset_id : x.settlement.asset_id;
      const k = `${x.kind}|${asset}`;
      const t = totals.get(k) ?? { kind: x.kind, state: "succeeded", asset_id: asset, count: 0, settled: 0n };
      t.count++;
      t.settled += BigInt(x.settled_amount ?? "0");
      totals.set(k, t);
    }
    return {
      account_id: q.account_id,
      livemode: q.livemode,
      day: q.day,
      complete: evidenceDay.complete,
      in_flight: evidenceDay.complete ? 0 : 1,
      held_open: 0,
      totals: [...totals.values()].map((t) => ({
        kind: t.kind,
        state: t.state,
        asset_id: t.asset_id,
        count: t.count,
        settled_amount: t.settled.toString(),
        refunded_amount: "0",
      })),
      tier_b: { count: 0, explorer_confirmed: 0, unconfirmed: [] },
      digest: "0".repeat(64),
      generated_at: new Date().toISOString(),
    } as never;
  });
  rails.on(listEvidence, async (ctx) => {
    const q = ctx.query as unknown as { account_id: string; livemode: boolean; day: string };
    return { data: settledOn(q.account_id, q.livemode, q.day), has_more: false } as never;
  });
  rails.on(submitExecutionDepositTx, async () => undefined as never);
  rails.on(signalExecution, async () => undefined as never);

  const agentpay = await mockPeer({ service: "agentpay", routes: INTERNAL_ROUTES });
  agentpay.on(relaySignedIntent, async () => ({ agent_payment_id: newId("ap") }));
  const compliance = await mockPeer({ service: "compliance", routes: INTERNAL_ROUTES });
  compliance.on(getGeoPolicy, async () => ({ version: "v1", blocked_countries: ["KP"], blocked_regions: ["UA-43"] }));
  compliance.on(
    createInternalCase,
    async (ctx) =>
      ({
        id: newId("case"),
        object: "compliance_case",
        account_id: ctx.body.account_id,
        livemode: ctx.body.livemode,
        kind: "reconciliation_diff",
        subject: ctx.body.subject,
        severity: ctx.body.severity ?? "high",
        status: "open",
        assignee: null,
        resolution: null,
        review: false,
        created: Math.floor(Date.now() / 1000),
        closed_at: null,
      }) as never,
  );
  const sandbox = await mockPeer({ service: "sandbox", routes: INTERNAL_ROUTES });
  sandbox.on(sandboxSimulateDeposit, async () => undefined as never);
  sandbox.on(sandboxAdvance, async () => undefined as never);
  sandbox.on(sandboxSimulateIntentsTransfer, async () => ({
    tx_hash: "4fWvVxqzQRXx9T2N1v1xVYbmbA7m8E3N8kNw8qVvbZNE",
    block_height: 1,
  }));

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config: WorkerConfig = {
    env: "test",
    logLevel: (process.env.NP_TEST_LOG ?? "silent") as never,
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
    pricingCurrencies: ["usd", "eur", "gbp", "chf"],
    nearRpcUrls: ["http://127.0.0.1:9"],
    linkSessionsPerIp: 1000,
    linkSessionsPerLink: 1000,
    linkSessionsPerLinkClient: 1000,
    turnstileOutageLimit: 5,
    natsUrl: nats?.url ?? "nats://127.0.0.1:9",
    ...(valkey ? { valkeyUrl: valkey.url } : {}),
    ...(o.config as object),
  } as WorkerConfig;
  const deps: ServiceDeps = {
    keys: testKeySource(),
    serviceToken: testServiceToken("payments"),
    // live salts would come from NEAR RPC; tests use a fixed salt for both modes
    nonces: { fresh: async () => makeNonce("5a0dbe11") },
    ...o.deps,
  };
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
    valkeyUrl: valkey?.url ?? null,
    onRefundCreate(fn) {
      refundCreateHook = fn;
    },
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
    sessionToken: (m, t = {}) =>
      mintTestToken({
        sub: newId("usr"),
        acct: m.account,
        lm: t.livemode ?? false,
        ptype: "session",
        scp: [],
        role: (t.role ?? "owner") as never,
        ...(t.stepUp ? { step_up_until: Math.floor(Date.now() / 1000) + 600 } : {}),
      }),
    serviceToken: (service) => mintServiceToken(service as never),
    opsToken: (t = {}) => mintOpsToken({ role: t.role ?? "ops", ...(t.stepUp ? { stepUp: true } : {}) }),
    failRefundCreates(n, code) {
      failRefunds = n;
      failRefundCode = code;
    },
    evidenceDay,
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
