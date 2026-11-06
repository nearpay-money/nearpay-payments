-- nearpay-payments, Stage 1 (lld/payments.md §4, §16). Kit tables (outbox, inbox, idempotency_keys, jobs,
-- dead_letters) come from @nearpay-internal/db migrations. Refunds, payment links, customers and
-- reconciliation runs arrive with their Stage 2 migration.
-- Asset amounts are numeric(78,0) (base units can exceed 2^63); fiat amounts are bigint minor units.

-- Read model of identity's settlement context (consumer + sync fallback, §8.1).
create table settlement_contexts (
  account_id uuid not null,
  livemode boolean not null,
  context jsonb not null,
  context_version timestamptz not null,
  refreshed_at timestamptz not null,
  stale boolean not null default false,          -- an identity event arrived; refresh before trusting it
  primary key (account_id, livemode));

-- Compliance geo policy (FR-CMP-03), one row, refreshed by evt.compliance.policy.updated.
create table geo_policy (
  id smallint primary key check (id = 1),
  version text not null,
  blocked_countries text[] not null,
  blocked_regions text[] not null,
  updated_at timestamptz not null default now());

create table payment_intents (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  status text not null check (status in ('requires_payment','processing','requires_review','succeeded','canceled','expired')),
  amount bigint,                                  -- fiat minor units when currency <> 'asset'
  currency text not null,                         -- ISO 4217 lower-case or 'asset'
  pricing_asset_id text,
  pricing_asset_amount numeric(78,0),
  description text,
  customer_id uuid,                               -- customers arrive in Stage 2
  source text not null check (source in ('checkout','invoice','payment_link','api')),
  invoice_id uuid,
  payment_link_id uuid,
  destination_snapshot jsonb not null,            -- {sd_id, asset_id, type, chain, address, address_norm, attestation_hash, verification, per_payment_cap_usd_micros}
  fee_snapshot jsonb not null,                    -- {schedule: FeeSchedule, bearer}
  settings_snapshot jsonb not null,               -- {late_payments, underpay_tolerance_bps}
  settlement_asset_id text not null,
  settlement_decimals smallint not null,
  settlement_symbol text not null,
  amount_settled numeric(78,0) not null default 0,
  amount_refunded numeric(78,0) not null default 0,
  amount_refund_pending numeric(78,0) not null default 0,
  succeeded_attempt_id uuid,
  succeeded_at timestamptz,
  late boolean not null default false,
  canceled_at timestamptz,
  cancellation_reason text,
  review_reason text check (review_reason in ('short_settlement','verification_held')),
  compliance_review jsonb,                        -- {id, status, reason} from evt.compliance.review.* (payment stands)
  metadata jsonb not null default '{}',
  sequence integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check ((currency = 'asset') = (pricing_asset_id is not null and pricing_asset_amount is not null and amount is null)),
  check (currency = 'asset' or amount is not null),
  check (amount_refunded + amount_refund_pending <= amount_settled));
create index pi_account_created on payment_intents (account_id, livemode, created_at desc, id desc);
create index pi_status on payment_intents (account_id, livemode, status);

create table checkout_sessions (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  payment_intent_id uuid not null unique references payment_intents(id),
  status text not null check (status in ('open','expiring','complete','expired')),
  client_secret_hash bytea not null,
  ui_mode text not null check (ui_mode in ('hosted','embedded')),
  success_url text not null,
  cancel_url text,
  expires_at timestamptz not null,
  customer_email_enc bytea,
  locale text,
  allowed_origins text[] not null default '{}',
  completed_at timestamptz,
  late boolean not null default false,
  live_attempts_count smallint not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0);
create index cs_account_created on checkout_sessions (account_id, livemode, created_at desc, id desc);
create index cs_expiry on checkout_sessions (expires_at) where status = 'open';

create table payment_attempts (
  id uuid primary key,
  payment_intent_id uuid not null references payment_intents(id),
  account_id uuid not null,
  livemode boolean not null,
  method text not null check (method in ('route_quote','intents_transfer')),
  status text not null check (status in ('quoting','awaiting_deposit','deposit_detected','incomplete_deposit','settling',
     'verifying','succeeded','refunded','failed','expired_unpaid','held')),
  visible boolean not null default true,
  origin_asset_id text not null,
  origin_chain text not null,
  refund_to text not null,
  refund_type text not null check (refund_type in ('origin_chain','intents')),
  payer_wallet text,
  payer_ip_country char(2),
  agent boolean not null default false,           -- created by agentpay (internal agent attempts)
  execution_id text,                              -- rails ex_…
  execution_version integer not null default 0,
  applied_fee_bps integer,
  route_class text,
  settlement_amount numeric(78,0),                -- expected output incl. amount tag
  amount_tag numeric(78,0),
  price_snapshot jsonb,
  deposit jsonb,                                  -- {address, memo, amount_in, min_amount_in, deadline, chain}
  intents_requirement jsonb,
  deadline timestamptz,
  settled_amount numeric(78,0),
  refunded_amount numeric(78,0),
  evidence jsonb,
  failure_code text,
  is_overpayment boolean not null default false,
  overpayment_reason text check (overpayment_reason in ('duplicate','after_cancel','after_expiry')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0);
create index pa_intent on payment_attempts (payment_intent_id, created_at desc);
create index pa_quoting on payment_attempts (created_at) where status = 'quoting';
create unique index pa_execution on payment_attempts (execution_id) where execution_id is not null;

create table balance_transactions (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  type text not null check (type in ('payment','overpayment','refund','fee_adjustment')),
  payment_intent_id uuid,
  refund_id uuid,
  payment_attempt_id uuid,
  gross_amount bigint,
  gross_currency text,
  settled_amount numeric(78,0) not null,
  settlement_asset_id text not null,
  settlement_decimals smallint not null,
  settlement_symbol text not null,
  fee_bps integer,
  fee_amount_est numeric(78,0),
  fee_asset_id text,
  evidence jsonb not null,
  created_at timestamptz not null default now());
create index bt_account_created on balance_transactions (account_id, livemode, created_at desc, id desc);
create index bt_intent on balance_transactions (payment_intent_id);
create unique index bt_once on balance_transactions (type, coalesce(payment_attempt_id, refund_id));

-- Transitions (foundations §7, INV-9): append-only.
create table checkout_session_transitions (
  id uuid primary key, checkout_session_id uuid not null references checkout_sessions(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index cst_session on checkout_session_transitions (checkout_session_id, created_at);

create table payment_intent_transitions (
  id uuid primary key, payment_intent_id uuid not null references payment_intents(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index pit_intent on payment_intent_transitions (payment_intent_id, created_at);

create table payment_attempt_transitions (
  id uuid primary key, payment_attempt_id uuid not null references payment_attempts(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index pat_attempt on payment_attempt_transitions (payment_attempt_id, created_at);

create function payments_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger cst_append_only before update or delete on checkout_session_transitions
  for each row execute function payments_append_only();
create trigger pit_append_only before update or delete on payment_intent_transitions
  for each row execute function payments_append_only();
create trigger pat_append_only before update or delete on payment_attempt_transitions
  for each row execute function payments_append_only();
create trigger bt_append_only before update or delete on balance_transactions
  for each row execute function payments_append_only();
