/**
 * Clients for the services payments calls (lld/payments.md §10), with payments' service token. Each
 * call is a spec route, so requests and responses are checked against the contract.
 *
 * | Target                       | Timeout | Retries | Breaker |
 * |------------------------------|---------|---------|---------|
 * | rails `POST /internal/executions` | 8 s | 0 (the quoting-recovery job retries) | global |
 * | rails reads (options, minimums, profiles, assets) | 2 s | 1 | yes |
 * | rails deposit tx / signals   | 2 s     | 1 (idempotent) | yes |
 * | identity settlement context  | 1 s     | 1       | yes     |
 * | agentpay `POST /internal/relay` | 5 s  | 0       | yes     |
 * | compliance geo policy        | 1 s     | 1       | yes     |
 * | sandbox (test mode)          | 2 s     | 1       | no      |
 * | rails `POST /internal/refund_executions` | 8 s | 0 (the refund prepare-recovery job retries) | global |
 * | rails FX rates / settlement estimate | 2 s | 1  | yes     |
 * | rails evidence (reconciliation) | 10 s | 1      | no      |
 * | compliance `POST /internal/cases` | 3 s | 0 (the case job retries, idempotent) | yes |
 */

import type { RouteBody, RouteQuery, RouteResponse } from "@nearpay/spec";
import { HttpError, httpClient, TimeoutError } from "@nearpay-internal/http";
import {
  createExecution,
  createInternalCase,
  createRefundExecution,
  estimateSettlement,
  type Execution,
  getDestinationMinimums,
  getEvidenceSummary,
  getExecution,
  getGeoPolicy,
  getInternalAsset,
  getSettlementContext,
  listChainProfiles,
  listEvidence,
  listFxRates,
  listInternalOptions,
  relaySignedIntent,
  type SettlementContext,
  sandboxAdvance,
  sandboxSimulateDeposit,
  sandboxSimulateIntentsTransfer,
  signalExecution,
  submitExecutionDepositTx,
} from "@nearpay-internal/spec";

const BREAKER = { failureRate: 0.5, minCalls: 10, windowMs: 30_000, halfOpenAfterMs: 15_000 } as const;

export interface PeerOptions {
  readonly serviceToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

/** An upstream answered with a NearPay error (4xx/5xx with an envelope) or could not be reached. */
export function upstreamCode(e: unknown): { code: string | null; status: number | null; timeout: boolean } {
  if (e instanceof HttpError) return { code: e.error?.code ?? null, status: e.status, timeout: false };
  if (e instanceof TimeoutError) return { code: null, status: null, timeout: true };
  return { code: null, status: null, timeout: false };
}

export type CreateExecutionBody = RouteBody<typeof createExecution>;
export type InternalAsset = RouteResponse<typeof getInternalAsset>;
export type ChainProfile = RouteResponse<typeof listChainProfiles>["profiles"][number];
export type InternalOption = RouteResponse<typeof listInternalOptions>["options"][number];
export type CreateRefundExecutionBody = RouteBody<typeof createRefundExecution>;
export type FxRatesResponse = RouteResponse<typeof listFxRates>;
export type SettlementEstimateResponse = RouteResponse<typeof estimateSettlement>;
export type EvidenceSummaryResponse = RouteResponse<typeof getEvidenceSummary>;
export type EvidencePage = RouteResponse<typeof listEvidence>;
export type CreateCaseBody = RouteBody<typeof createInternalCase>;

export interface Rails {
  createExecution(body: CreateExecutionBody): Promise<Execution>;
  getExecution(id: string): Promise<Execution>;
  options(q: RouteQuery<typeof listInternalOptions>): Promise<InternalOption[]>;
  minimums(keys: readonly string[]): Promise<RouteResponse<typeof getDestinationMinimums>>;
  chainProfiles(): Promise<ChainProfile[]>;
  asset(assetId: string, livemode: boolean): Promise<InternalAsset>;
  submitDepositTx(executionId: string, txHash: string): Promise<void>;
  signal(executionId: string): Promise<void>;
  // stage 2
  createRefundExecution(body: CreateRefundExecutionBody): Promise<Execution>;
  fxRates(livemode: boolean, currencies: readonly string[]): Promise<FxRatesResponse>;
  estimate(q: RouteQuery<typeof estimateSettlement>): Promise<SettlementEstimateResponse>;
  evidenceSummary(accountId: string, livemode: boolean, day: string): Promise<EvidenceSummaryResponse>;
  evidence(q: RouteQuery<typeof listEvidence>): Promise<EvidencePage>;
}

export function railsClient(o: PeerOptions & { baseUrl: string }): Rails {
  const common = {
    target: "rails",
    baseUrl: o.baseUrl,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  };
  const write = httpClient({ ...common, timeoutMs: 8_000, attempts: 1, breaker: BREAKER });
  const read = httpClient({ ...common, timeoutMs: 2_000, attempts: 2, breaker: BREAKER });
  // reconciliation reads pages of a whole day: a longer timeout, no breaker shared with checkout reads
  const reconcileRead = httpClient({ ...common, timeoutMs: 10_000, attempts: 2, breaker: false });
  return {
    createExecution: (body) => write.call(createExecution, { body }),
    getExecution: (id) => read.call(getExecution, { params: { id } }),
    options: async (q) => (await read.call(listInternalOptions, { query: q as never })).options,
    minimums: (keys) => read.call(getDestinationMinimums, { query: { keys: keys.join(",") } }),
    chainProfiles: async () => (await read.call(listChainProfiles)).profiles,
    asset: (assetId, livemode) =>
      read.call(getInternalAsset, { params: { asset_id: assetId }, query: { livemode: livemode ? "true" : "false" } }),
    submitDepositTx: async (id, tx) => {
      await read.call(submitExecutionDepositTx, {
        params: { id },
        body: { tx_hash: tx },
        idempotencyKey: `deposit_tx:${id}:${tx}`,
      });
    },
    signal: async (id) => {
      await read.call(signalExecution, {
        params: { id },
        body: { type: "payer_sent" },
        idempotencyKey: `signal:${id}:${Date.now()}`,
      });
    },
    createRefundExecution: (body) =>
      write.call(createRefundExecution, { body, idempotencyKey: body.idempotency_key }),
    fxRates: (livemode, currencies) =>
      read.call(listFxRates, {
        query: { livemode: livemode ? "true" : "false", currencies: currencies.join(",") } as never,
      }),
    estimate: (q) => read.call(estimateSettlement, { query: q as never }),
    evidenceSummary: (accountId, livemode, day) =>
      reconcileRead.call(getEvidenceSummary, {
        query: { account_id: accountId, livemode: livemode ? "true" : "false", day } as never,
      }),
    evidence: (q) => reconcileRead.call(listEvidence, { query: q as never }),
  };
}

export interface Identity {
  settlementContext(accountId: string, livemode: boolean): Promise<SettlementContext>;
}

export function identityClient(o: PeerOptions & { baseUrl: string }): Identity {
  const c = httpClient({
    target: "identity",
    baseUrl: o.baseUrl,
    timeoutMs: 1_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    settlementContext: (id, lm) =>
      c.call(getSettlementContext, { params: { id }, query: { livemode: lm ? "true" : "false" } }),
  };
}

export interface Agentpay {
  relay(body: RouteBody<typeof relaySignedIntent>): Promise<{ agent_payment_id: string }>;
}

export function agentpayClient(o: PeerOptions & { baseUrl: string }): Agentpay {
  const c = httpClient({
    target: "agentpay",
    baseUrl: o.baseUrl,
    timeoutMs: 5_000,
    attempts: 1,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { relay: (body) => c.call(relaySignedIntent, { body }) };
}

export interface Compliance {
  geoPolicy(): Promise<RouteResponse<typeof getGeoPolicy>>;
  /** Opens a `reconciliation_diff` case (idempotent on `rcn:<run id>`). */
  createCase(body: CreateCaseBody, idempotencyKey: string): Promise<{ id: string }>;
}

export function complianceClient(o: PeerOptions & { baseUrl: string }): Compliance {
  const c = httpClient({
    target: "compliance",
    baseUrl: o.baseUrl,
    timeoutMs: 1_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const write = httpClient({
    target: "compliance",
    baseUrl: o.baseUrl,
    timeoutMs: 3_000,
    attempts: 1,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    geoPolicy: () => c.call(getGeoPolicy),
    createCase: async (body, key) => {
      const r = await write.call(createInternalCase, { body, idempotencyKey: key });
      return { id: r.id };
    },
  };
}

export interface Sandbox {
  simulateDeposit(body: RouteBody<typeof sandboxSimulateDeposit>): Promise<void>;
  advance(body: RouteBody<typeof sandboxAdvance>): Promise<void>;
  simulateIntentsTransfer(body: RouteBody<typeof sandboxSimulateIntentsTransfer>): Promise<void>;
}

export function sandboxClient(o: PeerOptions & { baseUrl: string }): Sandbox {
  const c = httpClient({
    target: "sandbox",
    baseUrl: o.baseUrl,
    timeoutMs: 2_000,
    attempts: 1,
    breaker: false,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    simulateDeposit: async (body) => {
      await c.call(sandboxSimulateDeposit, { body });
    },
    advance: async (body) => {
      await c.call(sandboxAdvance, { body });
    },
    simulateIntentsTransfer: async (body) => {
      await c.call(sandboxSimulateIntentsTransfer, { body });
    },
  };
}
