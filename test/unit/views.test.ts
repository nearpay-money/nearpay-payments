/** Spec 0.1.5 view fields: the public session's `payment_intent` and the checkout session's `sequence`. */

import { fromUuid } from "@nearpay-internal/ids";
import { CheckoutSession, PublicCheckoutSession } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { publicSession, sessionView } from "../../src/app/views.js";
import { intentRow, sessionRow } from "../support/rows.js";

describe("public checkout session (payer read and SSE `session` event)", () => {
  it("carries the id of its payment intent", () => {
    const i = intentRow({ status: "requires_payment" });
    const s = sessionRow(i, { status: "open", completed_at: null });
    const pub = publicSession(s, i, "Acme Coffee", null);
    expect(pub.payment_intent).toBe(fromUuid("pi", i.id));
    expect(PublicCheckoutSession.parse(pub).payment_intent).toMatch(/^pi_/);
  });

  it("names the session's own intent, not another one", () => {
    const a = intentRow();
    const b = intentRow();
    expect(publicSession(sessionRow(a), a, "Acme", null).payment_intent).not.toBe(fromUuid("pi", b.id));
  });
});

describe("checkout session sequence", () => {
  it("is the session's aggregate version, on the API view and the bus object alike", () => {
    const i = intentRow();
    const s = sessionRow(i, { version: 7 });
    expect(sessionView(s, i).sequence).toBe(7);
    expect(sessionView(s, i, { expand: { attempts: [] }, secret: "x", url: "https://p/c" }).sequence).toBe(7);
  });

  it("increases with every change (each updateSession bumps the version)", () => {
    const i = intentRow({ status: "requires_payment" });
    // created → live attempt counted → expiring → complete, as the ledger writes them
    const states = [
      sessionRow(i, { status: "open", completed_at: null, version: 1 }),
      sessionRow(i, { status: "open", completed_at: null, live_attempts_count: 1, version: 2 }),
      sessionRow(i, { status: "expiring", completed_at: null, live_attempts_count: 1, version: 3 }),
      sessionRow(i, { status: "complete", live_attempts_count: 1, version: 4 }),
    ];
    const seq = states.map((s) => CheckoutSession.parse(sessionView(s, i)).sequence as number);
    for (let k = 1; k < seq.length; k++) expect(seq[k]).toBeGreaterThan(seq[k - 1] as number);
  });

  it("does not follow the intent's version (the intent has its own sequence)", () => {
    const i = intentRow({ version: 9, sequence: 9 });
    const s = sessionRow(i, { version: 2 });
    const v = sessionView(s, i, { expand: { attempts: [] } });
    expect(v.sequence).toBe(2);
    expect((v.payment_intent as { sequence: number }).sequence).toBe(9);
  });
});
