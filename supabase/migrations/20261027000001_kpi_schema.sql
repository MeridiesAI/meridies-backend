-- Time saved (monthly ROI report), step 1: the tables.
-- Spec: docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
--
-- Deploy order: either. Nothing outside the feature reads these, so none of it
-- is in REQUIRED_SCHEMA; the /kpi routes answer 503 kpi_unavailable until it is
-- applied. Additive only (one nullable column on meetings).

-- A consultant's own figures from signup / Settings. Minutes are maps keyed by
-- task type; each figure records whether the consultant edited it (unedited =
-- "estimated", and left out of prospect averages).
create table if not exists public.kpi_baselines (
  counselor_id            uuid primary key references public.profiles(id) on delete cascade,
  manual                  jsonb not null default '{}'::jsonb check (jsonb_typeof(manual) = 'object'),
  meridies                jsonb not null default '{}'::jsonb check (jsonb_typeof(meridies) = 'object'),
  manual_edited           jsonb not null default '{}'::jsonb check (jsonb_typeof(manual_edited) = 'object'),
  meridies_edited         jsonb not null default '{}'::jsonb check (jsonb_typeof(meridies_edited) = 'object'),
  hourly_rate             numeric(8,2) check (hourly_rate is null or hourly_rate between 1 and 2000),
  rate_edited             boolean not null default false,
  hours_per_student_year  numeric(6,1) check (hours_per_student_year is null or hours_per_student_year between 1 and 500),
  hours_edited            boolean not null default false,
  monthly_email           boolean not null default true,
  unsubscribe_token_hash  text unique check (unsubscribe_token_hash is null or length(unsubscribe_token_hash) = 64),
  prompt_dismissed_at     timestamptz,
  updated_at              timestamptz not null default now()
);

-- Per task in progress: only a running total of active seconds, one server-side
-- last-heartbeat time (cleared after 24 hours) and the last day of activity
-- (for the 14-day abandonment purge). No raw pings are stored.
create table if not exists public.kpi_task_sessions (
  counselor_id       uuid not null references public.profiles(id) on delete cascade,
  task_type          text not null check (task_type in ('college_list','essay_feedback','meeting','family_report','activity_list')),
  subject_id         uuid not null,
  active_seconds     integer not null default 0 check (active_seconds >= 0),
  last_heartbeat_at  timestamptz,
  last_active_on     date not null default current_date,
  primary key (counselor_id, task_type, subject_id)
);
create index if not exists kpi_task_sessions_last_active on public.kpi_task_sessions (last_active_on);

-- The ledger: one row per finished item, every figure snapshotted when it happened.
create table if not exists public.kpi_completions (
  id                  uuid primary key default gen_random_uuid(),
  counselor_id        uuid not null references public.profiles(id) on delete cascade,
  firm_id             uuid references public.firms(id) on delete set null,
  student_id          uuid references public.profiles(id) on delete set null,
  task_type           text not null check (task_type in ('college_list','essay_feedback','meeting','family_report','activity_list')),
  dedupe_key          text not null check (length(dedupe_key) between 1 and 200),
  month               date not null check (extract(day from month) = 1),
  completed_at        timestamptz not null default now(),
  manual_minutes      integer not null check (manual_minutes between 0 and 1440),
  manual_is_estimate  boolean not null,
  measured_seconds    integer not null default 0 check (measured_seconds >= 0),
  meridies_minutes    numeric(10,2) not null check (meridies_minutes >= 0),
  measure_method      text not null check (measure_method in ('active','capped','median','signup')),
  saved_minutes       numeric(10,2) not null,
  hourly_rate         numeric(8,2) not null,
  rate_is_estimate    boolean not null,
  unique (counselor_id, task_type, dedupe_key)
);
create index if not exists kpi_completions_month on public.kpi_completions (counselor_id, month);
create index if not exists kpi_completions_firm_month on public.kpi_completions (firm_id, month) where firm_id is not null;

-- Which source rows produced a completion, so undoing one can find it.
create table if not exists public.kpi_completion_sources (
  completion_id  uuid not null references public.kpi_completions(id) on delete cascade,
  source_table   text not null check (length(source_table) between 1 and 64),
  source_id      uuid not null,
  primary key (source_table, source_id)
);
create index if not exists kpi_completion_sources_completion on public.kpi_completion_sources (completion_id);

-- A month is locked once its report has been finalized.
create table if not exists public.kpi_months (
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  month         date not null check (extract(day from month) = 1),
  finalized_at  timestamptz not null default now(),
  primary key (counselor_id, month)
);

create table if not exists public.kpi_email_sends (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  month         date not null check (extract(day from month) = 1),
  kind          text not null check (kind in ('consultant','firm')),
  firm_id       uuid references public.firms(id) on delete cascade,
  sent_at       timestamptz not null default now()
);
create unique index if not exists kpi_email_sends_once
  on public.kpi_email_sends (recipient_id, month, kind, coalesce(firm_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.meetings add column if not exists notes_sent_at timestamptz;

-- RLS: the consultant reads their own baselines, completions and months.
-- Nothing is client-writable; the API writes through the service role and
-- SECURITY DEFINER functions.
alter table public.kpi_baselines          enable row level security;
alter table public.kpi_task_sessions      enable row level security;
alter table public.kpi_completions        enable row level security;
alter table public.kpi_completion_sources enable row level security;
alter table public.kpi_months             enable row level security;
alter table public.kpi_email_sends        enable row level security;

revoke all on public.kpi_baselines, public.kpi_task_sessions, public.kpi_completions,
  public.kpi_completion_sources, public.kpi_months, public.kpi_email_sends from anon, authenticated;
grant select on public.kpi_baselines, public.kpi_completions, public.kpi_months to authenticated;

drop policy if exists kpi_baselines_select_own on public.kpi_baselines;
create policy kpi_baselines_select_own on public.kpi_baselines
  for select to authenticated using (counselor_id = auth.uid());
drop policy if exists kpi_completions_select_own on public.kpi_completions;
create policy kpi_completions_select_own on public.kpi_completions
  for select to authenticated using (counselor_id = auth.uid());
drop policy if exists kpi_months_select_own on public.kpi_months;
create policy kpi_months_select_own on public.kpi_months
  for select to authenticated using (counselor_id = auth.uid());

select private.attach_approval_gate('public.kpi_baselines');
select private.attach_approval_gate('public.kpi_task_sessions');
select private.attach_approval_gate('public.kpi_completions');
select private.attach_approval_gate('public.kpi_completion_sources');
select private.attach_approval_gate('public.kpi_months');
select private.attach_approval_gate('public.kpi_email_sends');

-- The monthly job's heartbeat. Read the current CHECK back and add the label,
-- so another migration's label is never dropped (as 20261023070001 does).
do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.job_heartbeats'::regclass and c.conname = 'job_heartbeats_job_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if not ('kpi-monthly' = any(v_values)) then
    v_values := array_append(v_values, 'kpi-monthly'::text);
    alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
    execute format('alter table public.job_heartbeats add constraint job_heartbeats_job_check check (job = any (%L::text[]))', v_values);
  end if;
end;
$$;

insert into public.job_heartbeats (job, expected_every)
values ('kpi-monthly', interval '1 day')
on conflict (job) do nothing;
