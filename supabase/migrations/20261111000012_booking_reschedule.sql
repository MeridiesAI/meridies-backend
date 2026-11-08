-- Student self-booking, part 2: a student moves one of their own meetings.
--
-- public.reschedule_meeting_slot(p_meeting, p_student, p_counselor, p_starts_at, p_ends_at)
-- is book_meeting_slot's twin for a meeting that already exists
-- (20261111000001 is left as it is). SECURITY DEFINER, EXECUTE to service_role
-- only. Under the same transaction advisory lock per counselor
-- (hashtext('booking:' || counselor)), so a booking and a move can't both
-- take one slot, it re-checks that the student is the counselor's own active
-- student, the counselor is approved and has booking on, that the meeting is
-- this student's (primary attendee) with this counselor and still scheduled,
-- and that no OTHER scheduled meeting of the counselor's overlaps the new time
-- widened by the buffer (the meeting being moved never blocks itself). Then
-- it moves the meeting and returns it; the ICS SEQUENCE goes up through the
-- existing trigger private.meetings_ics_sequence. Errors, by message (and
-- SQLSTATE):
--   slot_taken          23P01  another scheduled meeting is in the way
--   booking_disabled    P0001  no settings row, or enabled is false
--   not_your_counselor  P0001  not this counselor's active student, or the counselor isn't approved
--   meeting_not_found   P0001  not this student's scheduled meeting with this counselor
--   invalid_slot        P0001  a start not in the future, end not after start, or over 180 minutes
-- The API checks the rest first (the slot grid, the cutoff, students_can_reschedule;
-- routes/studentBooking.ts). booked_by_student is not touched: a meeting the
-- counselor booked stays theirs.
--
-- No table, so no policy or approval gate to attach.
--
-- Deploy order: after 20261111000001 (it reads booking_settings). Either order
-- with the code: without this file PATCH /me/booking/:id answers 503
-- `booking_unavailable`; booking and cancelling work. Not in REQUIRED_SCHEMA.

create or replace function public.reschedule_meeting_slot(
  p_meeting   uuid,
  p_student   uuid,
  p_counselor uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns public.meetings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  settings public.booking_settings;
  buffer   interval;
  moved    public.meetings;
begin
  if p_meeting is null or p_student is null or p_counselor is null or p_starts_at is null or p_ends_at is null
     or p_starts_at <= now()
     or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '180 minutes' then
    raise exception 'invalid_slot' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('booking:' || p_counselor::text));

  if not private.is_counselor(p_counselor) or not exists (
    select 1 from public.profiles s
     where s.id = p_student and s.role = 'student' and s.counselor_id = p_counselor and s.archived_at is null
  ) then
    raise exception 'not_your_counselor' using errcode = 'P0001';
  end if;

  select * into settings from public.booking_settings where counselor_id = p_counselor;
  if not found or not settings.enabled then
    raise exception 'booking_disabled' using errcode = 'P0001';
  end if;
  buffer := make_interval(mins => settings.buffer_minutes);

  perform 1 from public.meetings m
   where m.id = p_meeting and m.student_id = p_student and m.counselor_id = p_counselor and m.status = 'scheduled'
   for update;
  if not found then
    raise exception 'meeting_not_found' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.meetings m
     where m.counselor_id = p_counselor
       and m.id <> p_meeting
       and m.status = 'scheduled'
       and m.starts_at < p_ends_at + buffer
       and coalesce(m.ends_at, m.starts_at + interval '1 hour') > p_starts_at - buffer
  ) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  update public.meetings
     set starts_at = p_starts_at, ends_at = p_ends_at
   where id = p_meeting
  returning * into moved;

  return moved;
end;
$$;

revoke all on function public.reschedule_meeting_slot(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.reschedule_meeting_slot(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;

comment on function public.reschedule_meeting_slot(uuid, uuid, uuid, timestamptz, timestamptz) is
  'Student booking: moves the student''s own scheduled meeting after re-checking the relationship, the settings and overlap (with buffer, ignoring the meeting itself) under the per-counselor advisory lock. Service role only.';
