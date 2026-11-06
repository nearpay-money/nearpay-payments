/**
 * Contract (foundations §16): every Stage-1 payments route is bound (and nothing else); every subject
 * the catalogue routes to payments is handled; every subject payments produces is emitted; the objects
 * payments emits and serves parse with the spec schemas.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CheckoutSession, PayerAttempt, PaymentIntent, PUBLIC_ROUTES, PublicCheckoutSession } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import { INTERNAL_ROUTES, SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { paymentsRoutes } from "../../src/api/routes.js";
import {
  type AttemptRow,
  type IntentRow,
  intentView,
  payerAttempt,
  publicSession,
  type SessionRow,
  sessionView,
} from "../../src/app/views.js";
import { paymentsHandlers } from "../../src/consumers/handlers.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage-1 payments route, and nothing else", () => {
    const bindings = paymentsRoutes({} as never);
    expect(unimplementedRoutes("payments", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "payments" && r.stage <= 1)
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
      (k) => SUBJECTS[k].producer === "payments" && SUBJECTS[k].stage <= 1,
    );
    expect(produced.length).toBe(10);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
  });
});

// ---- objects: rows as the database returns them → views → spec schemas
const now = new Date();
const intentRow = (o: Partial<IntentRow> = {}): IntentRow => ({
  id: uuidv7(),
  account_id: uuidv7(),
  livemode: false,
  status: "succeeded",
  amount: "200",
  currency: "usd",
  pricing_asset_id: null,
  pricing_asset_amount: null,
  description: "Flat white",
  customer_id: null,
  source: "checkout",
  invoice_id: null,
  payment_link_id: null,
  destination_snapshot: {
    sd_id: fromUuid("sd", uuidv7()),
    asset_id: USDC_NEAR,
    type: "intents_account",
    chain: "near:mainnet",
    address: "acme.near",
    address_norm: "acme.near",
    attestation_hash: null,
    verification: "test",
    per_payment_cap_usd_micros: null,
  },
  fee_snapshot: { schedule: {} as never, bearer: "payer" },
  settings_snapshot: { late_payments: false, underpay_tolerance_bps: 0 },
  settlement_asset_id: USDC_NEAR,
  settlement_decimals: 6,
  settlement_symbol: "USDC",
  amount_settled: "2000042",
  amount_refunded: "0",
  amount_refund_pending: "0",
  succeeded_attempt_id: null,
  succeeded_at: now,
  late: false,
  canceled_at: null,
  cancellation_reason: null,
  review_reason: null,
  compliance_review: null,
  metadata: { order: "42" },
  sequence: 3,
  created_at: now,
  updated_at: now,
  version: 3,
  ...o,
});
const attemptRow = (intent: IntentRow, o: Partial<AttemptRow> = {}): AttemptRow => ({
  id: uuidv7(),
  payment_intent_id: intent.id,
  account_id: intent.account_id,
  livemode: false,
  method: "route_quote",
  status: "awaiting_deposit",
  visible: true,
  origin_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  origin_chain: "eip155:8453",
  refund_to: "0x2222222222222222222222222222222222222222",
  refund_type: "origin_chain",
  payer_wallet: null,
  payer_ip_country: null,
  agent: false,
  execution_id: `ex_${"0".repeat(26)}`,
  execution_version: 1,
  applied_fee_bps: 50,
  route_class: "stable_pair",
  settlement_amount: "2000042",
  amount_tag: "42",
  price_snapshot: null,
  deposit: {
    address: "0x1111111111111111111111111111111111111111",
    memo: null,
    amount_in: "2010042",
    min_amount_in: "2010042",
    deadline: new Date(Date.now() + 600_000).toISOString(),
    chain: "eip155:8453",
  },
  intents_requirement: null,
  deadline: new Date(Date.now() + 600_000),
  settled_amount: null,
  refunded_amount: null,
  evidence: null,
  failure_code: null,
  is_overpayment: false,
  overpayment_reason: null,
  created_at: now,
  updated_at: now,
  version: 1,
  ...o,
});
const sessionRow = (intent: IntentRow, o: Partial<SessionRow> = {}): SessionRow => ({
  id: uuidv7(),
  account_id: intent.account_id,
  livemode: false,
  payment_intent_id: intent.id,
  status: "complete",
  client_secret_hash: Buffer.alloc(32),
  ui_mode: "hosted",
  success_url: "https://shop.example/thanks",
  cancel_url: null,
  expires_at: now,
  customer_email_enc: null,
  locale: null,
  allowed_origins: [],
  completed_at: now,
  late: false,
  live_attempts_count: 0,
  metadata: {},
  created_at: now,
  updated_at: now,
  version: 2,
  ...o,
});

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
    expect(JSON.stringify(pub)).not.toContain("acme.near");
  });
});
