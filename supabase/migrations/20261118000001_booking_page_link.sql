-- Two booking / invite fixes (owner approved, "OK booking migration").
--
-- 1. A counselor's own Google Calendar booking page (an appointment schedule), linked from Settings > Booking
--    and shown to their students as "Book on {counselor}'s calendar", beside Meridies' own booking or instead of it.
--
--      booking_settings.booking_page_url    https://calendar.app.google/... or https://calendar.google.com/calendar/...
--                                           (null: no page linked). The API checks the same rule first
--                                           (lib/bookingPage.ts parseBookingPageUrl); this CHECK refuses any other
--                                           host or scheme from a direct write.
--      booking_settings.booking_page_mode   'alongside' (both) or 'instead' (the page only: Meridies' own booking is
--                                           off for new bookings and moves; cancels keep working, as when paused)
--
--    On the table that already holds the counselor's booking choices: owner-only (booking_settings_owner) behind the
--    approval gate; a student never reads it directly (the API reads it with the service role for
--    /me/booking/types, for the student's own approved counselor only). No new policy or grant: the row policies
--    and table grants cover columns added later. Additive; existing rows get no page and 'alongside'.
--
-- 2. SEQUENCE now also rises when only `guardians_invited` changes. Before, a guardian taken off a meeting (CANCEL)
--    and put back (REQUEST) got both at the same SEQUENCE, and Google or Outlook may ignore a REQUEST that doesn't
--    outrank the CANCEL before it. private.meetings_ics_sequence() is re-created from its definition in
--    20261023090001 (the only one), with `guardians_invited` added to both column lists and nothing else changed:
--    same language, SECURITY INVOKER, search_path and grants. Only the function is replaced: the trigger
--    `meetings_ics_sequence` (and the axis-restore WHEN clause 20261108000003 put on it) is left exactly as it is.
--    No code change is needed: every invite round reads ics_sequence back from the saved row.
--
-- Deploy order: either. Before this file the API (lib/bookingPage.ts bookingPageReady) never names the two
-- columns: GET /booking/settings answers bookingPageReady: false, a PUT naming them is 503
-- booking_page_unavailable, and students see no link. Not in REQUIRED_SCHEMA.

alter table public.booking_settings
  add column if not exists booking_page_url text
    constraint booking_settings_booking_page_url_check check (
      booking_page_url is null or (
        length(booking_page_url) <= 500
        and booking_page_url ~ '^https://(calendar\.google\.com/calendar/|calendar\.app\.google/)[^\s"<>\\]+$'
      )
    ),
  add column if not exists booking_page_mode text not null default 'alongside'
    constraint booking_settings_booking_page_mode_check check (booking_page_mode in ('alongside', 'instead'));

comment on column public.booking_settings.booking_page_url is
  'The counselor''s Google Calendar appointment-schedule page (calendar.app.google or calendar.google.com/calendar/ only), shown to their students as a link. Null: none.';
comment on column public.booking_settings.booking_page_mode is
  'alongside: students see Meridies booking and the page; instead: only the page (Meridies booking off for new bookings and moves; cancels still work).';

-- The SEQUENCE only grows, and only on a change an invitee's calendar would
-- show (or invites switching on or off, or the guardians being invited or not,
-- so a re-invite outranks the cancel before it). A client-supplied value is
-- ignored either way.
create or replace function private.meetings_ics_sequence()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    new.ics_sequence := 0;
  elsif (new.title, new.starts_at, new.ends_at, new.location, new.join_url, new.mode, new.agenda, new.status, new.send_invites, new.guardians_invited)
        is distinct from
        (old.title, old.starts_at, old.ends_at, old.location, old.join_url, old.mode, old.agenda, old.status, old.send_invites, old.guardians_invited) then
    new.ics_sequence := old.ics_sequence + 1;
  else
    new.ics_sequence := old.ics_sequence;
  end if;
  return new;
end
$function$;

revoke all on function private.meetings_ics_sequence() from public, anon, authenticated;
