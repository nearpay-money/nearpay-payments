/**
 * Row → API object mapping (spec `PaymentIntent`, `CheckoutSession`, `PayerAttempt`,
 * `PublicCheckoutSession`, `BalanceTransaction`). The payer views never carry the raw destination
 * address or PII (§12).
 */
import type {
  BalanceTransaction,
  CheckoutSession,
  IntentStreamEvent,
  PayerAttempt,
  PaymentIntent,
  PublicCheckoutSession,
} from "@nearpay/spec";
import { getChain } from "@nearpay-internal/chains";
import type { Selectable } from "@nearpay-internal/db";
import { fromUuid } from "@nearpay-internal/ids";
import { formatUnits } from "@nearpay-internal/money";
import type { z } from "zod";
import type {
  BalanceTransactionsTable,
  CheckoutSessionsTable,
  PaymentAttemptsTable,
  PaymentIntentsTable,
} from "../infra/db/schema.js";

export type IntentRow = Selectable<PaymentIntentsTable>;
export type SessionRow = Selectable<CheckoutSessionsTable>;
export type AttemptRow = Selectable<PaymentAttemptsTable>;
export type LineRow = Selectable<BalanceTransactionsTable>;

type Intent = z.input<typeof PaymentIntent>;
type Session = z.input<typeof CheckoutSession>;

export const unix = (d: Date): number => Math.floor(d.getTime() / 1000);
const unixOrNull = (d: Date | null): number | null => (d ? unix(d) : null);

/** `25.00 USDC (Base)` (api-conventions §3). */
export function settlementValue(amount: string, assetId: string, decimals: number, symbol: string, chain: string) {
  const name = getChain(chain)?.name ?? chain;
  return {
    amount,
    asset_id: assetId,
    decimals,
    display: `${formatUnits(BigInt(amount), decimals, 2)} ${symbol} (${name})`,
  };
}

export function pricingOf(i: IntentRow): { amount: number | string; currency: string; asset_id: string | null } {
  return i.currency === "asset"
    ? { amount: i.pricing_asset_amount as string, currency: "asset", asset_id: i.pricing_asset_id }
    : { amount: Number(i.amount), currency: i.currency, asset_id: null };
}

export function attemptSummary(a: AttemptRow) {
  return {
    id: fromUuid("pa", a.id),
    object: "payment_attempt" as const,
    created: unix(a.created_at),
    status: a.status,
    method: a.method,
    origin_asset_id: a.origin_asset_id,
    origin_chain: a.origin_chain,
    settlement_amount: a.settlement_amount,
    settled_amount: a.settled_amount,
    deadline: unixOrNull(a.deadline),
    is_overpayment: a.is_overpayment,
    failure_code: a.failure_code,
    evidence: (a.evidence as Intent["attempts"][number]["evidence"]) ?? null,
  };
}

/** Attempts newest first (the order the API documents). */
export const newestFirst = (attempts: readonly AttemptRow[]) =>
  [...attempts].sort((x, y) => y.created_at.getTime() - x.created_at.getTime() || (x.id < y.id ? 1 : -1));

export function intentView(i: IntentRow, attempts: readonly AttemptRow[], sessionUuid: string | null): Intent {
  const d = i.destination_snapshot;
  const sorted = newestFirst(attempts);
  const priced = sorted.find((a) => a.id === i.succeeded_attempt_id) ?? sorted.find((a) => a.applied_fee_bps !== null);
  return {
    id: fromUuid("pi", i.id),
    object: "payment_intent",
    created: unix(i.created_at),
    livemode: i.livemode,
    status: i.status,
    ...pricingOf(i),
    description: i.description,
    source: i.source,
    checkout_session: sessionUuid ? fromUuid("cs", sessionUuid) : null,
    destination: {
      settlement_destination: d.sd_id as `sd_${string}`,
      asset_id: d.asset_id,
      type: d.type,
      chain: d.chain,
      address: d.address,
    },
    // the fee of the route that paid (or was last quoted); 0 until a route is quoted
    fee: { bearer: i.fee_snapshot.bearer, total_bps: priced?.applied_fee_bps ?? 0 },
    settlement_asset_id: i.settlement_asset_id,
    amount_settled: i.amount_settled,
    amount_refunded: i.amount_refunded,
    succeeded_at: unixOrNull(i.succeeded_at),
    late: i.late,
    canceled_at: unixOrNull(i.canceled_at),
    cancellation_reason: i.cancellation_reason,
    review_reason: i.review_reason,
    attempts: sorted.map(attemptSummary),
    overpayments: sorted
      .filter((a) => a.is_overpayment)
      .map((a) => ({
        attempt: fromUuid("pa", a.id),
        amount: a.settled_amount ?? "0",
        reason: a.overpayment_reason ?? "duplicate",
      })),
    sequence: i.sequence,
    metadata: i.metadata,
  } as Intent;
}

export function sessionView(
  s: SessionRow,
  i: IntentRow,
  o: { expand?: { attempts: readonly AttemptRow[] }; secret?: string; url?: string } = {},
): Session {
  return {
    id: fromUuid("cs", s.id),
    object: "checkout_session",
    created: unix(s.created_at),
    livemode: s.livemode,
    status: s.status,
    url: o.url ?? null,
    client_secret: o.secret ?? null,
    expires_at: unix(s.expires_at),
    payment_intent: o.expand ? (intentView(i, o.expand.attempts, s.id) as never) : fromUuid("pi", i.id),
    ...pricingOf(i),
    settlement_destination: i.destination_snapshot.sd_id as `sd_${string}`,
    ui_mode: s.ui_mode,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    description: i.description,
    allowed_origins: s.allowed_origins,
    late_payments: i.settings_snapshot.late_payments,
    locale: s.locale,
    completed_at: unixOrNull(s.completed_at),
    late: s.late,
    metadata: s.metadata,
  } as Session;
}

export function payerAttempt(a: AttemptRow, ticket: string | null): z.input<typeof PayerAttempt> {
  const d = a.deposit;
  return {
    id: fromUuid("pa", a.id),
    object: "payment_attempt",
    livemode: a.livemode,
    status: a.status as z.input<typeof PayerAttempt>["status"],
    method: a.method,
    visible: a.visible,
    origin_asset_id: a.origin_asset_id,
    deposit: d ? { ...d, origin_asset_id: a.origin_asset_id } : null,
    intents_requirement: a.intents_requirement as z.input<typeof PayerAttempt>["intents_requirement"],
    attestation_ticket: ticket,
    failure_code: a.failure_code,
    refunded_amount: a.refunded_amount,
  };
}

export function publicSession(
  s: SessionRow,
  i: IntentRow,
  merchantName: string,
  attempt: z.input<typeof PayerAttempt> | null,
): z.input<typeof PublicCheckoutSession> {
  const p = pricingOf(i);
  return {
    id: fromUuid("cs", s.id),
    object: "checkout_session",
    livemode: s.livemode,
    status: s.status,
    intent_status: i.status,
    amount: p.amount,
    currency: p.currency,
    asset_id: p.asset_id,
    display: { merchant_name_unverified: merchantName, description: i.description },
    expires_at: s.expires_at.toISOString(),
    settlement: {
      asset_id: i.settlement_asset_id,
      chain: i.destination_snapshot.chain,
      type: i.destination_snapshot.type,
    },
    ui_mode: s.ui_mode,
    allowed_origins: s.allowed_origins,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    attempt,
  } as z.input<typeof PublicCheckoutSession>;
}

export function intentStreamEvent(i: IntentRow): z.input<typeof IntentStreamEvent> {
  return { id: fromUuid("pi", i.id), status: i.status, amount_settled: i.amount_settled, late: i.late };
}

export function lineView(l: LineRow): z.input<typeof BalanceTransaction> {
  const chain = (l.evidence as { chain?: string }).chain ?? "";
  return {
    id: fromUuid("txn", l.id),
    object: "balance_transaction",
    created: unix(l.created_at),
    livemode: l.livemode,
    type: l.type,
    payment_intent: l.payment_intent_id ? fromUuid("pi", l.payment_intent_id) : null,
    refund: l.refund_id ? fromUuid("re", l.refund_id) : null,
    gross:
      l.gross_amount !== null && l.gross_currency
        ? { amount: Number(l.gross_amount), currency: l.gross_currency }
        : null,
    settled: settlementValue(
      l.settled_amount,
      l.settlement_asset_id,
      l.settlement_decimals,
      l.settlement_symbol,
      chain,
    ),
    fee:
      l.fee_bps !== null && l.fee_amount_est !== null && l.fee_asset_id
        ? { bps: l.fee_bps, amount_estimated: l.fee_amount_est, asset_id: l.fee_asset_id }
        : null,
    evidence: l.evidence as z.input<typeof BalanceTransaction>["evidence"],
  } as z.input<typeof BalanceTransaction>;
}
