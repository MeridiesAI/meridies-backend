-- Counselor alerts: the settings, one inactivity alert per streak, and room for a weekly family digest.
--
--   accountability_settings.inactive_alert_days   null = off; 1-90 = tell me when a student has done
--                                                 nothing for this many days (counselor-wide row, or a
--                                                 per-student row that wins over it)
--   accountability_settings.notify_on_essay       also email me when a student works on an essay (the
--                                                 bell notice is always on)
--   accountability_settings.weekly_digest         'off' | 'draft': draft a weekly family report for me to
--                                                 review (the job ships separately)
--
--   student_inactivity_alerts   one row per inactive streak, keyed (student_id, last_activity_at): the
--                               scheduled sweep inserts with ON CONFLICT DO NOTHING and tells the counselor
--                               only when the row is new, so a streak is announced once and new activity
--                               (a later last_activity_at) starts a new one. Service role writes; the
--                               student's counselor reads.
--
--   student_last_progress(uuid[])   the newest progress_events time per student that the student made
--                               (actor_id = the student, or null for legacy and system rows), for the
--                               sweep: a counselor's edit or tick is not the student's activity.
--                               EXECUTE to service_role only.
--
--   profiles.last_active_at   no longer client-writable: the API stamps it on the service client. With the
--                               client grant a student could set a far-future time and switch their own
--                               alert off (the API also ignores a future time).
--
--   family_reports.kind   gains 'weekly'; one weekly report per student per period_start.
--
-- Deploy order: either. The API reads the new settings through `loadSettings`, which fills them with the
-- defaults (all off) when the columns are missing, and a PUT that sets one answers 503
-- `alert_settings_unavailable` until this is applied; the sweep's inactivity pass logs and skips. The
-- previous build never reads any of it. Additive only: new nullable/defaulted columns, a new table and
-- function, a widened CHECK and a partial unique index (on a kind nothing writes yet). Not in
-- REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. accountability_settings: the alert settings
-- ---------------------------------------------------------------------------

alter table public.accountability_settings
  add column if not exists inactive_alert_days smallint,
  add column if not exists notify_on_essay boolean not null default false,
  add column if not exists weekly_digest text not null default 'off';

alter table public.accountability_settings
  drop constraint if exists accountability_settings_inactive_alert_days_check;
alter table public.accountability_settings
  add constraint accountability_settings_inactive_alert_days_check
  check (inactive_alert_days is null or inactive_alert_days between 1 and 90);

alter table public.accountability_settings
  drop constraint if exists accountability_settings_weekly_digest_check;
alter table public.accountability_settings
  add constraint accountability_settings_weekly_digest_check
  check (weekly_digest in ('off', 'draft'));

-- ---------------------------------------------------------------------------
-- 2. student_inactivity_alerts
-- ---------------------------------------------------------------------------

create table if not exists public.student_inactivity_alerts (
  student_id       uuid not null references public.profiles(id) on delete cascade,
  last_activity_at timestamptz not null,
  created_at       timestamptz not null default now(),
  primary key (student_id, last_activity_at)
);

create index if not exists student_inactivity_alerts_recent
  on public.student_inactivity_alerts (student_id, created_at desc);

alter table public.student_inactivity_alerts enable row level security;

drop policy if exists student_inactivity_alerts_select_counselor on public.student_inactivity_alerts;
create policy student_inactivity_alerts_select_counselor on public.student_inactivity_alerts
  for select to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())));

-- No client writes: the scheduled sweep (service role) is the only writer.
revoke all on public.student_inactivity_alerts from anon, authenticated;
grant select on public.student_inactivity_alerts to authenticated;
grant all on public.student_inactivity_alerts to service_role;

select private.attach_approval_gate('public.student_inactivity_alerts');

-- ---------------------------------------------------------------------------
-- 3. The newest progress event per student, for the sweep
-- ---------------------------------------------------------------------------

create or replace function public.student_last_progress(p_students uuid[])
returns table (student_id uuid, last_event_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select s.id, (
    select max(e.created_at) from public.progress_events e
     where e.student_id = s.id
       and (e.actor_id = s.id or e.actor_id is null)
  )
  from unnest(p_students) as s(id)
$$;

revoke all on function public.student_last_progress(uuid[]) from public, anon, authenticated;
grant execute on function public.student_last_progress(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. profiles.last_active_at: the API's to write, not the client's
-- ---------------------------------------------------------------------------

-- profiles has column-level UPDATE grants (20260828000014/16), so this takes away exactly this column.
-- Nothing in the app or the API writes it as the signed-in user.
revoke update (last_active_at) on public.profiles from authenticated;

-- ---------------------------------------------------------------------------
-- 5. family_reports: the weekly digest's kind, one per student per week
-- ---------------------------------------------------------------------------

alter table public.family_reports drop constraint if exists family_reports_kind_check;
alter table public.family_reports
  add constraint family_reports_kind_check
  check (kind in ('progress', 'milestone', 'monthly', 'ad-hoc', 'weekly'));

-- period_start / period_end exist since 20260828000005; kept here so this file stands alone.
alter table public.family_reports
  add column if not exists period_start date,
  add column if not exists period_end date;

create unique index if not exists family_reports_weekly_once
  on public.family_reports (student_id, kind, period_start)
  where kind = 'weekly';
