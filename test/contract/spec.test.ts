/**
 * Contract (foundations §16): every Stage-1 payments route is bound (and nothing else); every subject
 * the catalogue routes to payments is handled; every subject payments produces is emitted; the objects
 * payments emits and serves parse with the spec schemas.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BalanceTransaction,
  CheckoutSession,
  CreatedPaymentIntent,
  Customer,
  PayerAttempt,
  PaymentIntent,
  PaymentLink,
  PUBLIC_ROUTES,
  PublicCheckoutSession,
  Refund,
  streamCheckoutSession,
  TestHelperPayment,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  createInvoiceCheckoutSession,
  getInternalCheckoutSession,
  INTERNAL_ROUTES,
  InternalCustomer,
  ReconciliationRun,
  SUBJECTS,
  type Subject,
} from "@nearpay-internal/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { paymentsRoutes } from "../../src/api/routes.js";
import {
  customerView,
  intentView,
  lineView,
  linkView,
  payerAttempt,
  publicSession,
  refundView,
  runView,
  sessionView,
} from "../../src/app/views.js";
import { paymentsHandlers } from "../../src/consumers/handlers.js";
import {
  attemptRow,
  evidence,
  intentRow,
  legRow,
  refundRow,
  sessionRow,
  signIntentNextAction,
} from "../support/rows.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage-1, Stage-2 and Stage-3 payments route (incl. /ops console routes), and nothing else", () => {
    const bindings = paymentsRoutes({} as never);
    expect(unimplementedRoutes("payments", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      [...new Map(ALL.map((r) => [r.id, r])).values()]
        .filter((r) => r.service === "payments" && r.stage <= 3)
        .map((r) => r.id)
        .sort(),
    );
  });

  it("handles every subject the catalogue routes to payments", () => {
    const handlers = paymentsHandlers({} as never, {} as never);
    expect(unhandledSubjects("payments", handlers)).toEqual([]);
    for (const subject of Object.keys(handlers) as Subject[]) expect(SUBJECTS[subject].consumers).toContain("payments");
  });

  it("emits every subject payments produces", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "payments" && SUBJECTS[k].stage <= 3,
    );
    expect(produced.length).toBe(17);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
  });
});

// ---- objects: rows as the database returns them → views → spec schemas (0.1.5)
describe("objects", () => {
  it("payment intents (events and API) parse, including overpayments and asset pricing", () => {
    const i = intentRow();
    const paid = attemptRow(i, { status: "succeeded", settled_amount: "2000042" });
    const extra = attemptRow(i, {
      status: "succeeded",
      settled_amount: "5",
      is_overpayment: true,
      overpayment_reason: "duplicate",
    });
    const v = intentView({ ...i, succeeded_attempt_id: paid.id }, [paid, extra], uuidv7());
    expect(PaymentIntent.parse(v).overpayments).toHaveLength(1);
    for (const s of ["evt.payments.payment_intent.succeeded", "evt.payments.payment_intent.overpaid"] as const)
      expect(SUBJECTS[s].object.safeParse(v).success).toBe(true);
    const asset = intentRow({
      currency: "asset",
      amount: null,
      pricing_asset_id: USDC_NEAR,
      pricing_asset_amount: "2000000",
    });
    expect(PaymentIntent.parse(intentView(asset, [], null))).toMatchObject({
      currency: "asset",
      amount: "2000000",
      asset_id: USDC_NEAR,
    });
  });

  it("checkout sessions parse; on the bus they carry no secret or URL", () => {
    const i = intentRow();
    const s = sessionRow(i);
    const bus = sessionView(s, i);
    expect(SUBJECTS["evt.payments.checkout_session.completed"].object.safeParse(bus).success).toBe(true);
    expect(bus.client_secret).toBeNull();
    // 0.1.5: optional in the schema for 0.1.4 readers, but servers MUST send it
    expect(CheckoutSession.parse(bus).sequence).toBe(s.version);
    expect(SUBJECTS["evt.payments.checkout_session.expired"].object.parse(bus)).toHaveProperty("sequence", s.version);
    const created = sessionView(s, i, {
      secret: `${fromUuid("cs", s.id)}_secret_${"a".repeat(32)}`,
      url: "https://pay.nearpay.localhost/c/x#y",
      expand: { attempts: [] },
    });
    expect(CheckoutSession.safeParse(created).success).toBe(true);
  });

  it("payer views parse and never carry the raw destination address", () => {
    const i = intentRow({ status: "requires_payment" });
    const a = payerAttempt(attemptRow(i), "abc.def");
    expect(PayerAttempt.safeParse(a).success).toBe(true);
    const pub = publicSession(sessionRow(i, { status: "open", completed_at: null }), i, "Acme Coffee", a);
    expect(PublicCheckoutSession.safeParse(pub).success).toBe(true);
    // 0.1.5: the public session (also the SSE `session` event) names its payment intent
    const sessionEvent = streamCheckoutSession.stream?.events.session as typeof PublicCheckoutSession;
    expect(sessionEvent).toBe(PublicCheckoutSession);
    expect(sessionEvent.parse(pub).payment_intent).toBe(fromUuid("pi", i.id));
    const { payment_intent: _, ...pre015 } = pub;
    expect(PublicCheckoutSession.safeParse(pre015).success).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("acme.near");
  });

  it("spec 0.2.1 payer fields: deposit fee, amount received, pricing asset, attempt summary", () => {
    const i = intentRow({
      status: "processing",
      currency: "asset",
      amount: null,
      pricing_asset_id: USDC_NEAR,
      pricing_asset_amount: "2000000",
    });
    const row = attemptRow(i, { status: "deposit_detected", deposited_amount: "2000000" });
    const d = row.deposit as NonNullable<typeof row.deposit>;
    const a = payerAttempt({ ...row, deposit: { ...d, fee_amount: "10042" } }, "abc.def");
    expect(PayerAttempt.parse(a)).toMatchObject({ amount_received: "2000000", deposit: { fee_amount: "10042" } });
    // a deposit stored before 0.2.1 has no fee: null (unknown)
    expect(PayerAttempt.parse(payerAttempt(row, null)).deposit?.fee_amount).toBeNull();
    const pub = publicSession(sessionRow(i, { status: "open", completed_at: null }), i, "Acme Coffee", a, {
      asset_id: USDC_NEAR,
      symbol: "USDC",
      decimals: 6,
    });
    expect(PublicCheckoutSession.parse(pub).pricing_asset).toEqual({
      asset_id: USDC_NEAR,
      symbol: "USDC",
      decimals: 6,
    });
    const fiat = publicSession(sessionRow(i), intentRow(), "Acme Coffee", null, null);
    expect(PublicCheckoutSession.parse(fiat).pricing_asset).toBeNull();
    // unknown (rails down): omitted
    expect(publicSession(sessionRow(i), i, "Acme Coffee", null)).not.toHaveProperty("pricing_asset");
    const v = PaymentIntent.parse(intentView(i, [row], null));
    expect(v.attempts[0]).toMatchObject({ origin_amount: "2000000", refund_to: row.refund_to });
  });
});

// ---- stage 2 objects (spec 0.2.0)
describe("stage 2 objects", () => {
  const i = intentRow({ customer_id: uuidv7(), payment_link_id: uuidv7() });
  const paid = attemptRow(i, { status: "succeeded", settled_amount: "2000042" });

  it("payment intents carry customer, link, refunds, pending refunds, review decision and fingerprint", () => {
    const refundId = uuidv7();
    const v = intentView(
      {
        ...i,
        succeeded_attempt_id: paid.id,
        amount_refund_pending: "100",
        review_decision: {
          decision: "reject",
          decided_at: new Date().toISOString(),
          refund: refundId,
          reason: null,
          actor: "usr_x",
        },
        destination_snapshot: { ...i.destination_snapshot, fingerprint: "7KQ2-M9XA-31" },
      },
      [paid],
      uuidv7(),
      [{ id: refundId, created_at: new Date() }],
    );
    const parsed = PaymentIntent.parse(v);
    expect(parsed).toMatchObject({ amount_refund_pending: "100", refunds: [fromUuid("re", refundId)] });
    expect(parsed.destination.fingerprint).toBe("7KQ2-M9XA-31");
    expect(parsed.review_decision?.refund).toBe(fromUuid("re", refundId));
    expect(
      CreatedPaymentIntent.safeParse({
        ...v,
        checkout_session: fromUuid("cs", uuidv7()),
        client_secret: `cs_${"0".repeat(26)}_secret_${"a".repeat(32)}`,
      }).success,
    ).toBe(true);
    // Stage 1 snapshots (no fingerprint) stay valid
    expect(PaymentIntent.safeParse(intentView(intentRow(), [], null)).success).toBe(true);
  });

  it("refunds (API and every refund event) parse, with next actions of both kinds", () => {
    const r = refundRow(i, paid);
    const legs = [legRow(r, { number: 1, status: "expired", next_action: null }), legRow(r, { number: 2 })];
    const v = refundView(
      { ...r, current_leg_id: legs[1]?.id as string },
      legs,
      { id: USDC_NEAR, decimals: 6 },
      Date.now(),
    );
    expect(Refund.parse(v).next_action?.type).toBe("sign_and_send");
    expect(v.legs.map((l) => l.number)).toEqual([2, 1]);
    for (const s of Object.keys(SUBJECTS).filter((k) => k.startsWith("evt.payments.refund.")) as Subject[])
      expect(SUBJECTS[s].object.safeParse(v).success).toBe(true);
    const intents = legRow(r, { number: 3, next_action: signIntentNextAction() });
    const w = refundView(
      { ...r, current_leg_id: intents.id },
      [intents, legRow(r, { status: "preparing", deadline: null })],
      { id: USDC_NEAR, decimals: 6 },
      Date.now(),
    );
    expect(Refund.parse(w).next_action?.type).toBe("sign_intent");
    expect(w.legs).toHaveLength(1); // a leg being prepared is not shown
    // a leg being relayed (`submitting`): hidden from merchants, still shown to agentpay's relay check
    const relayed = { ...intents, status: "submitting" } as typeof intents;
    const at = (o?: { relaying: boolean }) =>
      refundView({ ...r, current_leg_id: intents.id }, [relayed], { id: USDC_NEAR, decimals: 6 }, Date.now(), o);
    expect(at().next_action).toBeNull();
    expect(at({ relaying: true }).next_action?.type).toBe("sign_intent");
    expect(
      refundView(
        { ...r, status: "pending", current_leg_id: intents.id },
        [relayed],
        { id: USDC_NEAR, decimals: 6 },
        Date.now(),
        { relaying: true },
      ).next_action,
    ).toBeNull();
    // past the deadline / not requires_action: no next action
    expect(
      refundView(
        { ...r, status: "pending", current_leg_id: intents.id },
        [intents],
        { id: USDC_NEAR, decimals: 6 },
        Date.now(),
      ).next_action,
    ).toBeNull();
  });

  it("links, customers, statement lines and reconciliation runs parse", () => {
    const now = new Date();
    const link = linkView(
      {
        id: uuidv7(),
        account_id: i.account_id,
        livemode: false,
        active: true,
        amount: "500",
        currency: "usd",
        pricing_asset_id: null,
        pricing_asset_amount: null,
        description: "Tea",
        name: "Tea counter",
        settlement_destination_id: null,
        success_url: null,
        max_uses: 3,
        uses: 1,
        session_expires_in: 3600,
        collect_email: true,
        metadata: {},
        created_at: now,
        updated_at: now,
        version: 1,
      },
      "https://pay.nearpay.localhost",
    );
    expect(PaymentLink.parse(link)).toMatchObject({
      url: `https://pay.nearpay.localhost/l/${link.id}`,
      name: "Tea counter",
    });
    const cus = customerView(
      {
        id: uuidv7(),
        account_id: i.account_id,
        livemode: false,
        email_hash: null,
        email_enc: null,
        name_enc: null,
        description: null,
        wallets: [{ chain: "near:mainnet", address: "a.near" }],
        metadata: {},
        deleted_at: null,
        last_payment_at: now,
        created_at: now,
        updated_at: now,
        version: 1,
      },
      { email: "ann@example.com", name: "Ann" },
      [
        {
          customer_id: uuidv7(),
          account_id: i.account_id,
          livemode: false,
          currency: "usd",
          asset_id: "",
          amount: "12345",
          count: 2,
          updated_at: now,
        },
        {
          customer_id: uuidv7(),
          account_id: i.account_id,
          livemode: false,
          currency: "asset",
          asset_id: USDC_NEAR,
          amount: "123456789012345678901234567890",
          count: 1,
          updated_at: now,
        },
      ],
    );
    expect(Customer.parse(cus)).toMatchObject({
      total_paid: [
        { currency: "asset", asset_id: USDC_NEAR, amount: "123456789012345678901234567890", count: 1 },
        { currency: "usd", asset_id: null, amount: 12345, count: 2 },
      ],
      last_payment_at: Math.floor(now.getTime() / 1000),
    });
    const line = lineView({
      id: uuidv7(),
      account_id: i.account_id,
      livemode: false,
      type: "refund",
      payment_intent_id: i.id,
      refund_id: uuidv7(),
      payment_attempt_id: null,
      gross_amount: null,
      gross_currency: null,
      settled_amount: "100",
      settlement_asset_id: USDC_NEAR,
      settlement_decimals: 6,
      settlement_symbol: "USDC",
      fee_bps: null,
      fee_amount_est: null,
      fee_asset_id: null,
      evidence: evidence(),
      refund_leg: 2,
      received: { amount: "99", asset_id: USDC_NEAR, chain: "near:mainnet" },
      fee_adjustment: null,
      execution_id: null,
      terminal_at: null,
      created_at: now,
    });
    expect(BalanceTransaction.parse(line)).toMatchObject({ refund_leg: 2, received: { amount: "99" } });
    const run = runView(
      {
        id: uuidv7(),
        account_id: i.account_id,
        livemode: false,
        day: new Date(2026, 10, 7) as never,
        status: "diff",
        trigger: "schedule",
        rerun_of: null,
        totals: [
          {
            asset_id: USDC_NEAR,
            decimals: 6,
            inflow: { statement: "1", evidence: "0", statement_lines: 1, executions: 0 },
            outflow: { statement: "0", evidence: "0", statement_lines: 0, executions: 0 },
            fees: { expected: "0", observed: null },
          },
        ],
        diffs: [
          {
            kind: "missing_evidence",
            asset_id: USDC_NEAR,
            execution_id: null,
            balance_transaction: null,
            payment_intent: null,
            refund: null,
            statement_amount: "1",
            evidence_amount: null,
            detail: "x",
          },
        ],
        error: null,
        resolution: null,
        case_id: null,
        created_by: "system",
        started_at: now,
        completed_at: now,
      },
      "Acme Coffee",
    );
    expect(ReconciliationRun.parse(run)).toMatchObject({
      day: "2026-11-07",
      diff_count: 1,
      account_display_name: "Acme Coffee",
      totals: [{ decimals: 6 }],
    });
  });
});

// ---- stage 3 objects (spec 0.3.0)
describe("stage 3 objects", () => {
  const invoice = uuidv7();
  const i = intentRow({ source: "invoice", invoice_id: invoice, customer_id: uuidv7() });
  const s = sessionRow(i, { status: "open", completed_at: null, invoice_id: invoice, customer_id: i.customer_id });

  it("invoice intents and sessions carry `invoice` in the API and on every event billing consumes", () => {
    const v = intentView(i, [], s.id);
    expect(PaymentIntent.parse(v).invoice).toBe(fromUuid("in", invoice));
    for (const sub of [
      "evt.payments.payment_intent.succeeded",
      "evt.payments.payment_intent.payment_failed",
      "evt.payments.payment_intent.expired",
    ] as const)
      expect(SUBJECTS[sub].object.parse(v)).toHaveProperty("invoice", fromUuid("in", invoice));
    const bus = sessionView(s, i);
    expect(SUBJECTS["evt.payments.checkout_session.expired"].object.parse(bus)).toHaveProperty(
      "invoice",
      fromUuid("in", invoice),
    );
    // the internal create returns the secret and URL once; the internal read never does
    const created = sessionView(s, i, {
      secret: `${fromUuid("cs", s.id)}_secret_${"a".repeat(32)}`,
      url: "https://pay.nearpay.localhost/c/x#y",
    });
    expect(createInvoiceCheckoutSession.response.parse(created)).toMatchObject({ invoice: fromUuid("in", invoice) });
    expect(getInternalCheckoutSession.response.parse(bus)).toMatchObject({ client_secret: null, url: null });
    // other sources: null (servers from 0.3.0 always send it)
    expect(PaymentIntent.parse(intentView(intentRow(), [], null)).invoice).toBeNull();
    expect(CheckoutSession.parse(sessionView(sessionRow(intentRow()), intentRow())).invoice).toBeNull();
  });

  it("the test-helper payment and the internal customer parse", () => {
    expect(
      TestHelperPayment.safeParse({
        object: "test_helper_payment",
        checkout_session: fromUuid("cs", s.id),
        payment_intent: fromUuid("pi", i.id),
        payment_attempt: fromUuid("pa", uuidv7()),
        outcome: "succeeded",
      }).success,
    ).toBe(true);
    const now = new Date();
    const c = customerView(
      {
        id: uuidv7(),
        account_id: i.account_id,
        livemode: false,
        email_hash: null,
        email_enc: null,
        name_enc: null,
        description: null,
        wallets: [],
        metadata: {},
        deleted_at: now,
        last_payment_at: null,
        created_at: now,
        updated_at: now,
        version: 2,
      },
      { email: null, name: null },
    );
    expect(InternalCustomer.parse({ ...c, account_id: fromUuid("acct", i.account_id), deleted: true })).toMatchObject({
      deleted: true,
      email: null,
    });
  });
});
