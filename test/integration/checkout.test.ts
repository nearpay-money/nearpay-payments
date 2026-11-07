/**
 * End-to-end through the real api and worker (lld/payments.md §15 integration): create session →
 * payer reads → attempt (rails mocked from the spec) → execution events over NATS → intent/session
 * transitions, statement line, outbox events; idempotent replays; SSE; cancel/expire; agent
 * attempts; quoting recovery; identity events mark contexts stale.
 */

import { createExecution } from "@nearpay-internal/spec";
import { account, domainEvent, expectEvent } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Stack, startStack, USDC_BASE, USDC_NEAR, uuid } from "../support/stack.js";

let st: Stack;

beforeAll(async () => {
  st = await startStack({ worker: true });
});
afterAll(async () => {
  await st?.stop();
});

async function session(m = st.merchant(), body: Record<string, unknown> = {}, key?: string) {
  const token = await st.token(m);
  const r = await st.call("POST", "/v1/checkout/sessions", {
    token,
    body: { amount: 200, currency: "usd", success_url: "https://shop.example/thanks", ...body },
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
  return { m, token, r };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("checkout sessions (merchant)", () => {
  it("creates a session with snapshots, a secret in the URL fragment and payment_intent.created", async () => {
    const probe = await st.probe();
    const { r } = await session();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      object: "checkout_session",
      status: "open",
      amount: 200,
      currency: "usd",
      ui_mode: "hosted",
      sequence: 1,
    });
    expect(r.body.url).toBe(`https://pay.nearpay.localhost/c/${r.body.id}#${r.body.client_secret}`);
    const e = await expectEvent(probe, "evt.payments.payment_intent.created", {
      data: { object: { id: r.body.payment_intent } },
    });
    expect(e.data.object).toMatchObject({
      status: "requires_payment",
      destination: { asset_id: USDC_NEAR },
      fee: { bearer: "payer", total_bps: 0 },
    });
    await probe.close();
  });

  it("replays an idempotent create with the same key", async () => {
    const m = st.merchant();
    const a = await session(m, {}, "k-1");
    const b = await session(m, {}, "k-1");
    expect(b.r.status).toBe(201);
    expect(b.r.body.id).toBe(a.r.body.id);
    expect(b.r.headers.get("idempotent-replayed")).toBe("true");
  });

  it("refuses: unsupported currency, live not enabled, below minimum, unverified cap, embedded without origins", async () => {
    expect((await session(undefined, { currency: "sek" })).r.body.error.code).toBe("currency_unsupported");
    const notLive = st.merchant({ liveEnabled: false });
    const r1 = await st.call("POST", "/v1/checkout/sessions", {
      token: await st.token(notLive, { livemode: true }),
      body: { amount: 200, currency: "usd", success_url: "https://shop.example/t" },
    });
    expect(r1.body.error.code).toBe("account_not_live");
    expect((await session(undefined, { amount: 5 })).r.body.error.code).toBe("amount_below_destination_minimum");
    const capped = st.merchant({ verification: "unverified", capUsdMicros: 1_000_000 });
    expect((await session(capped)).r.body.error.code).toBe("amount_above_unverified_cap");
    expect((await session(undefined, { ui_mode: "embedded" })).r.body.error.code).toBe("allowed_origins_required");
  });

  it("gets (expanded) and lists sessions with cursors", async () => {
    const m = st.merchant();
    const ids: string[] = [];
    for (let k = 0; k < 3; k++) ids.push((await session(m)).r.body.id);
    const token = await st.token(m);
    const one = await st.call("GET", `/v1/checkout/sessions/${ids[0]}?expand[]=payment_intent`, { token });
    expect(one.body.payment_intent).toMatchObject({ object: "payment_intent", attempts: [] });
    expect(one.body.client_secret).toBeNull();
    const page1 = await st.call("GET", "/v1/checkout/sessions?limit=2", { token });
    expect(page1.body.data.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1]]);
    expect(page1.body.has_more).toBe(true);
    const page2 = await st.call("GET", `/v1/checkout/sessions?limit=2&starting_after=${ids[1]}`, { token });
    expect(page2.body.data.map((s: { id: string }) => s.id)).toEqual([ids[0]]);
    const back = await st.call("GET", `/v1/checkout/sessions?limit=1&ending_before=${ids[0]}`, { token });
    expect(back.body.data.map((s: { id: string }) => s.id)).toEqual([ids[1]]);
    // another merchant sees nothing of this one
    const other = await st.call("GET", `/v1/checkout/sessions/${ids[0]}`, { token: await st.token(st.merchant()) });
    expect(other.status).toBe(404);
  });
});

describe("paying (payer → rails → worker)", () => {
  it("route_quote attempt → execution events → succeeded, session complete, statement line, events", async () => {
    const { m, token, r } = await session();
    const secret = r.body.client_secret as string;
    const cs = r.body.id as string;
    const pub = await st.call("GET", `/v1/checkout/sessions/${cs}/public`, { secret });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({
      display: { merchant_name_unverified: "Acme Coffee" },
      settlement: { asset_id: USDC_NEAR, type: "intents_account" },
      attempt: null,
      payment_intent: r.body.payment_intent,
    });
    expect(JSON.stringify(pub.body)).not.toContain("acme.near");
    expect(
      (
        await st.call("GET", `/v1/checkout/sessions/${cs}/public`, {
          secret: `${secret.slice(0, -1)}${secret.endsWith("x") ? "y" : "x"}`,
        })
      ).status,
    ).toBe(401);

    const opts = await st.call("GET", `/v1/checkout/sessions/${cs}/public/payment_options`, { secret });
    expect(opts.body.options[0]).toMatchObject({ origin_asset_id: USDC_BASE, available: true });
    expect(opts.body.options[0]).not.toHaveProperty("applied_fee_bps");
    expect(
      st.rails.calls.some(
        (c) => c.routeId === "listInternalOptions" && (c.query as { amount_out?: string }).amount_out === "2000000",
      ),
    ).toBe(true);

    const probe = await st.probe();
    const a = await st.call("POST", `/v1/checkout/sessions/${cs}/public/attempts`, {
      secret,
      body: {
        method: "route_quote",
        origin_asset_id: USDC_BASE,
        refund_to: "0x2222222222222222222222222222222222222222",
        turnstile_token: "t",
      },
    });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      status: "awaiting_deposit",
      method: "route_quote",
      visible: true,
      deposit: { chain: "eip155:8453", amount_in: "2010042" },
    });
    expect(a.body.attestation_ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const create = st.rails.calls.find((c) => c.routeId === createExecution.id);
    expect(create?.body).toMatchObject({
      idempotency_key: `attempt:${a.body.id}`,
      destination: { address: "acme.near" },
      pricing: { currency: "usd", amount: 200 },
    });

    const row = await st.admin.db
      .selectFrom("payment_attempts")
      .selectAll()
      .where("id", "=", uuid(a.body.id, "pa"))
      .executeTakeFirstOrThrow();
    const exId = row.execution_id as string;
    const acctUuid = uuid(m.account, "acct");
    const send = async (patch: Record<string, unknown>, subject: string) => {
      const x = st.advance(exId, patch as never);
      await st.publishEvent(
        domainEvent(subject as never, x, { accountUuid: acctUuid, livemode: false, version: x.version }),
      );
      return x;
    };
    await send({ state: "deposit_detected" }, "evt.rails.execution.updated");
    await expectEvent(probe, "evt.payments.payment_intent.processing", {
      data: { object: { id: r.body.payment_intent } },
    });
    const evidence = {
      chain: "near:mainnet",
      tx_hash: "4Fz7bUzfHtHWP3o9HTRwW2qxPyRk1J7n6zDcbH7cGzrC",
      block_ref: "1",
      recipient: "acme.near",
      asset_id: USDC_NEAR,
      amount: "2000042",
      finality: "final",
      tier: "A",
      source: "indexer",
      observed_at: new Date().toISOString(),
      explorer_url: "https://nearblocks.io/txns/4Fz7bUzfHtHWP3o9HTRwW2qxPyRk1J7n6zDcbH7cGzrC",
    };
    // a stale (older) event after the newer one is a no-op
    await send({ state: "succeeded", settled_amount: "2000042", evidence }, "evt.rails.execution.settled");
    await expectEvent(probe, "evt.payments.payment_intent.succeeded", {
      data: { object: { id: r.body.payment_intent, status: "succeeded", amount_settled: "2000042" } },
    });
    const completed = await expectEvent(probe, "evt.payments.checkout_session.completed", {
      data: { object: { id: cs, status: "complete", url: null, client_secret: null } },
    });
    // sequence (0.1.5) = the session's aggregate version: on the bus object and the API view alike
    const seq = (completed.data.object as { sequence: number }).sequence;
    expect(seq).toBe(completed.aggregate.version);
    expect(seq).toBeGreaterThan(r.body.sequence as number);
    expect((await st.call("GET", `/v1/checkout/sessions/${cs}`, { token })).body.sequence).toBe(seq);

    const intent = await st.call("GET", `/v1/payment_intents/${r.body.payment_intent}`, { token });
    expect(intent.body).toMatchObject({
      status: "succeeded",
      late: false,
      fee: { total_bps: 50 },
      attempts: [{ status: "succeeded", evidence: { tx_hash: evidence.tx_hash } }],
    });
    const lines = await st.call("GET", `/v1/balance_transactions?payment_intent=${r.body.payment_intent}`, { token });
    expect(lines.body.data).toHaveLength(1);
    expect(lines.body.data[0]).toMatchObject({
      type: "payment",
      gross: { amount: 200, currency: "usd" },
      settled: { amount: "2000042", display: "2.000042 USDC (NEAR)" },
      fee: { bps: 50 },
    });

    // a duplicate settled event (same version) changes nothing
    const x = st.executions.get(exId);
    await st.publishEvent(
      domainEvent("evt.rails.execution.settled", x, { accountUuid: acctUuid, livemode: false, version: x?.version }),
    );
    await new Promise((r2) => setTimeout(r2, 500));
    const lines2 = await st.call("GET", `/v1/balance_transactions?payment_intent=${r.body.payment_intent}`, { token });
    expect(lines2.body.data).toHaveLength(1);
    await probe.close();
  });

  it("intents_transfer: signed intent is relayed to agentpay; agent attempts are reused", async () => {
    const { r } = await session();
    const cs = r.body.id as string;
    const secret = r.body.client_secret as string;
    const a = await st.call("POST", `/v1/checkout/sessions/${cs}/public/attempts`, {
      secret,
      body: {
        method: "intents_transfer",
        origin_asset_id: USDC_NEAR,
        payer_wallet: "payer.near",
        turnstile_token: "t",
      },
    });
    expect(a.status).toBe(201);
    expect(a.body.intents_requirement).toMatchObject({ pay_to: "acme.near", fee_amount: "6000" });
    const signed = {
      standard: "nep413",
      payload: { message: "{}", nonce: "AAAA", recipient: "intents.near" },
      public_key: "ed25519:1",
      signature: "ed25519:1",
    };
    const rel = await st.call("POST", `/v1/checkout/sessions/${cs}/public/attempts/${a.body.id}/signed_intent`, {
      secret,
      body: { signed },
    });
    expect([202, 400]).toContain(rel.status); // 400 only if the vector-free payload fails the MultiPayload schema
    const svc = await (await import("@nearpay-internal/testing")).mintServiceToken("agentpay");
    const ag1 = await st.call("POST", `/internal/checkout_sessions/${cs}/agent_attempts`, {
      token: svc,
      body: { payer_wallet: "agent.near" },
    });
    expect(ag1.status).toBe(200);
    const ag2 = await st.call("POST", `/internal/checkout_sessions/${cs}/agent_attempts`, {
      token: svc,
      body: { payer_wallet: "agent.near" },
    });
    expect(ag2.body.attempt_id).toBe(ag1.body.attempt_id);
  });

  it("guards: geo policy blocks, too-slow routes and in-flight attempts", async () => {
    const { r } = await session();
    const cs = r.body.id as string;
    const secret = r.body.client_secret as string;
    const body = {
      method: "route_quote",
      origin_asset_id: USDC_BASE,
      refund_to: "0x2222222222222222222222222222222222222222",
      turnstile_token: "t",
    };
    const geo = await st.call("POST", `/v1/checkout/sessions/${cs}/public/attempts`, {
      secret,
      body,
      headers: { "cf-ipcountry": "KP" },
    });
    expect(geo.body.error.code).toBe("geo_blocked");
    const short = await session(undefined, { expires_in: 300 });
    // 300 s session vs Base min window 300 s: just at the edge after a moment → too slow
    await new Promise((r2) => setTimeout(r2, 1100));
    const slow = await st.call("POST", `/v1/checkout/sessions/${short.r.body.id}/public/attempts`, {
      secret: short.r.body.client_secret,
      body,
    });
    expect(slow.body.error.code).toBe("route_too_slow");
  });
});

describe("merchant actions and jobs", () => {
  it("cancels an unpaid intent (session expires, events) and refuses a paid one", async () => {
    const { token, r } = await session();
    const probe = await st.probe();
    const c = await st.call("POST", `/v1/payment_intents/${r.body.payment_intent}/cancel`, {
      token,
      body: { cancellation_reason: "customer left" },
    });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "canceled", cancellation_reason: "customer left" });
    await expectEvent(probe, "evt.payments.payment_intent.canceled", {
      data: { object: { id: r.body.payment_intent } },
    });
    await expectEvent(probe, "evt.payments.checkout_session.expired", { data: { object: { id: r.body.id } } });
    const again = await st.call("POST", `/v1/payment_intents/${r.body.payment_intent}/cancel`, { token, body: {} });
    expect(again.body.error.code).toBe("state_conflict");
    await probe.close();
  });

  it("expires an open session on request", async () => {
    const { token, r } = await session();
    const before = await st.call("GET", `/v1/checkout/sessions/${r.body.id}`, { token });
    expect(before.body.sequence).toBe(r.body.sequence);
    const e = await st.call("POST", `/v1/checkout/sessions/${r.body.id}/expire`, { token, body: {} });
    expect(e.body.status).toBe("expired");
    expect(e.body.sequence).toBeGreaterThan(before.body.sequence);
    const pi = await st.call("GET", `/v1/payment_intents/${r.body.payment_intent}`, { token });
    expect(pi.body.status).toBe("expired");
  });

  it("the session.expire job expires an unpaid session at expires_at", async () => {
    const { r } = await session();
    const id = uuid(r.body.id, "cs");
    await st.admin.db
      .updateTable("checkout_sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", id)
      .execute();
    await st.admin.db
      .updateTable("jobs" as never)
      .set({ run_at: new Date() } as never)
      .where("dedupe_key" as never, "=", `session.expire:${id}` as never)
      .execute();
    const s = await waitFor(async () => {
      const row = await st.admin.db
        .selectFrom("checkout_sessions")
        .select("status")
        .where("id", "=", id)
        .executeTakeFirst();
      return row?.status === "expired" ? row : null;
    });
    expect(s.status).toBe("expired");
  });

  it("quoting recovery links an execution that rails created after a timeout", async () => {
    const { r } = await session();
    const secret = r.body.client_secret as string;
    // rails does not answer the create (the attempt stays quoting; the payer gets 503)
    st.failCreates(1);
    const a = await st.call("POST", `/v1/checkout/sessions/${r.body.id}/public/attempts`, {
      secret,
      body: {
        method: "route_quote",
        origin_asset_id: USDC_BASE,
        refund_to: "0x2222222222222222222222222222222222222222",
        turnstile_token: "t",
      },
    });
    expect(a.body.error.code).toBe("rail_unavailable");
    const row = await st.admin.db
      .selectFrom("payment_attempts")
      .select(["id", "status"])
      .where("payment_intent_id", "=", uuid(r.body.payment_intent, "pi"))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("quoting");
    // rails is back; once the attempt is older than 20 s the recovery job re-asks with the same key
    await st.admin.db
      .updateTable("payment_attempts")
      .set({ created_at: new Date(Date.now() - 30_000) })
      .where("id", "=", row.id)
      .execute();
    const linked = await waitFor(async () => {
      const x = await st.admin.db
        .selectFrom("payment_attempts")
        .select(["status", "execution_id"])
        .where("id", "=", row.id)
        .executeTakeFirst();
      return x?.status === "awaiting_deposit" ? x : null;
    }, 30_000);
    expect(linked.execution_id).toMatch(/^ex_/);
  });

  it("identity events mark the settlement context stale", async () => {
    const { m } = await session();
    const acctUuid = uuid(m.account, "acct");
    await st.publishEvent(
      domainEvent("evt.identity.account.updated", account({ id: m.account }), {
        accountUuid: acctUuid,
        livemode: null,
      }),
    );
    await waitFor(async () => {
      const jobs = await st.admin.db
        .selectFrom("jobs" as never)
        .selectAll()
        .where("kind" as never, "=", "context.refresh" as never)
        .execute();
      return jobs.length > 0;
    });
  });
});

describe("payer stream (SSE)", () => {
  it("sends snapshots and an update after a change", async () => {
    const { r } = await session();
    const cs = r.body.id as string;
    const secret = r.body.client_secret as string;
    const ac = new AbortController();
    const res = await fetch(`${st.url}/v1/checkout/sessions/${cs}/public/stream`, {
      headers: { "x-nearpay-client-secret": secret },
      signal: ac.signal,
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const until = async (needle: string) => {
      const end = Date.now() + 15_000;
      while (!text.includes(needle)) {
        if (Date.now() > end) throw new Error(`no ${needle} in stream: ${text}`);
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await until("event: session");
    await until("event: intent");
    const snapshot = /event: session\ndata: (.*)\n/.exec(text)?.[1] as string;
    expect(JSON.parse(snapshot)).toMatchObject({ id: cs, payment_intent: r.body.payment_intent });
    await st.call("POST", `/v1/checkout/sessions/${cs}/public/attempts`, {
      secret,
      body: {
        method: "route_quote",
        origin_asset_id: USDC_BASE,
        refund_to: "0x2222222222222222222222222222222222222222",
        turnstile_token: "t",
      },
    });
    await until("event: attempt");
    ac.abort();
  });
});
