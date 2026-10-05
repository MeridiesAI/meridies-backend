-- Calendar (Demo v7–v9): consultant-made event types, moving an event onto
-- one, and the counselor's own practice events.
--
-- v7: "+" by the Event type heading makes a new type (name, description, time
-- zone, colour), modelled on Google Calendar's "Create new calendar". A new
-- type joins the filter checklist at once, and any event on the calendar can
-- be moved onto it from its own type pill — so the filter has something to
-- filter.
--
-- The calendar's events come from several tables (deadlines, meetings, task
-- stages, the practice events below, saved Events Hub events). A reassignment
-- is therefore keyed by (kind, ref) rather than a foreign key into any one of
-- them; the feed (src/lib/calendarFeed.ts) applies it on read. A ref that no
-- longer resolves is simply never matched, and the row is harmless.
--
-- All three tables are the counselor's own: another counselor's colours and
-- planning blocks are not shared, and a student never writes any of this.

-- ---------------------------------------------------------------------------
-- Event types
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_event_types (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text check (length(description) <= 500),
  -- IANA name ("America/New_York"). Validated loosely here; the route checks
  -- it against Intl's list.
  time_zone   text not null default 'America/New_York'
              check (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+\-]+){0,2}$' and length(time_zone) <= 64),
  color       text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order  integer not null default 0 check (sort_order between 0 and 999),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Lets the tables below require a type that belongs to the same owner.
  constraint calendar_event_types_id_owner unique (id, owner_id)
);

create index if not exists calendar_event_types_owner_idx
  on public.calendar_event_types (owner_id, sort_order, created_at);
create unique index if not exists calendar_event_types_owner_name
  on public.calendar_event_types (owner_id, lower(btrim(name)));

drop trigger if exists calendar_event_types_set_updated_at on public.calendar_event_types;
create trigger calendar_event_types_set_updated_at before update on public.calendar_event_types
  for each row execute function public.set_updated_at();

alter table public.calendar_event_types enable row level security;

drop policy if exists calendar_event_types_owner on public.calendar_event_types;
create policy calendar_event_types_owner on public.calendar_event_types
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on table public.calendar_event_types from public, anon;
grant select, insert, update, delete on table public.calendar_event_types to authenticated;

-- ---------------------------------------------------------------------------
-- Moving an event onto a type
--
-- Exactly one of builtin_type / type_id: an event can be moved onto another
-- built-in type (a meeting shown as a planning milestone) or onto one of the
-- counselor's own.
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_event_type_assignments (
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  event_kind    text not null check (event_kind in ('deadline','meeting','task','milestone','event')),
  event_ref     text not null check (length(event_ref) between 1 and 120),
  builtin_type  text check (builtin_type in ('deadline','meeting','task','milestone','event')),
  type_id       uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_id, event_kind, event_ref),
  constraint calendar_event_type_assignments_one_target
    check ((builtin_type is null) <> (type_id is null)),
  constraint calendar_event_type_assignments_type_fk
    foreign key (type_id, owner_id)
    references public.calendar_event_types (id, owner_id) on delete cascade
);

create index if not exists calendar_event_type_assignments_type_idx
  on public.calendar_event_type_assignments (type_id) where type_id is not null;

drop trigger if exists calendar_event_type_assignments_set_updated_at on public.calendar_event_type_assignments;
create trigger calendar_event_type_assignments_set_updated_at before update on public.calendar_event_type_assignments
  for each row execute function public.set_updated_at();

alter table public.calendar_event_type_assignments enable row level security;

drop policy if exists calendar_event_type_assignments_owner on public.calendar_event_type_assignments;
create policy calendar_event_type_assignments_owner on public.calendar_event_type_assignments
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on table public.calendar_event_type_assignments from public, anon;
grant select, insert, update, delete on table public.calendar_event_type_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- Practice events — "Planning milestone" in the demo: a practice planning
-- block, the weekly team sync, "October family reports go out". Usually
-- practice-wide (no student); when one is about a student the counselor may
-- show it on that student's calendar.
--
-- `on_date` is the calendar day as the counselor sees it. `starts_at` is null
-- for an all-day item, which is the common case; when set, the client sends
-- both, so the day never depends on the server's time zone.
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_events (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references public.profiles(id) on delete cascade,
  student_id          uuid references public.profiles(id) on delete cascade,
  title               text not null check (length(btrim(title)) between 1 and 300),
  detail              text check (length(detail) <= 2000),
  on_date             date not null,
  starts_at           timestamptz,
  ends_at             timestamptz,
  type_id             uuid,
  shared_with_student boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint calendar_events_end_after_start
    check (ends_at is null or (starts_at is not null and ends_at > starts_at)),
  constraint calendar_events_share_needs_student
    check (not shared_with_student or student_id is not null),
  constraint calendar_events_type_fk
    foreign key (type_id, owner_id)
    references public.calendar_event_types (id, owner_id) on delete set null (type_id)
);

create index if not exists calendar_events_owner_idx on public.calendar_events (owner_id, on_date);
create index if not exists calendar_events_student_idx
  on public.calendar_events (student_id, on_date) where student_id is not null;

drop trigger if exists calendar_events_set_updated_at on public.calendar_events;
create trigger calendar_events_set_updated_at before update on public.calendar_events
  for each row execute function public.set_updated_at();

alter table public.calendar_events enable row level security;

-- The owner sees their own; a student sees only an event about them that the
-- counselor chose to share.
drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (shared_with_student and student_id = (select auth.uid()))
  );

-- Writes are the owner's, and an event about a student must be about one of
-- their own students.
drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (student_id is null or private.is_counselor_of(student_id, (select auth.uid())))
  );

drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (student_id is null or private.is_counselor_of(student_id, (select auth.uid())))
  );

drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events
  for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on table public.calendar_events from public, anon;
grant select, insert, update, delete on table public.calendar_events to authenticated;
