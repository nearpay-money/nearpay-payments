/**
 * Stage 2 end to end through the real api and worker (lld/payments.md §6, §8.4, §9, §17): customers,
 * payment links (merchant + anonymous payer routes), `POST /v1/payment_intents` and list filters, review
 * decisions, refunds (sign_intent and sign_and_send legs, relay, events, statement lines, duplicates,
 * transient/definitive rail failures, recovery, cancel, prepare, recipient override, kill switch),
 * internal reads, and reconciliation runs on the console routes (ops tokens, step-up, cases, audit events).
 */

import { randomBytes } from "node:crypto";
import { newId } from "@nearpay-internal/ids";
import { signNep413 } from "@nearpay-internal/intents";
import { createRefundExecution, relaySignedIntent } from "@nearpay-internal/spec";
import { domainEvent, expectEvent, mockError } from "@nearpay-internal/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncKillSwitchAtBoot } from "../../src/app/kill-switch.js";
import { valkeyLimiter } from "../../src/infra/rate-limiter.js";
import { type Merchant, type Stack, startStack, USDC_BASE, USDC_NEAR, uuid } from "../support/stack.js";
import { agentpayRelayBody, type Evidence, freshEvidence, type PaidIntent } from "../support/stage2.js";

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

const yesterday = () => new Date(Date.now() - 86_400_000);

/** Publishes the next version of an execution as a rails event. */
async function railsEvent(
  m: Merchant,
  exId: string,
  patch: Record<string, unknown>,
  subject = "evt.rails.execution.updated",
) {
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

/** A succeeded intent paid by an intents_transfer attempt (settled 2000042). */
async function paidIntent(
  m: Merchant = st.merchant(),
  o: { livemode?: boolean; settled?: string; body?: Record<string, unknown> } = {},
): Promise<PaidIntent> {
  const token = await st.token(m, { livemode: o.livemode ?? false });
  const r = await st.call("POST", "/v1/checkout/sessions", {
    token,
    body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks", ...o.body },
  });
  expect(r.status).toBe(201);
  const a = await st.call("POST", `/v1/checkout/sessions/${r.body.id}/public/attempts`, {
    secret: r.body.client_secret,
    body: { method: "intents_transfer", origin_asset_id: USDC_NEAR, payer_wallet: "payer.near", turnstile_token: "t" },
  });
  expect(a.status).toBe(201);
  const row = await st.admin.db
    .selectFrom("payment_attempts")
    .selectAll()
    .where("id", "=", uuid(a.body.id, "pa"))
    .executeTakeFirstOrThrow();
  const exId = row.execution_id as string;
  const settled = o.settled ?? "2000042";
  await railsEvent(m, exId, { state: "settling" });
  await railsEvent(
    m,
    exId,
    {
      state: "succeeded",
      settled_amount: settled,
      evidence: freshEvidence("acme.near", settled),
      terminal_at: yesterday().toISOString(),
    },
    "evt.rails.execution.settled",
  );
  const pi = r.body.payment_intent as string;
  const want = o.settled && BigInt(o.settled) < 2000042n ? "requires_review" : "succeeded";
  await waitFor(async () => (await st.call("GET", `/v1/payment_intents/${pi}`, { token })).body.status === want);
  return { m, token, pi, cs: r.body.id, secret: r.body.client_secret, attempt: a.body.id, exId };
}

async function legExecution(refundId: string, n?: number) {
  const legs = await st.admin.db
    .selectFrom("refund_legs")
    .selectAll()
    .where("refund_id", "=", uuid(refundId, "re"))
    .orderBy("number", "desc")
    .execute();
  const leg = n ? legs.find((l) => l.number === n) : legs[0];
  return leg?.execution_id as string;
}

// ==================================================================================== customers

describe("customers", () => {
  it("CRUD with encrypted PII, email lookup, delete → DeletedCustomer and customer_deleted on attach", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const c = await st.call("POST", "/v1/customers", {
      token,
      body: {
        email: "Ann@Example.com",
        name: "Ann",
        wallets: [{ chain: "near:mainnet", address: "ann.near" }],
        metadata: { tier: "gold" },
      },
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ object: "customer", email: "ann@example.com", name: "Ann", livemode: false });
    const row = await st.admin.db
      .selectFrom("customers")
      .selectAll()
      .where("id", "=", uuid(c.body.id, "cus"))
      .executeTakeFirstOrThrow();
    expect(row.email_enc?.toString("utf8")).not.toContain("ann@");
    const found = await st.call("GET", "/v1/customers?email=ANN%40example.com", { token });
    expect(found.body.data.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
    const up = await st.call("PATCH", `/v1/customers/${c.body.id}`, {
      token,
      body: { name: null, description: "vip" },
    });
    expect(up.body).toMatchObject({ name: null, description: "vip", email: "ann@example.com" });

    // attach to a session and an API intent
    const s = await st.call("POST", "/v1/checkout/sessions", {
      token,
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/t", customer: c.body.id },
    });
    expect(s.body.customer).toBe(c.body.id);
    const del = await st.call("DELETE", `/v1/customers/${c.body.id}`, { token });
    expect(del.body).toEqual({ id: c.body.id, object: "customer", livemode: false, deleted: true });
    const erased = await st.admin.db
      .selectFrom("customers")
      .selectAll()
      .where("id", "=", uuid(c.body.id, "cus"))
      .executeTakeFirstOrThrow();
    expect([erased.email_enc, erased.name_enc, erased.email_hash]).toEqual([null, null, null]);
    expect((await st.call("GET", `/v1/customers/${c.body.id}`, { token })).status).toBe(404);
    expect((await st.call("PATCH", `/v1/customers/${c.body.id}`, { token, body: { name: "x" } })).body.error.code).toBe(
      "customer_deleted",
    );
    const again = await st.call("POST", "/v1/payment_intents", {
      token,
      body: { amount: 200, currency: "usd", return_url: "https://shop.example/r", customer: c.body.id },
    });
    expect(again.body.error.code).toBe("customer_deleted");
    // another merchant cannot see it
    expect((await st.call("GET", `/v1/customers/${c.body.id}`, { token: await st.token(st.merchant()) })).status).toBe(
      404,
    );
  });
});

// ==================================================================================== payment links

describe("payment links", () => {
  it("create, list, patch; anonymous read and sessions; uses count succeeded payments; link_inactive", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const l = await st.call("POST", "/v1/payment_links", {
      token,
      body: {
        amount: 200,
        currency: "usd",
        description: "Coffee beans",
        max_uses: 1,
        collect_email: true,
        metadata: { sku: "b1" },
      },
    });
    expect(l.status).toBe(201);
    expect(l.body).toMatchObject({
      object: "payment_link",
      active: true,
      uses: 0,
      url: `https://pay.nearpay.localhost/l/${l.body.id}`,
    });
    expect(
      (await st.call("POST", "/v1/payment_links", { token, body: { amount: 5, currency: "usd", description: "x" } }))
        .body.error.code,
    ).toBe("amount_below_destination_minimum");

    const pub = await st.call("GET", `/v1/payment_links/${l.body.id}/public`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({
      active: true,
      display: { merchant_name_unverified: "Acme Coffee", description: "Coffee beans" },
      settlement: { asset_id: USDC_NEAR, type: "intents_account" },
      collect_email: true,
    });
    expect(JSON.stringify(pub.body)).not.toContain("acme.near");

    const ses = await st.call("POST", `/v1/payment_links/${l.body.id}/public/sessions`, {
      body: { customer_email: "p@example.com" },
    });
    expect(ses.status).toBe(201);
    expect(ses.body.url).toBe(`https://pay.nearpay.localhost/c/${ses.body.checkout_session}#${ses.body.client_secret}`);
    const session = await st.call("GET", `/v1/checkout/sessions/${ses.body.checkout_session}?expand[]=payment_intent`, {
      token,
    });
    expect(session.body).toMatchObject({ payment_link: l.body.id, metadata: { sku: "b1" } });
    expect(session.body.payment_intent).toMatchObject({ source: "payment_link", payment_link: l.body.id });

    // pay it → uses = 1 = max_uses → link_inactive
    const a = await st.call("POST", `/v1/checkout/sessions/${ses.body.checkout_session}/public/attempts`, {
      secret: ses.body.client_secret,
      body: {
        method: "intents_transfer",
        origin_asset_id: USDC_NEAR,
        payer_wallet: "payer.near",
        turnstile_token: "t",
      },
    });
    const ex = (
      await st.admin.db
        .selectFrom("payment_attempts")
        .select("execution_id")
        .where("id", "=", uuid(a.body.id, "pa"))
        .executeTakeFirstOrThrow()
    ).execution_id as string;
    await railsEvent(
      m,
      ex,
      { state: "succeeded", settled_amount: "2000042", evidence: freshEvidence("acme.near", "2000042") },
      "evt.rails.execution.settled",
    );
    await waitFor(async () => (await st.call("GET", `/v1/payment_links/${l.body.id}`, { token })).body.uses === 1);
    expect((await st.call("GET", `/v1/payment_links/${l.body.id}/public`)).body.active).toBe(false);
    expect(
      (await st.call("POST", `/v1/payment_links/${l.body.id}/public/sessions`, { body: {} })).body.error.code,
    ).toBe("link_inactive");

    const patched = await st.call("PATCH", `/v1/payment_links/${l.body.id}`, {
      token,
      body: { max_uses: null, active: false },
    });
    expect(patched.body).toMatchObject({ max_uses: null, active: false, amount: 200 });
    expect(
      (await st.call("POST", `/v1/payment_links/${l.body.id}/public/sessions`, { body: {} })).body.error.code,
    ).toBe("link_inactive");
    const list = await st.call("GET", "/v1/payment_links?active=false", { token });
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(l.body.id);
    expect((await st.call("GET", "/v1/payment_links?active=true", { token })).body.data).toHaveLength(0);
  });
});

// ==================================================================================== intents

describe("payment intents (API) and filters", () => {
  it("POST /v1/payment_intents returns the client secret once and the payer API works with it", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const probe = await st.probe();
    const r = await st.call("POST", "/v1/payment_intents", {
      token,
      body: { amount: 300, currency: "usd", return_url: "https://shop.example/r", metadata: { order: "77" } },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ object: "payment_intent", source: "api", status: "requires_payment" });
    expect(r.body.client_secret).toMatch(new RegExp(`^${r.body.checkout_session}_secret_`));
    const e = await expectEvent(probe, "evt.payments.payment_intent.created", { data: { object: { id: r.body.id } } });
    expect(JSON.stringify(e)).not.toContain("_secret_");
    await probe.close();
    const pub = await st.call("GET", `/v1/checkout/sessions/${r.body.checkout_session}/public`, {
      secret: r.body.client_secret,
    });
    expect(pub.body).toMatchObject({ payment_intent: r.body.id, success_url: "https://shop.example/r" });
    expect((await st.call("GET", `/v1/payment_intents/${r.body.id}`, { token })).body.client_secret).toBeUndefined();
    // the internal payer read (agentpay, CR-15-15)
    const svc = await st.serviceToken("agentpay");
    const payer = await st.call("GET", `/internal/checkout_sessions/${r.body.checkout_session}/payer`, {
      token: svc,
      secret: r.body.client_secret,
    });
    expect(payer.body).toMatchObject({
      account_id: m.account,
      livemode: false,
      session: { payment_intent: r.body.id },
    });
    expect(
      (
        await st.call("GET", `/internal/checkout_sessions/${r.body.checkout_session}/payer`, {
          token: svc,
          secret: `${r.body.checkout_session}_secret_${"x".repeat(32)}`,
        })
      ).body.error.code,
    ).toBe("client_secret_invalid");
  });

  it("filters by amount, currency, source, metadata, customer, payment link and checkout session", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const c = (await st.call("POST", "/v1/customers", { token, body: { name: "Bob" } })).body.id;
    const mk = (body: Record<string, unknown>) =>
      st.call("POST", "/v1/payment_intents", {
        token,
        body: { currency: "usd", return_url: "https://s.example/r", ...body },
      });
    const a = (await mk({ amount: 200, metadata: { k: "a" } })).body;
    const b = (await mk({ amount: 500, metadata: { k: "b", x: "1" }, customer: c })).body;
    const e = (await mk({ amount: 1000, currency: "eur" })).body;
    const ids = async (q: string) =>
      ((await st.call("GET", `/v1/payment_intents?${q}`, { token })).body.data as { id: string }[])
        .map((x) => x.id)
        .sort();
    expect(await ids("amount[gte]=300&currency=usd")).toEqual([b.id]);
    expect(await ids("amount[lt]=500")).toEqual([a.id]);
    expect(await ids("amount[gt]=99999999999999999999999")).toEqual([]);
    expect(await ids("currency=eur")).toEqual([e.id]);
    expect(await ids("metadata[k]=b&metadata[x]=1")).toEqual([b.id]);
    expect(await ids(`customer=${c}`)).toEqual([b.id]);
    expect(await ids(`checkout_session=${a.checkout_session}`)).toEqual([a.id]);
    expect(await ids("source=api")).toEqual([a.id, b.id, e.id].sort());
    expect(await ids(`settlement_asset_id=${encodeURIComponent(USDC_NEAR)}`)).toHaveLength(3);
    expect((await st.call("GET", "/v1/payment_intents?bogus=1", { token })).status).toBe(400);
  });

  it("multi-currency: EUR priced via rails FX; stale → fx_rate_unavailable; unknown → currency_unsupported", async () => {
    const token = await st.token(st.merchant());
    const mk = (currency: string) =>
      st.call("POST", "/v1/checkout/sessions", {
        token,
        body: { amount: 500, currency, success_url: "https://s.example/t" },
      });
    expect((await mk("eur")).status).toBe(201);
    // spec 0.3.1 declares fx_rate_unavailable (503) on createCheckoutSession
    const stale = await mk("gbp");
    expect([stale.status, stale.body.error.code]).toEqual([503, "fx_rate_unavailable"]);
    expect((await mk("chf")).body.error.code).toBe("currency_unsupported");
    expect((await mk("sek")).body.error.code).toBe("currency_unsupported");
  });
});

// ==================================================================================== review

describe("review decisions", () => {
  it("accept completes a short settlement; reject drafts a refund of it against the attempt", async () => {
    const short = await paidIntent(st.merchant(), { settled: "1000000" });
    const acc = await st.call("POST", `/v1/payment_intents/${short.pi}/review`, {
      token: short.token,
      body: { decision: "accept" },
    });
    expect(acc.body).toMatchObject({ status: "succeeded", review_decision: { decision: "accept", refund: null } });

    const rej = await paidIntent(st.merchant(), { settled: "1000000" });
    const probe = await st.probe();
    const r = await st.call("POST", `/v1/payment_intents/${rej.pi}/review`, {
      token: rej.token,
      body: { decision: "reject", reason: "short" },
    });
    expect(r.body).toMatchObject({
      status: "requires_payment",
      amount_settled: "0",
      review_decision: { decision: "reject" },
    });
    const refundId = r.body.review_decision.refund as string;
    expect(refundId).toMatch(/^re_/);
    await expectEvent(probe, "evt.payments.payment_intent.payment_failed", { data: { object: { id: rej.pi } } });
    await expectEvent(probe, "evt.payments.refund.requires_action", { data: { object: { id: refundId } } });
    await probe.close();
    const refund = await st.call("GET", `/v1/refunds/${refundId}`, { token: rej.token });
    expect(refund.body).toMatchObject({
      source: "review_rejection",
      amount: "1000000",
      payment_attempt: rej.attempt,
      status: "requires_action",
    });
    const attempt = await st.admin.db
      .selectFrom("payment_attempts")
      .selectAll()
      .where("id", "=", uuid(rej.attempt, "pa"))
      .executeTakeFirstOrThrow();
    expect(attempt.amount_refund_pending).toBe("1000000");
    expect(
      (
        await st.call("POST", `/v1/payment_intents/${rej.pi}/review`, {
          token: rej.token,
          body: { decision: "accept" },
        })
      ).body.error.code,
    ).toBe("state_conflict");
  });

  it("a held verification cannot be accepted (review_requires_evidence)", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const s = await st.call("POST", "/v1/checkout/sessions", {
      token,
      body: { amount: 200, currency: "usd", success_url: "https://s.example/t" },
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
    const ex = (
      await st.admin.db
        .selectFrom("payment_attempts")
        .select("execution_id")
        .where("id", "=", uuid(a.body.id, "pa"))
        .executeTakeFirstOrThrow()
    ).execution_id as string;
    await railsEvent(m, ex, { state: "held", held_reason: "evidence_timeout" }, "evt.rails.execution.held");
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/payment_intents/${s.body.payment_intent}`, { token })).body.status ===
        "requires_review",
    );
    expect(
      (
        await st.call("POST", `/v1/payment_intents/${s.body.payment_intent}/review`, {
          token,
          body: { decision: "accept" },
        })
      ).body.error.code,
    ).toBe("review_requires_evidence");
  });
});

// ==================================================================================== refunds

describe("refunds", () => {
  it("sign_intent leg: exact payload, mismatch refused, relay (kind refund), payer-side evidence → succeeded + statement line + receipt", async () => {
    const paid = await paidIntent();
    const probe = await st.probe();
    const r = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "1000000", reason: "requested_by_customer" },
      headers: { "idempotency-key": "rf-1" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      object: "refund",
      status: "requires_action",
      method: "intents_transfer",
      amount: "1000000",
      asset_id: USDC_NEAR,
      recipient: { address: "payer.near", type: "intents", overridden: false },
      next_action: {
        type: "sign_intent",
        signer_id: "acme.near",
        transfer: { receiver_id: "payer.near", amount: "1000000" },
      },
    });
    const create = st.rails.calls.filter((c) => c.routeId === createRefundExecution.id).at(-1);
    expect(create?.body).toMatchObject({
      idempotency_key: `refund:${r.body.id}:leg:1`,
      method: "intents_transfer",
      amount: "1000000",
      swap_type: "EXACT_INPUT",
    });
    await expectEvent(probe, "evt.payments.refund.created", { data: { object: { id: r.body.id } } });
    await expectEvent(probe, "evt.payments.refund.requires_action", { data: { object: { id: r.body.id } } });
    const intent = await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token });
    expect(intent.body).toMatchObject({ amount_refund_pending: "1000000", refunds: [r.body.id] });
    // replay with the same key
    const replay = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "1000000", reason: "requested_by_customer" },
      headers: { "idempotency-key": "rf-1" },
    });
    expect(replay.body.id).toBe(r.body.id);
    // more than refundable
    expect(
      (
        await st.call("POST", "/v1/refunds", {
          token: paid.token,
          body: { payment_intent: paid.pi, amount: "1000043" },
        })
      ).body.error.code,
    ).toBe("amount_exceeds_refundable");

    const sk = new Uint8Array(randomBytes(32));
    const na = r.body.next_action;
    // wallets sign the exact strings of next_action (`nep413.message` / `payload`), never a re-serialised object
    const issued = JSON.parse(na.payload);
    const wrong = signNep413({ ...issued, intents: [{ ...issued.intents[0], receiver_id: "evil.near" }] }, sk);
    expect(
      (
        await st.call("POST", `/v1/refunds/${r.body.id}/submit_tx`, {
          token: paid.token,
          body: { signed_intent: wrong },
        })
      ).body.error.code,
    ).toBe("signed_intent_mismatch");
    expect(
      (
        await st.call("POST", `/v1/refunds/${r.body.id}/submit_tx`, {
          token: paid.token,
          body: { tx_hash: "0xabcdef0123456789" },
        })
      ).body.error.code,
    ).toBe("state_conflict");
    const signed = signNep413(issued, sk);
    const sub = await st.call("POST", `/v1/refunds/${r.body.id}/submit_tx`, {
      token: paid.token,
      body: { signed_intent: signed },
    });
    expect(sub.body.error ?? null).toBeNull();
    expect(sub.body.status).toBe("pending");
    const relay = st.agentpay.calls.filter((c) => c.routeId === relaySignedIntent.id).at(-1);
    expect(relay?.body).toMatchObject(agentpayRelayBody(r.body.id, na.transfer.memo));
    await expectEvent(probe, "evt.payments.refund.pending", { data: { object: { id: r.body.id } } });
    expect(
      (await st.call("POST", `/v1/refunds/${r.body.id}/cancel`, { token: paid.token, body: {} })).body.error.code,
    ).toBe("state_conflict");

    const ex = await legExecution(r.body.id);
    await railsEvent(paid.m, ex, { state: "settling" });
    const ev: Evidence = freshEvidence("payer.near", "1000000");
    await railsEvent(
      paid.m,
      ex,
      { state: "succeeded", settled_amount: "1000000", evidence: ev, terminal_at: yesterday().toISOString() },
      "evt.rails.execution.settled",
    );
    const done = await expectEvent(probe, "evt.payments.refund.succeeded", { data: { object: { id: r.body.id } } });
    expect(done.data.object).toMatchObject({
      status: "succeeded",
      amount_received: "1000000",
      extra_amount_sent: "0",
      livemode: false,
    });
    expect(done.livemode).toBe(false);
    await probe.close();
    const after = await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token });
    expect(after.body).toMatchObject({ amount_refunded: "1000000", amount_refund_pending: "0" });
    const lines = await st.call("GET", `/v1/balance_transactions?refund=${r.body.id}`, { token: paid.token });
    expect(lines.body.data).toEqual([
      expect.objectContaining({
        type: "refund",
        refund: r.body.id,
        refund_leg: 1,
        received: { amount: "1000000", asset_id: USDC_NEAR, chain: "near:mainnet" },
      }),
    ]);
    const svc = await st.serviceToken("notify");
    const rc = await st.call("GET", `/internal/refunds/${r.body.id}/receipt-context`, { token: svc });
    expect(rc.body).toMatchObject({
      refund: r.body.id,
      livemode: false,
      recipient_display: "payer.near on NEAR",
      evidence_links: [ev.explorer_url],
    });
    const internal = await st.call("GET", `/internal/refunds/${r.body.id}`, {
      token: await st.serviceToken("agentpay"),
    });
    expect(internal.body.id).toBe(r.body.id);
    const ops = await st.call("GET", `/ops/refunds/${r.body.id}`, { token: await st.opsToken() });
    expect(ops.body.legs).toHaveLength(1);
    // a duplicate event is a no-op
    const x = st.executions.get(ex);
    await st.publishEvent(
      domainEvent("evt.rails.execution.settled", x, {
        accountUuid: uuid(paid.m.account, "acct"),
        livemode: false,
        version: x?.version,
      }),
    );
    await new Promise((res) => setTimeout(res, 300));
    expect(
      (await st.call("GET", `/v1/balance_transactions?refund=${r.body.id}`, { token: paid.token })).body.data,
    ).toHaveLength(1);
  });

  it("sign_and_send leg (chain destination): tx hash forwarded; expired leg → prepare → both settle → duplicate leg", async () => {
    const m = st.merchant({ type: "chain_address" });
    const paid = await paidIntent(m);
    const r = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, fee_mode: "merchant_absorbs" },
    });
    expect(r.body).toMatchObject({
      amount: "2000042",
      next_action: { type: "sign_and_send", to: "0x3333333333333333333333333333333333333333" },
    });
    expect(st.rails.calls.filter((c) => c.routeId === createRefundExecution.id).at(-1)?.body).toMatchObject({
      swap_type: "EXACT_OUTPUT",
    });
    const ex1 = await legExecution(r.body.id, 1);
    await railsEvent(m, ex1, { state: "expired_unpaid" });
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/refunds/${r.body.id}`, { token: paid.token })).body.legs[0].status === "expired",
    );
    const p2 = await st.call("POST", `/v1/refunds/${r.body.id}/prepare`, { token: paid.token, body: {} });
    expect(p2.body.legs.map((l: { number: number }) => l.number)).toEqual([2, 1]);
    const tx = await st.call("POST", `/v1/refunds/${r.body.id}/submit_tx`, {
      token: paid.token,
      body: { tx_hash: "0xfeedfeedfeedfeed" },
    });
    expect(tx.body).toMatchObject({
      status: "requires_action",
      legs: [
        expect.objectContaining({ number: 2, submitted_tx: "0xfeedfeedfeedfeed", status: "submitted" }),
        expect.anything(),
      ],
    });
    const ex2 = await legExecution(r.body.id, 2);
    await railsEvent(
      m,
      ex2,
      {
        state: "succeeded",
        settled_amount: "2000000",
        evidence: freshEvidence("payer.near", "2000000"),
        terminal_at: yesterday().toISOString(),
      },
      "evt.rails.execution.settled",
    );
    await waitFor(
      async () => (await st.call("GET", `/v1/refunds/${r.body.id}`, { token: paid.token })).body.status === "succeeded",
    );
    // the merchant had also funded the expired leg; it settles late → duplicate
    await railsEvent(
      m,
      ex1,
      {
        state: "succeeded",
        settled_amount: "2000000",
        evidence: freshEvidence("payer.near", "2000000"),
        terminal_at: yesterday().toISOString(),
      },
      "evt.rails.execution.settled",
    );
    const dup = await waitFor(async () => {
      const v = (await st.call("GET", `/v1/refunds/${r.body.id}`, { token: paid.token })).body;
      return v.extra_amount_sent !== "0" ? v : null;
    });
    expect(dup).toMatchObject({ status: "succeeded", extra_amount_sent: "2000042" });
    expect(dup.legs.find((l: { number: number }) => l.number === 1).duplicate).toBe(true);
    const pi = (await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token })).body;
    expect(pi).toMatchObject({ amount_refunded: "2000042", amount_refund_pending: "0", amount_settled: "2000042" });
    expect(
      (await st.call("GET", `/v1/balance_transactions?refund=${r.body.id}`, { token: paid.token })).body.data,
    ).toHaveLength(2);
  });

  it("transient rail failure → 201 without next_action, recovery links it; definitive → failed, prepare again", async () => {
    const paid = await paidIntent();
    st.failRefundCreates(1);
    const r = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "500000" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "requires_action", next_action: null, legs: [] });
    // the recovery job (every 15 s, legs older than 20 s) links the leg with the same idempotency key
    await st.admin.db
      .updateTable("refund_legs")
      .set({ created_at: new Date(Date.now() - 30_000) })
      .where("refund_id", "=", uuid(r.body.id, "re"))
      .execute();
    const linked = await waitFor(
      async () => (await st.call("GET", `/v1/refunds/${r.body.id}`, { token: paid.token })).body.next_action,
      40_000,
    );
    expect(linked.type).toBe("sign_intent");

    st.failRefundCreates(1, "screening_blocked");
    const bad = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "500000" },
    });
    expect(bad.body.error.code).toBe("screening_blocked");
    const failed = (await st.call("GET", `/v1/refunds?payment_intent=${paid.pi}&status=failed`, { token: paid.token }))
      .body.data;
    expect(failed).toHaveLength(1);
    expect(
      (await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token })).body.amount_refund_pending,
    ).toBe("500000");
    const again = await st.call("POST", `/v1/refunds/${failed[0].id}/prepare`, { token: paid.token, body: {} });
    expect(again.body).toMatchObject({ status: "requires_action", next_action: { type: "sign_intent" } });
    // cancel releases the reservation
    const c = await st.call("POST", `/v1/refunds/${failed[0].id}/cancel`, { token: paid.token, body: {} });
    expect(c.body.status).toBe("canceled");
    expect(
      (await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token })).body.amount_refund_pending,
    ).toBe("500000");
  });

  it("overpayment refunds use the attempt's budget; unsettled attempts and unpaid intents are refused", async () => {
    const paid = await paidIntent();
    const token = paid.token;
    expect(
      (
        await st.call("POST", "/v1/refunds", {
          token,
          body: { payment_intent: paid.pi, payment_attempt: paid.attempt, amount: "1" },
        })
      ).status,
    ).toBe(201);
    const s = await st.call("POST", "/v1/payment_intents", {
      token,
      body: { amount: 200, currency: "usd", return_url: "https://s.example/r" },
    });
    expect((await st.call("POST", "/v1/refunds", { token, body: { payment_intent: s.body.id } })).body.error.code).toBe(
      "intent_not_succeeded",
    );
  });

  it("recipient override: owner session with step-up only; fresh screening; new leg", async () => {
    const paid = await paidIntent();
    const r = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "1000" },
    });
    const noStep = await st.call("POST", `/v1/refunds/${r.body.id}/recipient`, {
      token: await st.sessionToken(paid.m),
      body: { address: "other.near", reason: "payer lost access" },
    });
    expect(noStep.body.error.code).toBe("step_up_required");
    const admin = await st.call("POST", `/v1/refunds/${r.body.id}/recipient`, {
      token: await st.sessionToken(paid.m, { role: "admin", stepUp: true }),
      body: { address: "other.near", reason: "x" },
    });
    expect(admin.body.error.code).toBe("permission_denied");
    const ok = await st.call("POST", `/v1/refunds/${r.body.id}/recipient`, {
      token: await st.sessionToken(paid.m, { stepUp: true }),
      body: { address: "other.near", reason: "payer lost access" },
    });
    expect(ok.body).toMatchObject({
      recipient: { address: "other.near", overridden: true },
      status: "requires_action",
    });
    expect(st.rails.calls.filter((c) => c.routeId === createRefundExecution.id).at(-1)?.body).toMatchObject({
      screen: true,
      recipient: { address: "other.near" },
      idempotency_key: `refund:${r.body.id}:leg:2`,
    });
    const bad = await st.call("POST", `/v1/refunds/${r.body.id}/recipient`, {
      token: await st.sessionToken(paid.m, { stepUp: true }),
      body: { address: "NOT A NEAR ACCOUNT!", reason: "x" },
    });
    expect(bad.body.error.code).toBe("refund_address_invalid");
  });

  it("test helper simulates the leg's deposit on the sandbox", async () => {
    const paid = await paidIntent();
    const r = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "2000" },
    });
    const sim = await st.call("POST", `/v1/test_helpers/refunds/${r.body.id}/simulate_deposit`, {
      token: paid.token,
      body: {},
    });
    expect(sim.status).toBe(202);
    expect(st.sandbox.calls.at(-1)?.body).toMatchObject({
      from: "acme.near",
      to: "payer.near",
      amount: "2000",
      memo: r.body.next_action.transfer.memo,
    });
  });

  it("kill switch: no new live refund legs while engaged; resumes on release", async () => {
    const m = st.merchant({ livemode: true });
    const paid = await paidIntent(m, { livemode: true });
    const acct = uuid(m.account, "acct");
    // finding 8: no sentinel state applied yet → unknown → fail closed for live refunds
    expect(await st.admin.db.selectFrom("kill_switch").selectAll().executeTakeFirst()).toBeUndefined();
    const unknown = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "1000" },
    });
    expect(unknown.status).toBe(503);
    expect(unknown.body.error).toMatchObject({ code: "rail_unavailable" });
    expect(unknown.body.error.message).toMatch(/state is known/);
    await st.publishEvent(
      domainEvent(
        "evt.sentinel.kill_switch.engaged",
        { engaged: true, reason: "drill", actor: "ops" },
        { accountUuid: null, livemode: true, version: 1000 },
      ),
    );
    await waitFor(
      async () => (await st.admin.db.selectFrom("kill_switch").selectAll().executeTakeFirst())?.engaged === true,
    );
    const blocked = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "1000" },
    });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe("rail_unavailable");
    // test mode is unaffected
    const t = await paidIntent();
    expect(
      (await st.call("POST", "/v1/refunds", { token: t.token, body: { payment_intent: t.pi, amount: "1000" } })).status,
    ).toBe(201);
    // a stale (older) release is ignored, a newer one applies
    await st.publishEvent(
      domainEvent(
        "evt.sentinel.kill_switch.released",
        { engaged: false, reason: "old", actor: "ops" },
        { accountUuid: null, livemode: true, version: 999 },
      ),
    );
    await st.publishEvent(
      domainEvent(
        "evt.sentinel.kill_switch.released",
        { engaged: false, reason: "done", actor: "ops" },
        { accountUuid: null, livemode: true, version: 1001 },
      ),
    );
    await waitFor(
      async () => (await st.admin.db.selectFrom("kill_switch").selectAll().executeTakeFirst())?.engaged === false,
    );
    expect(
      (await st.call("POST", "/v1/refunds", { token: paid.token, body: { payment_intent: paid.pi, amount: "1000" } }))
        .status,
    ).toBe(201);
    void acct;
  });
});

// ==================================================================================== reconciliation

describe("reconciliation (console)", () => {
  it("ok run on consistent data; diff run opens a compliance case; resolution needs step-up; audit events", async () => {
    const paid = await paidIntent();
    const day = yesterday().toISOString().slice(0, 10);
    const ops = await st.opsToken();
    const probe = await st.probe();
    const run = await st.call("POST", "/ops/reconciliation_runs", {
      token: ops,
      body: { account_id: paid.m.account, livemode: false, day },
    });
    expect(run.body.error ?? null).toBeNull();
    expect(run.body).toMatchObject({ object: "reconciliation_run", status: "running", trigger: "ops" });
    await expectEvent(probe, "evt.payments.ops_action.recorded", {
      data: { object: { action: "reconciliation_run.created" } },
    });
    const ok = await waitFor(async () => {
      const v = (await st.call("GET", `/ops/reconciliation_runs/${run.body.id}`, { token: ops })).body;
      return v.status !== "running" ? v : null;
    }, 30_000);
    expect(ok).toMatchObject({ status: "ok", diff_count: 0 });
    expect(ok.totals[0]).toMatchObject({ asset_id: USDC_NEAR, inflow: { statement: "2000042", evidence: "2000042" } });

    // inject a discrepancy: a settled execution rails knows but the statement lacks
    await st.admin.db
      .deleteFrom("balance_transactions")
      .where("payment_intent_id", "=", uuid(paid.pi, "pi"))
      .execute()
      .catch(() => null);
    const x = st.executions.get(paid.exId);
    if (x) st.executions.set(paid.exId, { ...x, settled_amount: "2000043" } as never);
    const re = await st.call("POST", "/ops/reconciliation_runs", {
      token: ops,
      body: { account_id: paid.m.account, livemode: false, day },
    });
    expect(re.body.rerun_of).toBe(run.body.id);
    const diff = await waitFor(async () => {
      const v = (await st.call("GET", `/ops/reconciliation_runs/${re.body.id}`, { token: ops })).body;
      return v.status !== "running" ? v : null;
    }, 30_000);
    expect(diff.status).toBe("diff");
    expect(diff.diff_count).toBeGreaterThan(0);
    await waitFor(
      async () =>
        (
          await st.admin.db
            .selectFrom("reconciliation_runs")
            .select("case_id")
            .where("id", "=", uuid(re.body.id, "rcn"))
            .executeTakeFirst()
        )?.case_id,
    );
    expect(st.compliance.calls.find((c) => c.routeId === "createInternalCase")?.body).toMatchObject({
      kind: "reconciliation_diff",
      subject: { type: "reconciliation_run", id: re.body.id },
    });
    const list = await st.call("GET", `/ops/reconciliation_runs?account=${paid.m.account}&unresolved=true`, {
      token: ops,
    });
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([re.body.id]);

    const noStep = await st.call("POST", `/ops/reconciliation_runs/${re.body.id}/resolution`, {
      token: ops,
      body: { classification: "missed_event", note: "backfilled" },
    });
    expect(noStep.body.error.code).toBe("step_up_required");
    const res = await st.call("POST", `/ops/reconciliation_runs/${re.body.id}/resolution`, {
      token: await st.opsToken({ stepUp: true }),
      body: { classification: "missed_event", note: "backfilled" },
    });
    expect(res.body.resolution).toMatchObject({ classification: "missed_event", note: "backfilled" });
    await expectEvent(probe, "evt.payments.ops_action.recorded", {
      data: { object: { action: "reconciliation_run.resolved" } },
    });
    await probe.close();
    expect(
      (
        await st.call("POST", `/ops/reconciliation_runs/${re.body.id}/resolution`, {
          token: await st.opsToken({ stepUp: true }),
          body: { classification: "other", note: "again" },
        })
      ).body.error.code,
    ).toBe("state_conflict");
    // completed runs are immutable (INV-9)
    await expect(
      st.admin.db
        .updateTable("reconciliation_runs")
        .set({ status: "ok" })
        .where("id", "=", uuid(re.body.id, "rcn"))
        .execute(),
    ).rejects.toThrow();
  });

  it("reconcile.daily schedules one run per active account; the scheduled run waits for a complete rails day", async () => {
    const paid = await paidIntent();
    const day = yesterday().toISOString().slice(0, 10);
    const p = st.worker?.payments as NonNullable<typeof st.worker>["payments"];
    const { jobHandlers } = await import("../../src/workers/jobs.js");
    const { scheduleDaily, runJob } = await import("../../src/app/reconciliation.js");
    expect(await scheduleDaily(p, day)).toBeGreaterThan(0);
    const acct = uuid(paid.m.account, "acct");
    st.evidenceDay.complete = false;
    await expect(runJob(p, { account: acct, livemode: false, day }, 1)).rejects.toThrow(/not complete/);
    st.evidenceDay.complete = true;
    await runJob(p, { account: acct, livemode: false, day }, 1);
    const runs = await st.call("GET", `/ops/reconciliation_runs?account=${paid.m.account}&day=${day}`, {
      token: await st.opsToken(),
    });
    expect(runs.body.data[0]).toMatchObject({ trigger: "schedule", status: "ok", diff_count: 0 });
    expect(Object.keys(jobHandlers(p))).toEqual(
      expect.arrayContaining(["reconcile.daily", "reconcile.run", "reconcile.case", "refund.prepare_recovery"]),
    );
  });

  it("refuses open days, merchant tokens, and non-ops principals", async () => {
    const m = st.merchant();
    const ops = await st.opsToken();
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (
        await st.call("POST", "/ops/reconciliation_runs", {
          token: ops,
          body: { account_id: m.account, livemode: false, day: today },
        })
      ).body.error.code,
    ).toBe("reconciliation_day_open");
    const merchant = await st.call("GET", "/ops/reconciliation_runs", { token: await st.token(m) });
    expect(merchant.status).toBe(403);
    const unknown = await st.call("GET", "/ops/reconciliation_runs/rcn_00000000000000000000000000", { token: ops });
    expect(unknown.status).toBe(404);
  });
});

// ==================================================================================== stage 2 audit fixes

describe("audit fixes (lld/payments.md §18)", () => {
  const sessionsOf = (link: string, ip: string) =>
    st.call("POST", `/v1/payment_links/${link}/public/sessions`, { body: {}, headers: { "x-forwarded-for": ip } });

  it("finding 3: link limits per client network, a creation-only link ceiling, unknown ids cost nothing, Valkey", async () => {
    const settings = st.payments.settings as unknown as Record<string, number>;
    const saved = { ...settings };
    Object.assign(settings, { linkSessionsPerIp: 3, linkSessionsPerLinkClient: 2, linkSessionsPerLink: 3 });
    try {
      const token = await st.token(st.merchant());
      const mk = async () =>
        (
          await st.call("POST", "/v1/payment_links", {
            token,
            body: { amount: 200, currency: "usd", description: "x" },
          })
        ).body.id as string;
      const link = await mk();
      // unknown link ids are answered before anything is counted
      for (let n = 0; n < 4; n++)
        expect((await sessionsOf("plink_01jbz9k3m4n5p6q7r8s9t0v1w2", "192.0.2.1")).status).toBe(404);
      expect((await sessionsOf(link, "198.51.100.7")).status).toBe(201);
      expect((await sessionsOf(link, "198.51.100.200")).status).toBe(201);
      // a third session from the same /24 is refused for that client network only
      const third = await sessionsOf(link, "198.51.100.9");
      expect(third.status).toBe(429);
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await sessionsOf(link, "203.0.113.5")).status).toBe(201);
      // the per-link ceiling (3) throttles creation, never reads
      expect((await sessionsOf(link, "192.0.2.1")).status).toBe(429);
      expect((await st.call("GET", `/v1/payment_links/${link}/public`)).status).toBe(200);
      // 192.0.2.1 spent nothing on unknown ids or refused requests: it still opens a session elsewhere
      expect((await sessionsOf(await mk(), "192.0.2.1")).status).toBe(201);

      // the api counts in Valkey, and two replicas share the windows
      const url = st.valkeyUrl as string;
      const r = new Redis(url);
      expect((await r.keys("np:payments:rl:plink:*")).length).toBeGreaterThan(0);
      await r.quit();
      const a = valkeyLimiter(url);
      const b = valkeyLimiter(url);
      await waitFor(async () => a.backend() === "valkey" && b.backend() === "valkey");
      const lim = [{ key: `shared-${Date.now()}`, max: 2 }];
      expect((await a.take(lim, Date.now(), 60_000)).ok).toBe(true);
      expect((await b.take(lim, Date.now(), 60_000)).ok).toBe(true);
      expect((await a.take(lim, Date.now(), 60_000)).ok).toBe(false);
      await a.close();
      await b.close();
      // Valkey unreachable → the in-process fallback still limits
      const down = valkeyLimiter("redis://127.0.0.1:9");
      expect((await down.take(lim, Date.now(), 60_000)).ok).toBe(true);
      expect((await down.take(lim, Date.now(), 60_000)).ok).toBe(true);
      expect((await down.take(lim, Date.now(), 60_000)).ok).toBe(false);
      await down.close();
    } finally {
      Object.assign(settings, saved);
    }
  });

  it("finding 12: max_uses holds under concurrent session creation; an expired session gives its use back", async () => {
    const token = await st.token(st.merchant());
    const l = await st.call("POST", "/v1/payment_links", {
      token,
      body: { amount: 200, currency: "usd", description: "limited", max_uses: 2 },
    });
    const all = await Promise.all(Array.from({ length: 8 }, (_, n) => sessionsOf(l.body.id, `203.0.113.${n + 10}`)));
    const opened = all.filter((r) => r.status === 201);
    expect(opened).toHaveLength(2);
    for (const r of all.filter((x) => x.status !== 201)) expect(r.body.error.code).toBe("link_inactive");
    const exp = await st.call("POST", `/v1/checkout/sessions/${opened[0]?.body.checkout_session}/expire`, {
      token,
      body: {},
    });
    expect(exp.status).toBe(200);
    expect((await sessionsOf(l.body.id, "203.0.113.40")).status).toBe(201);
    const full = await sessionsOf(l.body.id, "203.0.113.41");
    expect(full.body.error.code).toBe("link_inactive");
    expect(full.body.error.message).toMatch(/held by a checkout in progress/);
  });

  it("finding 5: a cancel racing the relay is refused; a refused relay re-opens the leg; an unknown outcome keeps it", async () => {
    const paid = await paidIntent();
    const sk = new Uint8Array(randomBytes(32));
    const mkRefund = async () => {
      const r = await st.call("POST", "/v1/refunds", {
        token: paid.token,
        body: { payment_intent: paid.pi, amount: "600000" },
      });
      expect(r.status).toBe(201);
      return { id: r.body.id as string, signed: signNep413(JSON.parse(r.body.next_action.payload), sk) };
    };
    const submit = (id: string, signed: unknown) =>
      st.call("POST", `/v1/refunds/${id}/submit_tx`, { token: paid.token, body: { signed_intent: signed } });
    const cancel = (id: string) => st.call("POST", `/v1/refunds/${id}/cancel`, { token: paid.token, body: {} });
    const legStatus = async (id: string) =>
      (
        await st.admin.db
          .selectFrom("refund_legs")
          .select("status")
          .where("refund_id", "=", uuid(id, "re"))
          .executeTakeFirstOrThrow()
      ).status;
    try {
      // 1. relay in progress: cancel refused, the reservation stays
      let release: () => void = () => {};
      const gate = new Promise<void>((res) => {
        release = res;
      });
      st.agentpay.on(relaySignedIntent, async () => {
        await gate;
        return { agent_payment_id: newId("ap") };
      });
      const r1 = await mkRefund();
      const pending = submit(r1.id, r1.signed);
      await waitFor(async () => (await legStatus(r1.id)) === "submitting");
      expect((await cancel(r1.id)).body.error.code).toBe("state_conflict");
      const mid = (await st.call("GET", `/v1/refunds/${r1.id}`, { token: paid.token })).body;
      expect(mid).toMatchObject({ status: "requires_action", next_action: null });
      expect(mid.legs[0].status).toBe("submitted");
      release();
      expect((await pending).body.status).toBe("pending");
      expect(
        (await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token })).body.amount_refund_pending,
      ).toBe("600000");

      // 2. agentpay refuses (nothing published): the leg awaits a signature again and can be canceled
      st.agentpay.on(relaySignedIntent, async () => mockError("insufficient_balance" as never));
      const r2 = await mkRefund();
      expect((await submit(r2.id, r2.signed)).body.error.code).toBe("insufficient_balance");
      expect(await legStatus(r2.id)).toBe("awaiting_signature");
      expect((await cancel(r2.id)).body.status).toBe("canceled");

      // 3. unknown outcome: the leg stays submitting (cancel refused); the same payload is taken again
      st.agentpay.on(relaySignedIntent, async () => {
        throw new Error("agentpay is down");
      });
      const r3 = await mkRefund();
      expect((await submit(r3.id, r3.signed)).body.error.code).toBe("rail_unavailable");
      expect(await legStatus(r3.id)).toBe("submitting");
      expect((await cancel(r3.id)).body.error.code).toBe("state_conflict");
      st.agentpay.on(relaySignedIntent, async () => ({ agent_payment_id: newId("ap") }));
      expect((await submit(r3.id, r3.signed)).body.status).toBe("pending");
    } finally {
      st.agentpay.on(relaySignedIntent, async () => ({ agent_payment_id: newId("ap") }));
    }
  });

  it("finding 6: a late create response after a cancel does not revive the leg", async () => {
    const paid = await paidIntent();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let created = false;
    st.onRefundCreate(async () => {
      created = true;
      await gate;
    });
    try {
      const pending = st.call("POST", "/v1/refunds", {
        token: paid.token,
        body: { payment_intent: paid.pi, amount: "700000" },
      });
      await waitFor(async () => created);
      const row = await st.admin.db
        .selectFrom("refunds")
        .select("id")
        .where("payment_intent_id", "=", uuid(paid.pi, "pi"))
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      const id = (await st.call("GET", `/v1/refunds?payment_intent=${paid.pi}`, { token: paid.token })).body.data[0]
        .id as string;
      expect((await st.call("POST", `/v1/refunds/${id}/cancel`, { token: paid.token, body: {} })).body.status).toBe(
        "canceled",
      );
      release();
      const out = await pending;
      expect(out.body.status).toBe("canceled");
      expect(out.body.next_action).toBeNull();
      const leg = await st.admin.db
        .selectFrom("refund_legs")
        .selectAll()
        .where("refund_id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(leg).toMatchObject({ status: "failed", failure_code: "canceled" });
      expect(leg.execution_id).not.toBeNull();
      const note = await st.admin.db
        .selectFrom("refund_leg_transitions")
        .selectAll()
        .where("refund_leg_id", "=", leg.id)
        .where("from_state", "=", "failed")
        .where("to_state", "=", "failed")
        .where("cause", "like", "%ignored%")
        .executeTakeFirst();
      expect(note?.cause).toMatch(/ignored/);
      // spec 0.2.1: the orphaned execution is abandoned at rails
      expect(note?.cause).toMatch(/abandoning it at rails \(refund_canceled\)/);
      await waitFor(async () => st.abandoned.find((a) => a.id === leg.execution_id));
      expect(st.abandoned.find((a) => a.id === leg.execution_id)?.reason).toBe("refund_canceled");
      const done = await waitFor(async () => {
        const l = await st.admin.db.selectFrom("refund_legs").selectAll().where("id", "=", leg.id).executeTakeFirst();
        return l?.abandoned_at ? l : null;
      });
      expect(done).toMatchObject({ status: "failed", abandon_reason: "refund_canceled" });
    } finally {
      st.onRefundCreate(null);
      release();
    }
  });

  it("finding 7: instructions that do not match the leg fail it and are never shown", async () => {
    try {
      // Intents transfer to someone else than the refund recipient
      const paid = await paidIntent();
      st.onRefundCreate((x) => {
        (x.refund?.transfer as { receiver_id: string }).receiver_id = "evil.near";
      });
      const bad = await st.call("POST", "/v1/refunds", {
        token: paid.token,
        body: { payment_intent: paid.pi, amount: "800000" },
      });
      expect(bad.status).toBe(503);
      expect(bad.body.error.code).toBe("rail_unavailable");
      const [r] = (await st.call("GET", `/v1/refunds?payment_intent=${paid.pi}`, { token: paid.token })).body.data;
      expect(r).toMatchObject({ status: "failed", failure_code: "execution_mismatch", next_action: null });
      const badEx = await legExecution(r.id);
      await waitFor(async () => st.abandoned.find((a) => a.id === badEx && a.reason === "execution_mismatch"));
      expect(JSON.stringify(r)).not.toContain("evil.near");
      expect(
        (await st.call("GET", `/v1/payment_intents/${paid.pi}`, { token: paid.token })).body.amount_refund_pending,
      ).toBe("0");

      // EXACT_INPUT deposit for another amount (chain destination)
      const m = st.merchant({ type: "chain_address" });
      const chain = await paidIntent(m);
      st.onRefundCreate((x) => {
        (x.deposit as { amount_in: string }).amount_in = "1";
      });
      const short = await st.call("POST", "/v1/refunds", {
        token: chain.token,
        body: { payment_intent: chain.pi, amount: "900000", fee_mode: "payer_absorbs" },
      });
      expect(short.status).toBe(503);
      const [c] = (await st.call("GET", `/v1/refunds?payment_intent=${chain.pi}`, { token: chain.token })).body.data;
      expect(c).toMatchObject({ status: "failed", failure_code: "execution_mismatch", next_action: null });
    } finally {
      st.onRefundCreate(null);
    }
  });
});

// ==================================================================================== spec 0.2.1

describe('spec 0.2.1 (lld/payments.md §"Spec 0.2.1 contract changes")', () => {
  const killSwitchRow = () => st.admin.db.selectFrom("kill_switch").selectAll().executeTakeFirst();

  it("kill switch read from sentinel when unknown; its version decides which events still apply", async () => {
    const m = st.merchant({ livemode: true });
    const paid = await paidIntent(m, { livemode: true });
    const refund = () =>
      st.call("POST", "/v1/refunds", { token: paid.token, body: { payment_intent: paid.pi, amount: "1000" } });
    try {
      // sentinel down and nothing stored: unknown → fail closed
      await st.admin.db.deleteFrom("kill_switch").execute();
      st.killSwitchRead = null;
      expect(await syncKillSwitchAtBoot(st.payments)).toBe("unknown");
      // (the envelope carries code + message only; `params` just render the catalogue message)
      const unknown = await refund();
      expect(unknown.status).toBe(503);
      expect(unknown.body.error.code).toBe("rail_unavailable");
      expect(unknown.body.error.message).toMatch(/state is known/);
      // boot read: released at version 5000
      st.killSwitchRead = { engaged: false, version: 5000, reason: "normal" };
      expect(await syncKillSwitchAtBoot(st.payments)).toBe("released");
      expect(await killSwitchRow()).toMatchObject({ engaged: false, version: 5000 });
      expect((await refund()).status).toBe(201);
      // an older event is ignored, a newer one applies
      const ev = (engaged: boolean, version: number, reason: string) =>
        st.publishEvent(
          domainEvent(
            engaged ? "evt.sentinel.kill_switch.engaged" : "evt.sentinel.kill_switch.released",
            { engaged, reason, actor: "ops" },
            { accountUuid: null, livemode: true, version },
          ),
        );
      await ev(true, 4999, "stale");
      await ev(true, 5001, "drill");
      await waitFor(async () => (await killSwitchRow())?.version === 5001);
      expect(await killSwitchRow()).toMatchObject({ engaged: true, reason: "drill" });
      // a stored state is never replaced by a read
      st.killSwitchRead = { engaged: false, version: 1, reason: "old" };
      expect(await syncKillSwitchAtBoot(st.payments)).toBe("engaged");
      // sentinel 0.2.0 sends no version: stored as 0, so any event replaces it
      await st.admin.db.deleteFrom("kill_switch").execute();
      st.killSwitchRead = { engaged: true, reason: "no version" };
      expect(await syncKillSwitchAtBoot(st.payments)).toBe("engaged");
      expect((await killSwitchRow())?.version).toBe(0);
      const engaged = await refund();
      expect(engaged.status).toBe(503);
      expect(engaged.body.error.message).toMatch(/kill switch is engaged/);
      await ev(false, 1, "released");
      await waitFor(async () => (await killSwitchRow())?.engaged === false);
      expect((await refund()).status).toBe(201);
    } finally {
      st.killSwitchRead = null;
    }
  });

  it("legs canceled or replaced before any deposit are abandoned; money moved → rails keeps them", async () => {
    const paid = await paidIntent();
    const r = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "300000" },
    });
    expect(r.body.status).toBe("requires_action");
    const ex1 = await legExecution(r.body.id);
    expect((await st.call("POST", `/v1/refunds/${r.body.id}/cancel`, { token: paid.token, body: {} })).status).toBe(
      200,
    );
    await waitFor(async () => st.abandoned.find((a) => a.id === ex1 && a.reason === "refund_canceled"));
    // rails' expired_unpaid event closes the leg; the canceled refund is unchanged
    await railsEvent(paid.m, ex1, { state: "expired_unpaid" });
    await waitFor(async () => {
      const l = await st.admin.db
        .selectFrom("refund_legs")
        .selectAll()
        .where("execution_id", "=", ex1)
        .executeTakeFirst();
      return l?.status === "expired" && l.abandoned_at ? l : null;
    });
    expect((await st.call("GET", `/v1/refunds/${r.body.id}`, { token: paid.token })).body.status).toBe("canceled");

    // recipient override replaces a leg waiting for its signature: superseded
    const r2 = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "300000" },
    });
    const ex2 = await legExecution(r2.body.id);
    const owner = await st.sessionToken(paid.m, { role: "owner", stepUp: true });
    const o = await st.call("POST", `/v1/refunds/${r2.body.id}/recipient`, {
      token: owner,
      body: { address: "other.near", reason: "payer asked" },
    });
    expect(o.status).toBe(200);
    await waitFor(async () => st.abandoned.find((a) => a.id === ex2 && a.reason === "superseded"));

    // money moved before the abandon reached rails: 409, the leg stays tracked (INV-3)
    const r3 = await st.call("POST", "/v1/refunds", {
      token: paid.token,
      body: { payment_intent: paid.pi, amount: "300000" },
    });
    const ex3 = await legExecution(r3.body.id);
    st.advance(ex3, { state: "deposit_detected" } as never);
    await st.call("POST", `/v1/refunds/${r3.body.id}/cancel`, { token: paid.token, body: {} });
    await waitFor(async () => st.abandoned.find((a) => a.id === ex3));
    const leg3 = await waitFor(async () => {
      const l = await st.admin.db
        .selectFrom("refund_legs")
        .select(["id", "abandoned_at"])
        .where("execution_id", "=", ex3)
        .executeTakeFirstOrThrow();
      const n = await st.admin.db
        .selectFrom("refund_leg_transitions")
        .select("cause")
        .where("refund_leg_id", "=", l.id)
        .where("cause", "like", "%not abandoned%")
        .executeTakeFirst();
      return n ? l : null;
    });
    expect(leg3.abandoned_at).toBeNull();
  });

  it("sign_intent legs use the nonce rails issues (salt read only without it)", async () => {
    const nonce = Buffer.concat([Buffer.from("5a0dbe11", "hex"), randomBytes(28)]).toString("base64");
    st.refundNonce = nonce;
    try {
      const paid = await paidIntent();
      const r = await st.call("POST", "/v1/refunds", {
        token: paid.token,
        body: { payment_intent: paid.pi, amount: "1000" },
      });
      expect(r.body.next_action.nep413.nonce).toBe(nonce);
      expect(JSON.parse(r.body.next_action.payload).nonce).toBe(nonce);
      const leg = await st.admin.db
        .selectFrom("refund_legs")
        .select("signed_nonce")
        .where("refund_id", "=", uuid(r.body.id, "re"))
        .executeTakeFirstOrThrow();
      expect(leg.signed_nonce).toBe(nonce);
    } finally {
      st.refundNonce = null;
    }
    const fallback = await paidIntent();
    const r = await st.call("POST", "/v1/refunds", {
      token: fallback.token,
      body: { payment_intent: fallback.pi, amount: "1000" },
    });
    expect(r.body.next_action.nep413.nonce).not.toBe(nonce);
  });

  it("payer and merchant views: deposit fee, amount received, refund_to, pricing asset, link name", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const s = await st.call("POST", "/v1/checkout/sessions", {
      token,
      body: { amount: "2000000", currency: "asset", asset_id: USDC_NEAR, success_url: "https://shop.example/t" },
    });
    expect(s.status).toBe(201);
    const a = await st.call("POST", `/v1/checkout/sessions/${s.body.id}/public/attempts`, {
      secret: s.body.client_secret,
      body: {
        method: "route_quote",
        origin_asset_id: USDC_BASE,
        refund_to: "0x2222222222222222222222222222222222222222",
        turnstile_token: "t",
      },
    });
    expect(a.status).toBe(201);
    expect(a.body.deposit).toMatchObject({ amount_in: "2010042", fee_amount: "10042" });
    expect(a.body.amount_received).toBeNull();
    const pub = await st.call("GET", `/v1/checkout/sessions/${s.body.id}/public`, { secret: s.body.client_secret });
    expect(pub.body.pricing_asset).toEqual({ asset_id: USDC_NEAR, symbol: "USDC", decimals: 6 });
    const row = await st.admin.db
      .selectFrom("payment_attempts")
      .select("execution_id")
      .where("id", "=", uuid(a.body.id, "pa"))
      .executeTakeFirstOrThrow();
    await railsEvent(m, row.execution_id as string, { state: "incomplete_deposit", deposited_amount: "1500000" });
    await waitFor(
      async () =>
        (await st.call("GET", `/v1/checkout/sessions/${s.body.id}/public`, { secret: s.body.client_secret })).body
          .attempt?.amount_received === "1500000",
    );
    const pi = await st.call("GET", `/v1/payment_intents/${s.body.payment_intent}`, { token });
    expect(pi.body.attempts[0]).toMatchObject({
      origin_amount: "1500000",
      refund_to: "0x2222222222222222222222222222222222222222",
    });
    const fiat = await st.call("POST", "/v1/checkout/sessions", {
      token,
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/t" },
    });
    expect(
      (await st.call("GET", `/v1/checkout/sessions/${fiat.body.id}/public`, { secret: fiat.body.client_secret })).body
        .pricing_asset,
    ).toBeNull();

    // links: name on create / update / read (never on the public link), pricing asset on the public link
    const l = await st.call("POST", "/v1/payment_links", {
      token,
      body: { amount: "2000000", currency: "asset", asset_id: USDC_NEAR, description: "Beans", name: "Spring promo" },
    });
    expect(l.status).toBe(201);
    expect(l.body.name).toBe("Spring promo");
    const up = await st.call("PATCH", `/v1/payment_links/${l.body.id}`, { token, body: { name: "Summer promo" } });
    expect(up.body.name).toBe("Summer promo");
    expect((await st.call("GET", `/v1/payment_links/${l.body.id}`, { token })).body.name).toBe("Summer promo");
    expect(
      (await st.call("PATCH", `/v1/payment_links/${l.body.id}`, { token, body: { name: null } })).body.name,
    ).toBeNull();
    const pl = await st.call("GET", `/v1/payment_links/${l.body.id}/public`);
    expect(pl.body.pricing_asset).toEqual({ asset_id: USDC_NEAR, symbol: "USDC", decimals: 6 });
    expect(pl.body).not.toHaveProperty("name");
  });

  it("customer total_paid: succeeded intents per currency, concurrent payments, refunds not subtracted", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const c = await st.call("POST", "/v1/customers", { token, body: { email: "tot@example.com" } });
    expect(c.body).toMatchObject({ total_paid: [], last_payment_at: null });
    const n = 4;
    const paid = await Promise.all(Array.from({ length: n }, () => paidIntent(m, { body: { customer: c.body.id } })));
    await paidIntent(m, { body: { customer: c.body.id, amount: 300, currency: "eur" } });
    await paidIntent(m); // no customer
    const v = (await st.call("GET", `/v1/customers/${c.body.id}`, { token })).body;
    expect(v.total_paid).toEqual([
      { currency: "eur", asset_id: null, amount: 300, count: 1 },
      { currency: "usd", asset_id: null, amount: 200 * n, count: n },
    ]);
    expect(v.last_payment_at).toBeGreaterThan(0);
    // a refund that succeeds does not change the totals
    const p0 = paid[0] as PaidIntent;
    const r = await st.call("POST", "/v1/refunds", { token, body: { payment_intent: p0.pi, amount: "1000000" } });
    const ex = await legExecution(r.body.id);
    await railsEvent(
      m,
      ex,
      {
        state: "succeeded",
        settled_amount: "1000000",
        evidence: freshEvidence("payer.near", "1000000"),
        terminal_at: new Date().toISOString(),
      },
      "evt.rails.execution.settled",
    );
    await waitFor(
      async () => (await st.call("GET", `/v1/refunds/${r.body.id}`, { token })).body.status === "succeeded",
    );
    const after = (await st.call("GET", `/v1/customers/${c.body.id}`, { token })).body;
    expect(after.total_paid).toEqual(v.total_paid);
    expect((await st.call("GET", `/v1/customers?email=tot%40example.com`, { token })).body.data[0].total_paid).toEqual(
      v.total_paid,
    );
    // the stored totals equal the recomputed sum
    const sum = await st.admin.db
      .selectFrom("payment_intents")
      .select((eb) => [eb.fn.sum<string>("amount").as("amount"), eb.fn.countAll<string>().as("count")])
      .where("customer_id", "=", uuid(c.body.id, "cus"))
      .where("status", "=", "succeeded")
      .where("currency", "=", "usd")
      .executeTakeFirstOrThrow();
    expect({ amount: Number(sum.amount), count: Number(sum.count) }).toEqual({ amount: 200 * n, count: n });
  });

  it("reconciliation: observed fees, fee_mismatch, incomplete fees, decimals and account display name", async () => {
    const day = yesterday().toISOString().slice(0, 10);
    const ops = await st.opsToken();
    const runOf = async (account: string) => {
      const run = await st.call("POST", "/ops/reconciliation_runs", {
        token: ops,
        body: { account_id: account, livemode: false, day },
      });
      expect(run.body.error ?? null).toBeNull();
      return waitFor(async () => {
        const v = (await st.call("GET", `/ops/reconciliation_runs/${run.body.id}`, { token: ops })).body;
        return v.status !== "running" ? v : null;
      }, 30_000);
    };
    const feeOf = async (pi: string) =>
      (
        await st.admin.db
          .selectFrom("balance_transactions")
          .select(["fee_amount_est", "fee_asset_id"])
          .where("payment_intent_id", "=", uuid(pi, "pi"))
          .where("type", "=", "payment")
          .executeTakeFirstOrThrow()
      ).fee_amount_est as string;
    const observe = (exId: string, amount: string | null) => {
      const x = st.executions.get(exId);
      st.executions.set(exId, {
        ...x,
        observed_fee: amount === null ? null : { amount, asset_id: USDC_NEAR },
      } as never);
    };

    // every execution reports its fee and it matches: ok, observed filled
    const a = await paidIntent();
    observe(a.exId, await feeOf(a.pi));
    const ok = await runOf(a.m.account);
    expect(ok).toMatchObject({ status: "ok", account_display_name: "Acme Coffee" });
    expect(ok.totals[0]).toMatchObject({
      decimals: 6,
      fees: { expected: await feeOf(a.pi), observed: await feeOf(a.pi) },
    });

    // observed differs: fee_mismatch
    const b = await paidIntent();
    observe(b.exId, (BigInt(await feeOf(b.pi)) + 1n).toString());
    const diff = await runOf(b.m.account);
    expect(diff.status).toBe("diff");
    expect(diff.diffs).toEqual([expect.objectContaining({ kind: "fee_mismatch", asset_id: USDC_NEAR })]);

    // one execution without an observed fee: fees incomplete (observed null), not a diff
    const mc = st.merchant();
    const c1 = await paidIntent(mc);
    const c2 = await paidIntent(mc);
    observe(c1.exId, "1");
    observe(c2.exId, null);
    const inc = await runOf(mc.account);
    expect(inc).toMatchObject({ status: "ok", diff_count: 0 });
    expect(inc.totals[0].fees.observed).toBeNull();
  });
});
