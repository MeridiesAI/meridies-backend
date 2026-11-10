-- Student self-booking, part 1: a counselor's booking hours and meeting types,
-- the flag that marks a meeting a student booked, and the one function that
-- books a slot without double-booking.
--
-- 1. booking_settings: one row per counselor. Whether students may book
--    (`enabled`), the counselor's IANA zone, their weekly hours (jsonb, weekday
--    "0"-"6" -> [{start: "HH:MM", end: "HH:MM"}], validated in full by the API,
--    lib/bookingSlots.ts parseWeeklyHours; here only its type and size), the
--    minimum notice, how far ahead, the buffer kept around every meeting, the
--    cancel cutoff and whether students may reschedule.
-- 2. booking_meeting_types: what a student can book (name, 15-180 minutes, how
--    it's held: google-meet, teams, in-person, phone; Zoom left out on purpose).
--    Both tables are owner-only, the policy of calendar_event_types: the
--    counselor reads and writes their own rows, nobody else's. A student never
--    reads them directly: the API reads their counselor's rows with the service
--    role after checking the relationship (routes/studentBooking.ts).
-- 3. meetings.booked_by_student: true only on a meeting book_meeting_slot
--    wrote. Not client-writable: a user session can't insert it true or change
--    it (private.meetings_booked_by_student_guard, keyed off current_user like
--    meetings_owner_guard, 20261024000011, so the service role and SECURITY
--    DEFINER functions pass). It adds no policy, so meetings_owner_guard and the
--    pointer clean-up of 20261024000012 are unchanged.
-- 4. public.book_meeting_slot(...): SECURITY DEFINER, EXECUTE to service_role
--    only. Under a transaction advisory lock per counselor
--    (hashtext('booking:' || counselor)), it re-checks that the student is the
--    counselor's own active student, the counselor is approved and has booking
--    on, and that no scheduled meeting of the counselor's overlaps the slot
--    widened by the buffer; then inserts the meeting (booked_by_student true)
--    and returns it. Errors are distinguishable by message (and SQLSTATE):
--      slot_taken          23P01  another scheduled meeting is in the way
--      booking_disabled    P0001  no settings row, or enabled is false
--      not_your_counselor  P0001  not this counselor's active student, or the counselor isn't approved
--      invalid_slot        P0001  a start not in the future, end not after start, over 180 minutes, an unknown mode or an empty title
--    A meeting with no end counts as an hour, the same as the slot reader.
--
-- Deploy order: either. Additive only; the previous build never reads these
-- objects. Without this file the booking routes answer 503
-- `booking_unavailable` (bookingReady, a zero-row probe). Not in
-- REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. booking_settings
-- ---------------------------------------------------------------------------

create table if not exists public.booking_settings (
  counselor_id            uuid primary key references public.profiles(id) on delete cascade,
  enabled                 boolean not null default false,
  time_zone               text not null default 'America/New_York'
                          check (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+\-]+){0,2}$' and length(time_zone) <= 64),
  weekly_hours            jsonb not null default '{}'::jsonb
                          check (jsonb_typeof(weekly_hours) = 'object' and pg_column_size(weekly_hours) <= 8192),
  min_notice_hours        integer not null default 24 check (min_notice_hours between 0 and 720),
  max_days_ahead          integer not null default 30 check (max_days_ahead between 1 and 365),
  buffer_minutes          integer not null default 0 check (buffer_minutes between 0 and 240),
  cancel_cutoff_hours     integer not null default 24 check (cancel_cutoff_hours between 0 and 720),
  students_can_reschedule boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

drop trigger if exists booking_settings_set_updated_at on public.booking_settings;
create trigger booking_settings_set_updated_at before update on public.booking_settings
  for each row execute function public.set_updated_at();

alter table public.booking_settings enable row level security;

drop policy if exists booking_settings_owner on public.booking_settings;
create policy booking_settings_owner on public.booking_settings
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

revoke all on table public.booking_settings from public, anon;
grant select, insert, update, delete on table public.booking_settings to authenticated;

select private.attach_approval_gate('public.booking_settings');

comment on table public.booking_settings is
  'A counselor''s student-booking hours and rules. Owner-only; students read them only through the API (routes/studentBooking.ts).';

-- ---------------------------------------------------------------------------
-- 2. booking_meeting_types
-- ---------------------------------------------------------------------------

create table if not exists public.booking_meeting_types (
  id               uuid primary key default gen_random_uuid(),
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 80),
  duration_minutes integer not null check (duration_minutes between 15 and 180),
  mode             text not null check (mode in ('google-meet','teams','in-person','phone')),
  active           boolean not null default true,
  sort_order       integer not null default 0 check (sort_order between 0 and 999),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists booking_meeting_types_counselor_idx
  on public.booking_meeting_types (counselor_id, sort_order, created_at);
create unique index if not exists booking_meeting_types_counselor_name
  on public.booking_meeting_types (counselor_id, lower(btrim(name)));

drop trigger if exists booking_meeting_types_set_updated_at on public.booking_meeting_types;
create trigger booking_meeting_types_set_updated_at before update on public.booking_meeting_types
  for each row execute function public.set_updated_at();

alter table public.booking_meeting_types enable row level security;

drop policy if exists booking_meeting_types_owner on public.booking_meeting_types;
create policy booking_meeting_types_owner on public.booking_meeting_types
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

revoke all on table public.booking_meeting_types from public, anon;
grant select, insert, update, delete on table public.booking_meeting_types to authenticated;

select private.attach_approval_gate('public.booking_meeting_types');

comment on table public.booking_meeting_types is
  'What a student can book with a counselor. Owner-only; students read active rows only through the API.';

-- ---------------------------------------------------------------------------
-- 3. meetings.booked_by_student
-- ---------------------------------------------------------------------------

alter table public.meetings
  add column if not exists booked_by_student boolean not null default false;

comment on column public.meetings.booked_by_student is
  'True when the student booked this meeting themselves (public.book_meeting_slot). Never written by a user session.';

create or replace function private.meetings_booked_by_student_guard()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.booked_by_student then
      raise exception 'Only a student''s own booking marks a meeting booked by the student'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.booked_by_student is distinct from old.booked_by_student then
    raise exception 'Only a student''s own booking marks a meeting booked by the student'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.meetings_booked_by_student_guard() from public, anon, authenticated;

drop trigger if exists meetings_booked_by_student_guard on public.meetings;
create trigger meetings_booked_by_student_guard
  before insert or update on public.meetings
  for each row execute function private.meetings_booked_by_student_guard();

-- ---------------------------------------------------------------------------
-- 4. book_meeting_slot
-- ---------------------------------------------------------------------------

create or replace function public.book_meeting_slot(
  p_student   uuid,
  p_counselor uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_mode      text,
  p_title     text,
  p_agenda    text default null
)
returns public.meetings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  settings public.booking_settings;
  buffer   interval;
  booked   public.meetings;
begin
  if p_student is null or p_counselor is null or p_starts_at is null or p_ends_at is null
     or p_starts_at <= now()
     or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '180 minutes'
     or p_mode is null or p_mode not in ('google-meet','teams','in-person','phone')
     or p_title is null or length(btrim(p_title)) not between 1 and 300
     or (p_agenda is not null and length(p_agenda) > 4000) then
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

  if exists (
    select 1 from public.meetings m
     where m.counselor_id = p_counselor
       and m.status = 'scheduled'
       and m.starts_at < p_ends_at + buffer
       and coalesce(m.ends_at, m.starts_at + interval '1 hour') > p_starts_at - buffer
  ) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  insert into public.meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status, agenda, created_by, booked_by_student)
  values (p_student, p_counselor, btrim(p_title), p_mode, p_starts_at, p_ends_at, 'scheduled', p_agenda, p_student, true)
  returning * into booked;

  return booked;
end;
$$;

revoke all on function public.book_meeting_slot(uuid, uuid, timestamptz, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.book_meeting_slot(uuid, uuid, timestamptz, timestamptz, text, text, text) to service_role;

comment on function public.book_meeting_slot(uuid, uuid, timestamptz, timestamptz, text, text, text) is
  'Student booking: re-checks the relationship, the settings and overlap (with buffer) under a per-counselor advisory lock, then inserts the meeting. Service role only.';
