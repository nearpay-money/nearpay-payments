/**
 * Kysely table types (migrations/0001_payments.sql, 0002_stage2.sql, 0003_audit_fixes.sql, 0004_spec_0_2_1.sql). numeric(78,0) columns read as decimal
 * strings.
 */
import type { ColumnType, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Def<T> = ColumnType<T, T | undefined, T>;
type Opt<T> = ColumnType<T | null, T | null | undefined, T | null>;
type Json<T> = ColumnType<T, string, string>;
type OptJson<T> = ColumnType<T | null, string | null | undefined, string | null>;
/** numeric(78,0) */
type Num = ColumnType<string, string | bigint, string | bigint>;
type OptNum = ColumnType<string | null, string | bigint | null | undefined, string | bigint | null>;
type DefNum = ColumnType<string, string | bigint | undefined, string | bigint>;

export interface DestinationSnapshotJson {
  sd_id: string;
  asset_id: string;
  type: "chain_address" | "intents_account";
  chain: string;
  address: string;
  address_norm: string;
  attestation_hash: string | null;
  verification: string;
  per_payment_cap_usd_micros: number | null;
  /** Stage 2 (CR-15-04): fingerprint of the destination as shown at checkout; absent on Stage 1 snapshots. */
  fingerprint?: string | null;
}

export interface FeeSnapshotJson {
  schedule: {
    id: string;
    name: string;
    rules: Record<
      "same_asset" | "stable_pair" | "volatile" | "intents_transfer",
      { total_bps: number; min_fee_usd_micros: number }
    >;
    provider_split: { oneclick: { share_bps: number; floor_bps: number; stable_floor_bps: number } };
  };
  bearer: "payer" | "merchant";
}

export interface SettingsSnapshotJson {
  late_payments: boolean;
  underpay_tolerance_bps: number;
}

export interface DepositJson {
  address: string;
  memo: string | null;
  amount_in: string;
  min_amount_in: string;
  deadline: string;
  chain: string;
  /** Part of `amount_in` that pays NearPay's fee (rails `fee_amount_in`, spec 0.2.1); absent on older rows. */
  fee_amount?: string | null;
}

export interface RequirementJson {
  pay_to: string;
  token: string;
  amount: string;
  fee_to: string;
  fee_amount: string;
  binding: string;
  deadline: string;
}

export interface SettlementContextsTable {
  account_id: string;
  livemode: boolean;
  context: Json<unknown>;
  context_version: Timestamp;
  refreshed_at: Timestamp;
  stale: Def<boolean>;
}

export interface GeoPolicyTable {
  id: number;
  version: string;
  blocked_countries: string[];
  blocked_regions: string[];
  updated_at: Timestamp;
}

export interface PaymentIntentsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  status: "requires_payment" | "processing" | "requires_review" | "succeeded" | "canceled" | "expired";
  amount: ColumnType<string | null, bigint | number | null | undefined, bigint | number | null>;
  currency: string;
  pricing_asset_id: Opt<string>;
  pricing_asset_amount: OptNum;
  description: Opt<string>;
  customer_id: Opt<string>;
  source: "checkout" | "invoice" | "payment_link" | "api";
  invoice_id: Opt<string>;
  payment_link_id: Opt<string>;
  destination_snapshot: Json<DestinationSnapshotJson>;
  fee_snapshot: Json<FeeSnapshotJson>;
  settings_snapshot: Json<SettingsSnapshotJson>;
  settlement_asset_id: string;
  settlement_decimals: number;
  settlement_symbol: string;
  amount_settled: DefNum;
  amount_refunded: DefNum;
  amount_refund_pending: DefNum;
  succeeded_attempt_id: Opt<string>;
  succeeded_at: Opt<Date>;
  late: Def<boolean>;
  canceled_at: Opt<Date>;
  cancellation_reason: Opt<string>;
  review_reason: Opt<"short_settlement" | "verification_held">;
  compliance_review: OptJson<{ id: string; status: string; reason: string }>;
  review_decision: OptJson<ReviewDecisionJson>;
  metadata: ColumnType<Record<string, string>, string | undefined, string>;
  sequence: Def<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface CheckoutSessionsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  payment_intent_id: string;
  status: "open" | "expiring" | "complete" | "expired";
  client_secret_hash: Buffer;
  ui_mode: "hosted" | "embedded";
  success_url: string;
  cancel_url: Opt<string>;
  expires_at: Date;
  customer_email_enc: Opt<Buffer>;
  locale: Opt<string>;
  allowed_origins: Def<string[]>;
  completed_at: Opt<Date>;
  late: Def<boolean>;
  live_attempts_count: Def<number>;
  metadata: ColumnType<Record<string, string>, string | undefined, string>;
  customer_id: Opt<string>;
  payment_link_id: Opt<string>;
  headless: Def<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface PaymentAttemptsTable {
  id: string;
  payment_intent_id: string;
  account_id: string;
  livemode: boolean;
  method: "route_quote" | "intents_transfer";
  status: string;
  visible: Def<boolean>;
  origin_asset_id: string;
  origin_chain: string;
  refund_to: string;
  refund_type: "origin_chain" | "intents";
  payer_wallet: Opt<string>;
  payer_ip_country: Opt<string>;
  agent: Def<boolean>;
  execution_id: Opt<string>;
  execution_version: Def<number>;
  applied_fee_bps: Opt<number>;
  route_class: Opt<string>;
  settlement_amount: OptNum;
  amount_tag: OptNum;
  price_snapshot: OptJson<unknown>;
  deposit: OptJson<DepositJson>;
  intents_requirement: OptJson<RequirementJson>;
  deadline: Opt<Date>;
  settled_amount: OptNum;
  refunded_amount: OptNum;
  /** Rails `deposited_amount` (spec 0.2.1). */
  deposited_amount: OptNum;
  evidence: OptJson<Record<string, unknown>>;
  failure_code: Opt<string>;
  is_overpayment: Def<boolean>;
  overpayment_reason: Opt<"duplicate" | "after_cancel" | "after_expiry">;
  amount_refunded: DefNum;
  amount_refund_pending: DefNum;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface BalanceTransactionsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  type: "payment" | "overpayment" | "refund" | "fee_adjustment";
  payment_intent_id: Opt<string>;
  refund_id: Opt<string>;
  payment_attempt_id: Opt<string>;
  gross_amount: ColumnType<string | null, bigint | null | undefined, bigint | null>;
  gross_currency: Opt<string>;
  settled_amount: Num;
  settlement_asset_id: string;
  settlement_decimals: number;
  settlement_symbol: string;
  fee_bps: Opt<number>;
  fee_amount_est: OptNum;
  fee_asset_id: Opt<string>;
  evidence: Json<Record<string, unknown>>;
  refund_leg: Opt<number>;
  received: OptJson<{ amount: string; asset_id: string; chain: string }>;
  fee_adjustment: OptJson<Record<string, unknown>>;
  execution_id: Opt<string>;
  terminal_at: Opt<Date>;
  created_at: Timestamp;
}

export interface ReviewDecisionJson {
  decision: "accept" | "reject";
  decided_at: string;
  refund: string | null;
  reason: string | null;
  actor: string;
}

export interface CustomersTable {
  id: string;
  account_id: string;
  livemode: boolean;
  email_hash: Opt<Buffer>;
  email_enc: Opt<Buffer>;
  name_enc: Opt<Buffer>;
  description: Opt<string>;
  wallets: ColumnType<{ chain: string; address: string }[], string | undefined, string>;
  metadata: ColumnType<Record<string, string>, string | undefined, string>;
  deleted_at: Opt<Date>;
  last_payment_at: Opt<Date>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface CustomerTotalsTable {
  customer_id: string;
  account_id: string;
  livemode: boolean;
  currency: string;
  /** '' for fiat pricing. */
  asset_id: Def<string>;
  amount: DefNum;
  count: Def<number>;
  updated_at: Timestamp;
}

export interface PaymentLinksTable {
  id: string;
  account_id: string;
  livemode: boolean;
  active: Def<boolean>;
  amount: ColumnType<string | null, bigint | number | null | undefined, bigint | number | null>;
  currency: string;
  pricing_asset_id: Opt<string>;
  pricing_asset_amount: OptNum;
  description: string;
  name: Opt<string>;
  settlement_destination_id: Opt<string>;
  success_url: Opt<string>;
  max_uses: Opt<number>;
  uses: Def<number>;
  session_expires_in: Def<number>;
  collect_email: Def<boolean>;
  metadata: ColumnType<Record<string, string>, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export type RefundStatus = "requires_action" | "pending" | "succeeded" | "failed" | "canceled";
export type LegStatus =
  | "preparing"
  | "awaiting_signature"
  | "submitting"
  | "submitted"
  | "processing"
  | "succeeded"
  | "returned"
  | "failed"
  | "expired"
  | "held";

export interface RefundsTable {
  id: string;
  payment_intent_id: string;
  payment_attempt_id: string;
  account_id: string;
  livemode: boolean;
  amount: Num;
  budget: "intent" | "attempt";
  fee_mode: "payer_absorbs" | "merchant_absorbs";
  reason: Opt<string>;
  status: RefundStatus;
  method: "route_quote" | "intents_transfer";
  recipient: string;
  recipient_asset_id: string;
  recipient_chain: string;
  recipient_type: "origin_chain" | "intents";
  recipient_overridden: Def<boolean>;
  source: "api" | "dashboard" | "review_rejection";
  current_leg_id: Opt<string>;
  created_by: string;
  failure_code: Opt<string>;
  succeeded_at: Opt<Date>;
  canceled_at: Opt<Date>;
  amount_counted: DefNum;
  amount_received: OptNum;
  evidence: OptJson<Record<string, unknown>>;
  extra_amount_sent: DefNum;
  idempotency_key: Opt<string>;
  metadata: ColumnType<Record<string, string>, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface RefundLegsTable {
  id: string;
  refund_id: string;
  number: number;
  method: "route_quote" | "intents_transfer";
  swap_type: Opt<"EXACT_INPUT" | "EXACT_OUTPUT">;
  execution_id: Opt<string>;
  execution_version: Def<number>;
  status: LegStatus;
  next_action: OptJson<Record<string, unknown>>;
  deadline: Opt<Date>;
  amount: Num;
  amount_out_expected: OptNum;
  signed_nonce: Opt<string>;
  submitted_tx: Opt<string>;
  duplicate: Def<boolean>;
  evidence: OptJson<Record<string, unknown>>;
  failure_code: Opt<string>;
  screen: Def<boolean>;
  abandoned_at: Opt<Date>;
  abandon_reason: Opt<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface ReconciliationRunsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  day: ColumnType<string, string, string>;
  status: "running" | "ok" | "diff" | "error";
  trigger: "schedule" | "ops";
  rerun_of: Opt<string>;
  totals: ColumnType<unknown[], string | undefined, string>;
  diffs: ColumnType<unknown[], string | undefined, string>;
  error: Opt<string>;
  resolution: OptJson<{ classification: string; note: string; actor: string; resolved_at: string }>;
  case_id: Opt<string>;
  created_by: string;
  started_at: Timestamp;
  completed_at: Opt<Date>;
}

export interface KillSwitchTable {
  id: number;
  engaged: boolean;
  version: number;
  reason: Opt<string>;
  updated_at: Timestamp;
}

interface TransitionsTable {
  id: string;
  from_state: Opt<string>;
  to_state: string;
  cause: string;
  actor: string;
  evidence: OptJson<unknown>;
  created_at: Timestamp;
}

export interface PaymentsTables {
  settlement_contexts: SettlementContextsTable;
  geo_policy: GeoPolicyTable;
  payment_intents: PaymentIntentsTable;
  checkout_sessions: CheckoutSessionsTable;
  payment_attempts: PaymentAttemptsTable;
  balance_transactions: BalanceTransactionsTable;
  checkout_session_transitions: TransitionsTable & { checkout_session_id: string };
  payment_intent_transitions: TransitionsTable & { payment_intent_id: string };
  payment_attempt_transitions: TransitionsTable & { payment_attempt_id: string };
  customers: CustomersTable;
  customer_totals: CustomerTotalsTable;
  payment_links: PaymentLinksTable;
  refunds: RefundsTable;
  refund_legs: RefundLegsTable;
  refund_transitions: TransitionsTable & { refund_id: string };
  refund_leg_transitions: TransitionsTable & { refund_leg_id: string };
  reconciliation_runs: ReconciliationRunsTable;
  kill_switch: KillSwitchTable;
}

export type DB = PaymentsTables & KitTables;
