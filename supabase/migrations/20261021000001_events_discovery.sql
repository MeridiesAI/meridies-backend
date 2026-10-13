-- Events that find themselves, and students who can see them.
--
-- 1. Kinds a student plans around: campus-tour, virtual-visit, open-house.
-- 2. hub_events.audience: who a listing is for. 'counselor' (the default, so
--    every existing row keeps its meaning: conferences, IECA, a counselor's
--    own listings), 'student', or 'everyone' (a college's info session, tour,
--    open house). Plus where a listing came from (source: manual | csv |
--    discovered), the page it was cited from (source_url), and when its
--    sign-up link last answered (last_verified_at).
-- 3. One Meridies-wide row per event: a unique index on the same natural key
--    the CSV loader matches on (name, host, start_date; trimmed, whitespace
--    collapsed, case ignored), Meridies-wide rows only, so the discovery job
--    and the loader upsert instead of duplicating.
-- 4. Students read Meridies-wide listings meant for them, and save those to
--    their own calendar. hub_event_saves needs no change: its policy already
--    requires the event to be visible to the saver.
-- 5. The discovery job's labels: ai_runs.module 'events-discovery',
--    ingest_runs.source 'events-discovery', job_heartbeats 'events-discovery'
--    (weekly). Each CHECK is widened additively.

-- ---------------------------------------------------------------------------
-- 1-2. Columns
-- ---------------------------------------------------------------------------

alter table public.hub_events drop constraint if exists hub_events_kind_check;
alter table public.hub_events add constraint hub_events_kind_check
  check (kind in ('conference','webinar','workshop','college-fair','info-session',
                  'campus-tour','virtual-visit','open-house'));

alter table public.hub_events
  add column if not exists audience text not null default 'counselor'
    constraint hub_events_audience_check check (audience in ('counselor','student','everyone')),
  add column if not exists source text not null default 'manual'
    constraint hub_events_source_check check (source in ('manual','csv','discovered')),
  add column if not exists source_url text
    constraint hub_events_source_url_check check (source_url is null or (source_url ~ '^https?://' and length(source_url) <= 2000)),
  add column if not exists last_verified_at timestamptz;

-- Rows loaded from a CSV before this migration have no author and no firm.
update public.hub_events set source = 'csv'
 where created_by is null and firm_id is null and source = 'manual';

-- ---------------------------------------------------------------------------
-- 3. One Meridies-wide row per event
-- ---------------------------------------------------------------------------

create unique index if not exists hub_events_meridies_key
  on public.hub_events (
    lower(regexp_replace(btrim(name), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(host), '\s+', ' ', 'g')),
    start_date
  )
  where created_by is null and firm_id is null;

create index if not exists hub_events_audience_idx on public.hub_events (audience, start_date)
  where created_by is null and firm_id is null;

-- ---------------------------------------------------------------------------
-- 4. Students
-- ---------------------------------------------------------------------------

drop policy if exists hub_events_select_student on public.hub_events;
create policy hub_events_select_student on public.hub_events
  for select to authenticated
  using (
    created_by is null
    and firm_id is null
    and audience in ('student','everyone')
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'student')
  );

-- Only Meridies-wide rows reach a student, and only service_role writes those
-- (the loader and the discovery job). A counselor's own listing (it has an
-- author) never reaches a student, whatever its audience says.

-- ---------------------------------------------------------------------------
-- 5. Labels for the discovery job
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if 'events-discovery' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'events-discovery'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;

alter table public.ingest_runs drop constraint if exists ingest_runs_source_check;
alter table public.ingest_runs add constraint ingest_runs_source_check
  check (source in ('scorecard','ipeds','resources-link-check','events-discovery'));

alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
alter table public.job_heartbeats add constraint job_heartbeats_job_check
  check (job in ('accountability-sweep','message-dispatch','scorecard-ingest','resources-link-check','import-sweep',
                 'events-discovery'));
insert into public.job_heartbeats (job, expected_every)
values ('events-discovery', interval '7 days')
on conflict (job) do nothing;

-- ---------------------------------------------------------------------------
-- 6. A college's visit page
-- ---------------------------------------------------------------------------
-- Where a prospective student signs up for a tour or a session, found by the
-- discovery job on the college's own site and checked to answer. Many colleges
-- load their tour dates with script, so a run may find the page without dated
-- events; the student's Events tab still offers "Plan a visit" from here.
-- Written by service_role only (the catalog's columns are not user-writable).

alter table public.colleges
  add column if not exists visit_url text
    constraint colleges_visit_url_check check (visit_url is null or (visit_url ~ '^https?://' and length(visit_url) <= 2000)),
  add column if not exists visit_url_checked_at timestamptz;
