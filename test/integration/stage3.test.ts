/**
 * Stage 3 through the real api and worker (lld/payments.md §16.1, §20; spec 0.3.0):
 * - billing's internal invoice sessions (create with guards, idempotency and one open session per invoice;
 *   read without the secret; expire), `invoice` on intents/sessions and on the events billing consumes,
 *   `listPaymentIntents?invoice=`, `getInternalCustomer`;
 * - `payCheckoutSessionTestHelper` and the restricted-key alternatives on the test helpers;
 * - rails executions owned by another service are acknowledged without effect;
 * - reconciliation lists only payments' evidence (`owner=payments`).
 */

import { newId } from "@nearpay-internal/ids";
import { type Execution, listEvidence } from "@nearpay-internal/spec";
import { domainEvent, execution, expectEvent } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireAtDeadline } from "../../src/app/sessions.js";
import { type Merchant, type Stack, startStack, USDC_BASE, USDC_NEAR, uuid } from "../support/stack.js";
import { freshEvidence } from "../support/stage2.js";

let st: Stack;

beforeAll(async () => {
  st = await startStack({ worker: true });
});
afterAll(async () => {
  await st?.stop();
});

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const inv = () => newId("in");
const ahead = (s: number) => new Date(Date.now() + s * 1000).toISOString();

async function customer(m: Merchant, email = "ann@example.com"): Promise<string> {
  const r = await st.call("POST", "/v1/customers", { token: await st.token(m), body: { email, name: "Ann" } });
  expect(r.status).toBe(201);
  return r.body.id;
}

function invoiceBody(m: Merchant, cus: string, invoice: string, o: Record<string, unknown> = {}) {
  return {
    account_id: m.account,
    livemode: false,
    invoice,
    amount: 2500,
    currency: "usd",
    customer: cus,
    description: "Invoice ACME01T-00042",
    success_url: "https://pay.nearpay.localhost/i/x",
    expires_at: ahead(7 * 86_400),
    metadata: { invoice_number: "ACME01T-00042" },
    ...o,
  };
}

async function createInvoiceSession(body: unknown, key?: string, token?: string) {
  return st.call("POST", "/internal/checkout_sessions", {
    token: token ?? (await st.serviceToken("billing")),
    body,
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
}

async function railsEvent(m: Merchant, exId: string, patch: Record<string, unknown>, subject: string) {
  const x = st.advance(exId, patch as never);
  await st.publishEvent(
    domainEvent(subject as never, x, {
      accountUuid: uuid(m.account, "acct"),
      livemode: x.livemode,
      version: x.version,
    }),
  );
  return x;
}

async function executionOf(attempt: string): Promise<string> {
  const row = await st.admin.db
    .selectFrom("payment_attempts")
    .select("execution_id")
    .where("id", "=", uuid(attempt, "pa"))
    .executeTakeFirstOrThrow();
  return row.execution_id as string;
}

// ============================================================================ internal invoice sessions
describe("internal invoice sessions (billing, §20)", () => {
  it("opens a hosted invoice session with secret and URL once; idempotent; one open session per invoice", async () => {
    const m = st.merchant();
    const cus = await customer(m);
    const invoice = inv();
    const probe = await st.probe();
    const body = invoiceBody(m, cus, invoice);
    const r = await createInvoiceSession(body, `in:${invoice}:s1`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      object: "checkout_session",
      status: "open",
      ui_mode: "hosted",
      amount: 2500,
      currency: "usd",
      invoice,
      customer: cus,
      description: "Invoice ACME01T-00042",
      late_payments: false,
      metadata: { invoice_number: "ACME01T-00042" },
    });
    expect(r.body.expires_at).toBe(Math.floor(Date.parse(body.expires_at) / 1000));
    expect(r.body.url).toBe(`https://pay.nearpay.localhost/c/${r.body.id}#${r.body.client_secret}`);
    const created = await expectEvent(probe, "evt.payments.payment_intent.created", {
      data: { object: { id: r.body.payment_intent } },
    });
    expect(created.data.object).toMatchObject({
      source: "invoice",
      invoice,
      customer: cus,
      checkout_session: r.body.id,
    });
    await probe.close();

    // the same key replays the same session (secret included); no second intent
    const again = await createInvoiceSession(body, `in:${invoice}:s1`);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: r.body.id, client_secret: r.body.client_secret });
    // another create while that one is open: 409 (with or without a key), nothing created
    const second = await createInvoiceSession(body, `in:${invoice}:s2`);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("state_conflict");
    expect((await createInvoiceSession(body)).body.error.code).toBe("state_conflict");
    const token = await st.token(m);
    const list = await st.call("GET", `/v1/payment_intents?invoice=${invoice}`, { token });
    expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([r.body.payment_intent]);
    expect(list.body.data[0]).toMatchObject({ invoice, source: "invoice" });
    expect((await st.call("GET", `/v1/payment_intents?invoice=${inv()}`, { token })).body.data).toEqual([]);
    // a reused key with another body is refused
    const reused = await createInvoiceSession({ ...body, amount: 2600 }, `in:${invoice}:s1`);
    expect(reused.body.error.code).toBe("idempotency_key_reused");

    // billing's read: any status, never the secret or URL; merchants see `invoice` too
    const got = await st.call("GET", `/internal/checkout_sessions/${r.body.id}`, {
      token: await st.serviceToken("billing"),
    });
    expect(got.body).toMatchObject({ id: r.body.id, invoice, client_secret: null, url: null, status: "open" });
    const merchantView = await st.call("GET", `/v1/checkout/sessions/${r.body.id}`, { token });
    expect(merchantView.body).toMatchObject({ invoice, client_secret: null });
    // the payer page works with the secret like any hosted session
    const pubView = await st.call("GET", `/v1/checkout/sessions/${r.body.id}/public`, { secret: r.body.client_secret });
    expect(pubView.body).toMatchObject({ status: "open", amount: 2500 });
  });

  it("keeps every session guard: live account, destination minimum, unverified cap, customer, deadline, scope", async () => {
    const m = st.merchant();
    const cus = await customer(m);
    const code = async (b: unknown, token?: string) => (await createInvoiceSession(b, undefined, token)).body.error;
    expect((await code(invoiceBody(m, cus, inv(), { amount: 5 }))).code).toBe("amount_below_destination_minimum");
    const capped = st.merchant({ verification: "unverified", capUsdMicros: 10_000_000 });
    const cappedCus = await customer(capped);
    expect((await code(invoiceBody(capped, cappedCus, inv(), { amount: 1001 }))).code).toBe(
      "amount_above_unverified_cap",
    );
    expect((await createInvoiceSession(invoiceBody(capped, cappedCus, inv(), { amount: 1000 }))).status).toBe(201);
    expect((await code(invoiceBody(m, cus, inv(), { currency: "sek" }))).code).toBe("currency_unsupported");
    // live mode needs a live-enabled account (the customer must exist in live mode as well)
    const notLive = st.merchant({ liveEnabled: false });
    const liveCus = await st.call("POST", "/v1/customers", {
      token: await st.token(notLive, { livemode: true }),
      body: { email: "bob@example.com" },
    });
    expect((await code(invoiceBody(notLive, liveCus.body.id, inv(), { livemode: true }))).code).toBe(
      "account_not_live",
    );
    // a customer of another account or mode is not found; a deleted one is refused
    expect((await code(invoiceBody(m, liveCus.body.id, inv()))).code).toBe("resource_missing");
    const gone = await customer(m, "gone@example.com");
    await st.call("DELETE", `/v1/customers/${gone}`, { token: await st.token(m) });
    expect((await code(invoiceBody(m, gone, inv()))).code).toBe("customer_deleted");
    // expires_at: 5 min … 30 d ahead
    const soon = await code(invoiceBody(m, cus, inv(), { expires_at: ahead(240) }));
    expect(soon).toMatchObject({ code: "invalid_request", param: "expires_at" });
    expect((await code(invoiceBody(m, cus, inv(), { expires_at: ahead(31 * 86_400) }))).param).toBe("expires_at");
    // only billing's scope; merchants never reach the internal route
    expect(
      (await createInvoiceSession(invoiceBody(m, cus, inv()), undefined, await st.serviceToken("notify"))).status,
    ).toBe(403);
    expect((await createInvoiceSession(invoiceBody(m, cus, inv()), undefined, await st.token(m))).status).toBe(403);
  });

  it("billing expires an invoice session (events carry the invoice); expired is returned unchanged; then a new one opens", async () => {
    const m = st.merchant();
    const cus = await customer(m);
    const invoice = inv();
    const r = await createInvoiceSession(invoiceBody(m, cus, invoice));
    const billing = await st.serviceToken("billing");
    const probe = await st.probe();
    const ex = await st.call("POST", `/internal/checkout_sessions/${r.body.id}/expire`, {
      token: billing,
      body: { reason: "invoice_voided" },
    });
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ status: "expired", invoice, client_secret: null });
    await expectEvent(probe, "evt.payments.checkout_session.expired", {
      data: { object: { id: r.body.id, status: "expired", invoice } },
    });
    await expectEvent(probe, "evt.payments.payment_intent.expired", {
      data: { object: { id: r.body.payment_intent, status: "expired", invoice } },
    });
    await probe.close();
    const t = await st.admin.db
      .selectFrom("checkout_session_transitions")
      .select(["cause", "actor"])
      .where("checkout_session_id", "=", uuid(r.body.id, "cs"))
      .where("to_state", "=", "expired")
      .executeTakeFirstOrThrow();
    expect(t).toEqual({ cause: "expired by billing: invoice_voided", actor: "billing" });
    const twice = await st.call("POST", `/internal/checkout_sessions/${r.body.id}/expire`, {
      token: billing,
      body: { reason: "invoice_voided" },
    });
    expect(twice.status).toBe(200);
    expect(twice.body.sequence).toBe(ex.body.sequence);
    // the invoice may open a new session now
    expect((await createInvoiceSession(invoiceBody(m, cus, invoice))).status).toBe(201);

    // only invoice sessions
    const plain = await st.call("POST", "/v1/checkout/sessions", {
      token: await st.token(m),
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks" },
    });
    const refused = await st.call("POST", `/internal/checkout_sessions/${plain.body.id}/expire`, {
      token: billing,
      body: { reason: "superseded" },
    });
    expect(refused.body.error.code).toBe("state_conflict");
  });

  it("refuses to expire while a deposit is in flight (nothing changes)", async () => {
    const m = st.merchant();
    const r = await createInvoiceSession(invoiceBody(m, await customer(m), inv()));
    const a = await st.call("POST", `/v1/checkout/sessions/${r.body.id}/public/attempts`, {
      secret: r.body.client_secret,
      body: {
        method: "intents_transfer",
        origin_asset_id: USDC_NEAR,
        payer_wallet: "payer.near",
        turnstile_token: "t",
      },
    });
    await railsEvent(m, await executionOf(a.body.id), { state: "deposit_detected" }, "evt.rails.execution.updated");
    const token = await st.token(m);
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/payment_intents/${r.body.payment_intent}`, { token })).body.status === "processing",
    );
    const ex = await st.call("POST", `/internal/checkout_sessions/${r.body.id}/expire`, {
      token: await st.serviceToken("billing"),
      body: { reason: "invoice_voided" },
    });
    expect(ex.body.error.code).toBe("attempt_in_flight");
    expect((await st.call("GET", `/v1/checkout/sessions/${r.body.id}`, { token })).body.status).toBe("open");
  });

  it("emits checkout_session.expired with the invoice when the session reaches expires_at unpaid", async () => {
    const m = st.merchant();
    const invoice = inv();
    const r = await createInvoiceSession(invoiceBody(m, await customer(m), invoice));
    await st.admin.db
      .updateTable("checkout_sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", uuid(r.body.id, "cs"))
      .execute();
    const probe = await st.probe();
    expect(await expireAtDeadline(st.payments, uuid(r.body.id, "cs"))).toBe(uuid(r.body.id, "cs"));
    await expectEvent(probe, "evt.payments.checkout_session.expired", {
      data: { object: { id: r.body.id, invoice, status: "expired" } },
    });
    await expectEvent(probe, "evt.payments.payment_intent.expired", { data: { object: { invoice } } });
    await probe.close();
  });

  it("a paid invoice session: payment_intent.succeeded and checkout_session.completed carry the invoice", async () => {
    const m = st.merchant();
    const invoice = inv();
    const r = await createInvoiceSession(invoiceBody(m, await customer(m), invoice, { amount: 200 }));
    const probe = await st.probe();
    const pay = await st.call("POST", `/v1/test_helpers/checkout_sessions/${r.body.id}/pay`, {
      token: await st.token(m),
      body: { outcome: "none" },
    });
    expect(pay.status).toBe(202);
    const exId = await executionOf(pay.body.payment_attempt);
    await railsEvent(m, exId, { state: "settling" }, "evt.rails.execution.updated");
    await railsEvent(
      m,
      exId,
      { state: "succeeded", settled_amount: "2000042", evidence: freshEvidence("acme.near", "2000042") },
      "evt.rails.execution.settled",
    );
    await expectEvent(probe, "evt.payments.payment_intent.succeeded", {
      data: { object: { id: r.body.payment_intent, invoice, source: "invoice", status: "succeeded" } },
    });
    await expectEvent(probe, "evt.payments.checkout_session.completed", {
      data: { object: { id: r.body.id, invoice, status: "complete" } },
    });
    await probe.close();
  });
});

describe("internal customers (billing, §20 item 4)", () => {
  it("returns the decrypted email with the account; a deleted customer has deleted: true and no PII", async () => {
    const m = st.merchant();
    const cus = await customer(m, "Carol@Example.com");
    const billing = await st.serviceToken("billing");
    const got = await st.call("GET", `/internal/customers/${cus}`, { token: billing });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      id: cus,
      object: "customer",
      account_id: m.account,
      email: "carol@example.com",
      name: "Ann",
      deleted: false,
    });
    await st.call("DELETE", `/v1/customers/${cus}`, { token: await st.token(m) });
    const gone = await st.call("GET", `/internal/customers/${cus}`, { token: billing });
    expect(gone.body).toMatchObject({ id: cus, deleted: true, email: null, name: null });
    expect(
      (await st.call("GET", `/internal/customers/${cus}`, { token: await st.serviceToken("notify") })).status,
    ).toBe(403);
  });
});

// ============================================================================ test helpers (§16.1)
describe("payCheckoutSessionTestHelper (nearpay trigger)", () => {
  async function openSession(m: Merchant) {
    const r = await st.call("POST", "/v1/checkout/sessions", {
      token: await st.token(m),
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks" },
    });
    return r.body as { id: string; payment_intent: string; client_secret: string };
  }
  const sandboxCalls = (address: string) =>
    st.sandbox.calls.filter((c) => (c.body as { deposit_address?: string } | undefined)?.deposit_address === address);

  it("pays from the first sandbox option with the simulated payer's refund address, deposits and advances", async () => {
    const m = st.merchant();
    const s = await openSession(m);
    const before = st.sandbox.calls.length;
    const r = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s.id}/pay`, {
      token: await st.token(m),
      body: {},
      headers: { "idempotency-key": `trigger-${s.id}` },
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({
      object: "test_helper_payment",
      checkout_session: s.id,
      payment_intent: s.payment_intent,
      payment_attempt: expect.stringMatching(/^pa_/),
      outcome: "succeeded",
    });
    const create = st.rails.calls.find(
      (c) => (c.body as { idempotency_key?: string })?.idempotency_key === `attempt:${r.body.payment_attempt}`,
    );
    expect(create?.body).toMatchObject({
      method: "route_quote",
      origin: { asset_id: USDC_BASE, chain: "eip155:8453", refund_to: "0x000000000000000000000000000000000000dEaD" },
    });
    const calls = st.sandbox.calls.slice(before);
    expect(calls.map((c) => c.routeId)).toEqual(["sandboxSimulateDeposit", "sandboxAdvance"]);
    expect(calls[1]?.body).toMatchObject({ to: "success" });
    expect(calls[0]?.body).not.toHaveProperty("amount_in");
    // idempotent: the replay creates nothing new
    const again = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s.id}/pay`, {
      token: await st.token(m),
      body: {},
      headers: { "idempotency-key": `trigger-${s.id}` },
    });
    expect(again.body.payment_attempt).toBe(r.body.payment_attempt);
    expect(st.sandbox.calls.length).toBe(before + 2);
    // nothing is marked paid by the helper itself: the intent waits for rails' evidence (INV-2)
    const intent = await st.call("GET", `/v1/payment_intents/${s.payment_intent}`, { token: await st.token(m) });
    expect(intent.body.status).toBe("requires_payment");
  });

  it("honours origin_asset_id, amount_in and each outcome; `none` only creates the attempt", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const s1 = await openSession(m);
    const failed = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s1.id}/pay`, {
      token,
      body: { origin_asset_id: USDC_BASE, outcome: "payment_failed", amount_in: "2010000" },
    });
    expect(failed.status).toBe(202);
    const a1 = await st.admin.db
      .selectFrom("payment_attempts")
      .selectAll()
      .where("id", "=", uuid(failed.body.payment_attempt, "pa"))
      .executeTakeFirstOrThrow();
    const c1 = sandboxCalls(a1.deposit?.address as string).slice(-2);
    expect(c1.map((c) => c.body)).toMatchObject([{ amount_in: "2010000" }, { to: "fail" }]);
    const s2 = await openSession(m);
    const refunded = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s2.id}/pay`, {
      token,
      body: { outcome: "refunded" },
    });
    expect(st.sandbox.calls.at(-1)?.body).toMatchObject({ to: "refund" });
    expect(refunded.body.outcome).toBe("refunded");
    const s3 = await openSession(m);
    const before = st.sandbox.calls.length;
    const none = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s3.id}/pay`, {
      token,
      body: { outcome: "none" },
    });
    expect(none.status).toBe(202);
    expect(st.sandbox.calls.length).toBe(before);
    const a3 = await st.call("GET", `/v1/payment_intents/${s3.payment_intent}`, { token });
    expect(a3.body.attempts[0]).toMatchObject({ id: none.body.payment_attempt, status: "awaiting_deposit" });
  });

  it("auth: secret key, restricted checkout_sessions.write, dashboard owner/admin/developer; test mode only", async () => {
    const m = st.merchant();
    const pay = async (token: string, id?: string) =>
      st.call("POST", `/v1/test_helpers/checkout_sessions/${id ?? (await openSession(m)).id}/pay`, {
        token,
        body: { outcome: "none" },
      });
    expect((await pay(await st.restrictedToken(m, ["checkout_sessions.write"]))).status).toBe(202);
    expect((await pay(await st.restrictedToken(m, ["refunds.write"]))).status).toBe(403);
    expect((await pay(await st.sessionToken(m, { role: "developer" }))).status).toBe(202);
    expect((await pay(await st.sessionToken(m, { role: "finance" }))).status).toBe(403);
    const live = await pay(await st.token(m, { livemode: true }), (await openSession(m)).id);
    expect(live.body.error.code).toBe("livemode_forbidden");
    // another account's session is not found
    expect((await pay(await st.token(st.merchant()), (await openSession(m)).id)).status).toBe(404);
  });

  it("refuses a session that is not open", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const s = await openSession(m);
    await st.call("POST", `/v1/checkout/sessions/${s.id}/expire`, { token });
    const r = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s.id}/pay`, { token, body: {} });
    expect(r.body.error.code).toBe("session_not_open");
  });

  it("advancePaymentAttempt and simulateRefundDeposit accept the CLI's restricted test key", async () => {
    const m = st.merchant();
    const s = await openSession(m);
    const pay = await st.call("POST", `/v1/test_helpers/checkout_sessions/${s.id}/pay`, {
      token: await st.token(m),
      body: { outcome: "none" },
    });
    const advance = (token: string) =>
      st.call("POST", `/v1/test_helpers/payment_attempts/${pay.body.payment_attempt}/advance`, {
        token,
        body: { to: "deposit" },
      });
    expect((await advance(await st.restrictedToken(m, ["refunds.write"]))).status).toBe(403);
    expect((await advance(await st.restrictedToken(m, ["checkout_sessions.write"]))).status).toBe(202);
    expect(st.sandbox.calls.at(-1)?.body).toMatchObject({ to: "deposit" });

    // a refund of a paid intent; the restricted refunds.write key simulates its leg deposit
    const paid = await st.call("POST", "/v1/checkout/sessions", {
      token: await st.token(m),
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks" },
    });
    const a = await st.call("POST", `/v1/checkout/sessions/${paid.body.id}/public/attempts`, {
      secret: paid.body.client_secret,
      body: {
        method: "intents_transfer",
        origin_asset_id: USDC_NEAR,
        payer_wallet: "payer.near",
        turnstile_token: "t",
      },
    });
    const exId = await executionOf(a.body.id);
    await railsEvent(m, exId, { state: "settling" }, "evt.rails.execution.updated");
    await railsEvent(
      m,
      exId,
      { state: "succeeded", settled_amount: "2000042", evidence: freshEvidence("acme.near", "2000042") },
      "evt.rails.execution.settled",
    );
    const token = await st.token(m);
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/payment_intents/${paid.body.payment_intent}`, { token })).body.status ===
        "succeeded",
    );
    const refund = await st.call("POST", "/v1/refunds", {
      token,
      body: { payment_intent: paid.body.payment_intent, amount: "2000" },
    });
    const sim = (t: string) =>
      st.call("POST", `/v1/test_helpers/refunds/${refund.body.id}/simulate_deposit`, { token: t, body: {} });
    expect((await sim(await st.restrictedToken(m, ["checkout_sessions.write"]))).status).toBe(403);
    expect((await sim(await st.restrictedToken(m, ["refunds.write"]))).status).toBe(202);
  });
});

// ============================================================================ executions of other owners
describe("rails executions owned by another service (§16.1)", () => {
  function agentpayExecution(m: Merchant, o: Partial<Execution> = {}): Execution {
    return execution({
      kind: "payment",
      method: "route_quote",
      account_id: m.account,
      livemode: false,
      state: "succeeded",
      version: 3,
      owner: "agentpay",
      settled_amount: "1000000",
      evidence: freshEvidence("acme.near", "1000000"),
      ...o,
    } as never);
  }

  it("acks them without effect (no inbox row, no dead letter, no retry) and keeps consuming", async () => {
    const m = st.merchant();
    const x = agentpayExecution(m); // created just now: an unknown execution of ours would be retried
    const e = domainEvent("evt.rails.execution.settled", x, {
      accountUuid: uuid(m.account, "acct"),
      livemode: false,
      version: x.version,
    });
    await st.publishEvent(e);

    // the next event of ours is processed (the consumer is not stuck on the foreign one)
    const s = await st.call("POST", "/v1/checkout/sessions", {
      token: await st.token(m),
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks" },
    });
    const a = await st.call("POST", `/v1/checkout/sessions/${s.body.id}/public/attempts`, {
      secret: s.body.client_secret,
      body: {
        method: "intents_transfer",
        origin_asset_id: USDC_NEAR,
        payer_wallet: "payer.near",
        turnstile_token: "t",
      },
    });
    const exId = await executionOf(a.body.id);
    const token = await st.token(m);
    await railsEvent(m, exId, { state: "deposit_detected" }, "evt.rails.execution.updated");
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/payment_intents/${s.body.payment_intent}`, { token })).body.status === "processing",
    );
    expect(
      await st.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", e.id).executeTakeFirst(),
    ).toBeUndefined();
    const dead = await st.admin.db.selectFrom("dead_letters").select("payload").execute();
    expect(dead.filter((d) => JSON.stringify(d.payload).includes(x.id))).toEqual([]);

    // an event labelled with another owner is never applied, even to an execution id of ours
    const ours = st.executions.get(exId) as Execution;
    const relabelled = {
      ...ours,
      owner: "agentpay",
      state: "succeeded",
      version: ours.version + 5,
      settled_amount: "2000042",
      evidence: freshEvidence("acme.near", "2000042"),
    } as Execution;
    await st.publishEvent(
      domainEvent("evt.rails.execution.settled", relabelled, {
        accountUuid: uuid(m.account, "acct"),
        livemode: false,
        version: relabelled.version,
      }),
    );
    await new Promise((r) => setTimeout(r, 1000));
    const intent = await st.call("GET", `/v1/payment_intents/${s.body.payment_intent}`, { token });
    expect(intent.body.status).toBe("processing");
    expect(intent.body.attempts[0].status).toBe("deposit_detected");
  });

  it("reconciliation lists only payments' evidence and accepts other owners' executions on the same day", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const s = await st.call("POST", "/v1/checkout/sessions", {
      token,
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks" },
    });
    const a = await st.call("POST", `/v1/checkout/sessions/${s.body.id}/public/attempts`, {
      secret: s.body.client_secret,
      body: {
        method: "intents_transfer",
        origin_asset_id: USDC_NEAR,
        payer_wallet: "payer.near",
        turnstile_token: "t",
      },
    });
    const exId = await executionOf(a.body.id);
    const yesterday = new Date(Date.now() - 86_400_000);
    await railsEvent(m, exId, { state: "settling" }, "evt.rails.execution.updated");
    await railsEvent(
      m,
      exId,
      {
        state: "succeeded",
        settled_amount: "2000042",
        evidence: freshEvidence("acme.near", "2000042"),
        terminal_at: yesterday.toISOString(),
      },
      "evt.rails.execution.settled",
    );
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/payment_intents/${s.body.payment_intent}`, { token })).body.status === "succeeded",
    );
    // agentpay settled an x402 payment to the same merchant that day: rails' summary counts it
    const foreign = agentpayExecution(m, { terminal_at: yesterday.toISOString() });
    st.executions.set(foreign.id, foreign);

    const ops = await st.opsToken();
    const day = yesterday.toISOString().slice(0, 10);
    const before = st.rails.calls.length;
    const run = await st.call("POST", "/ops/reconciliation_runs", {
      token: ops,
      body: { account_id: m.account, livemode: false, day },
    });
    const done = await waitFor(async () => {
      const v = (await st.call("GET", `/ops/reconciliation_runs/${run.body.id}`, { token: ops })).body;
      return v.status !== "running" ? v : null;
    }, 30_000);
    expect(done).toMatchObject({ status: "ok", diff_count: 0, error: null });
    expect(done.totals[0]).toMatchObject({ inflow: { statement: "2000042", evidence: "2000042", executions: 1 } });
    const listings = st.rails.calls.slice(before).filter((c) => c.routeId === listEvidence.id);
    expect(listings.map((c) => (c.query as { owner?: string }).owner)).toEqual(["payments", undefined]);
  });
});
