-- Payment Tracker: card payments through Stripe Connect. The practice is paid
-- directly; Meridies never holds the money.
--
-- Each practice (a firm, or a solo counselor) connects its own Stripe account
-- (Standard, a direct charge on that account, so the practice pays Stripe's fee
-- and refunds in its own Stripe dashboard). A family pays an open invoice on a
-- Stripe Checkout page opened from the invoice's pay link, and Stripe's webhook
-- records the payment here.
--
--   * `practice_stripe_accounts`  one connected account per practice, keyed by
--     the practice id (`coalesce(firm_id, counselor_id)`, the same scope as an
--     invoice's `number_scope`). Written only by the API's service role (the
--     connect route after checking the caller is a firm owner/admin or a solo
--     counselor, and the webhook); the practice's counselors may read it.
--   * `pipeline_pay_tokens`  the capability in a pay link (`/pay/<token>`),
--     stored as a sha256 hash. One invoice may have several (each "Copy pay
--     link" mints one); every one stays valid, so an emailed link never expires.
--   * `pipeline_payments` gains `via_stripe`, `refunded_cents` (what Stripe
--     says went back, absolute, so a repeated webhook can't count it twice),
--     the Stripe ids (the PaymentIntent is unique, which is what makes
--     recording a payment idempotent) and the invoice it paid.
--   * `stripe_webhook_events`  ids of the Stripe events already handled. The
--     service role only; no client policy.
--
-- A card payment can't be removed by a client: the delete policy now skips
-- `via_stripe` rows (refund it in Stripe instead), and a client can't insert a
-- row claiming to be one. `pipeline_credit_available` counts a payment net of
-- what was refunded, the way lib/payments.ts does.
--
-- Deploy order: either. Additive only (new tables and columns; two policies
-- and one function replaced with stricter or equivalent versions). The new
-- code probes for this migration (stripeReady in lib/stripePractice.ts) and,
-- until it is applied, GET /pipeline/stripe answers `configured: false` and
-- the Stripe routes answer 503 `stripe_unavailable`. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- The practice's connected account
-- ---------------------------------------------------------------------------

create table if not exists public.practice_stripe_accounts (
  -- The firm's id, or the solo counselor's profile id.
  practice_id         uuid primary key,
  firm_id             uuid references public.firms(id) on delete cascade,
  counselor_id        uuid references public.profiles(id) on delete cascade,
  stripe_account_id   text not null unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]{1,64}$'),
  charges_enabled     boolean not null default false,
  payouts_enabled     boolean not null default false,
  details_submitted   boolean not null default false,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint practice_stripe_accounts_one_owner check ((firm_id is null) <> (counselor_id is null)),
  constraint practice_stripe_accounts_practice check (practice_id = coalesce(firm_id, counselor_id))
);

drop trigger if exists practice_stripe_accounts_set_updated_at on public.practice_stripe_accounts;
create trigger practice_stripe_accounts_set_updated_at before update on public.practice_stripe_accounts
  for each row execute function public.set_updated_at();

alter table public.practice_stripe_accounts enable row level security;

-- Everyone in the practice may see whether it takes cards; nobody writes from a client.
drop policy if exists practice_stripe_accounts_select on public.practice_stripe_accounts;
create policy practice_stripe_accounts_select on public.practice_stripe_accounts
  for select to authenticated
  using (
    private.is_counselor((select auth.uid()))
    and case when firm_id is null then counselor_id = (select auth.uid())
             else private.crm_firm_member(firm_id, (select auth.uid())) end
  );

revoke all on public.practice_stripe_accounts from public, anon, authenticated;
grant select on public.practice_stripe_accounts to authenticated;

select private.attach_approval_gate('public.practice_stripe_accounts');

-- ---------------------------------------------------------------------------
-- Pay link tokens
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_pay_tokens (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  invoice_id  uuid not null references public.pipeline_invoices(id) on delete cascade,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists pipeline_pay_tokens_invoice_idx on public.pipeline_pay_tokens (invoice_id);

alter table public.pipeline_pay_tokens enable row level security;

-- Whoever may bill the family may mint a link for its invoice.
drop policy if exists pipeline_pay_tokens_select on public.pipeline_pay_tokens;
create policy pipeline_pay_tokens_select on public.pipeline_pay_tokens
  for select to authenticated
  using (exists (
    select 1 from public.pipeline_invoices i
    where i.id = invoice_id and private.crm_can_bill(i.contact_id, (select auth.uid()))
  ));

drop policy if exists pipeline_pay_tokens_insert on public.pipeline_pay_tokens;
create policy pipeline_pay_tokens_insert on public.pipeline_pay_tokens
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.pipeline_invoices i
      where i.id = invoice_id and private.crm_can_bill(i.contact_id, (select auth.uid()))
    )
  );

-- No update or delete: a link that went out keeps working.
revoke all on public.pipeline_pay_tokens from public, anon, authenticated;
grant select, insert on public.pipeline_pay_tokens to authenticated;

select private.attach_approval_gate('public.pipeline_pay_tokens');

-- ---------------------------------------------------------------------------
-- Card payments on pipeline_payments
-- ---------------------------------------------------------------------------

alter table public.pipeline_payments
  add column if not exists via_stripe boolean not null default false,
  add column if not exists refunded_cents bigint not null default 0,
  add column if not exists stripe_payment_intent_id text,
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_charge_id text,
  add column if not exists invoice_id uuid references public.pipeline_invoices(id) on delete restrict;

alter table public.pipeline_payments drop constraint if exists pipeline_payments_refund_range;
alter table public.pipeline_payments add constraint pipeline_payments_refund_range
  check (refunded_cents >= 0 and refunded_cents <= amount_cents);

alter table public.pipeline_payments drop constraint if exists pipeline_payments_stripe_ids;
alter table public.pipeline_payments add constraint pipeline_payments_stripe_ids
  check (
    (via_stripe and stripe_payment_intent_id is not null)
    or (not via_stripe and refunded_cents = 0 and stripe_payment_intent_id is null
        and stripe_checkout_session_id is null and stripe_charge_id is null)
  );

-- One payment per PaymentIntent: a repeated webhook can't record it twice.
create unique index if not exists pipeline_payments_stripe_pi_key
  on public.pipeline_payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists pipeline_payments_stripe_charge_idx
  on public.pipeline_payments (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists pipeline_payments_invoice_idx
  on public.pipeline_payments (invoice_id) where invoice_id is not null;

-- A client records only payments it typed in.
drop policy if exists pipeline_payments_insert on public.pipeline_payments;
create policy pipeline_payments_insert on public.pipeline_payments
  for insert to authenticated
  with check (
    private.crm_can_bill(contact_id, (select auth.uid()))
    and created_by = (select auth.uid())
    and not via_stripe
    and refunded_cents = 0
    and stripe_payment_intent_id is null
    and stripe_checkout_session_id is null
    and stripe_charge_id is null
  );

-- A payment taken by card stays: it is refunded in Stripe, never erased here.
drop policy if exists pipeline_payments_delete on public.pipeline_payments;
create policy pipeline_payments_delete on public.pipeline_payments
  for delete to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())) and not via_stripe);

-- Held credit, counted net of what Stripe refunded: a refund comes off the
-- payment's held credit first, then off what it paid toward the package
-- (lib/payments.ts deriveAccount).
create or replace function private.pipeline_credit_available(p_contact uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with pay as (
    select coalesce(sum(amount_cents - refunded_cents), 0) as received,
           coalesce(sum(greatest(0, credit_cents - refunded_cents)), 0) as held
    from public.pipeline_payments where contact_id = p_contact
  ), inv as (
    select coalesce(sum(credit_applied_cents), 0) as applied
    from public.pipeline_invoices where contact_id = p_contact and voided_at is null
  ), ref as (
    select coalesce(sum(amount_cents), 0) as refunded
    from public.pipeline_credit_refunds where contact_id = p_contact
  ), pkg as (
    select total_cents from public.pipeline_packages where contact_id = p_contact
  )
  select greatest(0,
           pay.held - inv.applied - ref.refunded
           + greatest(0, pay.received - pay.held + inv.applied - coalesce(pkg.total_cents, 0)))
  from pay, inv, ref left join pkg on true;
$$;

revoke all on function private.pipeline_credit_available(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Webhook events already handled
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_webhook_events (
  id           text primary key check (id ~ '^evt_[A-Za-z0-9_]{1,255}$'),
  type         text not null check (length(type) <= 120),
  account      text check (length(account) <= 80),
  received_at  timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;

-- No policy: only the service role reads or writes it.
revoke all on public.stripe_webhook_events from public, anon, authenticated;

select private.attach_approval_gate('public.stripe_webhook_events');
