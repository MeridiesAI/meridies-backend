-- Email blast: combined filters, parents, and scheduled / yearly sends.
--
-- A blast is now written with filters that combine (class year, colleges a
-- student is applying to, application status), an optional hand-picked set of
-- students inside them, and a recipient type: the students, or their parents
-- (guardians with an email and alerts on).
--
-- A blast can also be scheduled for a date and time, repeating yearly. A
-- scheduled blast is a row in status `scheduled`; the `email-blasts` cron
-- (POST /internal/blasts/dispatch) sends it when `scheduled_for` passes,
-- resolving who it reaches again at that moment. A yearly one stays
-- `scheduled` with `scheduled_for` moved a year on, and each run is written as
-- its own `email_blasts` row (so "who got this" stays answerable per send).
--
--   * `filters`       {"classYears": [...], "colleges": [...], "statuses": [...]}
--   * `student_ids`   the students the counselor left ticked; null = all matches
--   * `claimed_at`    set by the dispatcher before it sends, reclaimed after 10
--                     minutes, so overlapping runs cannot send a blast twice
--
-- No new table, so no new RLS. The owner policy already covers these columns;
-- a client that writes its own `scheduled` row gains nothing, because the
-- dispatcher resolves recipients from the counselor's live roster and ignores
-- anything the row says about who they are.
--
-- Deploy order: either. The serving build keeps writing the older kinds (a
-- `selection` blast) until this is applied, and the new code answers 503
-- `blast_schedule_unavailable` for a scheduled blast until then. Not in
-- REQUIRED_SCHEMA. Then add the Railway cron service for the dispatcher.

alter table public.email_blasts
  add column if not exists recipient_type text not null default 'students',
  add column if not exists filters        jsonb not null default '{}'::jsonb,
  add column if not exists student_ids    uuid[],
  add column if not exists scheduled_for  timestamptz,
  add column if not exists repeat_yearly  boolean not null default false,
  add column if not exists claimed_at     timestamptz;

alter table public.email_blasts drop constraint if exists email_blasts_recipient_type_check;
alter table public.email_blasts
  add constraint email_blasts_recipient_type_check check (recipient_type in ('students', 'parents'));

alter table public.email_blasts drop constraint if exists email_blasts_filters_is_object;
alter table public.email_blasts
  add constraint email_blasts_filters_is_object
  check (jsonb_typeof(filters) = 'object' and pg_column_size(filters) <= 20000);

alter table public.email_blasts drop constraint if exists email_blasts_student_ids_bound;
alter table public.email_blasts
  add constraint email_blasts_student_ids_bound check (student_ids is null or cardinality(student_ids) <= 500);

-- The new kind, and the new status.
alter table public.email_blasts drop constraint if exists email_blasts_audience_kind_check;
alter table public.email_blasts
  add constraint email_blasts_audience_kind_check
  check (audience_kind in ('roster', 'class-year', 'school', 'status', 'selection', 'filters'));

alter table public.email_blasts drop constraint if exists email_blasts_targeted_kinds_need_a_value;
alter table public.email_blasts
  add constraint email_blasts_targeted_kinds_need_a_value
  check (audience_kind in ('roster', 'selection', 'filters') or audience_value is not null);

alter table public.email_blasts drop constraint if exists email_blasts_status_check;
alter table public.email_blasts
  add constraint email_blasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'partial', 'failed', 'cancelled'));

alter table public.email_blasts drop constraint if exists email_blasts_scheduled_needs_a_time;
alter table public.email_blasts
  add constraint email_blasts_scheduled_needs_a_time
  check (status <> 'scheduled' or scheduled_for is not null);

-- Only a repeating blast repeats: a yearly row that is not scheduled would
-- never run again.
alter table public.email_blasts drop constraint if exists email_blasts_repeat_needs_a_time;
alter table public.email_blasts
  add constraint email_blasts_repeat_needs_a_time
  check (not repeat_yearly or scheduled_for is not null);

-- What the dispatcher scans, and what the Queued tab lists.
create index if not exists email_blasts_scheduled_idx
  on public.email_blasts (scheduled_for)
  where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- The cron's heartbeat
-- ---------------------------------------------------------------------------

-- Read the current CHECK back and add the label, so another migration's label
-- is never dropped (as 20261028000004 does).
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

  if not ('email-blasts' = any(v_values)) then
    v_values := array_append(v_values, 'email-blasts'::text);
    alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
    execute format('alter table public.job_heartbeats add constraint job_heartbeats_job_check check (job = any (%L::text[]))', v_values);
  end if;
end;
$$;

insert into public.job_heartbeats (job, expected_every)
values ('email-blasts', interval '15 minutes')
on conflict (job) do nothing;
