/**
 * Contract (foundations §16): every Stage-1 payments route is bound (and nothing else); every subject
 * the catalogue routes to payments is handled; every subject payments produces is emitted; the objects
 * payments emits and serves parse with the spec schemas.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CheckoutSession,
  PayerAttempt,
  PaymentIntent,
  PUBLIC_ROUTES,
  PublicCheckoutSession,
  streamCheckoutSession,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import { INTERNAL_ROUTES, SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { paymentsRoutes } from "../../src/api/routes.js";
import { intentView, payerAttempt, publicSession, sessionView } from "../../src/app/views.js";
import { paymentsHandlers } from "../../src/consumers/handlers.js";
import { attemptRow, intentRow, sessionRow } from "../support/rows.js";

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
});
