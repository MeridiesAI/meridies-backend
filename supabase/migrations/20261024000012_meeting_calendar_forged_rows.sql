-- Meetings: neutralise rows that already name, as their owner, a counselor
-- with no hold on the meeting's student.
--
-- Why. 20261024000011 stops a user session writing a meeting for someone
-- else, but rows written before it is applied stay as they were. Before it,
-- meetings_write checked only the caller's own access to the student, so any
-- approved counselor could insert a meeting about their own student with
-- counselor_id set to another counselor and calendar_provider /
-- calendar_event_id set to that counselor's real Google or Outlook event. The
-- API no longer calls a provider for a meeting the caller doesn't own
-- (lib/meetingCalendar.ts), and no longer emails invites or spends the
-- invite throttle for a meeting whose owner doesn't hold its student
-- (lib/meetingInvites.ts), so this file is the database half: a forged row
-- loses the event pointer it was forged to carry.
--
-- Which rows. A meeting whose counselor_id is neither the student's counselor
-- (profiles.counselor_id) nor a collaborator on the student (any access).
-- Approval is deliberately not asked: a pending or revoked counselor's own
-- meetings are not forged. The same test also matches a meeting booked by a
-- collaborator who has since been taken off the student; clearing its
-- pointer is harmless, because only the owner's session ever acts on the
-- event, and an owner who can no longer edit the student can't reach the
-- meeting through the API at all. Nothing is deleted and counselor_id is
-- left as it is (the row stays visible to whoever could see it before); the
-- event on the provider's calendar is not touched. A notice names how many
-- rows were cleared; DATABASE_MIGRATION_INSTRUCTIONS.md has the read-only
-- query that lists them.
--
-- The update runs as the migration role, so meetings_owner_guard (a user
-- session check) lets it through, and meetings_ics_sequence doesn't move the
-- SEQUENCE (the pointer isn't a field a calendar shows).
--
-- Deploy order: either, and either way round with 20261024000011 (apply
-- 20261024000011 first so no new forged row can appear after this runs; run
-- this file again by hand if it was applied first: it is idempotent). The
-- code doesn't read anything new and already ignores a forged row's pointer.
-- Not in REQUIRED_SCHEMA: it adds no object.

do $$
declare
  cleared integer;
begin
  with forged as (
    select m.id
      from public.meetings m
      join public.profiles s on s.id = m.student_id
     where (m.calendar_provider is not null or m.calendar_event_id is not null)
       and s.counselor_id is distinct from m.counselor_id
       and not exists (
             select 1 from public.student_collaborators c
              where c.student_id = m.student_id and c.counselor_id = m.counselor_id)
  )
  update public.meetings m
     set calendar_provider = null,
         calendar_event_id = null
    from forged
   where m.id = forged.id;
  get diagnostics cleared = row_count;
  raise notice 'meetings: cleared the calendar event pointer on % meeting(s) whose owner has no hold on the student', cleared;
end
$$;
