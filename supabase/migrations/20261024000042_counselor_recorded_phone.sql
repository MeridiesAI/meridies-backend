-- The student's phone number as their counselor recorded it, for reminder
-- texts.
--
-- Why: the due-tomorrow reminder job (lib/studentReminders.ts) texted
-- `student_preferences.sms_phone`, which the student writes and nobody
-- verifies, so a student could point Meridies' Twilio account at any number
-- with titles they wrote. `profiles.phone` is no better: the student can
-- write it too. A text now goes only to the number the counselor saved on
-- the student's card, and only when the student's own reminder number is the
-- same; the counselor saving it is the verification.
--
-- profiles.phone_recorded_by_counselor
--   Written only by the trigger below: when a counselor who can edit the
--   student (private.counselor_can_edit_student: approved, on the roster or
--   a write collaborator, never the student) changes or saves
--   profiles.phone, it copies the number here. The student changing their
--   own phone leaves it as it was. authenticated has no UPDATE grant on the
--   column (profiles UPDATE is granted per column since 20260828000016), so
--   no client writes it directly. service_role and SECURITY DEFINER code
--   don't touch it. No backfill: who wrote an existing phone is unknown.
--
-- Deploy order: either. Before it, the code reads the column as missing
-- (42703, remembered five minutes) and sends no reminder texts at all, which
-- is the safe answer; emails are unaffected. Safe for the previous build: a
-- new nullable column and a trigger that only sets it. Not in
-- REQUIRED_SCHEMA: only the reminder job reads it, and it degrades.

alter table public.profiles
  add column if not exists phone_recorded_by_counselor text
    check (phone_recorded_by_counselor is null or length(phone_recorded_by_counselor) <= 40);

comment on column public.profiles.phone_recorded_by_counselor is
  'The student''s phone as their counselor last saved it; the only number reminder texts go to. Trigger-written.';

create or replace function private.profiles_record_counselor_phone()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Nobody writes the column directly through a client (no grant); a trusted
  -- writer (service_role, postgres) may, and is left alone.
  if v_uid is null then
    return new;
  end if;
  if new.phone_recorded_by_counselor is distinct from old.phone_recorded_by_counselor then
    new.phone_recorded_by_counselor := old.phone_recorded_by_counselor;
  end if;
  if new.role = 'student' and private.counselor_can_edit_student(new.id, v_uid) then
    new.phone_recorded_by_counselor := nullif(btrim(coalesce(new.phone, '')), '');
  end if;
  return new;
end;
$$;

revoke all on function private.profiles_record_counselor_phone() from public, anon, authenticated;

drop trigger if exists profiles_record_counselor_phone on public.profiles;
create trigger profiles_record_counselor_phone
  before update of phone, phone_recorded_by_counselor on public.profiles
  for each row execute function private.profiles_record_counselor_phone();
