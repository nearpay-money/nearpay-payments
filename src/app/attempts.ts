/**
 * Attempts (lld/payments.md §8.2, §6.2–§6.3): the payer's `route_quote` / `intents_transfer` attempts,
 * agentpay's agent attempts, and the payer signals that follow (deposit tx, "I've sent it", signed
 * intent, test-mode simulation).
 *
 * The attempt is inserted in `quoting` (tx1) before rails is called with idempotency key
 * `attempt:<pa_id>`, so a crash between the two never loses a live quote: the quoting-recovery job
 * re-asks rails with the same key.
 */
import type { ErrorCode, PayerAttempt } from "@nearpay/spec";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Execution } from "@nearpay-internal/spec";
import type { z } from "zod";
import { attemptGuard } from "../domain/checkout-session/session.js";
import { INSTRUCTIONS_LIVE, isAttemptStatus } from "../domain/payment-attempt/attempt.js";
import { type CreateExecutionBody, upstreamCode } from "../infra/clients/peers.js";
import { applyAttemptChange } from "./apply.js";
import type { Payments, Tx } from "./context.js";
import { applyExecutionToAttempt } from "./executions.js";
import { checkGeo } from "./geo.js";
import {
  attemptsOf,
  attemptTransition,
  hideAttempts,
  lockIntent,
  lockSessionOfIntent,
  touchIntent,
  updateAttempt,
  updateSession,
} from "./ledger.js";
import { depositKey, secretMatches, signTicket, TICKET_TTL_S } from "./secrets.js";
import type { AttemptRow, IntentRow, SessionRow } from "./views.js";
import { payerAttempt } from "./views.js";

const NEAR = "near:mainnet";

// ------------------------------------------------------------------------------------- shared

/** Loads a session and its intent and checks the client secret (`401 client_secret_invalid` either way). */
export async function payerSession(
  p: Payments,
  sessionId: string,
  secret: string | undefined,
): Promise<{ s: SessionRow; i: IntentRow }> {
  const s = await p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("id", "=", toUuid(sessionId, "cs"))
    .executeTakeFirst();
  if (!s || !secretMatches(secret, sessionId, s.client_secret_hash)) throw new ApiError("client_secret_invalid");
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", s.payment_intent_id)
    .executeTakeFirstOrThrow();
  return { s, i };
}

/** The attestation ticket while the attempt's instructions are live (§6.2), else null. */
export function ticketFor(p: Payments, a: AttemptRow): string | null {
  if (!a.visible || !isAttemptStatus(a.status) || !INSTRUCTIONS_LIVE.has(a.status)) return null;
  if (a.method === "intents_transfer" && a.status !== "awaiting_deposit") return null;
  if (a.deadline && a.deadline.getTime() <= p.now()) return null;
  const key = depositKey(a.livemode, {
    method: a.method,
    deposit: a.deposit ? { address: a.deposit.address, memo: a.deposit.memo } : null,
    binding: a.intents_requirement?.binding ?? null,
  });
  if (!key) return null;
  return signTicket(
    {
      attempt_id: fromUuid("pa", a.id),
      livemode: a.livemode,
      deposit_key: key,
      exp: Math.floor(p.now() / 1000) + TICKET_TTL_S,
    },
    p.ticketKey,
  );
}

export function payerView(p: Payments, a: AttemptRow): z.input<typeof PayerAttempt> {
  return payerAttempt(a, ticketFor(p, a));
}

/** Rails rejected the create: the codes the payer API returns (others become `rail_unavailable`). */
const PASS_THROUGH = new Set<ErrorCode>([
  "asset_unsupported",
  "route_unavailable",
  "pricing_unavailable",
  "quote_rejected",
  "screening_blocked",
  "screening_unavailable",
  "rail_unavailable",
]);

function payerError(code: string, message: string | undefined, param: string | undefined): ApiError {
  if (code === "deadline_too_short") return new ApiError("route_too_slow", { ...(message ? { message } : {}) });
  if (code === "invalid_request" && param === "origin.refund_to")
    return new ApiError("refund_address_invalid", { ...(message ? { message } : {}), param: "refund_to" });
  if (code === "invalid_request") return ApiError.invalid(message ?? "the payment request is invalid");
  if (PASS_THROUGH.has(code as ErrorCode)) return new ApiError(code as ErrorCode, { ...(message ? { message } : {}) });
  return new ApiError("rail_unavailable", { params: { reason: code } });
}

/** A rails answer that settles the attempt as failed (an error envelope other than a transient one). */
function definitive(e: unknown): { code: string; message?: string; param?: string } | null {
  const u = upstreamCode(e);
  if (!u.code || u.code === "api_error" || u.code === "idempotency_in_progress" || u.code === "rate_limited")
    return null;
  const env = (e as { error?: { message?: string; param?: string } }).error;
  return {
    code: u.code,
    ...(env?.message ? { message: env.message } : {}),
    ...(env?.param ? { param: env.param } : {}),
  };
}

// ------------------------------------------------------------------------------------- creation

export interface AttemptRequest {
  readonly method: "route_quote" | "intents_transfer";
  readonly originAssetId: string;
  readonly originChain: string;
  readonly refundTo: string;
  readonly refundType: "origin_chain" | "intents";
  readonly payerWallet: string | null;
  readonly payerCountry: string | null;
  readonly agent: boolean;
}

function executionBody(i: IntentRow, s: SessionRow, attemptId: string, r: AttemptRequest): CreateExecutionBody {
  const d = i.destination_snapshot;
  return {
    idempotency_key: `attempt:${fromUuid("pa", attemptId)}`,
    kind: "payment",
    method: r.method,
    account_id: fromUuid("acct", i.account_id),
    livemode: i.livemode,
    origin: { asset_id: r.originAssetId, chain: r.originChain, refund_to: r.refundTo, refund_type: r.refundType },
    destination: { asset_id: d.asset_id, type: d.type, chain: d.chain, address: d.address },
    pricing:
      i.currency === "asset"
        ? { currency: "asset", asset_id: i.pricing_asset_id as string, amount: i.pricing_asset_amount as string }
        : { currency: i.currency, amount: Number(i.amount) },
    fee: { schedule: i.fee_snapshot.schedule as CreateExecutionBody["fee"]["schedule"], bearer: i.fee_snapshot.bearer },
    deadline_cap: i.settings_snapshot.late_payments ? null : s.expires_at.toISOString(),
  } as CreateExecutionBody;
}

async function minDeadlineS(p: Payments, chain: string): Promise<number> {
  const profiles = await p.caches.profiles.get("all", () => p.rails.chainProfiles()).catch(() => null);
  return profiles?.find((x) => x.chain === chain)?.min_deadline_s ?? 0;
}

/** tx1: guards, hide older attempts, insert `quoting`. */
async function insertQuoting(
  p: Payments,
  sessionUuid: string,
  r: AttemptRequest,
): Promise<{ attemptId: string; s: SessionRow; i: IntentRow }> {
  const minS = await minDeadlineS(p, r.originChain);
  return p.db.transaction().execute(async (tx) => {
    const s0 = await tx
      .selectFrom("checkout_sessions")
      .select("payment_intent_id")
      .where("id", "=", sessionUuid)
      .executeTakeFirstOrThrow();
    const i = (await lockIntent(tx, s0.payment_intent_id)) as IntentRow;
    const s = (await lockSessionOfIntent(tx, i.id)) as SessionRow;
    const attempts = await attemptsOf(tx, i.id, true);
    const err = attemptGuard({
      session: s.status,
      intent: i.status,
      attempts: attempts.map((a) => (isAttemptStatus(a.status) ? a.status : "held")),
      livemode: s.livemode,
      liveAttempts: s.live_attempts_count,
      maxLiveAttempts: p.settings.maxLiveAttempts,
      remainingS: (s.expires_at.getTime() - p.now()) / 1000,
      minDeadlineS: minS,
      latePayments: i.settings_snapshot.late_payments,
    });
    if (err === "route_too_slow") throw new ApiError("route_too_slow", { params: { chain: r.originChain } });
    if (err) throw new ApiError(err);
    await hideAttempts(tx, i.id);
    const id = uuidv7();
    await tx
      .insertInto("payment_attempts")
      .values({
        id,
        payment_intent_id: i.id,
        account_id: i.account_id,
        livemode: i.livemode,
        method: r.method,
        status: "quoting",
        origin_asset_id: r.originAssetId,
        origin_chain: r.originChain,
        refund_to: r.refundTo,
        refund_type: r.refundType,
        payer_wallet: r.payerWallet,
        payer_ip_country: r.payerCountry,
        agent: r.agent,
      })
      .execute();
    await attemptTransition(tx, id, null, "quoting", {
      cause: r.agent ? "agent attempt" : "payer attempt",
      actor: r.agent ? "agentpay" : "payer",
    });
    const s2 = s.livemode
      ? await updateSession(
          tx,
          s,
          { live_attempts_count: s.live_attempts_count + 1 },
          { cause: "attempt", actor: "payer" },
        )
      : s;
    const i2 = await touchIntent(tx, i);
    return { attemptId: id, s: s2, i: i2 };
  });
}

/** The create failed definitively: the attempt is failed (with its intent/session effects). */
export async function failQuoting(p: Payments, attemptId: string, code: string, actor: string): Promise<void> {
  await p.db.transaction().execute(async (tx) => {
    const head = await tx
      .selectFrom("payment_attempts")
      .select("payment_intent_id")
      .where("id", "=", attemptId)
      .executeTakeFirstOrThrow();
    const intent = (await lockIntent(tx, head.payment_intent_id)) as IntentRow;
    const session = (await lockSessionOfIntent(tx, intent.id)) ?? null;
    const attempts = await attemptsOf(tx, intent.id, true);
    const before = attempts.find((a) => a.id === attemptId) as AttemptRow;
    if (before.status !== "quoting") return;
    const after = await updateAttempt(
      tx,
      before,
      { status: "failed", failure_code: code.slice(0, 64) },
      { cause: `quote failed: ${code}`, actor },
    );
    await applyAttemptChange(
      p,
      tx,
      { intent, session, before, after, others: attempts.filter((a) => a.id !== attemptId) },
      { cause: `quote failed: ${code}`, actor },
    );
  });
}

/** tx2: the execution becomes the attempt's state (version-checked). */
export async function linkExecution(p: Payments, attemptId: string, x: Execution, actor: string): Promise<AttemptRow> {
  const out = await p.db.transaction().execute(async (tx: Tx) => applyExecutionToAttempt(p, tx, attemptId, x, actor));
  const a =
    out?.attempt ??
    (await p.db.selectFrom("payment_attempts").selectAll().where("id", "=", attemptId).executeTakeFirstOrThrow());
  if (out?.session) await p.notifier.publish(out.session.id);
  return a;
}

async function quote(p: Payments, sessionUuid: string, r: AttemptRequest): Promise<AttemptRow> {
  const { attemptId, s, i } = await insertQuoting(p, sessionUuid, r);
  await p.notifier.publish(s.id);
  let x: Execution;
  try {
    x = await p.rails.createExecution(executionBody(i, s, attemptId, r));
  } catch (e) {
    const d = definitive(e);
    if (d) {
      await failQuoting(p, attemptId, d.code, r.agent ? "agentpay" : "payer");
      await p.notifier.publish(s.id);
      p.metrics.attempt(r.method, "unknown", `rejected:${d.code}`);
      throw payerError(d.code, d.message, d.param);
    }
    // timeout / unreachable: the attempt stays `quoting`; the recovery job re-asks with the same key
    p.log.warn(
      { attempt: attemptId, err: e instanceof Error ? e.message : String(e) },
      "rails create did not answer; left quoting",
    );
    p.metrics.attempt(r.method, "unknown", "rail_timeout");
    throw new ApiError("rail_unavailable", { params: { reason: "quote timed out" } });
  }
  const a = await linkExecution(p, attemptId, x, r.agent ? "agentpay" : "payer");
  p.metrics.attempt(r.method, x.route_class, "quoted");
  return a;
}

/** How long an attempt may stay `quoting` before recovery gives up (§9). */
export const QUOTING_GIVE_UP_MS = 2 * 60_000;
/** Attempts younger than this are still in their own create call. */
export const QUOTING_RECOVER_AFTER_MS = 20_000;

/**
 * The `attempt.quoting_recovery` job for one attempt (§9): re-asks rails with the attempt's own
 * idempotency key (rails returns the execution it already created, or creates it now); after two
 * minutes the attempt fails with `rail_timeout`. Returns the session uuid when something changed.
 */
export async function recoverQuoting(p: Payments, attemptId: string): Promise<string | null> {
  const a = await p.db.selectFrom("payment_attempts").selectAll().where("id", "=", attemptId).executeTakeFirst();
  if (a?.status !== "quoting") return null;
  const s = await p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("payment_intent_id", "=", a.payment_intent_id)
    .executeTakeFirstOrThrow();
  const actor = a.agent ? "agentpay" : "system";
  if (p.now() - a.created_at.getTime() >= QUOTING_GIVE_UP_MS) {
    await failQuoting(p, a.id, "rail_timeout", actor);
    p.metrics.attempt(a.method, "unknown", "rail_timeout");
    return s.id;
  }
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", a.payment_intent_id)
    .executeTakeFirstOrThrow();
  const r: AttemptRequest = {
    method: a.method,
    originAssetId: a.origin_asset_id,
    originChain: a.origin_chain,
    refundTo: a.refund_to,
    refundType: a.refund_type,
    payerWallet: a.payer_wallet,
    payerCountry: a.payer_ip_country,
    agent: a.agent,
  };
  let x: Execution;
  try {
    x = await p.rails.createExecution(executionBody(i, s, a.id, r));
  } catch (e) {
    const d = definitive(e);
    if (!d) return null; // still unanswered: the next run retries
    await failQuoting(p, a.id, d.code, actor);
    p.metrics.attempt(a.method, "unknown", `rejected:${d.code}`);
    return s.id;
  }
  await linkExecution(p, a.id, x, actor);
  p.metrics.attempt(a.method, x.route_class, "recovered");
  return s.id;
}

export interface PayerAttemptInput {
  readonly method: "route_quote" | "intents_transfer";
  readonly origin_asset_id: string;
  readonly refund_to?: string | undefined;
  readonly payer_wallet?: string | undefined;
  readonly turnstile_token: string;
}

/** `POST /v1/checkout/sessions/{id}/public/attempts`. */
export async function createPayerAttempt(
  p: Payments,
  sessionId: string,
  secret: string | undefined,
  body: PayerAttemptInput,
  client: { ip: string; country: string | null; region: string | null },
): Promise<z.input<typeof PayerAttempt>> {
  const { s, i } = await payerSession(p, sessionId, secret);
  const t = await p.turnstile.verify(body.turnstile_token, client.ip === "unknown" ? null : client.ip);
  if (t === "failed") throw new ApiError("turnstile_failed");
  if (t === "unavailable") outageLimit(p, client.ip);
  await checkGeo(p, client.country, client.region);
  let r: AttemptRequest;
  if (body.method === "intents_transfer") {
    r = {
      method: "intents_transfer",
      originAssetId: body.origin_asset_id,
      originChain: NEAR,
      refundTo: body.payer_wallet as string,
      refundType: "intents",
      payerWallet: body.payer_wallet as string,
      payerCountry: client.country,
      agent: false,
    };
  } else {
    let chain: string;
    try {
      chain = (
        await p.caches.assets.get(`${i.livemode}|${body.origin_asset_id}`, () =>
          p.rails.asset(body.origin_asset_id, i.livemode),
        )
      ).chain;
    } catch (e) {
      const d = definitive(e);
      if (d?.code === "asset_unsupported")
        throw new ApiError("asset_unsupported", { params: { asset_id: body.origin_asset_id } });
      throw new ApiError("rail_unavailable", { params: { reason: "asset lookup failed" } });
    }
    r = {
      method: "route_quote",
      originAssetId: body.origin_asset_id,
      originChain: chain,
      refundTo: body.refund_to as string,
      refundType: "origin_chain",
      payerWallet: body.payer_wallet ?? null,
      payerCountry: client.country,
      agent: false,
    };
  }
  const a = await quote(p, s.id, r);
  return payerView(p, a);
}

// Turnstile outage (F-12): a stricter per-IP limit instead of the challenge
const outage = new Map<string, number[]>();
const OUTAGE_WINDOW_MS = 10 * 60_000;

function outageLimit(p: Payments, ip: string): void {
  const now = p.now();
  const recent = (outage.get(ip) ?? []).filter((t) => now - t < OUTAGE_WINDOW_MS);
  if (recent.length >= p.settings.turnstileOutageLimit) {
    const retry = Math.ceil(((recent[0] as number) + OUTAGE_WINDOW_MS - now) / 1000);
    throw new ApiError("rate_limited", { params: { retry_after: retry }, headers: { "Retry-After": String(retry) } });
  }
  recent.push(now);
  outage.set(ip, recent);
  if (outage.size > 10_000) outage.delete(outage.keys().next().value as string);
  p.log.warn({ ip }, "Turnstile unavailable: attempt allowed under the outage limit");
}

/** For tests: forget the outage counters. */
export function resetOutageCounters(): void {
  outage.clear();
}

/** `POST /internal/checkout_sessions/{id}/agent_attempts` (agentpay): create or reuse. */
export async function createAgentAttempt(p: Payments, sessionId: string, payerWallet: string) {
  const s = await p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("id", "=", toUuid(sessionId, "cs"))
    .executeTakeFirst();
  if (!s) throw ApiError.missing("checkout_session", sessionId);
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", s.payment_intent_id)
    .executeTakeFirstOrThrow();
  if (i.destination_snapshot.type !== "intents_account")
    throw new ApiError("destination_not_intents_account", { params: { asset_id: i.settlement_asset_id } });
  const reusable = await p.db
    .selectFrom("payment_attempts")
    .selectAll()
    .where("payment_intent_id", "=", i.id)
    .where("agent", "=", true)
    .where("payer_wallet", "=", payerWallet)
    .where("method", "=", "intents_transfer")
    .where("status", "=", "awaiting_deposit")
    .where("visible", "=", true)
    .where("deadline", ">", new Date(p.now() + 30_000))
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  const a =
    reusable ??
    (await quote(p, s.id, {
      method: "intents_transfer",
      originAssetId: i.settlement_asset_id,
      originChain: NEAR,
      refundTo: payerWallet,
      refundType: "intents",
      payerWallet,
      payerCountry: null,
      agent: true,
    }));
  if (!a.execution_id || !a.intents_requirement)
    throw new ApiError("rail_unavailable", { params: { reason: "no requirement" } });
  return {
    attempt_id: fromUuid("pa", a.id),
    execution_id: a.execution_id as `ex_${string}`,
    account_id: fromUuid("acct", a.account_id),
    livemode: a.livemode,
    intents_requirement: a.intents_requirement,
    attestation_ticket: ticketFor(p, a) as string,
  };
}

// ------------------------------------------------------------------------------------- payer signals

async function payerAttemptRow(p: Payments, sessionId: string, attemptId: string, secret: string | undefined) {
  const { s, i } = await payerSession(p, sessionId, secret);
  const a = await p.db
    .selectFrom("payment_attempts")
    .selectAll()
    .where("id", "=", toUuid(attemptId, "pa"))
    .where("payment_intent_id", "=", i.id)
    .executeTakeFirst();
  if (!a) throw ApiError.missing("payment_attempt", attemptId, "attempt");
  return { s, i, a };
}

const conflict = (what: string) => new ApiError("state_conflict", { message: what });

function liveExecution(a: AttemptRow): string {
  if (!a.execution_id || !isAttemptStatus(a.status) || !INSTRUCTIONS_LIVE.has(a.status))
    throw conflict(`The attempt is ${a.status}; its deposit instructions are no longer live.`);
  return a.execution_id;
}

async function railsSignal(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "state_conflict") throw conflict("The execution no longer accepts this signal.");
    throw new ApiError("rail_unavailable", { params: { reason: u.code ?? (u.timeout ? "timeout" : "unreachable") } });
  }
}

export async function submitDepositTx(
  p: Payments,
  sessionId: string,
  attemptId: string,
  secret: string | undefined,
  txHash: string,
) {
  const { a } = await payerAttemptRow(p, sessionId, attemptId, secret);
  if (a.method !== "route_quote") throw conflict("Only route_quote attempts take a deposit transaction.");
  const ex = liveExecution(a);
  await railsSignal(() => p.rails.submitDepositTx(ex, txHash));
}

export async function signalSent(p: Payments, sessionId: string, attemptId: string, secret: string | undefined) {
  const { a } = await payerAttemptRow(p, sessionId, attemptId, secret);
  const ex = liveExecution(a);
  await railsSignal(() => p.rails.signal(ex));
}

export async function submitSignedIntent(
  p: Payments,
  sessionId: string,
  attemptId: string,
  secret: string | undefined,
  signed: unknown,
) {
  const { a } = await payerAttemptRow(p, sessionId, attemptId, secret);
  if (a.method !== "intents_transfer" || a.status !== "awaiting_deposit" || !a.intents_requirement || !a.execution_id)
    throw conflict(`The attempt is ${a.method} in ${a.status}; it does not take a signed intent.`);
  try {
    await p.agentpay.relay({
      execution_id: a.execution_id as `ex_${string}`,
      binding: a.intents_requirement.binding,
      signed: signed as never,
    });
  } catch (e) {
    const u = upstreamCode(e);
    const env = (e as { error?: { message?: string } }).error;
    if (u.code === "intent_invalid" || u.code === "insufficient_balance")
      throw new ApiError(u.code, { ...(env?.message ? { message: env.message } : { params: { reason: "rejected" } }) });
    throw new ApiError("rail_unavailable", { params: { reason: u.code ?? "relay unreachable" } });
  }
}

/** Test mode: "Simulate payment" → sandbox `POST /sim/deposits`. */
export async function simulateDeposit(
  p: Payments,
  sessionId: string,
  attemptId: string,
  secret: string | undefined,
  amountIn?: string,
) {
  const { s, a } = await payerAttemptRow(p, sessionId, attemptId, secret);
  if (s.livemode) throw new ApiError("livemode_forbidden");
  if (!p.sandbox) throw new ApiError("rail_unavailable", { params: { reason: "sandbox not configured" } });
  if (!a.deposit || (a.status !== "awaiting_deposit" && a.status !== "incomplete_deposit"))
    throw conflict(`The attempt is ${a.status}; there is no open deposit to simulate.`);
  const sb = p.sandbox;
  await sandboxCall(() =>
    sb.simulateDeposit({
      deposit_address: (a.deposit as NonNullable<AttemptRow["deposit"]>).address,
      ...(a.deposit?.memo ? { memo: a.deposit.memo } : {}),
      ...(amountIn ? { amount_in: amountIn } : {}),
    }),
  );
}

/** Test helper: move the sandbox execution of an attempt (secret test key). */
export async function advanceAttempt(
  p: Payments,
  accountId: string,
  attemptId: string,
  to: "deposit" | "processing" | "success" | "refund" | "fail",
) {
  const a = await p.db
    .selectFrom("payment_attempts")
    .selectAll()
    .where("id", "=", toUuid(attemptId, "pa"))
    .where("account_id", "=", toUuid(accountId, "acct"))
    .where("livemode", "=", false)
    .executeTakeFirst();
  if (!a) throw ApiError.missing("payment_attempt", attemptId, "attempt");
  if (!p.sandbox) throw new ApiError("rail_unavailable", { params: { reason: "sandbox not configured" } });
  if (!a.deposit) throw conflict("Only route_quote attempts with a deposit address can be advanced.");
  const sb = p.sandbox;
  const d = a.deposit;
  await sandboxCall(() => sb.advance({ deposit_address: d.address, ...(d.memo ? { memo: d.memo } : {}), to }));
}

async function sandboxCall(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "state_conflict" || u.status === 409)
      throw conflict("The sandbox execution cannot take that step now.");
    throw new ApiError("rail_unavailable", { params: { reason: u.code ?? "sandbox unreachable" } });
  }
}
