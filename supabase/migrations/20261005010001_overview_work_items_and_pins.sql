-- Overview (demo v7-v9): My Work Queue and pinned students.
--
-- counselor_work_items
--   Everything a counselor owes someone that is not a student task: their own
--   to-dos, private notes ("Parents prefer evening calls after 6pm"), deadlines
--   to chase, reports to approve, meetings to prepare. `deadlines` looks close
--   but is wrong for this: it is a student-scoped table the student can read and
--   tick, and `student_id` is NOT NULL there, so practice-wide items and private
--   notes are impossible.
--
--   Owner-only in both directions, like student_status_overrides: the student is
--   never a reader. v9 lets Management assign a to-do to a colleague in the same
--   firm, so the row carries `assigned_by`; the assigner keeps sight of what
--   they assigned (and may edit or withdraw it), and nobody else does.
--
-- consultant_student_pins
--   v7: pins are per consultant, not firm-wide. Two consultants sharing a
--   roster each keep their own short list.

create table if not exists public.counselor_work_items (
  id               uuid primary key default gen_random_uuid(),
  -- Whose queue the item sits on (the assignee).
  counselor_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  -- Who put it there. Equal to counselor_id for the counselor's own items.
  assigned_by      uuid default auth.uid() references public.profiles(id) on delete set null,
  -- Null = practice-wide work.
  student_id       uuid references public.profiles(id) on delete cascade,
  kind             text not null default 'task'
                     check (kind in ('task','note','deadline','report','meeting')),
  title            text not null check (length(btrim(title)) between 1 and 300),
  detail           text check (length(detail) <= 2000),
  -- Who has to act: the counselor, or the student being chased.
  owner            text not null default 'counselor' check (owner in ('counselor','student')),
  due_date         date,
  -- v8 to-do: an optional time and repeat on the due date.
  due_time         time,
  repeat           text not null default 'none' check (repeat in ('none','daily','weekly','monthly')),
  done             boolean not null default false,
  done_at          timestamptz,
  -- Where the item came from ("Added by you", "Management", "Family reports").
  source           text check (length(source) <= 120),
  family_report_id uuid references public.family_reports(id) on delete cascade,
  meeting_id       uuid references public.meetings(id) on delete cascade,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint counselor_work_items_time_needs_date check (due_time is null or due_date is not null),
  constraint counselor_work_items_repeat_needs_date check (repeat = 'none' or due_date is not null)
);

create index if not exists counselor_work_items_owner_idx
  on public.counselor_work_items (counselor_id, done, due_date);
create index if not exists counselor_work_items_assigner_idx
  on public.counselor_work_items (assigned_by) where assigned_by is not null;
create index if not exists counselor_work_items_student_idx
  on public.counselor_work_items (student_id) where student_id is not null;

drop trigger if exists counselor_work_items_set_updated_at on public.counselor_work_items;
create trigger counselor_work_items_set_updated_at before update on public.counselor_work_items
  for each row execute function public.set_updated_at();

comment on table public.counselor_work_items is
  'My Work Queue. Owner-only (plus the colleague who assigned an item); never readable by the student it mentions.';

-- May `viewer` put an item on `assignee`'s queue? Themselves always (if a
-- counselor); a colleague only when both sit in the same firm.
create or replace function private.can_assign_work(assignee uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select private.is_counselor(viewer)
     and private.is_counselor(assignee)
     and (
       assignee = viewer
       or exists (
         select 1
         from public.firm_members a
         join public.firm_members b on b.firm_id = a.firm_id
         where a.profile_id = assignee and b.profile_id = viewer
       )
     );
$$;
revoke all on function private.can_assign_work(uuid, uuid) from public, anon;
grant execute on function private.can_assign_work(uuid, uuid) to authenticated;

alter table public.counselor_work_items enable row level security;
revoke all on table public.counselor_work_items from anon;
grant select, insert, update, delete on table public.counselor_work_items to authenticated;

drop policy if exists counselor_work_items_select on public.counselor_work_items;
create policy counselor_work_items_select on public.counselor_work_items
  for select to authenticated
  using (counselor_id = (select auth.uid()) or assigned_by = (select auth.uid()));

drop policy if exists counselor_work_items_insert on public.counselor_work_items;
create policy counselor_work_items_insert on public.counselor_work_items
  for insert to authenticated
  with check (
    assigned_by = (select auth.uid())
    and private.can_assign_work(counselor_id, (select auth.uid()))
    and (student_id is null or private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists counselor_work_items_update on public.counselor_work_items;
create policy counselor_work_items_update on public.counselor_work_items
  for update to authenticated
  using (counselor_id = (select auth.uid()) or assigned_by = (select auth.uid()))
  with check (
    (counselor_id = (select auth.uid()) or assigned_by = (select auth.uid()))
    and private.can_assign_work(counselor_id, coalesce(assigned_by, counselor_id))
    and (student_id is null or private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists counselor_work_items_delete on public.counselor_work_items;
create policy counselor_work_items_delete on public.counselor_work_items
  for delete to authenticated
  using (counselor_id = (select auth.uid()) or assigned_by = (select auth.uid()));

-- assigned_by is set once: an assignee cannot rewrite who gave them the work.
create or replace function private.work_items_guard()
returns trigger
language plpgsql set search_path to 'private','public'
as $$
begin
  if new.assigned_by is distinct from old.assigned_by then
    raise exception 'assigned_by cannot change' using errcode = '42501';
  end if;
  if new.done and not old.done then
    new.done_at := now();
  elsif not new.done then
    new.done_at := null;
  end if;
  return new;
end;
$$;
revoke all on function private.work_items_guard() from public, anon, authenticated;

drop trigger if exists counselor_work_items_guard on public.counselor_work_items;
create trigger counselor_work_items_guard before update on public.counselor_work_items
  for each row execute function private.work_items_guard();

-- ---------------------------------------------------------------------------
-- Pins, per consultant.
-- ---------------------------------------------------------------------------

create table if not exists public.consultant_student_pins (
  consultant_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  student_id    uuid not null references public.profiles(id) on delete cascade,
  pinned_at     timestamptz not null default now(),
  primary key (consultant_id, student_id)
);

comment on table public.consultant_student_pins is
  'Pinned students on Overview. Per consultant (v7), private to that consultant.';

alter table public.consultant_student_pins enable row level security;
revoke all on table public.consultant_student_pins from anon;
grant select, insert, delete on table public.consultant_student_pins to authenticated;

drop policy if exists consultant_student_pins_owner on public.consultant_student_pins;
create policy consultant_student_pins_owner on public.consultant_student_pins
  for all to authenticated
  using (consultant_id = (select auth.uid()))
  with check (
    consultant_id = (select auth.uid())
    and private.is_counselor((select auth.uid()))
    and private.can_view_student(student_id, (select auth.uid()))
  );
