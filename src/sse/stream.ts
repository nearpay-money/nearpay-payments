/**
 * Payer live status (lld/payments.md §6.2, FR-PAY-06): `GET …/public/stream` as server-sent events.
 * Opens with full `session`, `attempt` and `intent` snapshots, then sends whichever changed when the
 * session's notifier channel fires (Valkey `cs:<uuid>`, published after each commit) and on a
 * periodic re-check, so a lost notification only delays an update. Heartbeats and `retry:` come from
 * the route's stream definition.
 */

import type { RequestContext } from "@nearpay-internal/service";
import type { streamCheckoutSession } from "@nearpay-money/spec";
import { payerSession } from "../app/attempts.js";
import type { Payments } from "../app/context.js";
import { publicSnapshot } from "../app/payer.js";
import { type IntentRow, intentStreamEvent, type SessionRow } from "../app/views.js";

/** Re-check period without notifications. */
export const RECHECK_MS = 5_000;

/** Attempt snapshots without the per-call ticket, for change detection (a ticket is re-signed each time). */
const key = (v: unknown) => JSON.stringify(v, (k, x) => (k === "attestation_ticket" ? undefined : x));

export async function openStream(
  p: Payments,
  ctx: RequestContext<typeof streamCheckoutSession>,
  o: { recheckMs?: number } = {},
): Promise<void> {
  const sessionId = ctx.params.id;
  const secret = ctx.headers["x-nearpay-client-secret"];
  const { s } = await payerSession(p, sessionId, typeof secret === "string" ? secret : undefined);
  const sse = ctx.sse();
  const last: Record<"session" | "attempt" | "intent", string | null> = { session: null, attempt: null, intent: null };
  let running = false;
  let again = false;

  const load = async (): Promise<{ s: SessionRow; i: IntentRow }> => {
    const s2 = await p.db.selectFrom("checkout_sessions").selectAll().where("id", "=", s.id).executeTakeFirstOrThrow();
    const i2 = await p.db
      .selectFrom("payment_intents")
      .selectAll()
      .where("id", "=", s2.payment_intent_id)
      .executeTakeFirstOrThrow();
    return { s: s2, i: i2 };
  };

  const push = async (): Promise<void> => {
    if (sse.closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const cur = await load();
        const snap = await publicSnapshot(p, cur.s, cur.i);
        const attempt = snap.session.attempt ?? null;
        const intent = intentStreamEvent(cur.i);
        const k = { session: key(snap.session), attempt: key(attempt), intent: key(intent) };
        if (k.session !== last.session) sse.send("session", snap.session);
        if (attempt && k.attempt !== last.attempt) sse.send("attempt", attempt);
        if (k.intent !== last.intent) sse.send("intent", intent);
        last.session = k.session;
        last.attempt = k.attempt;
        last.intent = k.intent;
      } while (again && !sse.closed);
    } catch (e) {
      p.log.warn({ session: s.id, err: e instanceof Error ? e.message : String(e) }, "stream update failed");
    } finally {
      running = false;
    }
  };

  const unsubscribe = p.notifier.subscribe(s.id, () => {
    void push();
  });
  const timer = setInterval(() => void push(), o.recheckMs ?? RECHECK_MS);
  timer.unref();
  sse.onClose(() => {
    clearInterval(timer);
    unsubscribe();
  });
  await push();
}
