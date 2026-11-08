/**
 * Customers (lld/payments.md §4, §6.1, §12): the merchant's record of a payer. Email and name are
 * envelope-encrypted at rest (AAD binds them to the customer id) and never put in events; the email is
 * looked up by `HMAC(emailHashKey, normalised email)`. DELETE erases the personal data and keeps the row
 * (payments keep their customer id). Customer changes emit no events in v1.
 */
import { createHmac } from "node:crypto";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { dedupeWallets, normalizeEmail, type Wallet } from "../domain/customer/customer.js";
import type { Payments } from "./context.js";
import { type PageQuery, pageOf } from "./pages.js";
import type { Merchant } from "./sessions.js";
import { type CustomerRow, type CustomerTotalRow, customerView } from "./views.js";

export const emailHash = (p: Payments, email: string): Buffer =>
  createHmac("sha256", p.emailHashKey).update(normalizeEmail(email), "utf8").digest();

const aad = (id: string, field: "email" | "name") => (field === "email" ? `cus:${id}` : `cus:${id}:name`);

function decrypt(p: Payments, c: CustomerRow) {
  return {
    email: c.email_enc ? p.cipher.decrypt(c.email_enc, aad(c.id, "email")).toString("utf8") : null,
    name: c.name_enc ? p.cipher.decrypt(c.name_enc, aad(c.id, "name")).toString("utf8") : null,
  };
}

/** Stored `total_paid` rows of the customers (maintained with every intent change, spec 0.2.1). */
async function totalsOf(p: Payments, rows: readonly CustomerRow[]): Promise<Map<string, CustomerTotalRow[]>> {
  const out = new Map<string, CustomerTotalRow[]>();
  if (!rows.length) return out;
  const first = rows[0] as CustomerRow;
  const totals = await p.db
    .selectFrom("customer_totals")
    .selectAll()
    .where("account_id", "=", first.account_id)
    .where("livemode", "=", first.livemode)
    .where(
      "customer_id",
      "in",
      rows.map((c) => c.id),
    )
    .execute();
  for (const t of totals) out.set(t.customer_id, [...(out.get(t.customer_id) ?? []), t]);
  return out;
}

async function views(p: Payments, rows: readonly CustomerRow[]) {
  const totals = await totalsOf(p, rows);
  return rows.map((c) => customerView(c, decrypt(p, c), totals.get(c.id) ?? []));
}

const view = async (p: Payments, c: CustomerRow) => (await views(p, [c]))[0] as ReturnType<typeof customerView>;

export interface CustomerFields {
  readonly email?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly wallets?: readonly Wallet[] | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/** `POST /v1/customers`. */
export async function createCustomer(p: Payments, m: Merchant, body: CustomerFields) {
  const id = uuidv7();
  const email = body.email ? normalizeEmail(body.email) : null;
  const row = await p.db
    .insertInto("customers")
    .values({
      id,
      account_id: m.account,
      livemode: m.livemode,
      email_hash: email ? emailHash(p, email) : null,
      email_enc: email ? p.cipher.encrypt(email, aad(id, "email")) : null,
      name_enc: body.name ? p.cipher.encrypt(body.name, aad(id, "name")) : null,
      description: body.description ?? null,
      wallets: JSON.stringify(dedupeWallets(body.wallets ?? [])),
      metadata: JSON.stringify(body.metadata ?? {}),
      version: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return view(p, row);
}

async function own(p: Payments, m: Merchant, id: string): Promise<CustomerRow> {
  const c = await p.db
    .selectFrom("customers")
    .selectAll()
    .where("id", "=", toUuid(id, "cus"))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .executeTakeFirst();
  if (!c) throw ApiError.missing("customer", id);
  return c;
}

/** `GET /v1/customers/{id}` (a deleted customer is gone: 404). */
export async function getCustomer(p: Payments, m: Merchant, id: string) {
  const c = await own(p, m, id);
  if (c.deleted_at) throw ApiError.missing("customer", id);
  return view(p, c);
}

/** `GET /v1/customers` (`email`: exact, case-insensitive, via the lookup hash). */
export async function listCustomers(p: Payments, m: Merchant, q: PageQuery & { email?: string | undefined }) {
  let base = p.db
    .selectFrom("customers")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("deleted_at", "is", null);
  if (q.email) base = base.where("email_hash", "=", emailHash(p, q.email));
  const page = await pageOf(base, q, "cus");
  return {
    object: "list" as const,
    data: await views(p, page.rows),
    has_more: page.hasMore,
    url: "/v1/customers",
  };
}

/** `PATCH /v1/customers/{id}` (`null` clears a field; `wallets` replaces the list). */
export async function updateCustomer(p: Payments, m: Merchant, id: string, body: CustomerFields) {
  const c = await own(p, m, id);
  if (c.deleted_at) throw new ApiError("customer_deleted");
  const patch: Record<string, unknown> = {};
  if (body.email !== undefined) {
    const email = body.email === null ? null : normalizeEmail(body.email);
    patch.email_hash = email ? emailHash(p, email) : null;
    patch.email_enc = email ? p.cipher.encrypt(email, aad(c.id, "email")) : null;
  }
  if (body.name !== undefined)
    patch.name_enc = body.name === null ? null : p.cipher.encrypt(body.name, aad(c.id, "name"));
  if (body.description !== undefined) patch.description = body.description;
  if (body.wallets !== undefined) patch.wallets = JSON.stringify(dedupeWallets(body.wallets));
  if (body.metadata !== undefined) patch.metadata = JSON.stringify(body.metadata);
  const row = await p.db
    .updateTable("customers")
    .set({ ...patch, version: c.version + 1, updated_at: new Date() })
    .where("id", "=", c.id)
    .where("version", "=", c.version)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new ApiError("state_conflict", { message: "The customer changed concurrently; retry." });
  return view(p, row);
}

/** `DELETE /v1/customers/{id}`: erases personal data (email, name, description, wallets, metadata). */
export async function deleteCustomer(p: Payments, m: Merchant, id: string) {
  const c = await own(p, m, id);
  if (!c.deleted_at)
    await p.db
      .updateTable("customers")
      .set({
        email_hash: null,
        email_enc: null,
        name_enc: null,
        description: null,
        wallets: "[]",
        metadata: "{}",
        deleted_at: new Date(p.now()),
        updated_at: new Date(),
        version: c.version + 1,
      })
      .where("id", "=", c.id)
      .execute();
  return { id: fromUuid("cus", c.id), object: "customer" as const, livemode: c.livemode, deleted: true as const };
}

/**
 * `GET /internal/customers/{id}` (billing, `payments.read`; Stage 3 §20 item 4): any customer by id with its
 * account and decrypted email (PII; never in events). A deleted customer is returned with `deleted: true` and
 * its personal data erased (`email`/`name` null) so billing can refuse it with `customer_deleted`.
 */
export async function getInternalCustomer(p: Payments, id: string) {
  const c = await p.db.selectFrom("customers").selectAll().where("id", "=", toUuid(id, "cus")).executeTakeFirst();
  if (!c) throw ApiError.missing("customer", id);
  const deleted = c.deleted_at !== null;
  const totals = await totalsOf(p, [c]);
  const v = customerView(c, deleted ? { email: null, name: null } : decrypt(p, c), totals.get(c.id) ?? []);
  return { ...v, account_id: fromUuid("acct", c.account_id), deleted };
}
