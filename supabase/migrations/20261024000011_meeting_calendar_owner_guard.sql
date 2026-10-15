-- Meetings: only the owner points a meeting at a calendar event, nobody
-- changes the owner from a user session, and only counselors with edit access
-- to the student write meetings.
--
-- Why. A meeting booked with a Meet / Teams link remembers its event
-- (calendar_provider, calendar_event_id, 20260923000004) on the calendar of
-- meetings.counselor_id, and the API moves or deletes that event with the
-- owner's stored OAuth tokens. meetings_write (20260918000001) checked only
-- is_counselor_of(student_id), so any approved counselor could, through
-- PostgREST, insert or update a meeting about their own student naming another
-- counselor as counselor_id and that counselor's event id: PATCH or DELETE
-- /meetings/:id then rewrote or deleted the victim's real Google / Outlook
-- event with the victim's token. is_counselor_of also counts read-only
-- collaborators, so a read collaborator could write meetings directly.
--
-- What this adds:
--   1. private.meetings_owner_guard(), BEFORE INSERT OR UPDATE on meetings:
--      from a user session (current_user = 'authenticated') an insert must
--      name the caller as counselor_id; an update may not change
--      counselor_id, and may set, change or clear calendar_provider /
--      calendar_event_id only when the caller is the meeting's counselor_id.
--      Like documents_external_pointer_guard (20260923000004), but keyed off
--      current_user, not auth.uid(): transfer_caseload (20261023030002) is
--      SECURITY DEFINER and runs with the admin's JWT, re-pointing moved
--      meetings to the receiver and clearing their calendar pointer, so it
--      must pass. Deliberately NOT security definer, for the same reason as
--      admission_outcomes_lock_guard (20261023030001): the guard has to see
--      who is writing. The service role and SECURITY DEFINER functions are
--      not user sessions and pass.
--   2. meetings_write is replaced by insert, update and delete policies on
--      private.counselor_can_edit_student (the primary counselor or a write
--      collaborator, approved, never the student). Select is unchanged
--      (meetings_select, meetings_select_attendee).
--   3. meeting_attendees_write: the attendee added must be a student the
--      caller can edit (was is_counselor_of, which counts read access).
--
-- Deploy order: either. The code (lib/meetingCalendar.ts, routes/meetings.ts)
-- already calls a calendar provider only for a meeting the caller owns, with
-- the caller's own token, so it stands without this file; this makes the
-- database refuse the forged row in the first place. The previous build only
-- ever inserts meetings with counselor_id = the caller, never writes
-- counselor_id on update, and sets or clears the pointer only on its own
-- meetings (a write collaborator's cancel or mode change on someone else's
-- calendar-backed meeting did clear it, and is now refused with 403 until the
-- new code is live; the new code keeps the pointer). Not in REQUIRED_SCHEMA:
-- nothing reads a new object.

create or replace function private.meetings_owner_guard()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
declare
  caller uuid := (select auth.uid());
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if caller is null or new.counselor_id is distinct from caller then
      raise exception 'A meeting is booked by the counselor who owns it'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.counselor_id is distinct from old.counselor_id then
    raise exception 'A meeting''s owner changes only through a caseload transfer'
      using errcode = '42501';
  end if;
  if (new.calendar_provider, new.calendar_event_id) is distinct from (old.calendar_provider, old.calendar_event_id)
     and (caller is null or old.counselor_id is distinct from caller) then
    raise exception 'Only the counselor who owns a meeting may change its calendar event'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.meetings_owner_guard() from public, anon, authenticated;

drop trigger if exists meetings_owner_guard on public.meetings;
create trigger meetings_owner_guard
  before insert or update on public.meetings
  for each row execute function private.meetings_owner_guard();

drop policy if exists meetings_write on public.meetings;

drop policy if exists meetings_insert on public.meetings;
create policy meetings_insert on public.meetings
  for insert to authenticated
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists meetings_update on public.meetings;
create policy meetings_update on public.meetings
  for update to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())))
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists meetings_delete on public.meetings;
create policy meetings_delete on public.meetings
  for delete to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists meeting_attendees_write on public.meeting_attendees;
create policy meeting_attendees_write on public.meeting_attendees
  for all to authenticated
  using (private.owns_meeting(meeting_id, (select auth.uid())))
  with check (
    private.owns_meeting(meeting_id, (select auth.uid()))
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  );

comment on column public.meetings.counselor_id is
  'The counselor who owns the meeting and whose calendar its event is on. Set to the booking counselor on insert; changed only by transfer_caseload (meetings_owner_guard).';
