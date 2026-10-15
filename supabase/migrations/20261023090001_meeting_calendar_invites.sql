-- Emailed calendar invites (lib/meetingInvites.ts, lib/ics.ts).
--
-- A meeting booked with "Email calendar invites" on sends each invited
-- student (and, when the meeting invites them, each guardian who receives
-- messages) an iCalendar file through Resend, whether or not Google or
-- Microsoft is connected. This adds what the invites need on the meeting and
-- the link from each delivery row back to its meeting. No new table, so no
-- new policy and no approval gate to attach: counselors already read these
-- delivery rows through message_deliveries_counselor (student_id is always an
-- invited student), students their own through message_deliveries_student_self,
-- and writes stay service_role (lib/email.ts).
--
-- Safe before or after the code: the previous code selects meetings with *
-- and ignores the new columns, and the new code sends nothing until it sees
-- them (invitesReady).

alter table public.meetings
  add column if not exists send_invites boolean not null default false,
  add column if not exists ics_sequence integer not null default 0;

alter table public.meetings drop constraint if exists meetings_ics_sequence_nonneg;
alter table public.meetings add constraint meetings_ics_sequence_nonneg check (ics_sequence >= 0);

-- An invite is a block of time on someone's calendar: without an end there
-- is no file to send, and no cancellation could be built later either. The
-- route says so with a 400; this keeps a direct PostgREST write honest too.
alter table public.meetings drop constraint if exists meetings_invites_need_end;
alter table public.meetings add constraint meetings_invites_need_end
  check (not send_invites or ends_at is not null);

comment on column public.meetings.send_invites is
  'Email each invitee an iCalendar invite on booking, changes and cancellation (lib/meetingInvites.ts). Off for meetings made before this existed.';
comment on column public.meetings.ics_sequence is
  'RFC 5545 SEQUENCE of the emailed invite. Written only by private.meetings_ics_sequence: raised on every change a calendar shows, never lowered.';

-- The SEQUENCE only grows, and only on a change an invitee's calendar would
-- show (or invites switching on or off, so a re-invite outranks the cancel
-- before it). A client-supplied value is ignored either way.
create or replace function private.meetings_ics_sequence()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    new.ics_sequence := 0;
  elsif (new.title, new.starts_at, new.ends_at, new.location, new.join_url, new.mode, new.agenda, new.status, new.send_invites)
        is distinct from
        (old.title, old.starts_at, old.ends_at, old.location, old.join_url, old.mode, old.agenda, old.status, old.send_invites) then
    new.ics_sequence := old.ics_sequence + 1;
  else
    new.ics_sequence := old.ics_sequence;
  end if;
  return new;
end
$function$;

revoke all on function private.meetings_ics_sequence() from public, anon, authenticated;

drop trigger if exists meetings_ics_sequence on public.meetings;
create trigger meetings_ics_sequence before insert or update on public.meetings
  for each row execute function private.meetings_ics_sequence();

-- Which meeting a delivery row was an invite for. Set null when the meeting
-- is deleted (its cancellations are written with no meeting at all).
alter table public.message_deliveries
  add column if not exists meeting_id uuid references public.meetings(id) on delete set null;

create index if not exists message_deliveries_meeting_idx
  on public.message_deliveries (meeting_id, created_at desc) where meeting_id is not null;

comment on column public.message_deliveries.meeting_id is
  'The meeting a calendar invite, update or cancellation was sent for (templates meeting-invite, meeting-update, meeting-cancel).';
