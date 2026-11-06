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
 */

import type { RouteBody, RouteQuery, RouteResponse } from "@nearpay/spec";
import { HttpError, httpClient, TimeoutError } from "@nearpay-internal/http";
import {
  createExecution,
  type Execution,
  getDestinationMinimums,
  getExecution,
  getGeoPolicy,
  getInternalAsset,
  getSettlementContext,
  listChainProfiles,
  listInternalOptions,
  relaySignedIntent,
  type SettlementContext,
  sandboxAdvance,
  sandboxSimulateDeposit,
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

export interface Rails {
  createExecution(body: CreateExecutionBody): Promise<Execution>;
  getExecution(id: string): Promise<Execution>;
  options(q: RouteQuery<typeof listInternalOptions>): Promise<InternalOption[]>;
  minimums(keys: readonly string[]): Promise<RouteResponse<typeof getDestinationMinimums>>;
  chainProfiles(): Promise<ChainProfile[]>;
  asset(assetId: string, livemode: boolean): Promise<InternalAsset>;
  submitDepositTx(executionId: string, txHash: string): Promise<void>;
  signal(executionId: string): Promise<void>;
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
  return { geoPolicy: () => c.call(getGeoPolicy) };
}

export interface Sandbox {
  simulateDeposit(body: RouteBody<typeof sandboxSimulateDeposit>): Promise<void>;
  advance(body: RouteBody<typeof sandboxAdvance>): Promise<void>;
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
  };
}
