/** Kysely table types (migrations/0001_payments.sql). numeric(78,0) columns read as decimal strings. */
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
  evidence: OptJson<Record<string, unknown>>;
  failure_code: Opt<string>;
  is_overpayment: Def<boolean>;
  overpayment_reason: Opt<"duplicate" | "after_cancel" | "after_expiry">;
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
  created_at: Timestamp;
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
}

export type DB = PaymentsTables & KitTables;
