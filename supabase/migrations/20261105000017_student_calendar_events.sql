-- A student's own calendar events (QA round 10: "click and add an event like
-- Google Calendar" on the student's Calendar).
--
-- `student_calendar_events` holds what a student puts on their own calendar:
-- a campus visit, an interview, a study block. An all-day event has only
-- `on_date`; a timed one also has `starts_at` (and optionally `ends_at`), with
-- `on_date` the day it starts in the student's zone. The student writes their
-- own rows; anyone who can view the student (their counselor, a collaborator)
-- reads them on the student's calendar. Nothing here is emailed or shared.
--
-- Deploy order: either. Additive only. Until it is applied the calendar feed
-- leaves these out (a missing table reads as none) and the /me/calendar/events
-- routes answer 503 `student_events_unavailable`. Not in REQUIRED_SCHEMA.

create table if not exists public.student_calendar_events (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  detail      text check (detail is null or length(detail) <= 2000),
  on_date     date not null,
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint student_calendar_events_end_after_start
    check (ends_at is null or (starts_at is not null and ends_at > starts_at))
);

create index if not exists student_calendar_events_student_date
  on public.student_calendar_events (student_id, on_date);

drop trigger if exists student_calendar_events_set_updated_at on public.student_calendar_events;
create trigger student_calendar_events_set_updated_at before update on public.student_calendar_events
  for each row execute function public.set_updated_at();

alter table public.student_calendar_events enable row level security;
revoke all on public.student_calendar_events from public, anon, authenticated;
grant select, delete on public.student_calendar_events to authenticated;
grant insert (student_id, title, detail, on_date, starts_at, ends_at) on public.student_calendar_events to authenticated;
grant update (title, detail, on_date, starts_at, ends_at) on public.student_calendar_events to authenticated;

drop policy if exists student_calendar_events_select on public.student_calendar_events;
create policy student_calendar_events_select on public.student_calendar_events
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists student_calendar_events_insert_self on public.student_calendar_events;
create policy student_calendar_events_insert_self on public.student_calendar_events
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

drop policy if exists student_calendar_events_update_self on public.student_calendar_events;
create policy student_calendar_events_update_self on public.student_calendar_events
  for update to authenticated
  using (student_id = (select auth.uid()))
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

drop policy if exists student_calendar_events_delete_self on public.student_calendar_events;
create policy student_calendar_events_delete_self on public.student_calendar_events
  for delete to authenticated
  using (student_id = (select auth.uid()));

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.student_calendar_events');
