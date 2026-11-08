/**
 * Row → API object mapping (spec `PaymentIntent`, `CheckoutSession`, `PayerAttempt`,
 * `PublicCheckoutSession`, `BalanceTransaction`). The payer views never carry the raw destination
 * address or PII (§12).
 */
import type {
  BalanceTransaction,
  CheckoutSession,
  Customer,
  IntentStreamEvent,
  PayerAttempt,
  PaymentIntent,
  PaymentLink,
  PublicCheckoutSession,
  Refund,
} from "@nearpay/spec";
import { getChain } from "@nearpay-internal/chains";
import type { Selectable } from "@nearpay-internal/db";
import { fromUuid } from "@nearpay-internal/ids";
import { formatUnits } from "@nearpay-internal/money";
import type { ReconciliationRun } from "@nearpay-internal/spec";
import type { z } from "zod";
import type {
  BalanceTransactionsTable,
  CheckoutSessionsTable,
  CustomersTable,
  CustomerTotalsTable,
  PaymentAttemptsTable,
  PaymentIntentsTable,
  PaymentLinksTable,
  ReconciliationRunsTable,
  RefundLegsTable,
  RefundsTable,
} from "../infra/db/schema.js";

export type IntentRow = Selectable<PaymentIntentsTable>;
export type SessionRow = Selectable<CheckoutSessionsTable>;
export type AttemptRow = Selectable<PaymentAttemptsTable>;
export type LineRow = Selectable<BalanceTransactionsTable>;
export type RefundRow = Selectable<RefundsTable>;
export type LegRow = Selectable<RefundLegsTable>;
export type LinkRow = Selectable<PaymentLinksTable>;
export type CustomerRow = Selectable<CustomersTable>;
export type RunRow = Selectable<ReconciliationRunsTable>;
export type CustomerTotalRow = Selectable<CustomerTotalsTable>;

/** `PricingAssetDisplay` (spec 0.2.1): the pricing asset of an asset-priced session or link. */
export interface PricingAssetDisplay {
  readonly asset_id: string;
  readonly symbol: string;
  readonly decimals: number;
}

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
    // spec 0.2.1
    origin_amount: a.deposited_amount,
    refund_to: a.refund_to,
    deadline: unixOrNull(a.deadline),
    is_overpayment: a.is_overpayment,
    failure_code: a.failure_code,
    evidence: (a.evidence as Intent["attempts"][number]["evidence"]) ?? null,
  };
}

/** Attempts newest first (the order the API documents). */
export const newestFirst = (attempts: readonly AttemptRow[]) =>
  [...attempts].sort((x, y) => y.created_at.getTime() - x.created_at.getTime() || (x.id < y.id ? 1 : -1));

/** Refunds of an intent (uuid + created), for `PaymentIntent.refunds` (newest first). */
export interface RefundRef {
  readonly id: string;
  readonly created_at: Date;
}

export function intentView(
  i: IntentRow,
  attempts: readonly AttemptRow[],
  sessionUuid: string | null,
  refunds: readonly RefundRef[] = [],
): Intent {
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
      fingerprint: d.fingerprint ?? null,
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
    // stage 2
    customer: i.customer_id ? fromUuid("cus", i.customer_id) : null,
    payment_link: i.payment_link_id ? fromUuid("plink", i.payment_link_id) : null,
    amount_refund_pending: i.amount_refund_pending,
    refunds: [...refunds]
      .sort((x, y) => y.created_at.getTime() - x.created_at.getTime() || (x.id < y.id ? 1 : -1))
      .map((r) => fromUuid("re", r.id)),
    review_decision: i.review_decision
      ? {
          decision: i.review_decision.decision,
          decided_at: unix(new Date(i.review_decision.decided_at)),
          refund: i.review_decision.refund ? (fromUuid("re", i.review_decision.refund) as `re_${string}`) : null,
        }
      : null,
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
    // the session's aggregate version: every session change goes through updateSession, which bumps it,
    // and it is the `aggregate.version` its events carry (0.1.5, CR-15-09)
    sequence: s.version,
    metadata: s.metadata,
    customer: s.customer_id ? fromUuid("cus", s.customer_id) : null,
    payment_link: s.payment_link_id ? fromUuid("plink", s.payment_link_id) : null,
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
    deposit: d ? { ...d, fee_amount: d.fee_amount ?? null, origin_asset_id: a.origin_asset_id } : null,
    intents_requirement: a.intents_requirement as z.input<typeof PayerAttempt>["intents_requirement"],
    attestation_ticket: ticket,
    failure_code: a.failure_code,
    refunded_amount: a.refunded_amount,
    amount_received: a.deposited_amount,
  };
}

export function publicSession(
  s: SessionRow,
  i: IntentRow,
  merchantName: string,
  attempt: z.input<typeof PayerAttempt> | null,
  pricingAsset?: PricingAssetDisplay | null,
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
    payment_intent: fromUuid("pi", i.id),
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
    ...(pricingAsset !== undefined ? { pricing_asset: pricingAsset } : {}),
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
    refund_leg: l.refund_leg,
    received: l.received,
    fee_adjustment: (l.fee_adjustment as z.input<typeof BalanceTransaction>["fee_adjustment"]) ?? null,
  } as z.input<typeof BalanceTransaction>;
}

// ------------------------------------------------------------------------------------------- stage 2

type RefundView = z.input<typeof Refund>;

/** Legs as the API shows them: prepared legs only (a leg being prepared has no instructions yet), newest first. */
export function legViews(legs: readonly LegRow[]): RefundView["legs"] {
  return [...legs]
    .filter((l) => l.status !== "preparing")
    .sort((a, b) => b.number - a.number)
    .map((l) => ({
      number: l.number,
      // `submitting` is internal (the relay is in progress): the merchant has submitted
      status: (l.status === "submitting" ? "submitted" : l.status) as RefundView["legs"][number]["status"],
      method: l.method,
      swap_type: l.swap_type,
      amount: l.amount,
      amount_out_expected: l.amount_out_expected,
      deadline: unix(l.deadline ?? l.created_at),
      submitted_tx: l.submitted_tx,
      duplicate: l.duplicate,
      evidence: (l.evidence as RefundView["evidence"]) ?? null,
      failure_code: l.failure_code,
      created: unix(l.created_at),
    }));
}

/**
 * The refund object. `next_action` is shown only in `requires_action` while the current leg awaits its
 * signature and its deadline has not passed.
 *
 * `relaying` (the internal view agentpay reads while it validates a merchant-signed leg, payments §8.4): the
 * leg is already `submitting` under payments' row lock when agentpay asks for the issued payload, so that view
 * also shows the action of a `submitting` leg. Without it every Intents-account refund relay was refused
 * (`intent_invalid`: "the refund has no leg awaiting a signed intent"; step 2.4 integration).
 */
export function refundView(
  r: RefundRow,
  legs: readonly LegRow[],
  asset: { readonly id: string; readonly decimals: number },
  now: number,
  o: { readonly relaying?: boolean } = {},
): RefundView {
  const current = legs.find((l) => l.id === r.current_leg_id) ?? null;
  const live =
    r.status === "requires_action" &&
    (current?.status === "awaiting_signature" || (o.relaying === true && current?.status === "submitting")) &&
    current.next_action !== null &&
    current.deadline !== null &&
    current.deadline.getTime() > now;
  return {
    id: fromUuid("re", r.id),
    object: "refund",
    created: unix(r.created_at),
    livemode: r.livemode,
    status: r.status,
    payment_intent: fromUuid("pi", r.payment_intent_id),
    payment_attempt: fromUuid("pa", r.payment_attempt_id),
    amount: r.amount,
    asset_id: asset.id,
    decimals: asset.decimals,
    fee_mode: r.fee_mode,
    reason: r.reason as RefundView["reason"],
    method: r.method,
    recipient: {
      address: r.recipient,
      asset_id: r.recipient_asset_id,
      chain: r.recipient_chain,
      type: r.recipient_type,
      overridden: r.recipient_overridden,
    },
    next_action: live ? (current?.next_action as RefundView["next_action"]) : null,
    legs: legViews(legs),
    amount_received: r.amount_received,
    evidence: (r.evidence as RefundView["evidence"]) ?? null,
    extra_amount_sent: r.extra_amount_sent,
    source: r.source,
    failure_code: r.failure_code,
    succeeded_at: unixOrNull(r.succeeded_at),
    canceled_at: unixOrNull(r.canceled_at),
    sequence: r.version,
    metadata: r.metadata,
  } as RefundView;
}

export function linkView(l: LinkRow, payOrigin: string): z.input<typeof PaymentLink> {
  const id = fromUuid("plink", l.id);
  return {
    id,
    object: "payment_link",
    created: unix(l.created_at),
    livemode: l.livemode,
    active: l.active,
    url: `${payOrigin}/l/${id}`,
    amount: l.currency === "asset" ? (l.pricing_asset_amount as string) : Number(l.amount),
    currency: l.currency,
    asset_id: l.pricing_asset_id,
    description: l.description,
    name: l.name,
    settlement_destination: l.settlement_destination_id as `sd_${string}` | null,
    success_url: l.success_url,
    session_expires_in: l.session_expires_in,
    max_uses: l.max_uses,
    uses: l.uses,
    collect_email: l.collect_email,
    metadata: l.metadata,
  } as z.input<typeof PaymentLink>;
}

/** `Customer.total_paid` entries ordered by currency, then asset (stable output). */
export function totalPaidView(rows: readonly CustomerTotalRow[]) {
  return [...rows]
    .filter((t) => t.count > 0)
    .sort((a, b) => (a.currency + a.asset_id < b.currency + b.asset_id ? -1 : 1))
    .map((t) => ({
      currency: t.currency,
      asset_id: t.currency === "asset" ? t.asset_id : null,
      amount: t.currency === "asset" ? t.amount : Number(t.amount),
      count: t.count,
    }));
}

export function customerView(
  c: CustomerRow,
  pii: { email: string | null; name: string | null },
  totals: readonly CustomerTotalRow[] = [],
): z.input<typeof Customer> {
  return {
    id: fromUuid("cus", c.id),
    object: "customer",
    created: unix(c.created_at),
    livemode: c.livemode,
    email: pii.email,
    name: pii.name,
    description: c.description,
    wallets: c.wallets,
    metadata: c.metadata,
    total_paid: totalPaidView(totals),
    last_payment_at: unixOrNull(c.last_payment_at),
  } as z.input<typeof Customer>;
}

/** A `date` column as `YYYY-MM-DD` (node-postgres parses `date` into a local-midnight Date). */
export function dayString(v: unknown): string {
  if (v instanceof Date) {
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

export function runView(r: RunRow, accountDisplayName: string | null = null): z.input<typeof ReconciliationRun> {
  return {
    id: fromUuid("rcn", r.id),
    object: "reconciliation_run",
    account_id: fromUuid("acct", r.account_id),
    account_display_name: accountDisplayName,
    livemode: r.livemode,
    day: dayString(r.day),
    status: r.status,
    trigger: r.trigger,
    rerun_of: r.rerun_of ? fromUuid("rcn", r.rerun_of) : null,
    started_at: r.started_at.toISOString(),
    completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    totals: r.totals,
    diffs: r.diffs,
    diff_count: r.diffs.length,
    error: r.error,
    resolution: r.resolution,
  } as z.input<typeof ReconciliationRun>;
}
