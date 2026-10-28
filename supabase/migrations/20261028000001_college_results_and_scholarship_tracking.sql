-- College results and scholarship tracking (extends existing tables; no new table).
--
-- Results: a school's decision is already student_colleges.status (accepted,
-- denied, waitlisted, deferred, enrolled, withdrawn). This adds the day the
-- decision came, makes "enrolled" the student's one final choice (picking a new
-- one puts the old one back to accepted), and tells the student's counselor in
-- the notification bell when the student records a decision. "Applying to N" is
-- a number the student types, kept with their personal details.
--
-- Scholarship tracking: scholarship_matches already runs suggested -> awarded and
-- holds hand-entered awards (scholarship_id is null for those). This adds the
-- amount won, a requirements checklist, and a "not-awarded" outcome.
--
-- Deploy order: migration first is safest; either works.
--   * Code first: the new routes see a missing column (PGRST204 / 42703) and
--     answer 503 "isn't switched on yet" instead of failing; the old routes
--     never touch the new columns.
--   * Migration first: nothing the previous build reads changes shape. The
--     student-set-decision trigger starts notifying counselors at once.
-- Not in REQUIRED_SCHEMA: no request depends on it.

-- ---------------------------------------------------------------------------
-- 1. Decision date, and enrolled as the one final choice
-- ---------------------------------------------------------------------------

alter table public.student_colleges
  add column if not exists decision_date date;

-- Stamp the day a school first becomes a decision, unless one was given.
create or replace function private.student_colleges_stamp_decision_date()
returns trigger
language plpgsql
security invoker
set search_path to 'private', 'public', 'pg_temp'
as $function$
declare
  v_changed boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_changed := old.status is distinct from new.status;
  end if;
  if v_changed
     and new.status in ('accepted', 'denied', 'waitlisted', 'deferred', 'enrolled', 'withdrawn')
     and new.decision_date is null then
    new.decision_date := current_date;
  end if;
  return new;
end;
$function$;

revoke all on function private.student_colleges_stamp_decision_date() from public;

drop trigger if exists student_colleges_stamp_decision_date on public.student_colleges;
create trigger student_colleges_stamp_decision_date
  before insert or update on public.student_colleges
  for each row execute function private.student_colleges_stamp_decision_date();

-- One final choice per student. Picking a new enrolled school puts the previous
-- one back to accepted. Done by trigger, not a unique index, so a student who
-- somehow already has two enrolled rows cannot make this migration fail.
-- SECURITY DEFINER because a counselor or student may edit only their own
-- student's rows under RLS and this touches sibling rows of the same student.
create or replace function private.student_colleges_one_enrolled()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $function$
declare
  v_changed boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_changed := old.status is distinct from new.status;
  end if;
  if v_changed and new.status = 'enrolled' then
    update public.student_colleges
       set status = 'accepted'
     where student_id = new.student_id
       and id <> new.id
       and status = 'enrolled';
  end if;
  return null;
end;
$function$;

revoke all on function private.student_colleges_one_enrolled() from public;

drop trigger if exists student_colleges_one_enrolled on public.student_colleges;
create trigger student_colleges_one_enrolled
  after insert or update of status on public.student_colleges
  for each row execute function private.student_colleges_one_enrolled();

-- ---------------------------------------------------------------------------
-- 2. Tell the counselor when a student records a decision
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in
  ('deadline','red-flag','report','invite','ai','policy',
   'scholarship','aid','opportunity','system','college-result'));

-- Fires only when the student themself changed the status (auth.uid() is the
-- student; a counselor, the service role or another trigger does not notify) and
-- only at depth 1, so the demotion of a previous final choice is silent. The
-- recipient is the student's primary counselor, and only while approved. A
-- student cannot insert a notification addressed to someone else under RLS,
-- hence SECURITY DEFINER.
create or replace function private.student_colleges_notify_counselor()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $function$
declare
  v_counselor uuid;
  v_student_name text;
  v_label text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if (select auth.uid()) is distinct from new.student_id then return null; end if;
  if new.status not in ('accepted', 'denied', 'waitlisted', 'deferred', 'enrolled', 'withdrawn') then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if old.status is not distinct from new.status then return null; end if;
  end if;

  select counselor_id, full_name into v_counselor, v_student_name
    from public.profiles where id = new.student_id;
  if v_counselor is null or not private.is_counselor(v_counselor) then return null; end if;

  v_label := case new.status
    when 'accepted' then 'accepted'
    when 'denied' then 'rejected'
    when 'waitlisted' then 'waitlisted'
    when 'deferred' then 'deferred'
    when 'enrolled' then 'enrolling'
    else 'withdrawn'
  end;

  insert into public.notifications
    (recipient_id, student_id, kind, urgency, title, body, href, created_by)
  values
    (v_counselor, new.student_id, 'college-result', 'normal',
     coalesce(v_student_name, 'A student') || ': ' || new.name || ' ' || v_label,
     coalesce(v_student_name, 'A student') || ' recorded a result for ' || new.name || '.',
     '/dashboard/counselor/students/' || new.student_id || '/college-list',
     new.student_id);
  return null;
end;
$function$;

revoke all on function private.student_colleges_notify_counselor() from public;

drop trigger if exists student_colleges_notify_counselor on public.student_colleges;
create trigger student_colleges_notify_counselor
  after insert or update of status on public.student_colleges
  for each row execute function private.student_colleges_notify_counselor();

-- ---------------------------------------------------------------------------
-- 3. Scholarship tracking
-- ---------------------------------------------------------------------------

alter table public.scholarship_matches
  add column if not exists awarded_cents bigint check (awarded_cents is null or awarded_cents >= 0),
  add column if not exists requirements jsonb not null default '[]'::jsonb;

alter table public.scholarship_matches drop constraint if exists scholarship_matches_status_check;
alter table public.scholarship_matches add constraint scholarship_matches_status_check check (status in
  ('suggested','saved','applying','applied','awarded','not-awarded','dismissed'));

-- ---------------------------------------------------------------------------
-- 4. "Applying to N"
-- ---------------------------------------------------------------------------

alter table public.student_personal_details
  add column if not exists colleges_planned smallint
    check (colleges_planned is null or colleges_planned between 0 and 99);
