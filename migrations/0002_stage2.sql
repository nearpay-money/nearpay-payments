-- nearpay-payments, Stage 2 (lld/payments.md §4, §16, §17): customers, payment links, refunds and their legs,
-- reconciliation runs, the local kill-switch flag, ADR-0018 list-filter indexes and the Stage 2 statement columns.
-- Additive and forward-only. Asset amounts are numeric(78,0); fiat amounts bigint minor units.

-- ---------------------------------------------------------------------------------------------- customers
-- Email and name are envelope-encrypted (NP_PII_KEK); email_hash = HMAC(kek-derived key, lower(email)) for lookup.
-- DELETE erases the personal data and keeps the row (payments keep their customer id).
create table customers (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  email_hash bytea,
  email_enc bytea,
  name_enc bytea,
  description text,
  wallets jsonb not null default '[]',
  metadata jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0);
create index customers_account_created on customers (account_id, livemode, created_at desc, id desc) where deleted_at is null;
create index customers_email on customers (account_id, livemode, email_hash) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------- payment links
create table payment_links (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  active boolean not null default true,
  amount bigint,
  currency text not null,
  pricing_asset_id text,
  pricing_asset_amount numeric(78,0),
  description text not null,
  settlement_destination_id text,                 -- sd_… (identity's id); null = account default at session time
  success_url text,
  max_uses integer check (max_uses is null or max_uses >= 1),
  uses integer not null default 0,                -- succeeded payments (§17 item 11)
  session_expires_in integer not null default 3600 check (session_expires_in between 300 and 86400),
  collect_email boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check ((currency = 'asset') = (pricing_asset_id is not null and pricing_asset_amount is not null and amount is null)),
  check (currency = 'asset' or amount is not null));
create index plink_account_created on payment_links (account_id, livemode, created_at desc, id desc);
create index plink_active on payment_links (account_id, livemode, active, created_at desc);

-- ---------------------------------------------------------------------------------------------- intents and sessions
alter table payment_intents add constraint pi_customer_fk foreign key (customer_id) references customers(id);
alter table payment_intents add constraint pi_payment_link_fk foreign key (payment_link_id) references payment_links(id);
alter table payment_intents add column review_decision jsonb;      -- {decision, decided_at, refund, reason, actor}
-- ADR-0018 list filters: every typed filter has an index under (account_id, livemode)
create index pi_amount on payment_intents (account_id, livemode, currency, amount) where currency <> 'asset';
create index pi_asset_amount on payment_intents (account_id, livemode, pricing_asset_id, pricing_asset_amount) where currency = 'asset';
create index pi_settlement_asset on payment_intents (account_id, livemode, settlement_asset_id, created_at desc);
create index pi_source on payment_intents (account_id, livemode, source, created_at desc);
create index pi_customer on payment_intents (account_id, livemode, customer_id, created_at desc) where customer_id is not null;
create index pi_payment_link on payment_intents (account_id, livemode, payment_link_id, created_at desc) where payment_link_id is not null;
create index pi_metadata on payment_intents using gin (metadata jsonb_path_ops);

alter table checkout_sessions add column customer_id uuid references customers(id);
alter table checkout_sessions add column payment_link_id uuid references payment_links(id);
alter table checkout_sessions add column headless boolean not null default false;   -- POST /v1/payment_intents (§17 item 10)

-- per-attempt refund budget: refunds of an attempt that is not the intent's settlement (overpayments, rejected short
-- settlements) reserve against the attempt; refunds of the paying attempt reserve against the intent (§5)
alter table payment_attempts add column amount_refunded numeric(78,0) not null default 0;
alter table payment_attempts add column amount_refund_pending numeric(78,0) not null default 0;
alter table payment_attempts add constraint pa_refund_budget
  check (amount_refunded + amount_refund_pending <= coalesce(settled_amount, 0));

-- ---------------------------------------------------------------------------------------------- refunds
create table refunds (
  id uuid primary key,
  payment_intent_id uuid not null references payment_intents(id),
  payment_attempt_id uuid not null references payment_attempts(id),
  account_id uuid not null,
  livemode boolean not null,
  amount numeric(78,0) not null check (amount > 0),   -- settlement-asset base units (reserved / counted value)
  budget text not null check (budget in ('intent','attempt')),
  fee_mode text not null check (fee_mode in ('payer_absorbs','merchant_absorbs')),
  reason text,
  status text not null check (status in ('requires_action','pending','succeeded','failed','canceled')),
  method text not null check (method in ('route_quote','intents_transfer')),
  recipient text not null,
  recipient_asset_id text not null,
  recipient_chain text not null,
  recipient_type text not null check (recipient_type in ('origin_chain','intents')),
  recipient_overridden boolean not null default false,
  source text not null check (source in ('api','dashboard','review_rejection')),
  current_leg_id uuid,
  created_by text not null,
  failure_code text,
  succeeded_at timestamptz,
  canceled_at timestamptz,
  amount_counted numeric(78,0) not null default 0,    -- part of a success counted in the budget (≤ amount)
  amount_received numeric(78,0),
  evidence jsonb,
  extra_amount_sent numeric(78,0) not null default 0,
  idempotency_key text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check (amount_counted <= amount));
create unique index refunds_idem on refunds (account_id, livemode, idempotency_key) where idempotency_key is not null;
create index refunds_intent on refunds (payment_intent_id, created_at desc);
create index refunds_attempt on refunds (payment_attempt_id);
create index refunds_account_created on refunds (account_id, livemode, created_at desc, id desc);
create index refunds_status on refunds (account_id, livemode, status, created_at desc);

create table refund_legs (
  id uuid primary key,
  refund_id uuid not null references refunds(id),
  number smallint not null check (number >= 1),
  method text not null check (method in ('route_quote','intents_transfer')),
  swap_type text check (swap_type in ('EXACT_INPUT','EXACT_OUTPUT')),
  execution_id text unique,
  execution_version integer not null default 0,
  status text not null check (status in ('preparing','awaiting_signature','submitted','processing','succeeded',
     'returned','failed','expired','held')),
  next_action jsonb,                                  -- the exact RefundNextAction issued (null while preparing)
  deadline timestamptz,
  amount numeric(78,0) not null check (amount > 0),   -- what the merchant sends (settlement asset)
  amount_out_expected numeric(78,0),
  signed_nonce text,                                  -- nonce of the issued sign_intent payload
  submitted_tx text,
  duplicate boolean not null default false,
  evidence jsonb,
  failure_code text,
  screen boolean not null default false,              -- recipient override: rails screens again (INV-7)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  unique (refund_id, number));
create index refund_legs_preparing on refund_legs (created_at) where status = 'preparing';
alter table refunds add constraint refunds_current_leg_fk foreign key (current_leg_id) references refund_legs(id);

create table refund_transitions (
  id uuid primary key, refund_id uuid not null references refunds(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index rft_refund on refund_transitions (refund_id, created_at);
create trigger rft_append_only before update or delete on refund_transitions
  for each row execute function payments_append_only();

create table refund_leg_transitions (
  id uuid primary key, refund_leg_id uuid not null references refund_legs(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index rflt_leg on refund_leg_transitions (refund_leg_id, created_at);
create trigger rflt_append_only before update or delete on refund_leg_transitions
  for each row execute function payments_append_only();

-- ---------------------------------------------------------------------------------------------- statement
alter table balance_transactions add column refund_leg smallint;
alter table balance_transactions add column received jsonb;          -- {amount, asset_id, chain}
alter table balance_transactions add column fee_adjustment jsonb;
alter table balance_transactions add column execution_id text;       -- rails ex_… behind the line (reconciliation)
alter table balance_transactions add column terminal_at timestamptz; -- execution terminal_at: the line's evidence day
drop index bt_once;
create unique index bt_once on balance_transactions (type, coalesce(payment_attempt_id, refund_id), coalesce(refund_leg, 0));
create index bt_refund on balance_transactions (refund_id) where refund_id is not null;
create index bt_day on balance_transactions (account_id, livemode, (coalesce(terminal_at, created_at)));

-- ---------------------------------------------------------------------------------------------- reconciliation
create table reconciliation_runs (                  -- append-only: a re-run is a new row (INV-9)
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  day date not null,
  status text not null check (status in ('running','ok','diff','error')),
  trigger text not null check (trigger in ('schedule','ops')),
  rerun_of uuid references reconciliation_runs(id),
  totals jsonb not null default '[]',
  diffs jsonb not null default '[]',
  error text,
  resolution jsonb,                                 -- {classification, note, actor, resolved_at}
  case_id text,                                     -- compliance case_… opened for a diff/error run
  created_by text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz);
create unique index rr_running on reconciliation_runs (account_id, livemode, day) where status = 'running';
create index rr_day on reconciliation_runs (day desc, id desc);
create index rr_account_day on reconciliation_runs (account_id, livemode, day desc, id desc);

-- a completed run is never edited, except recording its resolution and its compliance case once
create function reconciliation_runs_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'reconciliation_runs is append-only'; end if;
  if old.completed_at is not null and (
       new.status is distinct from old.status or new.totals is distinct from old.totals
       or new.diffs is distinct from old.diffs or new.error is distinct from old.error
       or new.completed_at is distinct from old.completed_at or new.day is distinct from old.day
       or new.account_id is distinct from old.account_id or new.livemode is distinct from old.livemode
       or (old.resolution is not null and new.resolution is distinct from old.resolution)
       or (old.case_id is not null and new.case_id is distinct from old.case_id)) then
    raise exception 'completed reconciliation run % is immutable', old.id;
  end if;
  return new;
end $$;
create trigger rr_guard before update or delete on reconciliation_runs
  for each row execute function reconciliation_runs_guard();

-- ---------------------------------------------------------------------------------------------- kill switch
-- Local copy of sentinel's kill switch (evt.sentinel.kill_switch.*, version-checked): while engaged no new live
-- refund leg is prepared and no live refund payload is relayed (§17 item 16).
create table kill_switch (
  id smallint primary key check (id = 1),
  engaged boolean not null,
  version integer not null,
  reason text,
  updated_at timestamptz not null default now());
