-- Payment Tracker card payments that went wrong (approved 2026-11; the code
-- shipped first in #156: lib/cardIssues.ts, routes/stripeWebhook.ts).
--
-- Stripe tells us when a family's card payment fails (payment_intent.payment_failed,
-- checkout.session.async_payment_failed) and when a family disputes a card
-- payment with their bank (charge.dispute.*). Neither is money received, so
-- neither belongs in pipeline_payments. This table keeps one row per Stripe
-- event (the event id is unique, which makes a redelivery a no-op) and the
-- tracker derives what to show every read, the way balances are derived:
--
--   * an invoice shows "Card payment failed" with the latest failure's reason
--     while it is still owed and no card payment on it is newer;
--   * a card payment shows "Disputed" with the latest dispute event's status
--     (needs_response, under_review, won, lost, ...).
--
-- Nothing here changes what counts as paid: a failure never touches
-- pipeline_payments, and a dispute is a flag (a lost dispute is NOT taken off
-- the payment; the counselor decides what to record).
--
-- Written only by the API's service role (the webhook); whoever may bill the
-- family may read it. No client write grant.
--
-- Deploy order: either. Additive (one new table). The code probes for it
-- (cardIssuesReady in lib/cardIssues.ts, re-asked every 30 s): before it is
-- applied the webhook notes a failure or dispute in audit_log instead (action
-- pipeline.card_payment_failed / pipeline.card_dispute) and answers 200, and
-- the tracker shows no failure line. Rows from before the migration are not
-- backfilled. Not in REQUIRED_SCHEMA.

create table if not exists public.pipeline_card_issues (
  id                        uuid primary key default gen_random_uuid(),
  -- One row per Stripe event: a redelivered event can't add a second row.
  stripe_event_id           text not null unique check (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,255}$'),
  kind                      text not null check (kind in ('payment_failed', 'dispute')),
  contact_id                uuid not null references public.pipeline_packages(contact_id) on delete cascade,
  invoice_id                uuid not null references public.pipeline_invoices(id) on delete cascade,
  -- The card payment a dispute is about (null for a failure: nothing was paid).
  payment_id                uuid references public.pipeline_payments(id) on delete cascade,
  stripe_account_id         text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]{1,64}$'),
  stripe_payment_intent_id  text check (length(stripe_payment_intent_id) <= 255),
  stripe_dispute_id         text check (length(stripe_dispute_id) <= 255),
  amount_cents              bigint check (amount_cents between 0 and 100000000),
  -- Stripe's code (decline_code / code, or the dispute reason), and its words.
  reason_code               text check (length(reason_code) <= 80),
  reason                    text check (length(reason) <= 300),
  -- A dispute's status at this event.
  dispute_status            text check (length(dispute_status) <= 40),
  -- When Stripe made the event.
  occurred_at               timestamptz not null,
  created_at                timestamptz not null default now(),
  constraint pipeline_card_issues_shape check (
    (kind = 'payment_failed' and payment_id is null and stripe_dispute_id is null and dispute_status is null)
    or (kind = 'dispute' and payment_id is not null and stripe_dispute_id is not null)
  )
);

create index if not exists pipeline_card_issues_contact_idx
  on public.pipeline_card_issues (contact_id, occurred_at desc);

alter table public.pipeline_card_issues enable row level security;

-- Whoever may bill the family sees what went wrong with its card payments.
drop policy if exists pipeline_card_issues_select on public.pipeline_card_issues;
create policy pipeline_card_issues_select on public.pipeline_card_issues
  for select to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

revoke all on public.pipeline_card_issues from public, anon, authenticated;
grant select on public.pipeline_card_issues to authenticated;

select private.attach_approval_gate('public.pipeline_card_issues');
