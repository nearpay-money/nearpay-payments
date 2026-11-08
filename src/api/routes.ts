/**
 * Spec route bindings (lld/payments.md §6). Authentication, scopes, test-mode-only routes and
 * automatic idempotency (merchant POSTs with `Idempotency-Key`) are enforced from the spec by the
 * service bootstrap; payer routes authenticate with the session's client secret here.
 */
import {
  advancePaymentAttempt,
  cancelPaymentIntent,
  cancelRefund,
  createCheckoutSession,
  createCustomer,
  createPaymentAttempt,
  createPaymentIntent,
  createPaymentLink,
  createPaymentLinkSession,
  createRefund,
  deleteCustomer,
  expireCheckoutSession,
  getCheckoutSession,
  getCustomer,
  getPaymentIntent,
  getPaymentLink,
  getPublicCheckoutSession,
  getPublicPaymentLink,
  getRefund,
  listBalanceTransactions,
  listCheckoutSessions,
  listCustomers,
  listPaymentIntents,
  listPaymentLinks,
  listPaymentOptions,
  listRefunds,
  prepareRefund,
  reviewPaymentIntent,
  signalDepositSent,
  simulateDeposit,
  simulateRefundDeposit,
  streamCheckoutSession,
  submitDepositTx,
  submitRefundTx,
  submitSignedIntent,
  updateCustomer,
  updatePaymentLink,
  updateRefundRecipient,
} from "@nearpay/spec";
import { toUuid } from "@nearpay-internal/ids";
import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import {
  createAgentAttempt as createAgentAttemptRoute,
  createOpsReconciliationRun,
  getInternalPaymentIntent,
  getInternalRefund,
  getOpsReconciliationRun,
  getOpsRefund,
  getPayerCheckoutSession,
  getReceiptContext,
  getRefundReceiptContext,
  listOpsReconciliationRuns,
  resolveOpsReconciliationRun,
} from "@nearpay-internal/spec";
import * as attempts from "../app/attempts.js";
import type { Payments } from "../app/context.js";
import * as customers from "../app/customers.js";
import {
  cancelIntent,
  createPaymentIntent as createIntent,
  getIntent,
  getInternalIntent,
  listIntents,
  reviewIntent,
} from "../app/intents.js";
import { operatorOf } from "../app/ops-audit.js";
import { getPayerSession, getPublicSession, paymentOptions } from "../app/payer.js";
import * as links from "../app/payment-links.js";
import { receiptContext } from "../app/receipts.js";
import * as recon from "../app/reconciliation.js";
import * as refunds from "../app/refunds.js";
import { createSession, expireSession, getSession, listSessions, type Merchant } from "../app/sessions.js";
import { listLines } from "../app/statement.js";
import { clientIp } from "../domain/payment-link/rate-limit.js";
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

/**
 * The payer's IP by identity's rule (L-ID-07, audit finding 3): `CF-Connecting-IP` on the server stage,
 * the first `X-Forwarded-For` hop elsewhere; `unknown` when absent or malformed. Cloudflare geo headers.
 */
export function payerClient(p: Payments, ctx: RequestContext) {
  const ip = clientIp(p.env, {
    cfConnectingIp: header(ctx, "cf-connecting-ip"),
    xForwardedFor: header(ctx, "x-forwarded-for"),
  });
  return {
    ip: ip ?? "unknown",
    country: header(ctx, "cf-ipcountry") ?? null,
    region: header(ctx, "cf-region-code") ?? null,
  };
}

/** Who acts on a merchant route: the key or dashboard user, and whether it came from the dashboard. */
export function actorOf(ctx: RequestContext): refunds.Actor {
  const c = ctx.principal;
  return { id: c?.sub ?? "unknown", source: c?.ptype === "session" ? "dashboard" : "api" };
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
      async (ctx) =>
        attempts.createPayerAttempt(p, ctx.params.id, secretOf(ctx), ctx.body, payerClient(p, ctx)) as never,
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

    // ---- stage 2: payment intents
    implement(createPaymentIntent, async (ctx) => createIntent(p, merchant(ctx), ctx.body as never) as never),
    implement(
      reviewPaymentIntent,
      async (ctx) => reviewIntent(p, merchant(ctx), ctx.params.id, ctx.body, actorOf(ctx)) as never,
    ),

    // ---- stage 2: refunds
    implement(createRefund, async (ctx) =>
      respond(
        201,
        (await refunds.createRefund(p, merchant(ctx), ctx.body as never, actorOf(ctx), ctx.idempotencyKey)) as never,
      ),
    ),
    implement(getRefund, async (ctx) => refunds.getRefund(p, merchant(ctx), ctx.params.id) as never),
    implement(listRefunds, async (ctx) => refunds.listRefunds(p, merchant(ctx), ctx.query) as never),
    implement(
      prepareRefund,
      async (ctx) => refunds.prepareRefund(p, merchant(ctx), ctx.params.id, actorOf(ctx)) as never,
    ),
    implement(
      submitRefundTx,
      async (ctx) => refunds.submitRefundTx(p, merchant(ctx), ctx.params.id, ctx.body as never, actorOf(ctx)) as never,
    ),
    implement(
      cancelRefund,
      async (ctx) => refunds.cancelRefund(p, merchant(ctx), ctx.params.id, actorOf(ctx)) as never,
    ),
    implement(
      updateRefundRecipient,
      async (ctx) => refunds.updateRecipient(p, merchant(ctx), ctx.params.id, ctx.body, actorOf(ctx)) as never,
    ),
    implement(simulateRefundDeposit, async (ctx) => {
      await refunds.simulateRefundDeposit(p, merchant(ctx), ctx.params.id);
      return respond(202, undefined);
    }),

    // ---- stage 2: payment links
    implement(createPaymentLink, async (ctx) => links.createLink(p, merchant(ctx), ctx.body as never) as never),
    implement(getPaymentLink, async (ctx) => links.getLink(p, merchant(ctx), ctx.params.id) as never),
    implement(listPaymentLinks, async (ctx) => links.listLinks(p, merchant(ctx), ctx.query) as never),
    implement(updatePaymentLink, async (ctx) => links.updateLink(p, merchant(ctx), ctx.params.id, ctx.body) as never),
    implement(getPublicPaymentLink, async (ctx) => links.getPublicLink(p, ctx.params.id) as never),
    implement(
      createPaymentLinkSession,
      async (ctx) => links.createLinkSession(p, ctx.params.id, ctx.body, payerClient(p, ctx).ip) as never,
    ),

    // ---- stage 2: customers
    implement(createCustomer, async (ctx) => customers.createCustomer(p, merchant(ctx), ctx.body) as never),
    implement(getCustomer, async (ctx) => customers.getCustomer(p, merchant(ctx), ctx.params.id) as never),
    implement(listCustomers, async (ctx) => customers.listCustomers(p, merchant(ctx), ctx.query) as never),
    implement(
      updateCustomer,
      async (ctx) => customers.updateCustomer(p, merchant(ctx), ctx.params.id, ctx.body) as never,
    ),
    implement(deleteCustomer, async (ctx) => customers.deleteCustomer(p, merchant(ctx), ctx.params.id) as never),

    // ---- stage 2: internal
    // agentpay reads the issued payload here while payments holds the leg `submitting` (refundView `relaying`)
    implement(getInternalRefund, async (ctx) => refunds.getRefundById(p, ctx.params.id, { relaying: true }) as never),
    implement(getRefundReceiptContext, async (ctx) => refunds.refundReceiptContext(p, ctx.params.id) as never),
    implement(
      getPayerCheckoutSession,
      async (ctx) => getPayerSession(p, ctx.params.id, secretOf(ctx as never)) as never,
    ),

    // ---- stage 2: console (/ops, ops principals; scopes, opsRoles and step-up enforced by the service kit)
    implement(listOpsReconciliationRuns, async (ctx) => recon.listRuns(p, ctx.query as never) as never),
    implement(getOpsReconciliationRun, async (ctx) => recon.getRun(p, ctx.params.id) as never),
    implement(createOpsReconciliationRun, async (ctx) =>
      respond(202, (await recon.createRun(p, operatorOf(ctx), ctx.body)) as never),
    ),
    implement(
      resolveOpsReconciliationRun,
      async (ctx) => recon.resolveRun(p, operatorOf(ctx), ctx.params.id, ctx.body) as never,
    ),
    implement(getOpsRefund, async (ctx) => refunds.getRefundById(p, ctx.params.id) as never),
  ];
}
