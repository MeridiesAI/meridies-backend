-- Management (demo v7, v9): the practice's consultants, the tasks assigned to
-- each (with subtasks), whether their students are slipping, and an email
-- blast to the consultants themselves.
--
-- Authorization, decided here once:
--   * Everyone in a firm sees the consultant list (names, seat, caseload).
--   * The alert figures (overdue, no activity, progress) are a performance
--     read-out: firm owners and admins see everyone's, a consultant sees their
--     own, and nobody else's. A solo counselor is a firm of one.
--   * Owners and admins assign tasks to any consultant in the firm; anyone
--     may assign a task to themselves. A task is visible to its assignee, to
--     whoever assigned it, and to the firm's owners and admins.
--   * The staff blast is an owner/admin action.
-- Firm owners count as admins even without a firm_members row
-- (private.crm_firm_admin, from 20261005050001).
--
-- None of this is visible to a student, and the consultant summaries never
-- hand one counselor another's student roster: they return counts, and the
-- "about which student" picker answers only for the assignee or an admin.

-- ---------------------------------------------------------------------------
-- Consultant tasks
-- ---------------------------------------------------------------------------

create table if not exists public.consultant_tasks (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references public.firms(id) on delete cascade,
  assignee_id   uuid not null references public.profiles(id) on delete cascade,
  assigned_by   uuid references public.profiles(id) on delete set null,
  -- One level of subtasks: a parent's parent must be null (trigger).
  parent_id     uuid references public.consultant_tasks(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 300),
  detail        text check (length(detail) <= 4000),
  -- The student the task is about, if any, and their name frozen at
  -- assignment: an admin may not otherwise be able to read that profile.
  student_id    uuid references public.profiles(id) on delete set null,
  student_name  text check (length(student_name) <= 200),
  due_on        date,
  done          boolean not null default false,
  done_at       timestamptz,
  position      integer not null default 0 check (position between 0 and 100000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists consultant_tasks_assignee_idx on public.consultant_tasks (assignee_id, done, position);
create index if not exists consultant_tasks_firm_idx on public.consultant_tasks (firm_id) where firm_id is not null;
create index if not exists consultant_tasks_parent_idx on public.consultant_tasks (parent_id) where parent_id is not null;

drop trigger if exists consultant_tasks_set_updated_at on public.consultant_tasks;
create trigger consultant_tasks_set_updated_at before update on public.consultant_tasks
  for each row execute function public.set_updated_at();

create or replace function private.consultant_tasks_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  p public.consultant_tasks;
begin
  if tg_op = 'INSERT' then
    if new.parent_id is not null then
      select * into p from public.consultant_tasks where id = new.parent_id;
      if not found or p.parent_id is not null then
        raise exception 'Subtasks go one level deep' using errcode = '23514';
      end if;
      if p.assignee_id <> new.assignee_id or p.firm_id is distinct from new.firm_id then
        raise exception 'A subtask belongs to its task''s consultant' using errcode = '23514';
      end if;
    end if;
    if new.student_id is not null then
      select full_name into new.student_name from public.profiles where id = new.student_id;
    else
      new.student_name := null;
    end if;
  end if;

  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now();
  elsif not new.done then
    new.done_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.consultant_tasks_guard() from public, anon, authenticated;

drop trigger if exists consultant_tasks_guard on public.consultant_tasks;
create trigger consultant_tasks_guard before insert or update on public.consultant_tasks
  for each row execute function private.consultant_tasks_guard();

alter table public.consultant_tasks enable row level security;

drop policy if exists consultant_tasks_select on public.consultant_tasks;
create policy consultant_tasks_select on public.consultant_tasks
  for select to authenticated
  using (
    assignee_id = (select auth.uid())
    or assigned_by = (select auth.uid())
    or private.crm_firm_admin(firm_id, (select auth.uid()))
  );

drop policy if exists consultant_tasks_insert on public.consultant_tasks;
create policy consultant_tasks_insert on public.consultant_tasks
  for insert to authenticated
  with check (
    assigned_by = (select auth.uid())
    and private.is_counselor((select auth.uid()))
    and firm_id is not distinct from private.crm_workspace_firm((select auth.uid()))
    and (
      assignee_id = (select auth.uid())
      or (private.crm_firm_admin(firm_id, (select auth.uid()))
          and private.crm_firm_member(firm_id, assignee_id))
    )
    -- The student must be on the assignee's caseload.
    and (student_id is null or private.is_counselor_of(student_id, assignee_id))
  );

drop policy if exists consultant_tasks_update on public.consultant_tasks;
create policy consultant_tasks_update on public.consultant_tasks
  for update to authenticated
  using (
    assignee_id = (select auth.uid())
    or assigned_by = (select auth.uid())
    or private.crm_firm_admin(firm_id, (select auth.uid()))
  )
  with check (
    assignee_id = (select auth.uid())
    or assigned_by = (select auth.uid())
    or private.crm_firm_admin(firm_id, (select auth.uid()))
  );

-- The assignee ticks a task off; removing it is the assigner's or an admin's.
drop policy if exists consultant_tasks_delete on public.consultant_tasks;
create policy consultant_tasks_delete on public.consultant_tasks
  for delete to authenticated
  using (
    assigned_by = (select auth.uid())
    or private.crm_firm_admin(firm_id, (select auth.uid()))
  );

revoke all on public.consultant_tasks from public, anon, authenticated;
grant select, insert, delete on public.consultant_tasks to authenticated;
grant update (title, detail, due_on, done, position) on public.consultant_tasks to authenticated;

-- ---------------------------------------------------------------------------
-- Consultants and their alert figures
-- ---------------------------------------------------------------------------

-- One row per consultant in the caller's firm (or just the caller, solo).
-- SECURITY DEFINER because the counts read other consultants' students, which
-- RLS rightly hides; it returns counts only, and the alert figures are null
-- unless the caller is an admin or the row is their own.
--
--   overdue      open deliverables of their students past their due date
--   no_activity  students with open work and no activity in 14 days
--   progress_pct mean progress across their students' deliverables
create or replace function public.firm_consultants()
returns table (
  profile_id       uuid,
  full_name        text,
  email            text,
  avatar_url       text,
  seat_role        text,
  student_count    integer,
  alerts_visible   boolean,
  overdue_count    integer,
  no_activity_count integer,
  progress_pct     integer
)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_firm  uuid;
  v_admin boolean;
begin
  if v_uid is null or not private.is_counselor(v_uid) then
    raise exception 'Only counselors can open Management' using errcode = '42501';
  end if;
  v_firm := private.crm_workspace_firm(v_uid);
  v_admin := v_firm is not null and private.crm_firm_admin(v_firm, v_uid);

  return query
  with members as (
    select v_uid as id, case when v_firm is null then 'owner' else null end as seat
    where v_firm is null
    union
    select m.profile_id, m.seat_role from public.firm_members m where m.firm_id = v_firm
    union
    select f.owner_id, 'owner' from public.firms f
    where f.id = v_firm
      and not exists (select 1 from public.firm_members m where m.firm_id = v_firm and m.profile_id = f.owner_id)
  ),
  students as (
    select s.id, s.counselor_id
    from public.profiles s
    join members mb on mb.id = s.counselor_id
    where s.role = 'student' and s.archived_at is null
  ),
  work as (
    select st.counselor_id,
           count(*) filter (where d.status <> 'complete' and d.due_date < current_date) as overdue,
           round(avg(d.progress_pct))::integer as progress
    from students st
    join public.deliverables d on d.student_id = st.id
    group by st.counselor_id
  ),
  idle as (
    select st.counselor_id, count(*) as n
    from students st
    where exists (select 1 from public.deliverables d where d.student_id = st.id and d.status <> 'complete')
      and not exists (
        select 1 from public.deliverables d
        where d.student_id = st.id and d.last_activity_at > now() - interval '14 days'
      )
    group by st.counselor_id
  )
  select p.id,
         p.full_name,
         p.email,
         p.avatar_url,
         coalesce(mb.seat, 'counselor'),
         (select count(*)::integer from students st where st.counselor_id = p.id),
         (v_admin or p.id = v_uid),
         case when v_admin or p.id = v_uid then coalesce(w.overdue, 0)::integer end,
         case when v_admin or p.id = v_uid then coalesce(i.n, 0)::integer end,
         case when v_admin or p.id = v_uid then w.progress end
  from members mb
  join public.profiles p on p.id = mb.id
  left join work w on w.counselor_id = p.id
  left join idle i on i.counselor_id = p.id
  where p.role = 'counselor'
  order by (p.id = v_uid) desc, p.full_name;
end;
$$;

-- The students a task can be about: the chosen consultant's caseload. Names
-- only, and only to that consultant or an admin of their firm.
create or replace function public.firm_consultant_students(p_consultant uuid)
returns table (student_id uuid, full_name text, grad_year text)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_firm uuid := private.crm_workspace_firm(v_uid);
begin
  if v_uid is null or not private.is_counselor(v_uid) then
    raise exception 'Only counselors can do that' using errcode = '42501';
  end if;
  if p_consultant <> v_uid and not (
    v_firm is not null and private.crm_firm_admin(v_firm, v_uid) and private.crm_firm_member(v_firm, p_consultant)
  ) then
    raise exception 'That consultant is not in your practice' using errcode = '42501';
  end if;

  return query
  select s.id, s.full_name, s.grad_year
  from public.profiles s
  where s.counselor_id = p_consultant and s.role = 'student' and s.archived_at is null
  order by s.full_name;
end;
$$;

revoke all on function public.firm_consultants() from public, anon;
revoke all on function public.firm_consultant_students(uuid) from public, anon;
grant execute on function public.firm_consultants() to authenticated;
grant execute on function public.firm_consultant_students(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Staff blast: Management's email to the practice's consultants (v9)
--
-- Kept apart from email_blasts, whose recipients are students resolved from a
-- roster rule; these are colleagues, chosen by id from the firm.
-- ---------------------------------------------------------------------------

create table if not exists public.staff_blasts (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null references public.firms(id) on delete cascade,
  sender_id        uuid not null references public.profiles(id) on delete cascade,
  subject          text not null check (length(btrim(subject)) between 1 and 300),
  body             text not null check (length(btrim(body)) between 1 and 20000),
  status           text not null default 'sending'
                   check (status in ('sending', 'sent', 'partial', 'failed')),
  recipient_count  integer not null default 0 check (recipient_count >= 0),
  delivered_count  integer not null default 0 check (delivered_count >= 0),
  failed_count     integer not null default 0 check (failed_count >= 0),
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists staff_blasts_firm_idx on public.staff_blasts (firm_id, created_at desc);

drop trigger if exists staff_blasts_set_updated_at on public.staff_blasts;
create trigger staff_blasts_set_updated_at before update on public.staff_blasts
  for each row execute function public.set_updated_at();

alter table public.staff_blasts enable row level security;

drop policy if exists staff_blasts_select on public.staff_blasts;
create policy staff_blasts_select on public.staff_blasts
  for select to authenticated
  using (sender_id = (select auth.uid()) or private.crm_firm_admin(firm_id, (select auth.uid())));

drop policy if exists staff_blasts_insert on public.staff_blasts;
create policy staff_blasts_insert on public.staff_blasts
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and firm_id = private.crm_workspace_firm((select auth.uid()))
    and private.crm_firm_admin(firm_id, (select auth.uid()))
  );

drop policy if exists staff_blasts_update on public.staff_blasts;
create policy staff_blasts_update on public.staff_blasts
  for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

revoke all on public.staff_blasts from public, anon, authenticated;
grant select, insert on public.staff_blasts to authenticated;
grant update (status, delivered_count, failed_count, sent_at) on public.staff_blasts to authenticated;

create table if not exists public.staff_blast_recipients (
  id                   uuid primary key default gen_random_uuid(),
  blast_id             uuid not null references public.staff_blasts(id) on delete cascade,
  profile_id           uuid references public.profiles(id) on delete set null,
  full_name            text,
  to_email             text,
  status               text not null default 'queued' check (status in ('queued', 'sent', 'skipped', 'failed')),
  message_delivery_id  uuid references public.message_deliveries(id) on delete set null,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists staff_blast_recipients_blast_idx on public.staff_blast_recipients (blast_id);

alter table public.staff_blast_recipients enable row level security;

drop policy if exists staff_blast_recipients_rw on public.staff_blast_recipients;
create policy staff_blast_recipients_rw on public.staff_blast_recipients
  for all to authenticated
  using (exists (
    select 1 from public.staff_blasts b
    where b.id = staff_blast_recipients.blast_id
      and (b.sender_id = (select auth.uid()) or private.crm_firm_admin(b.firm_id, (select auth.uid())))
  ))
  with check (exists (
    select 1 from public.staff_blasts b
    where b.id = staff_blast_recipients.blast_id and b.sender_id = (select auth.uid())
  ));

revoke all on public.staff_blast_recipients from public, anon, authenticated;
grant select, insert on public.staff_blast_recipients to authenticated;
grant update (status, message_delivery_id, error, sent_at) on public.staff_blast_recipients to authenticated;
