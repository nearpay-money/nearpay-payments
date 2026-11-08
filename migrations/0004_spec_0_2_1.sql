-- Spec 0.2.1 (lld/payments.md §"Spec 0.2.1 contract changes"): additive, forward-only.

-- What the payer's deposit actually delivered (rails `Execution.deposited_amount`): `PayerAttempt.amount_received`,
-- `PaymentAttemptSummary.origin_amount`.
alter table payment_attempts add column deposited_amount numeric(78,0);

-- `PaymentLink.name`: internal dashboard name, never shown to payers.
alter table payment_links add column name text;

-- Orphaned refund legs payments asked rails to abandon (`abandonExecution`): when it was acknowledged and why.
alter table refund_legs add column abandoned_at timestamptz;
alter table refund_legs add column abandon_reason text;

-- `Customer.total_paid` / `last_payment_at`: per pricing currency (or pricing asset), Σ priced amounts of the
-- customer's succeeded payment intents (refunds are not subtracted, spec 0.2.1). Maintained in the same
-- transaction as every payment-intent change (ledger `updateIntent`). `asset_id` is '' for fiat pricing.
alter table customers add column last_payment_at timestamptz;
create table customer_totals (
  customer_id uuid not null references customers(id),
  account_id uuid not null,
  livemode boolean not null,
  currency text not null,
  asset_id text not null default '',
  amount numeric(78,0) not null default 0 check (amount >= 0),
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (customer_id, currency, asset_id));

insert into customer_totals (customer_id, account_id, livemode, currency, asset_id, amount, count)
  select customer_id, account_id, livemode, currency, coalesce(pricing_asset_id, ''),
         sum(case when currency = 'asset' then pricing_asset_amount else amount end), count(*)
  from payment_intents
  where status = 'succeeded' and customer_id is not null
  group by customer_id, account_id, livemode, currency, coalesce(pricing_asset_id, '');

update customers c set last_payment_at = s.at
  from (select customer_id, max(coalesce(succeeded_at, updated_at)) as at from payment_intents
        where status = 'succeeded' and customer_id is not null group by customer_id) s
  where s.customer_id = c.id;
