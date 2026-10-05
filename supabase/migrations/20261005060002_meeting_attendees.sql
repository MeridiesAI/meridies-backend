-- Meetings with more than one student (Demo v6+ "Book a meeting").
--
-- The booker multi-selects students and invites each of them. `meetings`
-- keeps its single `student_id` as the primary attendee, so every existing
-- per-student read keeps working; the rest are rows here. The primary is
-- written here too, so "who is invited" is one query.
--
-- An invited student sees the meeting on their own calendar. They still
-- cannot move it: writes stay with the counselor who owns the meeting.

create table if not exists public.meeting_attendees (
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (meeting_id, student_id)
);

create index if not exists meeting_attendees_student_idx on public.meeting_attendees (student_id);

-- Whether the caller is the counselor on a meeting. SECURITY DEFINER so the
-- attendee policies can ask without re-entering the meetings policies, which
-- themselves ask about attendees (that loop is what recursion errors are made of).
create or replace function private.owns_meeting(p_meeting uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private','public'
as $function$
  select exists (
    select 1 from public.meetings m
     where m.id = p_meeting and m.counselor_id = p_viewer
  );
$function$;

revoke all on function private.owns_meeting(uuid, uuid) from public, anon;
grant execute on function private.owns_meeting(uuid, uuid) to authenticated;

-- Whether the viewer may see a meeting because a student they can view is on
-- its attendee list. Same reason for SECURITY DEFINER as above.
create or replace function private.can_view_meeting_attendee(p_meeting uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private','public'
as $function$
  select exists (
    select 1 from public.meeting_attendees a
     where a.meeting_id = p_meeting
       and private.can_view_student(a.student_id, p_viewer)
  );
$function$;

revoke all on function private.can_view_meeting_attendee(uuid, uuid) from public, anon;
grant execute on function private.can_view_meeting_attendee(uuid, uuid) to authenticated;

alter table public.meeting_attendees enable row level security;

drop policy if exists meeting_attendees_select on public.meeting_attendees;
create policy meeting_attendees_select on public.meeting_attendees
  for select to authenticated
  using (
    private.owns_meeting(meeting_id, (select auth.uid()))
    or private.can_view_student(student_id, (select auth.uid()))
  );

-- Only the meeting's counselor adds or removes attendees, and only their own
-- students.
drop policy if exists meeting_attendees_write on public.meeting_attendees;
create policy meeting_attendees_write on public.meeting_attendees
  for all to authenticated
  using (private.owns_meeting(meeting_id, (select auth.uid())))
  with check (
    private.owns_meeting(meeting_id, (select auth.uid()))
    and private.is_counselor_of(student_id, (select auth.uid()))
  );

revoke all on table public.meeting_attendees from public, anon;
grant select, insert, delete on table public.meeting_attendees to authenticated;

-- An invited (non-primary) student can read the meeting itself.
drop policy if exists meetings_select_attendee on public.meetings;
create policy meetings_select_attendee on public.meetings
  for select to authenticated
  using (private.can_view_meeting_attendee(id, (select auth.uid())));

-- The primary student is always an attendee, however the meeting was made.
create or replace function private.meetings_add_primary_attendee()
returns trigger
language plpgsql
security definer
set search_path to 'private','public'
as $function$
begin
  insert into public.meeting_attendees (meeting_id, student_id)
  values (new.id, new.student_id)
  on conflict do nothing;
  return new;
end;
$function$;

revoke all on function private.meetings_add_primary_attendee() from public, anon, authenticated;

drop trigger if exists meetings_add_primary_attendee on public.meetings;
create trigger meetings_add_primary_attendee after insert or update of student_id on public.meetings
  for each row execute function private.meetings_add_primary_attendee();

-- Every existing meeting's primary student is an attendee.
insert into public.meeting_attendees (meeting_id, student_id)
select m.id, m.student_id from public.meetings m
on conflict do nothing;
