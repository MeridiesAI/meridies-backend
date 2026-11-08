-- Saved task sets: a counselor's named list of up to 30 tasks, applied in one go to picked students or a
-- class year (routes/taskSets.ts, lib/taskSets.ts), and a names-only firm roster for owners and admins.
--
--   task_sets            the owner's own rows (the email_templates_owner model). `firm_id` set means
--                        "shared": every counselor in that firm may READ it (and so apply it to their own
--                        students); only the owner writes. A shared set must name the owner's own
--                        current firm.
--   deliverables         task_set_id / task_set_item mark a task made from a set's item. A UNIQUE partial
--                        index on (student_id, task_set_id, task_set_item) makes applying a set twice
--                        harmless: the second insert is a 23505 the API reports as "already assigned".
--                        Only a counselor task may carry the marker (a student's own to-do can't squat
--                        on an item). Deleting a set clears the marker (on delete set null).
--   firm_roster()        SECURITY DEFINER, for a firm OWNER or ADMIN only (a member, a solo counselor, a
--                        student, an unapproved counselor are refused with 42501): every active student of
--                        the firm's consultants as id, name, class year and counselor. Names only. It does
--                        NOT widen private.can_view_student: a student's record stays readable only by
--                        their counselor and collaborators.
--
-- Deploy order: either. Without this file the task-set routes answer 503 `task_sets_unavailable` and
-- GET /management/firm-roster answers 503 `firm_roster_unavailable`; POST /tasks never reads the new
-- columns. Not in REQUIRED_SCHEMA. Safe for the previous build: it adds a table, two nullable columns,
-- an index and a function, and touches no existing row.

create table if not exists public.task_sets (
  id           uuid primary key default gen_random_uuid(),
  counselor_id uuid not null references public.profiles (id) on delete cascade,
  firm_id      uuid null references public.firms (id) on delete set null,
  name         text not null,
  items        jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint task_sets_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint task_sets_items_shape check (
    jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30
  ),
  constraint task_sets_items_size check (pg_column_size(items) <= 262144)
);

create index if not exists task_sets_owner_idx on public.task_sets (counselor_id, created_at);
create index if not exists task_sets_firm_idx on public.task_sets (firm_id) where firm_id is not null;

drop trigger if exists task_sets_set_updated_at on public.task_sets;
create trigger task_sets_set_updated_at before update on public.task_sets
  for each row execute function public.set_updated_at();

alter table public.task_sets enable row level security;

drop policy if exists task_sets_owner on public.task_sets;
create policy task_sets_owner on public.task_sets
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (
    counselor_id = (select auth.uid())
    and private.is_counselor((select auth.uid()))
    and (firm_id is null or firm_id = private.crm_workspace_firm((select auth.uid())))
  );

drop policy if exists task_sets_firm_read on public.task_sets;
create policy task_sets_firm_read on public.task_sets
  for select to authenticated
  using (
    firm_id is not null
    and private.is_counselor((select auth.uid()))
    and private.crm_firm_member(firm_id, (select auth.uid()))
  );

revoke all on public.task_sets from public, anon, authenticated;
grant select, insert, delete on public.task_sets to authenticated;
grant update (name, items, firm_id) on public.task_sets to authenticated;

select private.attach_approval_gate('public.task_sets');

-- ---- the marker on a task ------------------------------------------------------------------------

alter table public.deliverables
  add column if not exists task_set_id uuid null references public.task_sets (id) on delete set null,
  add column if not exists task_set_item integer null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deliverables_task_set_marker') then
    alter table public.deliverables add constraint deliverables_task_set_marker check (
      (task_set_id is null)
      or (source = 'counselor' and task_set_item is not null and task_set_item between 0 and 29)
    );
  end if;
end $$;

create unique index if not exists deliverables_task_set_item_uidx
  on public.deliverables (student_id, task_set_id, task_set_item)
  where task_set_id is not null;

-- ---- firm_roster() --------------------------------------------------------------------------------

create or replace function public.firm_roster()
returns table (
  id           uuid,
  full_name    text,
  grad_year    text,
  counselor_id uuid
)
language plpgsql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_firm uuid;
begin
  if v_uid is null or not private.is_counselor(v_uid) then
    raise exception 'Only a firm owner or admin can see the firm roster' using errcode = '42501';
  end if;
  v_firm := private.crm_workspace_firm(v_uid);
  if v_firm is null or not private.crm_firm_admin(v_firm, v_uid) then
    raise exception 'Only a firm owner or admin can see the firm roster' using errcode = '42501';
  end if;

  return query
  with consultants as (
    select m.profile_id as cid from public.firm_members m where m.firm_id = v_firm
    union
    select f.owner_id from public.firms f where f.id = v_firm
  )
  select s.id, s.full_name, s.grad_year::text, s.counselor_id
  from public.profiles s
  join consultants c on c.cid = s.counselor_id
  join public.profiles cp on cp.id = s.counselor_id and cp.role = 'counselor'
  where s.role = 'student' and s.archived_at is null
  order by s.full_name, s.id;
end;
$$;

revoke all on function public.firm_roster() from public, anon;
grant execute on function public.firm_roster() to authenticated;
