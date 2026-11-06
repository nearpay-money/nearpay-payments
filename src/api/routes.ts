/**
 * Spec route bindings (lld/payments.md §6). Authentication, scopes, test-mode-only routes and
 * automatic idempotency (merchant POSTs with `Idempotency-Key`) are enforced from the spec by the
 * service bootstrap; payer routes authenticate with the session's client secret here.
 */
import {
  advancePaymentAttempt,
  cancelPaymentIntent,
  createCheckoutSession,
  createPaymentAttempt,
  expireCheckoutSession,
  getCheckoutSession,
  getPaymentIntent,
  getPublicCheckoutSession,
  listBalanceTransactions,
  listCheckoutSessions,
  listPaymentIntents,
  listPaymentOptions,
  signalDepositSent,
  simulateDeposit,
  streamCheckoutSession,
  submitDepositTx,
  submitSignedIntent,
} from "@nearpay/spec";
import { toUuid } from "@nearpay-internal/ids";
import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import {
  createAgentAttempt as createAgentAttemptRoute,
  getInternalPaymentIntent,
  getReceiptContext,
} from "@nearpay-internal/spec";
import * as attempts from "../app/attempts.js";
import type { Payments } from "../app/context.js";
import { cancelIntent, getIntent, getInternalIntent, listIntents } from "../app/intents.js";
import { getPublicSession, paymentOptions } from "../app/payer.js";
import { receiptContext } from "../app/receipts.js";
import { createSession, expireSession, getSession, listSessions, type Merchant } from "../app/sessions.js";
import { listLines } from "../app/statement.js";
import { openStream } from "../sse/stream.js";

/** The account principal of a merchant route (secret/restricted key or dashboard session). */
export function merchant(ctx: RequestContext): Merchant {
  const acct = ctx.principal?.acct;
  if (!acct) throw new ApiError("authentication_required");
  return { account: toUuid(acct, "acct"), livemode: ctx.livemode };
}

const header = (ctx: RequestContext, name: string): string | undefined => {
  const v = ctx.request.headers[name];
  return (Array.isArray(v) ? v[0] : v) || undefined;
};

/** The payer's IP (first `X-Forwarded-For` hop, set by the gateway) and Cloudflare geo headers. */
export function payerClient(ctx: RequestContext) {
  const first = header(ctx, "x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: (first || ctx.request.ip || "unknown").slice(0, 64),
    country: header(ctx, "cf-ipcountry") ?? null,
    region: header(ctx, "cf-region-code") ?? null,
  };
}

const secretOf = (ctx: { headers: { "x-nearpay-client-secret"?: string } }) => ctx.headers["x-nearpay-client-secret"];

export function paymentsRoutes(p: Payments): RouteBinding[] {
  return [
    // ---- merchant
    implement(createCheckoutSession, async (ctx) => createSession(p, merchant(ctx), ctx.body) as never),
    implement(
      getCheckoutSession,
      async (ctx) => getSession(p, merchant(ctx), ctx.params.id, ctx.query.expand ?? []) as never,
    ),
    implement(listCheckoutSessions, async (ctx) => listSessions(p, merchant(ctx), ctx.query) as never),
    implement(expireCheckoutSession, async (ctx) => expireSession(p, merchant(ctx), ctx.params.id) as never),
    implement(getPaymentIntent, async (ctx) => getIntent(p, merchant(ctx), ctx.params.id) as never),
    implement(listPaymentIntents, async (ctx) => listIntents(p, merchant(ctx), ctx.query) as never),
    implement(
      cancelPaymentIntent,
      async (ctx) => cancelIntent(p, merchant(ctx), ctx.params.id, ctx.body.cancellation_reason) as never,
    ),
    implement(listBalanceTransactions, async (ctx) => listLines(p, merchant(ctx), ctx.query) as never),
    implement(advancePaymentAttempt, async (ctx) => {
      const m = merchant(ctx);
      if (m.livemode) throw new ApiError("livemode_forbidden");
      await attempts.advanceAttempt(p, ctx.principal?.acct as string, ctx.params.attempt, ctx.body.to);
      return respond(202, undefined);
    }),

    // ---- payer (client secret)
    implement(getPublicCheckoutSession, async (ctx) => getPublicSession(p, ctx.params.id, secretOf(ctx)) as never),
    implement(listPaymentOptions, async (ctx) => paymentOptions(p, ctx.params.id, secretOf(ctx), ctx.query) as never),
    implement(
      createPaymentAttempt,
      async (ctx) => attempts.createPayerAttempt(p, ctx.params.id, secretOf(ctx), ctx.body, payerClient(ctx)) as never,
    ),
    implement(submitDepositTx, async (ctx) => {
      await attempts.submitDepositTx(p, ctx.params.id, ctx.params.attempt, secretOf(ctx), ctx.body.tx_hash);
      return respond(202, undefined);
    }),
    implement(signalDepositSent, async (ctx) => {
      await attempts.signalSent(p, ctx.params.id, ctx.params.attempt, secretOf(ctx));
      return respond(202, undefined);
    }),
    implement(submitSignedIntent, async (ctx) => {
      await attempts.submitSignedIntent(p, ctx.params.id, ctx.params.attempt, secretOf(ctx), ctx.body.signed);
      return respond(202, undefined);
    }),
    implement(simulateDeposit, async (ctx) => {
      await attempts.simulateDeposit(p, ctx.params.id, ctx.params.attempt, secretOf(ctx), ctx.body.amount_in);
      return respond(202, undefined);
    }),
    implement(streamCheckoutSession, async (ctx) => {
      await openStream(p, ctx);
    }),

    // ---- internal
    implement(
      createAgentAttemptRoute,
      async (ctx) => attempts.createAgentAttempt(p, ctx.params.id, ctx.body.payer_wallet) as never,
    ),
    implement(getInternalPaymentIntent, async (ctx) => getInternalIntent(p, ctx.params.id) as never),
    implement(getReceiptContext, async (ctx) => receiptContext(p, ctx.params.id) as never),
  ];
}
