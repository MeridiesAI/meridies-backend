-- Every approved counselor starts with one meeting type: "Meeting", 30 minutes, Google Meet.
--
-- A student's "Book a time" needs booking switched on AND at least one active meeting type
-- (20261111000001), and the type was only ever made by hand with "Add a meeting type", so a counselor
-- who turned booking on still showed their students nothing. This file gives each counselor the one
-- type almost everyone wants, ready to use; they rename, change or delete it like any other.
--
--   1. private.seed_default_booking_type(uuid): for an approved counselor with NO meeting types, inserts
--      ('Meeting', 30 min, google-meet, active, first). Idempotent (a counselor with any type, including
--      one they renamed, is left alone; the unique name index makes a race a no-op).
--   2. A one-time backfill for every approved counselor who has no type today.
--   3. A trigger on profiles that seeds it when a counselor is APPROVED (null -> set, or an approved row
--      inserted), so new counselors get it too.
--
-- Seeded once, never again: the trigger fires only at approval and the backfill only runs here, so a
-- counselor who deletes it keeps their choice (the one exception is an account revoked and approved again).
-- Booking itself stays off until the counselor switches it on (booking_settings.enabled defaults to false),
-- so no student sees anything new until then. Google Calendar need not be connected: a booking without a
-- Meet link works (lib/bookingCalendar.ts, `conference: "not-connected"`).
--
-- Deploy order: either. The code is unchanged and reads types the way it always did. Additive only (two
-- functions, one trigger, inserted rows); not in REQUIRED_SCHEMA. Needs 20261111000001 (booking_meeting_types).
-- The seed never blocks an approval: a failure inside the trigger is a WARNING, not an error.

create or replace function private.seed_default_booking_type(p_counselor uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = p_counselor and role = 'counselor' and counselor_approved_at is not null
  ) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('booking-default-type:' || p_counselor::text));
  if exists (select 1 from public.booking_meeting_types where counselor_id = p_counselor) then
    return;
  end if;
  insert into public.booking_meeting_types (counselor_id, name, duration_minutes, mode, active, sort_order)
  values (p_counselor, 'Meeting', 30, 'google-meet', true, 0)
  on conflict do nothing;
end;
$$;

revoke all on function private.seed_default_booking_type(uuid) from public, anon, authenticated;

create or replace function private.booking_default_type_trigger()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private'
as $$
begin
  if new.role = 'counselor'
     and new.counselor_approved_at is not null
     and (tg_op = 'INSERT' or old.counselor_approved_at is null) then
    begin
      perform private.seed_default_booking_type(new.id);
    exception when others then
      -- Approval must never fail because of a convenience default.
      raise warning 'default booking type not seeded for %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke all on function private.booking_default_type_trigger() from public, anon, authenticated;

drop trigger if exists profiles_default_booking_type on public.profiles;
create trigger profiles_default_booking_type
  after insert or update of counselor_approved_at on public.profiles
  for each row execute function private.booking_default_type_trigger();

-- One-time backfill: every approved counselor without a meeting type.
select private.seed_default_booking_type(p.id)
  from public.profiles p
 where p.role = 'counselor'
   and p.counselor_approved_at is not null
   and not exists (select 1 from public.booking_meeting_types t where t.counselor_id = p.id);
