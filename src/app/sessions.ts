/**
 * Checkout sessions for merchants (lld/payments.md §6.1, §8.1): create, read, list and expire.
 *
 * Creation snapshots everything that fixes the payment's terms (destination, fee schedule and bearer,
 * settings) onto the intent in the same transaction as the session (INV-6), and schedules the
 * `session.expire` job at `expires_at`. The client secret is returned once, in the URL fragment.
 */
import { enqueueJob } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { originsProblem, sessionTtl } from "../domain/checkout-session/session.js";
import { isAttemptStatus } from "../domain/payment-attempt/attempt.js";
import { canExpire, onSessionDeadline } from "../domain/payment-intent/intent.js";
import { acceptsPayers, RESERVING_INTENT_STATUSES } from "../domain/payment-link/link.js";
import type { DestinationSnapshotJson } from "../infra/db/schema.js";
import type { Payments, Tx } from "./context.js";
import {
  attemptsOf,
  emitIntentEvents,
  emitSessionEvents,
  hideAttempts,
  lockIntent,
  lockSessionOfIntent,
  updateIntent,
  updateSession,
} from "./ledger.js";
import { type Page, type PageQuery, pageOf } from "./pages.js";
import { validatePrice } from "./pricing.js";
import { newClientSecret } from "./secrets.js";
import { settlementContext } from "./settlement-context.js";
import { type AttemptRow, type IntentRow, type SessionRow, sessionView } from "./views.js";

export const SESSION_EXPIRE_JOB = "session.expire";

export interface Merchant {
  /** Account uuid. */
  readonly account: string;
  readonly livemode: boolean;
}

export interface SessionCreate {
  readonly amount: number | string;
  readonly currency: string;
  readonly asset_id?: string | undefined;
  readonly settlement_destination?: string | undefined;
  readonly success_url: string;
  readonly cancel_url?: string | undefined;
  readonly expires_in?: number | undefined;
  readonly ui_mode: "hosted" | "embedded";
  readonly customer_email?: string | undefined;
  readonly description?: string | undefined;
  readonly allowed_origins?: readonly string[] | undefined;
  readonly late_payments?: boolean | undefined;
  readonly locale?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

export { assetInfo } from "./pricing.js";

/** What opens a session: the merchant API, an API intent (headless), or a payment link payer. */
export interface SessionSpec extends SessionCreate {
  readonly source: "checkout" | "payment_link" | "api";
  readonly customerId?: string | null;
  readonly paymentLinkId?: string | null;
  readonly headless?: boolean;
}

export interface Opened {
  readonly s: SessionRow;
  readonly i: IntentRow;
  readonly secret: string;
  readonly url: string;
}

/**
 * The customer to attach (same account and mode); a deleted one is refused (`customer_deleted`).
 * Returns its uuid.
 */
export async function attachableCustomer(p: Payments, m: Merchant, id: string | undefined): Promise<string | null> {
  if (!id) return null;
  const c = await p.db
    .selectFrom("customers")
    .select(["id", "deleted_at"])
    .where("id", "=", toUuid(id, "cus"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!c) throw ApiError.missing("customer", id, "customer");
  if (c.deleted_at) throw new ApiError("customer_deleted", { param: "customer" });
  return c.id;
}

/**
 * A session opened from a payment link reserves one of its uses (audit finding 12): under the link's row
 * lock, `uses` + intents of the link that can still succeed must stay below `max_uses`. Concurrent
 * session creations serialise on the lock; a reservation ends with its intent (succeeded → a use;
 * canceled or expired → released), so nothing has to be given back explicitly.
 */
async function reserveLinkUse(tx: Tx, m: Merchant, linkId: string): Promise<void> {
  const l = await tx
    .selectFrom("payment_links")
    .select(["active", "uses", "max_uses"])
    .where("id", "=", linkId)
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .forUpdate()
    .executeTakeFirst();
  if (!l) throw ApiError.missing("payment_link", fromUuid("plink", linkId));
  let reserved = 0;
  if (l.max_uses !== null) {
    const r = await tx
      .selectFrom("payment_intents")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("payment_link_id", "=", linkId)
      .where("account_id", "=", m.account)
      .where("livemode", "=", m.livemode)
      .where("status", "in", [...RESERVING_INTENT_STATUSES])
      .executeTakeFirstOrThrow();
    reserved = Number(r.n);
  }
  if (!acceptsPayers({ active: l.active, uses: l.uses, maxUses: l.max_uses }, reserved))
    throw new ApiError("link_inactive", {
      message: !l.active
        ? "This payment link is no longer active."
        : l.uses >= (l.max_uses as number)
          ? "This payment link has reached its usage limit."
          : "Every remaining use of this payment link is held by a checkout in progress; try again later.",
    });
}

/**
 * Opens a checkout session and its intent (§8.1): validates the price, snapshots destination, fee
 * schedule + bearer and settings (INV-6) and schedules `session.expire`, in one transaction.
 */
export async function openSession(p: Payments, m: Merchant, body: SessionSpec): Promise<Opened> {
  const ctx = await settlementContext(p, m.account, m.livemode);
  if (m.livemode && !ctx.account.live_enabled) throw new ApiError("account_not_live");
  const assetPriced = body.currency === "asset";
  const origins = body.allowed_origins ?? [];
  const problem = originsProblem(body.ui_mode, origins, m.livemode);
  if (problem) throw new ApiError("allowed_origins_required", { param: "allowed_origins", message: problem });
  const { dest, destAsset } = await validatePrice(p, m.livemode, ctx, body);

  const settings = ctx.account.settings;
  const ttl = sessionTtl(body.expires_in, settings.session_ttl_default);
  const now = p.now();
  const intentId = uuidv7();
  const sessionId = uuidv7();
  const csId = fromUuid("cs", sessionId);
  const secret = newClientSecret(csId);
  const snapshot: DestinationSnapshotJson = {
    sd_id: dest.id,
    asset_id: dest.asset_id,
    type: dest.type,
    chain: dest.chain,
    address: dest.address,
    address_norm: dest.address_norm,
    attestation_hash: dest.attestation_hash,
    verification: dest.verification,
    per_payment_cap_usd_micros: dest.per_payment_cap_usd_micros,
    fingerprint: dest.fingerprint ?? null,
  };
  const metadata = JSON.stringify(body.metadata ?? {});
  const expiresAt = new Date(now + ttl * 1000);

  const { s, i } = await p.db.transaction().execute(async (tx) => {
    if (body.paymentLinkId) await reserveLinkUse(tx, m, body.paymentLinkId);
    const i0 = await tx
      .insertInto("payment_intents")
      .values({
        id: intentId,
        account_id: m.account,
        livemode: m.livemode,
        status: "requires_payment",
        amount: assetPriced ? null : Number(body.amount),
        currency: body.currency,
        pricing_asset_id: assetPriced ? (body.asset_id as string) : null,
        pricing_asset_amount: assetPriced ? String(body.amount) : null,
        description: body.description ?? null,
        source: body.source,
        customer_id: body.customerId ?? null,
        payment_link_id: body.paymentLinkId ?? null,
        destination_snapshot: JSON.stringify(snapshot),
        fee_snapshot: JSON.stringify({ schedule: ctx.fee_schedule, bearer: ctx.account.fee_bearer }),
        settings_snapshot: JSON.stringify({
          late_payments: body.late_payments ?? settings.late_payments,
          underpay_tolerance_bps: Math.min(settings.underpay_tolerance_bps, p.settings.underpayToleranceMaxBps),
        }),
        settlement_asset_id: dest.asset_id,
        settlement_decimals: destAsset.decimals,
        settlement_symbol: destAsset.symbol,
        metadata,
        version: 1,
        sequence: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const s0 = await tx
      .insertInto("checkout_sessions")
      .values({
        id: sessionId,
        account_id: m.account,
        livemode: m.livemode,
        payment_intent_id: intentId,
        status: "open",
        client_secret_hash: secret.hash,
        ui_mode: body.ui_mode,
        success_url: body.success_url,
        cancel_url: body.cancel_url ?? null,
        expires_at: expiresAt,
        customer_email_enc: body.customer_email
          ? p.cipher.encrypt(body.customer_email.toLowerCase(), `cs:${sessionId}`)
          : null,
        locale: body.locale ?? null,
        allowed_origins: [...origins],
        metadata,
        customer_id: body.customerId ?? null,
        payment_link_id: body.paymentLinkId ?? null,
        headless: body.headless ?? false,
        version: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const actor = body.source === "payment_link" ? "payer" : "merchant";
    await tx
      .insertInto("payment_intent_transitions")
      .values({
        id: uuidv7(),
        payment_intent_id: intentId,
        from_state: null,
        to_state: "requires_payment",
        cause:
          body.source === "api"
            ? "payment intent created"
            : body.source === "payment_link"
              ? "payment link session opened"
              : "checkout session created",
        actor,
        evidence: null,
      })
      .execute();
    await tx
      .insertInto("checkout_session_transitions")
      .values({
        id: uuidv7(),
        checkout_session_id: sessionId,
        from_state: null,
        to_state: "open",
        cause: body.headless ? "created (headless, API intent)" : "created",
        actor,
        evidence: null,
      })
      .execute();
    await emitIntentEvents(tx, i0, ["evt.payments.payment_intent.created"]);
    await enqueueJob(tx, {
      kind: SESSION_EXPIRE_JOB,
      payload: { session: sessionId },
      runAt: expiresAt,
      dedupeKey: `${SESSION_EXPIRE_JOB}:${sessionId}`,
      maxAttempts: 50,
    });
    return { s: s0, i: i0 };
  });
  return { s, i, secret: secret.secret, url: `${p.settings.payOrigin}/c/${csId}#${secret.secret}` };
}

export interface CheckoutCreate extends SessionCreate {
  readonly customer?: string | undefined;
}

/** `POST /v1/checkout/sessions` (§8.1). */
export async function createSession(p: Payments, m: Merchant, body: CheckoutCreate) {
  const { customer, ...rest } = body;
  const customerId = await attachableCustomer(p, m, customer);
  const o = await openSession(p, m, { ...rest, source: "checkout", customerId });
  return sessionView(o.s, o.i, { secret: o.secret, url: o.url });
}

async function ownSession(p: Payments, m: Merchant, id: string): Promise<SessionRow> {
  const s = await p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("id", "=", toUuid(id, "cs"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!s) throw ApiError.missing("checkout_session", id);
  return s;
}

/** Intents and (when expanding) their attempts for a page of sessions, by intent uuid. */
async function intentsFor(p: Payments, ids: readonly string[], withAttempts: boolean) {
  const intents = ids.length
    ? await p.db.selectFrom("payment_intents").selectAll().where("id", "in", ids).execute()
    : [];
  const attempts =
    withAttempts && ids.length
      ? await p.db.selectFrom("payment_attempts").selectAll().where("payment_intent_id", "in", ids).execute()
      : [];
  const byIntent = new Map<string, AttemptRow[]>();
  for (const a of attempts) byIntent.set(a.payment_intent_id, [...(byIntent.get(a.payment_intent_id) ?? []), a]);
  return { intents: new Map(intents.map((i) => [i.id, i])), attempts: byIntent };
}

const view = (s: SessionRow, i: IntentRow, expand: boolean, attempts: Map<string, AttemptRow[]>) =>
  sessionView(s, i, expand ? { expand: { attempts: attempts.get(i.id) ?? [] } } : {});

/** `GET /v1/checkout/sessions/{id}`. */
export async function getSession(p: Payments, m: Merchant, id: string, expand: readonly string[] = []) {
  const s = await ownSession(p, m, id);
  const exp = expand.includes("payment_intent");
  const { intents, attempts } = await intentsFor(p, [s.payment_intent_id], exp);
  return view(s, intents.get(s.payment_intent_id) as IntentRow, exp, attempts);
}

export interface SessionListQuery extends PageQuery {
  readonly status?: string | undefined;
  readonly payment_intent?: string | undefined;
  readonly expand?: readonly string[] | undefined;
}

/** `GET /v1/checkout/sessions`. */
export async function listSessions(p: Payments, m: Merchant, q: SessionListQuery) {
  let base = p.db
    .selectFrom("checkout_sessions")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.status) base = base.where("status", "=", q.status as SessionRow["status"]);
  if (q.payment_intent) base = base.where("payment_intent_id", "=", toUuid(q.payment_intent, "pi"));
  const page: Page<SessionRow> = await pageOf(base, q, "cs");
  const exp = (q.expand ?? []).includes("payment_intent");
  const { intents, attempts } = await intentsFor(
    p,
    page.rows.map((s) => s.payment_intent_id),
    exp,
  );
  return {
    object: "list" as const,
    data: page.rows.map((s) => view(s, intents.get(s.payment_intent_id) as IntentRow, exp, attempts)),
    has_more: page.hasMore,
    url: "/v1/checkout/sessions",
  };
}

/** `POST /v1/checkout/sessions/{id}/expire` (domain-model §4.1: open → expired, nothing in flight). */
export async function expireSession(p: Payments, m: Merchant, id: string) {
  const own = await ownSession(p, m, id);
  const out = await p.db.transaction().execute(async (tx) => {
    let i = (await lockIntent(tx, own.payment_intent_id)) as IntentRow;
    let s = (await lockSessionOfIntent(tx, i.id)) as SessionRow;
    const attempts = await attemptsOf(tx, i.id, true);
    const err = canExpire(
      s.status,
      i.status,
      attempts.map((a) => (isAttemptStatus(a.status) ? a.status : "held")),
    );
    if (err === "attempt_in_flight") throw new ApiError("attempt_in_flight");
    if (err)
      throw new ApiError("state_conflict", {
        message: `The session is ${s.status}; only an open session can be expired.`,
      });
    const meta = { cause: "expired by the merchant", actor: "merchant" };
    await hideAttempts(tx, i.id);
    s = await updateSession(tx, s, { status: "expired" }, meta);
    const previous = { status: i.status };
    i = await updateIntent(tx, i, { status: "expired" }, meta);
    i = await emitIntentEvents(tx, i, ["evt.payments.payment_intent.expired"], previous);
    await emitSessionEvents(tx, s, i, ["evt.payments.checkout_session.expired"]);
    return { s, i, attempts: await attemptsOf(tx, i.id) };
  });
  await p.notifier.publish(out.s.id);
  return sessionView(out.s, out.i);
}

/**
 * The `session.expire` job at `expires_at` (§9): `open → expiring` (attempts hidden: "don't send
 * again"), or straight to `expired` with the intent when nothing can still settle (INV-3). Returns
 * the session uuid when something changed.
 */
export async function expireAtDeadline(p: Payments, sessionUuid: string): Promise<string | null> {
  return p.db.transaction().execute(async (tx: Tx) => {
    const head = await tx
      .selectFrom("checkout_sessions")
      .select(["payment_intent_id", "expires_at", "status"])
      .where("id", "=", sessionUuid)
      .executeTakeFirst();
    if (head?.status !== "open") return null;
    if (head.expires_at.getTime() > p.now()) throw new Error(`session ${sessionUuid} is not due yet`);
    let i = (await lockIntent(tx, head.payment_intent_id)) as IntentRow;
    let s = (await lockSessionOfIntent(tx, i.id)) as SessionRow;
    const attempts = await attemptsOf(tx, i.id, true);
    const d = onSessionDeadline(
      s.status,
      i.status,
      attempts.map((a) => (isAttemptStatus(a.status) ? a.status : "held")),
    );
    if (!d) return null;
    const meta = { cause: "session expires_at reached", actor: "system" };
    await hideAttempts(tx, i.id);
    s = await updateSession(tx, s, { status: d.session }, meta);
    if (d.intent !== i.status) {
      const previous = { status: i.status };
      i = await updateIntent(tx, i, { status: d.intent }, meta);
      if (d.intentEvents.length) i = await emitIntentEvents(tx, i, d.intentEvents, previous);
    }
    if (d.sessionEvents.length) await emitSessionEvents(tx, s, i, d.sessionEvents);
    return s.id;
  });
}
