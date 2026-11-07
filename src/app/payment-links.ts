/**
 * Payment links (lld/payments.md §6.1–§6.2, §17 item 11). Merchants create, read, list and PATCH links
 * (pricing immutable, INV-6; deactivate instead of delete). Payers read a link and open a checkout
 * session from it anonymously (`GET|POST /v1/payment_links/{id}/public/**`, per-IP and per-link rate
 * limits); the session is `source: payment_link` with the link's metadata, and the checkout continues
 * exactly like `/c/:id` (attempts stay Turnstile-protected). Links emit no events in v1.
 */
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { acceptsPayers } from "../domain/payment-link/link.js";
import type { Payments } from "./context.js";
import { type PageQuery, pageOf } from "./pages.js";
import { merchantName } from "./payer.js";
import { pickDestination, validatePrice } from "./pricing.js";
import { type Merchant, openSession } from "./sessions.js";
import { settlementContext } from "./settlement-context.js";
import { type LinkRow, linkView } from "./views.js";

export interface LinkCreate {
  readonly amount: number | string;
  readonly currency: string;
  readonly asset_id?: string | undefined;
  readonly description: string;
  readonly settlement_destination?: string | undefined;
  readonly success_url?: string | undefined;
  readonly session_expires_in?: number | undefined;
  readonly max_uses?: number | undefined;
  readonly collect_email?: boolean | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/** `POST /v1/payment_links`: the price is validated like a session's now, and again for every session. */
export async function createLink(p: Payments, m: Merchant, body: LinkCreate) {
  const ctx = await settlementContext(p, m.account, m.livemode);
  await validatePrice(p, m.livemode, ctx, body);
  const asset = body.currency === "asset";
  const row = await p.db
    .insertInto("payment_links")
    .values({
      id: uuidv7(),
      account_id: m.account,
      livemode: m.livemode,
      active: true,
      amount: asset ? null : Number(body.amount),
      currency: body.currency,
      pricing_asset_id: asset ? (body.asset_id as string) : null,
      pricing_asset_amount: asset ? String(body.amount) : null,
      description: body.description,
      settlement_destination_id: body.settlement_destination ?? null,
      success_url: body.success_url ?? null,
      max_uses: body.max_uses ?? null,
      session_expires_in: body.session_expires_in ?? 3600,
      collect_email: body.collect_email ?? false,
      metadata: JSON.stringify(body.metadata ?? {}),
      version: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return linkView(row, p.settings.payOrigin);
}

async function own(p: Payments, m: Merchant, id: string): Promise<LinkRow> {
  const l = await p.db
    .selectFrom("payment_links")
    .selectAll()
    .where("id", "=", toUuid(id, "plink"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!l) throw ApiError.missing("payment_link", id);
  return l;
}

export async function getLink(p: Payments, m: Merchant, id: string) {
  return linkView(await own(p, m, id), p.settings.payOrigin);
}

export async function listLinks(p: Payments, m: Merchant, q: PageQuery & { active?: boolean | undefined }) {
  let base = p.db
    .selectFrom("payment_links")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.active !== undefined) base = base.where("active", "=", q.active);
  const page = await pageOf(base, q, "plink");
  return {
    object: "list" as const,
    data: page.rows.map((l) => linkView(l, p.settings.payOrigin)),
    has_more: page.hasMore,
    url: "/v1/payment_links",
  };
}

export interface LinkPatch {
  readonly active?: boolean | undefined;
  readonly description?: string | undefined;
  readonly success_url?: string | null | undefined;
  readonly max_uses?: number | null | undefined;
  readonly collect_email?: boolean | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/** `PATCH /v1/payment_links/{id}` (pricing and destination are immutable). */
export async function updateLink(p: Payments, m: Merchant, id: string, body: LinkPatch) {
  const l = await own(p, m, id);
  const patch: Record<string, unknown> = {};
  if (body.active !== undefined) patch.active = body.active;
  if (body.description !== undefined) patch.description = body.description;
  if (body.success_url !== undefined) patch.success_url = body.success_url;
  if (body.max_uses !== undefined) patch.max_uses = body.max_uses;
  if (body.collect_email !== undefined) patch.collect_email = body.collect_email;
  if (body.metadata !== undefined) patch.metadata = JSON.stringify(body.metadata);
  const row = await p.db
    .updateTable("payment_links")
    .set((eb) => ({ ...patch, version: eb("version", "+", 1), updated_at: new Date() }))
    .where("id", "=", l.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return linkView(row, p.settings.payOrigin);
}

// ------------------------------------------------------------------------------------------- payer (anonymous)

async function publicRow(p: Payments, id: string): Promise<LinkRow> {
  const l = await p.db.selectFrom("payment_links").selectAll().where("id", "=", toUuid(id, "plink")).executeTakeFirst();
  if (!l) throw ApiError.missing("payment_link", id);
  return l;
}

/** `GET /v1/payment_links/{id}/public`: no PII, never the raw address. */
export async function getPublicLink(p: Payments, id: string) {
  const l = await publicRow(p, id);
  let settlement: { asset_id: string; chain: string; type: "chain_address" | "intents_account" } | null = null;
  let name = "";
  try {
    const ctx = await settlementContext(p, l.account_id, l.livemode);
    name = ctx.account.verified_legal_name ?? ctx.account.display_name;
    const d = pickDestination(ctx, l.settlement_destination_id, l.currency === "asset" ? l.pricing_asset_id : null);
    settlement = { asset_id: d.asset_id, chain: d.chain, type: d.type };
  } catch {
    if (!name) name = await merchantName(p, l.account_id, l.livemode).catch(() => "");
  }
  return {
    id: fromUuid("plink", l.id),
    object: "payment_link" as const,
    livemode: l.livemode,
    active: acceptsPayers({ active: l.active, uses: l.uses, maxUses: l.max_uses }),
    amount: l.currency === "asset" ? (l.pricing_asset_amount as string) : Number(l.amount),
    currency: l.currency,
    asset_id: l.pricing_asset_id,
    display: { merchant_name_unverified: name, description: l.description },
    settlement,
    collect_email: l.collect_email,
  };
}

// sliding-window limits per replica (the gateway adds its own per-IP limit)
const windows = new Map<string, number[]>();
const WINDOW_MS = 60_000;

function limit(p: Payments, key: string, max: number): void {
  const now = p.now();
  const recent = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    const retry = Math.max(1, Math.ceil(((recent[0] as number) + WINDOW_MS - now) / 1000));
    throw new ApiError("rate_limited", { params: { retry_after: retry }, headers: { "Retry-After": String(retry) } });
  }
  recent.push(now);
  windows.set(key, recent);
  if (windows.size > 50_000) windows.delete(windows.keys().next().value as string);
}

/** For tests: forget the rate-limit windows. */
export function resetLinkLimits(): void {
  windows.clear();
}

/** `POST /v1/payment_links/{id}/public/sessions`. */
export async function createLinkSession(
  p: Payments,
  id: string,
  body: { customer_email?: string | undefined; locale?: string | undefined },
  ip: string,
) {
  limit(p, `ip:${ip}`, p.settings.linkSessionsPerIp);
  limit(p, `link:${id}`, p.settings.linkSessionsPerLink);
  const l = await publicRow(p, id);
  if (!acceptsPayers({ active: l.active, uses: l.uses, maxUses: l.max_uses }))
    throw new ApiError("link_inactive", {
      message: l.active ? "This payment link has reached its usage limit." : "This payment link is no longer active.",
    });
  const plink = fromUuid("plink", l.id);
  const o = await openSession(
    p,
    { account: l.account_id, livemode: l.livemode },
    {
      amount: l.currency === "asset" ? (l.pricing_asset_amount as string) : Number(l.amount),
      currency: l.currency,
      ...(l.pricing_asset_id ? { asset_id: l.pricing_asset_id } : {}),
      ...(l.settlement_destination_id ? { settlement_destination: l.settlement_destination_id } : {}),
      // no merchant redirect: the checkout's own confirmation page for the link
      success_url: l.success_url ?? `${p.settings.payOrigin}/l/${plink}/complete`,
      expires_in: l.session_expires_in,
      ui_mode: "hosted",
      description: l.description,
      ...(l.collect_email && body.customer_email ? { customer_email: body.customer_email } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
      metadata: l.metadata,
      source: "payment_link",
      paymentLinkId: l.id,
    },
  );
  return {
    object: "payment_link_session" as const,
    checkout_session: fromUuid("cs", o.s.id),
    client_secret: o.secret,
    url: o.url,
    expires_at: o.s.expires_at.toISOString(),
  };
}
