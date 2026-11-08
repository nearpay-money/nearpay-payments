/**
 * Internal invoice checkout sessions (lld/payments.md §6.3, §20; spec 0.3.0). Billing owns the invoice;
 * payments owns the session and intent that pay it. The hosted invoice payer routes
 * (`/v1/invoices/{id}/public/**`, `X-NearPay-Invoice-Secret`) are billing's: `createPublicInvoiceSession`
 * calls `createInvoiceCheckoutSession` here.
 *
 * - create: the usual session guards (§8.1: account live in live mode, destination active, rails minimum,
 *   unverified cap, currency) plus the customer, `source: invoice`, `invoice`, an explicit `expires_at`
 *   5 min–30 d ahead and at most one `open` session per invoice (unique index; `409 state_conflict`). The
 *   response carries `client_secret` and `url` once. `Idempotency-Key` is honoured here because the service
 *   kit only stores keys of account principals (billing's token has no account).
 * - read: any session by id, never its secret or URL.
 * - expire: invoice sessions only, like the merchant expire (`attempt_in_flight`, `state_conflict`); an
 *   `expired` session is returned unchanged.
 *
 * Billing learns outcomes from the ordinary `evt.payments.payment_intent.*` and
 * `evt.payments.checkout_session.*` events: both objects carry `invoice`.
 */
import { createHash } from "node:crypto";
import { idempotencyStore } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { invoiceExpiryProblem } from "../domain/checkout-session/session.js";
import type { Payments } from "./context.js";
import { attachableCustomer, expireOpen, type Merchant, openSession } from "./sessions.js";
import { sessionView } from "./views.js";

export interface InvoiceSessionCreate {
  readonly account_id: string;
  readonly livemode: boolean;
  readonly invoice: string;
  readonly amount: number | string;
  readonly currency: string;
  readonly asset_id?: string | undefined;
  readonly customer: string;
  readonly description: string;
  readonly settlement_destination?: string | undefined;
  readonly success_url: string;
  readonly expires_at: string;
  readonly locale?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

export const INVOICE_SESSIONS_PATH = "/internal/checkout_sessions";

/** The stored idempotency key: namespaced so billing's keys never meet the merchant's own (≤ 255 chars). */
export function billingIdempotencyKey(key: string): string {
  const k = `billing:${key}`;
  return k.length <= 255 ? k : `billing:sha256:${createHash("sha256").update(key).digest("hex")}`;
}

async function create(p: Payments, body: InvoiceSessionCreate) {
  const m: Merchant = { account: toUuid(body.account_id, "acct"), livemode: body.livemode };
  const expiresAt = Date.parse(body.expires_at);
  const problem = invoiceExpiryProblem(expiresAt, p.now());
  if (problem) throw ApiError.invalid(problem, "expires_at");
  const customerId = await attachableCustomer(p, m, body.customer);
  const o = await openSession(p, m, {
    amount: body.amount,
    currency: body.currency,
    asset_id: body.asset_id,
    settlement_destination: body.settlement_destination,
    success_url: body.success_url,
    ui_mode: "hosted",
    description: body.description,
    locale: body.locale,
    metadata: body.metadata,
    // late payments follow the account setting (INV-3; §20 item 1)
    late_payments: undefined,
    source: "invoice",
    customerId,
    invoiceId: toUuid(body.invoice, "in"),
    expiresAt: new Date(expiresAt),
  });
  return sessionView(o.s, o.i, { secret: o.secret, url: o.url });
}

/** `POST /internal/checkout_sessions` (`createInvoiceCheckoutSession`) → `201` session with secret and URL. */
export async function createInvoiceSession(p: Payments, body: InvoiceSessionCreate, idempotencyKey?: string) {
  if (!idempotencyKey) return create(p, body);
  const r = await idempotencyStore(p.db, p.cipher).run(
    {
      accountId: toUuid(body.account_id, "acct"),
      livemode: body.livemode,
      key: billingIdempotencyKey(idempotencyKey),
      method: "POST",
      path: INVOICE_SESSIONS_PATH,
      body,
    },
    async () => ({ status: 201, body: await create(p, body) }),
  );
  return r.body as Awaited<ReturnType<typeof create>>;
}

async function sessionById(p: Payments, id: string) {
  const s = await p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("id", "=", toUuid(id, "cs"))
    .executeTakeFirst();
  if (!s) throw ApiError.missing("checkout_session", id);
  return s;
}

/** `GET /internal/checkout_sessions/{id}` (`getInternalCheckoutSession`): any status, never the secret. */
export async function getInternalSession(p: Payments, id: string) {
  const s = await sessionById(p, id);
  const i = await p.db
    .selectFrom("payment_intents")
    .selectAll()
    .where("id", "=", s.payment_intent_id)
    .where("account_id", "=", s.account_id)
    .where("livemode", "=", s.livemode)
    .executeTakeFirstOrThrow();
  return sessionView(s, i);
}

/** `POST /internal/checkout_sessions/{id}/expire` (`expireInvoiceCheckoutSession`). */
export async function expireInvoiceSession(
  p: Payments,
  id: string,
  reason: "invoice_voided" | "invoice_paid" | "superseded" | (string & {}),
) {
  const s = await sessionById(p, id);
  if (!s.invoice_id)
    throw new ApiError("state_conflict", { message: "Only a session opened for an invoice can be expired here." });
  return expireOpen(p, s, { cause: `expired by billing: ${reason}`, actor: "billing" }, { expiredIsDone: true });
}
