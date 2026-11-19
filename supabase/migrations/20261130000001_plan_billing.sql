-- Per-student plan billing (Feature 4), NOT switched on by this migration.
--
--   plan_subscriptions   one row per Consultant: which kind of plan they are on (standard, founding or custom), their
--                        Stripe customer and subscription, the state Stripe last reported, and when a failed payment
--                        started. Stripe is the source of truth; the plan webhook (/webhooks/stripe-billing) keeps this
--                        in step. The Consultant reads their own row; only the service role writes.
--   plan_billing_events  the plan webhook's handled event ids, so a redelivery is answered without work.
--
-- Deploy order: either. Additive. Nothing reads these tables unless BILLING_ENABLED=true.

create table if not exists public.plan_subscriptions (
  counselor_id           uuid primary key references public.profiles(id) on delete cascade,
  kind                   text not null default 'standard' check (kind in ('standard', 'founding', 'custom')),
  stripe_customer_id     text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id text unique check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  billing_interval       text check (billing_interval is null or billing_interval in ('month', 'year')),
  status                 text not null default 'none' check (status in ('none', 'active', 'past_due', 'canceled')),
  -- A plan can be set up ahead of time: until this moment the account has no access (a founding client who starts later).
  access_starts_at       timestamptz,
  billed_students        integer check (billed_students is null or billed_students between 0 and 100000),
  started_at             timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  past_due_since         timestamptz,
  canceled_at            timestamptz,
  -- The first-month money-back is once per customer: set when a full refund cancels the subscription.
  money_back_used_at     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists plan_subscriptions_set_updated_at on public.plan_subscriptions;
create trigger plan_subscriptions_set_updated_at before update on public.plan_subscriptions
  for each row execute function public.set_updated_at();

alter table public.plan_subscriptions enable row level security;
revoke all on public.plan_subscriptions from public, anon, authenticated;
grant select on public.plan_subscriptions to authenticated;
grant all on public.plan_subscriptions to service_role;

drop policy if exists plan_subscriptions_select_own on public.plan_subscriptions;
create policy plan_subscriptions_select_own on public.plan_subscriptions
  for select to authenticated using (counselor_id = (select auth.uid()));

select private.attach_approval_gate('public.plan_subscriptions');

create table if not exists public.plan_billing_events (
  id          text primary key check (length(id) between 5 and 120),
  type        text not null check (length(type) <= 120),
  received_at timestamptz not null default now()
);

alter table public.plan_billing_events enable row level security;
revoke all on public.plan_billing_events from public, anon, authenticated;
grant all on public.plan_billing_events to service_role;
