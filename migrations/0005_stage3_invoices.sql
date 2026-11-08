-- Stage 3 (lld/payments.md §20, spec 0.3.0): internal invoice checkout sessions for billing. Additive, forward-only.

-- The invoice a session pays (`CheckoutSession.invoice`); the intent already has `payment_intents.invoice_id`.
alter table checkout_sessions add column invoice_id uuid;

-- At most one `open` session per invoice (§20 item 1): a second create answers `409 state_conflict`. An
-- `expiring` session no longer counts (its attempts are hidden; a late settlement is still honoured, INV-3).
create unique index cs_invoice_open on checkout_sessions (account_id, livemode, invoice_id)
  where invoice_id is not null and status = 'open';
create index cs_invoice on checkout_sessions (account_id, livemode, invoice_id) where invoice_id is not null;

-- `listPaymentIntents?invoice=` and billing's lookups.
create index pi_invoice on payment_intents (account_id, livemode, invoice_id, created_at desc, id desc)
  where invoice_id is not null;

-- An invoice intent always names its invoice, and only invoice intents do (no rows have `source = 'invoice'` yet).
alter table payment_intents add constraint pi_invoice_source check ((source = 'invoice') = (invoice_id is not null));
alter table checkout_sessions add constraint cs_invoice_ui check (invoice_id is null or ui_mode = 'hosted');
