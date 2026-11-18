-- Zoom: a counselor connects their Zoom account like Google or Microsoft, and a meeting can be a Zoom meeting.
--
--   integration_tokens, integration_oauth_states, integrations   `provider` may be 'zoom' (the OAuth handshake and the
--                                    visible grant; tokens stay encrypted and service-role only, nothing about that changes).
--   meetings.mode                    'zoom' joins google-meet, teams, in-person, phone.
--   meetings.calendar_provider       'zoom' too: the pointer's `calendar_event_id` is then the Zoom meeting's id, so moving,
--                                    cancelling or deleting the meeting here does the same in Zoom.
--   axis_trash_restored_meetings     reports a Zoom pointer as it does Google and Microsoft, so an AxIS Restore puts the
--                                    Zoom meeting back (a new one, with a new link) instead of leaving the old, dead link.
--
-- Left alone on purpose: booking_meeting_types, public_bookings, book_meeting_slot, book_public_slot (student and public
-- booking stay Meet / Teams / in person / phone) and documents.external_provider (Zoom has no files).
--
-- Deploy order: either. Additive only: each constraint is dropped and re-added with one more allowed value, and no row
-- changes. Zoom is also off until ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET are set on the API. Before this is applied a Zoom
-- connect fails at its first write and a Zoom meeting cannot be saved (the API deletes the Zoom meeting it just made).
-- Not in REQUIRED_SCHEMA. No table is created, so no RLS or approval gate to attach.

alter table public.integration_tokens drop constraint if exists integration_tokens_provider_check;
alter table public.integration_tokens add constraint integration_tokens_provider_check
  check (provider in ('google','microsoft','zoom'));

alter table public.integration_oauth_states drop constraint if exists integration_oauth_states_provider_check;
alter table public.integration_oauth_states add constraint integration_oauth_states_provider_check
  check (provider in ('google','microsoft','zoom'));

alter table public.integrations drop constraint if exists integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check check (provider in (
  'google','microsoft','zoom',
  'google-drive','google-calendar','onedrive',
  'common-app','scoir','maialearning','csv','gmail','outlook','twilio'
));

alter table public.meetings drop constraint if exists meetings_mode_check;
alter table public.meetings add constraint meetings_mode_check
  check (mode in ('google-meet','teams','zoom','in-person','phone'));

alter table public.meetings drop constraint if exists meetings_calendar_provider_check;
alter table public.meetings add constraint meetings_calendar_provider_check
  check (calendar_provider in ('google','microsoft','zoom'));

comment on table public.integration_tokens is
  'OAuth tokens for the google/microsoft/zoom connections. Service role only: RLS on with no policies, grants revoked. Token columns are AES-256-GCM ciphertext (INTEGRATION_TOKEN_KEY); never copy them into integrations.config.';
comment on column public.meetings.mode is
  'Google Meet, Microsoft Teams, Zoom, in person or phone.';
comment on column public.meetings.calendar_event_id is
  'The event the API created on the counselor''s Google or Outlook calendar, or the Zoom meeting it created on their Zoom account, when the meeting was booked with a conference link. Null for meetings recorded only in Meridies.';

-- The same function as 20261113000001, with 'zoom' among the providers it reports.
create or replace function public.axis_trash_restored_meetings(p_action uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null or p_action is null or not coalesce(private.is_counselor(v_uid), false) then
    return '[]'::jsonb;
  end if;
  perform set_config('meridies.axis_restore', 'on', true);
  with gone as (
    select (t.row_pk ->> 'id')::uuid as id,
           t.row_data ->> 'calendar_provider' as provider,
           nullif(t.row_data ->> 'calendar_event_id', '') is not null as had_event,
           coalesce((t.row_data ->> 'ics_sequence')::integer, 0) as seq
    from private.axis_trash t
    where t.action_id = p_action
      and t.table_name = 'meetings'
      and t.kind = 'delete'
      and t.deleted_by = v_uid
      and t.restored_at is not null
  ), bumped as (
    update public.meetings m
       set ics_sequence = greatest(m.ics_sequence, g.seq + 2)
      from gone g
     where m.id = g.id
    returning m.id, g.provider, g.had_event
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id,
           'calendarProvider', case when b.had_event and b.provider in ('google', 'microsoft', 'zoom') then b.provider end
         )), '[]'::jsonb)
    into v_out
    from bumped b;
  perform set_config('meridies.axis_restore', 'off', true);
  return v_out;
end;
$$;
revoke all on function public.axis_trash_restored_meetings(uuid) from public, anon, service_role;
grant execute on function public.axis_trash_restored_meetings(uuid) to authenticated;
