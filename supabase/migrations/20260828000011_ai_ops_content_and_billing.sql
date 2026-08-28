-- AI audit trail, abuse limits, content feeds, and billing.
--
-- Rate limiting lives in the database on purpose: an in-process limiter in the
-- API resets on every Railway deploy and does not hold across replicas. The
-- Fastify limiter is the cheap first gate; `consume_rate_limit` is the one that
-- actually protects spend on the AI routes.

-- ---------------------------------------------------------------------------
-- AI runs — one row per model call. Every /ai/* route writes one.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_runs (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid references public.profiles(id) on delete set null,
  student_id     uuid references public.profiles(id) on delete cascade,
  module         text not null check (module in
                   ('profile-summary','narrative-coherence','family-report','school-reframing',
                    'college-list','college-fit','concierge','scholarship-match','award-appeal',
                    'aid-report','draft-quality','essay-advice','visualizer','chat')),
  model          text not null,
  status         text not null default 'running' check (status in ('running','succeeded','failed','blocked')),
  input          jsonb not null default '{}'::jsonb,
  output         jsonb not null default '{}'::jsonb,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  error          text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists ai_runs_student_idx on public.ai_runs (student_id, created_at desc);
create index if not exists ai_runs_actor_idx on public.ai_runs (actor_id, created_at desc);

alter table public.ai_runs enable row level security;
drop policy if exists ai_runs_select on public.ai_runs;
create policy ai_runs_select on public.ai_runs
  for select to authenticated
  using (
    actor_id = (select auth.uid())
    or (student_id is not null and private.is_counselor_of(student_id, (select auth.uid())))
  );
-- Inserts come from the backend (service_role); clients never write runs.

-- ---------------------------------------------------------------------------
-- Chat (Meridies chat + per-module chat)
-- ---------------------------------------------------------------------------

create table if not exists public.ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  student_id  uuid references public.profiles(id) on delete cascade,
  module      text,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists ai_conversations_owner_idx
  on public.ai_conversations (owner_id, updated_at desc);
drop trigger if exists ai_conversations_set_updated_at on public.ai_conversations;
create trigger ai_conversations_set_updated_at before update on public.ai_conversations
  for each row execute function public.set_updated_at();

alter table public.ai_conversations enable row level security;
drop policy if exists ai_conversations_owner on public.ai_conversations;
create policy ai_conversations_owner on public.ai_conversations
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create table if not exists public.ai_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.ai_conversations(id) on delete cascade,
  owner_id         uuid not null references public.profiles(id) on delete cascade,
  role             text not null check (role in ('user','assistant','system')),
  content          text not null,
  citations        jsonb not null default '[]'::jsonb,
  ai_run_id        uuid references public.ai_runs(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);

alter table public.ai_messages enable row level security;
drop policy if exists ai_messages_owner on public.ai_messages;
create policy ai_messages_owner on public.ai_messages
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Rate limiting + quotas
-- ---------------------------------------------------------------------------

create table if not exists private.rate_limit_buckets (
  key           text primary key,
  window_start  timestamptz not null,
  count         integer not null default 0
);

-- Fixed-window counter. Returns true when the caller is under the limit and
-- the hit was recorded; false when the request should be rejected.
create or replace function private.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path to 'private','public'
as $function$
declare
  v_now    timestamptz := now();
  v_start  timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_count  integer;
begin
  insert into private.rate_limit_buckets (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set count = case when private.rate_limit_buckets.window_start < v_start
                     then 1
                     else private.rate_limit_buckets.count + 1 end,
        window_start = case when private.rate_limit_buckets.window_start < v_start
                            then v_now
                            else private.rate_limit_buckets.window_start end
  returning count into v_count;

  return v_count <= p_limit;
end;
$function$;

revoke all on function private.consume_rate_limit(text, integer, integer) from public, anon, authenticated;

-- Longer-horizon spend guard, readable by the owner so the UI can show it.
create table if not exists public.usage_counters (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references public.profiles(id) on delete cascade,
  metric        text not null check (metric in
                  ('ai_calls','ai_input_tokens','ai_output_tokens','uploads',
                   'parent_alerts','scholarship_searches','invites')),
  period        text not null check (period in ('day','month')),
  period_start  date not null,
  count         bigint not null default 0 check (count >= 0),
  updated_at    timestamptz not null default now()
);

create unique index if not exists usage_counters_unique
  on public.usage_counters (subject_id, metric, period, period_start);

alter table public.usage_counters enable row level security;
drop policy if exists usage_counters_select_own on public.usage_counters;
create policy usage_counters_select_own on public.usage_counters
  for select to authenticated using (subject_id = (select auth.uid()));

create or replace function private.consume_quota(
  p_subject uuid,
  p_metric text,
  p_period text,
  p_limit bigint,
  p_amount bigint default 1
)
returns boolean
language plpgsql
security definer
set search_path to 'private','public'
as $function$
declare
  v_start date := case when p_period = 'month' then date_trunc('month', now())::date
                       else current_date end;
  v_count bigint;
begin
  insert into public.usage_counters (subject_id, metric, period, period_start, count)
  values (p_subject, p_metric, p_period, v_start, p_amount)
  on conflict (subject_id, metric, period, period_start) do update
    set count = public.usage_counters.count + p_amount,
        updated_at = now()
  returning count into v_count;

  return v_count <= p_limit;
end;
$function$;

revoke all on function private.consume_quota(uuid, text, text, bigint, bigint)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles(id) on delete set null,
  student_id   uuid references public.profiles(id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  metadata     jsonb not null default '{}'::jsonb,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists audit_log_actor_idx on public.audit_log (actor_id, created_at desc);
create index if not exists audit_log_student_idx on public.audit_log (student_id, created_at desc);

alter table public.audit_log enable row level security;
drop policy if exists audit_log_select_own on public.audit_log;
create policy audit_log_select_own on public.audit_log
  for select to authenticated
  using (
    actor_id = (select auth.uid())
    or (student_id is not null and private.is_counselor_of(student_id, (select auth.uid())))
  );
-- Append-only from the backend; no client insert/update/delete path.

-- ---------------------------------------------------------------------------
-- Institutional Policy Tracker + Resource Hub
-- ---------------------------------------------------------------------------

create table if not exists public.policy_updates (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid references public.colleges(id) on delete cascade,
  institution         text,
  title               text not null,
  summary             text,
  body                text,
  category            text not null check (category in
                        ('testing','financial-aid','admissions','deadline','policy','program')),
  severity            text not null default 'normal' check (severity in ('high','normal','low')),
  effective_at        date,
  published_at        timestamptz not null default now(),
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists policy_updates_published_idx on public.policy_updates (published_at desc);
create index if not exists policy_updates_college_idx on public.policy_updates (college_id);

alter table public.policy_updates enable row level security;
drop policy if exists policy_updates_select on public.policy_updates;
create policy policy_updates_select on public.policy_updates
  for select to authenticated using (true);

create table if not exists public.policy_update_reads (
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  policy_update_id  uuid not null references public.policy_updates(id) on delete cascade,
  read_at           timestamptz not null default now(),
  primary key (profile_id, policy_update_id)
);

alter table public.policy_update_reads enable row level security;
drop policy if exists policy_update_reads_own on public.policy_update_reads;
create policy policy_update_reads_own on public.policy_update_reads
  for all to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create table if not exists public.resources (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  url          text,
  org          text,
  category     text,
  tags         text[] not null default '{}',
  -- Global rows are the curated directory; a counselor's own rows are private.
  is_global    boolean not null default false,
  created_by   uuid references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists resources_tags_idx on public.resources using gin (tags);
drop trigger if exists resources_set_updated_at on public.resources;
create trigger resources_set_updated_at before update on public.resources
  for each row execute function public.set_updated_at();

alter table public.resources enable row level security;
drop policy if exists resources_select on public.resources;
create policy resources_select on public.resources
  for select to authenticated
  using (is_global or created_by = (select auth.uid()));
drop policy if exists resources_write_own on public.resources;
create policy resources_write_own on public.resources
  for all to authenticated
  using (created_by = (select auth.uid()) and not is_global)
  with check (created_by = (select auth.uid()) and not is_global);

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------

create table if not exists public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  firm_id                   uuid references public.firms(id) on delete cascade,
  counselor_id              uuid references public.profiles(id) on delete cascade,
  plan                      text not null default 'solo' check (plan in ('trial','solo','practice','association')),
  status                    text not null default 'trialing' check (status in
                              ('trialing','active','past_due','canceled','incomplete')),
  seats                     integer not null default 1 check (seats between 1 and 500),
  provider                  text,
  provider_customer_id      text,
  provider_subscription_id  text,
  current_period_end        timestamptz,
  cancel_at                 timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint subscriptions_need_an_owner check (firm_id is not null or counselor_id is not null)
);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (
    counselor_id = (select auth.uid())
    or (firm_id is not null and private.is_firm_admin(firm_id, (select auth.uid())))
  );
-- Only the billing webhook (service_role) writes here.

create table if not exists public.invoices (
  id                uuid primary key default gen_random_uuid(),
  subscription_id   uuid not null references public.subscriptions(id) on delete cascade,
  amount_cents      bigint not null check (amount_cents >= 0),
  currency          text not null default 'usd',
  status            text not null check (status in ('draft','open','paid','void','uncollectible')),
  hosted_url        text,
  issued_at         timestamptz,
  paid_at           timestamptz,
  provider_invoice_id text,
  created_at        timestamptz not null default now()
);

create index if not exists invoices_subscription_idx on public.invoices (subscription_id, issued_at desc);

alter table public.invoices enable row level security;
drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select to authenticated
  using (exists (
    select 1 from public.subscriptions s
    where s.id = invoices.subscription_id
      and (s.counselor_id = (select auth.uid())
           or (s.firm_id is not null and private.is_firm_admin(s.firm_id, (select auth.uid()))))
  ));
