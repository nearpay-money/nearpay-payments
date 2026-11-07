-- Stage 2 audit fixes (lld/payments.md §18): additive, forward-only.

-- finding 5: a sign_intent leg is `submitting` while agentpay relays its payload (cancel refused meanwhile)
alter table refund_legs drop constraint refund_legs_status_check;
alter table refund_legs add constraint refund_legs_status_check check (status in ('preparing','awaiting_signature',
  'submitting','submitted','processing','succeeded','returned','failed','expired','held'));

-- finding 12: max_uses counts the link's intents that can still succeed under the link's row lock
create index pi_payment_link_open on payment_intents (payment_link_id)
  where payment_link_id is not null and status in ('requires_payment','processing','requires_review');
