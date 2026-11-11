-- Public booking link: every counselor gets a share link (Calendly-style) that anyone, signed in or not (a
-- prospective family), can use to book one of the counselor's meeting types.
--
-- 1. booking_settings.public_slug / public_booking_enabled. The slug is the link's path segment
--    (/public/book/<slug>, e.g. "jane-doe-4f7km"): the counselor's name slugified plus a 5-character random
--    suffix, lower-case letters and digits only. Unique. Backfilled below for every counselor who already has a
--    settings row; the API gives one to every later row on its first GET /booking/settings (lib/publicBooking.ts),
--    and POST /booking/public-link/rotate replaces the suffix (the old link stops working at once). A user session
--    can't set or change the slug (private.booking_settings_slug_guard, keyed off current_user like
--    meetings_booked_by_student_guard): a counselor choosing their own slug could take a name like
--    "harvard-admissions". `public_booking_enabled` (default true) switches the link off without pausing student
--    booking; the counselor writes it through the existing owner policy and grants.
-- 2. public_bookings: a booking made through the link, with the booker's contact details. A new table rather
--    than a nullable meetings.student_id: meetings.student_id is the primary attendee that every per-student read,
--    RLS helper (meetings_owner_guard, private.counselor_can_edit_student), the attendee trigger, the invite rounds
--    (resolveRound: "a meeting whose own student isn't on its owner's caseload sends nothing") and the caseload
--    transfer key on, so a meeting with no student would either be refused by those guards or be a row half the
--    code reads wrongly. Owner-only RLS: the counselor reads their own rows and may only cancel one (column grant
--    on `status`, scheduled -> cancelled, private.public_bookings_guard). No anon or student access at all: the
--    public routes run on the service role after resolving the slug. `manage_token_hash` is reserved for a later
--    "manage my booking" link (sha256 of a random token, never the token); nothing writes it yet.
-- 3. public.book_public_slot(...): SECURITY DEFINER, EXECUTE to service_role only. Under the same transaction
--    advisory lock as student booking (hashtext('booking:' || counselor)), so a public booking and a student
--    booking can't both take one slot, it re-checks that the counselor is approved, booking is on and not
--    replaced by a Google booking page (`instead`), the link is on, the type is the counselor's active type and
--    the slot is its exact length, and that no scheduled meeting or public booking overlaps it widened by the
--    buffer; then inserts the booking with the type's name and mode. Errors, by message (and SQLSTATE):
--      slot_taken        23P01  a scheduled meeting or public booking is in the way
--      booking_disabled  P0001  not approved, no settings row, booking off or replaced, or the link off
--      type_not_found    P0001  not one of the counselor's active types
--      invalid_slot      P0001  a start not in the future, the wrong length, or a name/email/phone/note out of bounds
-- 4. book_meeting_slot and reschedule_meeting_slot are re-created exactly as 20261111000001 / 20261111000012
--    left them, with one more overlap check: a scheduled public booking blocks a student's slot too. Same
--    signatures, language, SECURITY DEFINER, search_path and grants.
-- 5. public.public_booking_to_pipeline(p_booking, p_activity): SECURITY DEFINER, service_role only. Puts the
--    booker on the counselor's Contact Pipeline: an existing contact of the counselor's workspace (their firm's
--    while they are a member, else their own) whose parent or student email is the booker's (an open one first),
--    else a new contact in the workspace's first stage (by position) titled with the booker's name, the email and
--    phone in the parent fields (a family books as the parent more often than not; nothing is known about the
--    student), owner the counselor, source 'Booking link'. Then a `meeting` timeline entry with p_activity
--    ("Booked Check-in for Wed, Nov 11, 9:00 AM EST") and the booking's contact_id. A workspace with no stages yet
--    (the pipeline never opened) gets no contact: it returns null. Serialized per workspace so two bookings by
--    the same email can't make two cards.
--
-- Deploy order: either. Additive, plus two functions re-created with an extra check the previous build doesn't
-- notice (it calls them with the same arguments). Before this file the API (lib/publicBooking.ts
-- publicBookingReady, a zero-row probe) never names the new columns or table: the public routes answer 503
-- `public_booking_unavailable`, GET /booking/settings leaves out publicSlug / publicBookingEnabled, a PUT naming
-- publicBookingEnabled and the rotate route answer 503 `public_booking_unavailable`, and slots and the calendar
-- feed read no public bookings. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. booking_settings: the slug and the switch
-- ---------------------------------------------------------------------------

alter table public.booking_settings
  add column if not exists public_slug text
    constraint booking_settings_public_slug_check check (
      public_slug is null or (length(public_slug) between 3 and 64 and public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    ),
  add column if not exists public_booking_enabled boolean not null default true;

create unique index if not exists booking_settings_public_slug_key
  on public.booking_settings (public_slug) where public_slug is not null;

comment on column public.booking_settings.public_slug is
  'The public booking link''s path segment (/public/book/<slug>). Written by the API with the service role only (lib/publicBooking.ts); a user session cannot set or change it.';
comment on column public.booking_settings.public_booking_enabled is
  'Whether the public booking link takes bookings. Off: the link answers 404, student booking is unaffected.';

create or replace function private.booking_settings_slug_guard()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.public_slug is not null then
      raise exception 'The booking link is made by Meridies' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.public_slug is distinct from old.public_slug then
    raise exception 'The booking link is made by Meridies' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.booking_settings_slug_guard() from public, anon, authenticated;

drop trigger if exists booking_settings_slug_guard on public.booking_settings;
create trigger booking_settings_slug_guard
  before insert or update on public.booking_settings
  for each row execute function private.booking_settings_slug_guard();

-- Backfill: every existing settings row gets a slug. The same rule as lib/publicBooking.ts makeSlug: the name
-- lower-cased, common accents folded, anything else between letters and digits a single dash, at most 40
-- characters ("counselor" when nothing is left), then a dash and 5 characters from a 32-letter alphabet with no
-- l, o, 0 or 1.
do $$
declare
  r         record;
  base      text;
  candidate text;
begin
  for r in
    select bs.counselor_id, p.full_name
      from public.booking_settings bs
      join public.profiles p on p.id = bs.counselor_id
     where bs.public_slug is null
  loop
    base := translate(lower(coalesce(r.full_name, '')),
                      'áàâäãåāéèêëēíìîïīóòôöõøōúùûüūñçýÿ',
                      'aaaaaaaeeeeeiiiiiooooooouuuuuncyy');
    base := btrim(regexp_replace(base, '[^a-z0-9]+', '-', 'g'), '-');
    base := btrim(left(base, 40), '-');
    if base = '' then
      base := 'counselor';
    end if;
    loop
      candidate := base || '-' || array_to_string(array(
        select substr('abcdefghijkmnpqrstuvwxyz23456789', 1 + floor(random() * 32)::int, 1)
          from generate_series(1, 5)
      ), '');
      exit when not exists (select 1 from public.booking_settings where public_slug = candidate);
    end loop;
    update public.booking_settings set public_slug = candidate where counselor_id = r.counselor_id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. public_bookings
-- ---------------------------------------------------------------------------

create table if not exists public.public_bookings (
  id                uuid primary key default gen_random_uuid(),
  counselor_id      uuid not null references public.profiles(id) on delete cascade,
  booking_type_id   uuid references public.booking_meeting_types(id) on delete set null,
  -- The type's name and mode when booked, so renaming or deleting the type later changes nothing here.
  type_name         text not null check (length(btrim(type_name)) between 1 and 80),
  mode              text not null check (mode in ('google-meet','teams','in-person','phone')),
  name              text not null check (length(btrim(name)) between 1 and 120),
  email             text not null check (length(email) between 3 and 320 and email ~ '^[^\s@]+@[^\s@]+$'),
  phone             text check (phone is null or length(phone) <= 40),
  note              text check (note is null or length(note) <= 1000),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  status            text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  join_url          text check (join_url is null or length(join_url) <= 2000),
  calendar_provider text check (calendar_provider is null or calendar_provider in ('google','microsoft')),
  calendar_event_id text check (calendar_event_id is null or length(calendar_event_id) <= 1024),
  contact_id        uuid references public.pipeline_contacts(id) on delete set null,
  manage_token_hash text unique check (manage_token_hash is null or manage_token_hash ~ '^[0-9a-f]{64}$'),
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint public_bookings_times_check check (ends_at > starts_at and ends_at - starts_at <= interval '180 minutes')
);

create index if not exists public_bookings_counselor_starts_idx
  on public.public_bookings (counselor_id, starts_at) where status = 'scheduled';
create index if not exists public_bookings_counselor_email_idx
  on public.public_bookings (counselor_id, lower(email), starts_at) where status = 'scheduled';
create index if not exists public_bookings_contact_idx
  on public.public_bookings (contact_id) where contact_id is not null;

drop trigger if exists public_bookings_set_updated_at on public.public_bookings;
create trigger public_bookings_set_updated_at before update on public.public_bookings
  for each row execute function public.set_updated_at();

-- A user session (the counselor, through the `status` grant) may only cancel a scheduled booking. Whoever cancels,
-- the time is stamped.
create or replace function private.public_bookings_guard()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
begin
  if current_user = 'authenticated' and new.status is distinct from old.status
     and not (old.status = 'scheduled' and new.status = 'cancelled') then
    raise exception 'A public booking can only be cancelled' using errcode = '42501';
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;
  return new;
end;
$$;

revoke all on function private.public_bookings_guard() from public, anon, authenticated;

drop trigger if exists public_bookings_guard on public.public_bookings;
create trigger public_bookings_guard before update on public.public_bookings
  for each row execute function private.public_bookings_guard();

alter table public.public_bookings enable row level security;

drop policy if exists public_bookings_owner_select on public.public_bookings;
create policy public_bookings_owner_select on public.public_bookings
  for select to authenticated
  using (counselor_id = (select auth.uid()));

drop policy if exists public_bookings_owner_update on public.public_bookings;
create policy public_bookings_owner_update on public.public_bookings
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

revoke all on table public.public_bookings from public, anon, authenticated;
grant select on table public.public_bookings to authenticated;
grant update (status) on table public.public_bookings to authenticated;

select private.attach_approval_gate('public.public_bookings');

comment on table public.public_bookings is
  'Bookings made through a counselor''s public booking link, by people without a Meridies account. Owner-only reads; the API writes them with the service role (routes/publicBooking.ts).';

-- ---------------------------------------------------------------------------
-- 3. book_public_slot
-- ---------------------------------------------------------------------------

create or replace function public.book_public_slot(
  p_counselor uuid,
  p_type      uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_name      text,
  p_email     text,
  p_phone     text default null,
  p_note      text default null
)
returns public.public_bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  settings public.booking_settings;
  t        public.booking_meeting_types;
  buffer   interval;
  booked   public.public_bookings;
begin
  if p_counselor is null or p_type is null or p_starts_at is null or p_ends_at is null
     or p_starts_at <= now()
     or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '180 minutes'
     or p_name is null or length(btrim(p_name)) not between 1 and 120
     or p_email is null or length(btrim(p_email)) not between 3 and 320 or btrim(p_email) !~ '^[^\s@]+@[^\s@]+$'
     or (p_phone is not null and length(p_phone) > 40)
     or (p_note is not null and length(p_note) > 1000) then
    raise exception 'invalid_slot' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('booking:' || p_counselor::text));

  if not private.is_counselor(p_counselor) then
    raise exception 'booking_disabled' using errcode = 'P0001';
  end if;

  select * into settings from public.booking_settings where counselor_id = p_counselor;
  if not found or not settings.enabled or not settings.public_booking_enabled or settings.public_slug is null
     or (settings.booking_page_url is not null and settings.booking_page_mode = 'instead') then
    raise exception 'booking_disabled' using errcode = 'P0001';
  end if;
  buffer := make_interval(mins => settings.buffer_minutes);

  select * into t from public.booking_meeting_types
   where id = p_type and counselor_id = p_counselor and active;
  if not found then
    raise exception 'type_not_found' using errcode = 'P0001';
  end if;
  if p_ends_at - p_starts_at <> make_interval(mins => t.duration_minutes) then
    raise exception 'invalid_slot' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.meetings m
     where m.counselor_id = p_counselor
       and m.status = 'scheduled'
       and m.starts_at < p_ends_at + buffer
       and coalesce(m.ends_at, m.starts_at + interval '1 hour') > p_starts_at - buffer
  ) or exists (
    select 1 from public.public_bookings pb
     where pb.counselor_id = p_counselor
       and pb.status = 'scheduled'
       and pb.starts_at < p_ends_at + buffer
       and pb.ends_at > p_starts_at - buffer
  ) then
    raise exception 'slot_taken' using errcode = '23P01';
  end if;

  insert into public.public_bookings
    (counselor_id, booking_type_id, type_name, mode, name, email, phone, note, starts_at, ends_at)
  values
    (p_counselor, t.id, btrim(t.name), t.mode, btrim(p_name), lower(btrim(p_email)),
     nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), p_starts_at, p_ends_at)
  returning * into booked;

  return booked;
end;
$$;

revoke all on function public.book_public_slot(uuid, uuid, timestamptz, timestamptz, text, text, text, text) from public, anon, authenticated;
grant execute on function public.book_public_slot(uuid, uuid, timestamptz, timestamptz, text, text, text, text) to service_role;

comment on function public.book_public_slot(uuid, uuid, timestamptz, timestamptz, text, text, text, text) is
  'Public booking link: re-checks approval, the settings, the link switch, the type and overlap (with buffer, meetings and public bookings) under the per-counselor booking lock, then inserts the booking. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. Student booking: a public booking blocks the slot too
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
  ) or exists (
    select 1 from public.public_bookings pb
     where pb.counselor_id = p_counselor
       and pb.status = 'scheduled'
       and pb.starts_at < p_ends_at + buffer
       and pb.ends_at > p_starts_at - buffer
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
  ) or exists (
    select 1 from public.public_bookings pb
     where pb.counselor_id = p_counselor
       and pb.status = 'scheduled'
       and pb.starts_at < p_ends_at + buffer
       and pb.ends_at > p_starts_at - buffer
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

-- ---------------------------------------------------------------------------
-- 5. public_booking_to_pipeline
-- ---------------------------------------------------------------------------

create or replace function public.public_booking_to_pipeline(p_booking uuid, p_activity text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b         public.public_bookings;
  v_firm    uuid;
  v_stage   uuid;
  v_contact uuid;
  v_next    integer;
begin
  if p_activity is null or length(btrim(p_activity)) not between 1 and 300 then
    raise exception 'invalid_activity' using errcode = 'P0001';
  end if;

  select * into b from public.public_bookings where id = p_booking;
  if not found then
    return null;
  end if;
  if b.contact_id is not null then
    return b.contact_id;
  end if;

  v_firm := private.crm_workspace_firm(b.counselor_id);
  perform pg_advisory_xact_lock(hashtext('pipeline-public-booking:' || coalesce(v_firm, b.counselor_id)::text));

  select c.id into v_contact
    from public.pipeline_contacts c
   where ((v_firm is not null and c.firm_id = v_firm)
          or (v_firm is null and c.firm_id is null and c.counselor_id = b.counselor_id))
     and (lower(btrim(c.parent_email)) = b.email or lower(btrim(c.student_email)) = b.email)
   order by (c.status = 'open') desc, c.created_at desc
   limit 1;

  if v_contact is null then
    select s.id into v_stage
      from public.pipeline_stages s
     where (v_firm is not null and s.firm_id = v_firm)
        or (v_firm is null and s.firm_id is null and s.counselor_id = b.counselor_id)
     order by s.position, s.created_at
     limit 1;
    if v_stage is null then
      return null;
    end if;
    select coalesce(max(c.position) + 1, 0) into v_next from public.pipeline_contacts c where c.stage_id = v_stage;
    insert into public.pipeline_contacts
      (firm_id, counselor_id, stage_id, position, student_name, parent_email, parent_phone, owner_id, source)
    values
      (v_firm, b.counselor_id, v_stage, least(v_next, 100000), left(btrim(b.name), 200), b.email,
       left(coalesce(b.phone, ''), 40), b.counselor_id, 'Booking link')
    returning id into v_contact;
  end if;

  insert into public.pipeline_activities (contact_id, kind, body, meta)
  values (v_contact, 'meeting', left(btrim(p_activity), 300), jsonb_build_object('publicBookingId', b.id));

  update public.public_bookings set contact_id = v_contact where id = b.id;
  return v_contact;
end;
$$;

revoke all on function public.public_booking_to_pipeline(uuid, text) from public, anon, authenticated;
grant execute on function public.public_booking_to_pipeline(uuid, text) to service_role;

comment on function public.public_booking_to_pipeline(uuid, text) is
  'Public booking link: the booker''s Contact Pipeline card (reused by email, else new in the workspace''s first stage) and a meeting entry on its timeline. Null when the workspace has no stages. Service role only.';
