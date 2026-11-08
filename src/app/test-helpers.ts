/**
 * `POST /v1/test_helpers/checkout_sessions/{id}/pay` (`payCheckoutSessionTestHelper`, lld/payments.md §16.1;
 * test mode only, behind `nearpay trigger`). It pays an open session the way a payer would on the sandbox
 * rail — §8.2 without Turnstile and geo (no payer request): a `route_quote` attempt from the requested origin
 * asset (else the session's first available sandbox option) with the simulated payer's refund address, then,
 * unless `outcome: none`, the sandbox deposit and an advance to the outcome. The normal events follow from
 * rails as for any payment: nothing here marks anything paid (INV-2).
 */
import { getChain } from "@nearpay-internal/chains";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import {
  defaultOrigin,
  SANDBOX_REFUND_ADDRESSES,
  sandboxStepOf,
  type TestOutcome,
} from "../domain/payment-attempt/test-helper.js";
import { definitive, quote, sandboxCall } from "./attempts.js";
import type { Payments } from "./context.js";
import { sessionOptions } from "./payer.js";
import type { Merchant } from "./sessions.js";

export interface TestPayInput {
  readonly origin_asset_id?: string | undefined;
  readonly outcome?: TestOutcome | undefined;
  readonly amount_in?: string | undefined;
}

async function chainOf(p: Payments, assetId: string): Promise<string> {
  try {
    return (await p.caches.assets.get(`false|${assetId}`, () => p.rails.asset(assetId, false))).chain;
  } catch (e) {
    if (definitive(e)?.code === "asset_unsupported")
      throw new ApiError("asset_unsupported", { params: { asset_id: assetId } });
    throw new ApiError("rail_unavailable", { params: { reason: "asset lookup failed" } });
  }
}

export async function payWithTestHelper(p: Payments, m: Merchant, sessionId: string, body: TestPayInput) {
  if (m.livemode) throw new ApiError("livemode_forbidden");
  const outcome: TestOutcome = body.outcome ?? "succeeded";
  const s = await p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("id", "=", toUuid(sessionId, "cs"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", false)
    .executeTakeFirst();
  if (!s) throw ApiError.missing("checkout_session", sessionId);
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", s.payment_intent_id)
    .where("account_id", "=", m.account)
    .where("livemode", "=", false)
    .executeTakeFirstOrThrow();
  if (s.status !== "open" || (i.status !== "requires_payment" && i.status !== "processing"))
    throw new ApiError("session_not_open");
  if (!p.sandbox) throw new ApiError("rail_unavailable", { params: { reason: "sandbox not configured" } });

  let origin: { asset: string; chain: string } | null;
  if (body.origin_asset_id) origin = { asset: body.origin_asset_id, chain: await chainOf(p, body.origin_asset_id) };
  else {
    const { options } = await sessionOptions(p, s, i);
    origin = defaultOrigin(options);
    if (!origin)
      throw new ApiError("asset_unsupported", { message: "No sandbox payment option can pay this session." });
  }
  const family = getChain(origin.chain)?.family;
  if (!family) throw new ApiError("asset_unsupported", { params: { asset_id: origin.asset } });

  const a = await quote(p, s.id, {
    method: "route_quote",
    originAssetId: origin.asset,
    originChain: origin.chain,
    refundTo: SANDBOX_REFUND_ADDRESSES[family],
    refundType: "origin_chain",
    payerWallet: null,
    payerCountry: null,
    agent: false,
  });
  const step = sandboxStepOf(outcome);
  if (step) {
    const d = a.deposit;
    if (!d) throw new ApiError("rail_unavailable", { params: { reason: "the quote has no deposit address" } });
    const sb = p.sandbox;
    const where = { deposit_address: d.address, ...(d.memo ? { memo: d.memo } : {}) };
    await sandboxCall(() => sb.simulateDeposit({ ...where, ...(body.amount_in ? { amount_in: body.amount_in } : {}) }));
    await sandboxCall(() => sb.advance({ ...where, to: step }));
  }
  return {
    object: "test_helper_payment" as const,
    checkout_session: fromUuid("cs", s.id),
    payment_intent: fromUuid("pi", i.id),
    payment_attempt: fromUuid("pa", a.id),
    outcome,
  };
}
