-- Caseload transfer, step 1: the record of each transfer, the firm's setting,
-- and the one guard that would otherwise refuse a transfer.
-- Spec: docs/superpowers/specs/2026-10-15-caseload-transfer-design.md
--
-- Additive. Nothing here is read by a request outside the feature, so none of
-- it is in REQUIRED_SCHEMA; the routes answer 503 caseload_transfer_unavailable
-- until it is applied.

-- ---------------------------------------------------------------------------
-- 1. The record. One row per transfer call, one per student moved. Names are
--    frozen so the history reads the same after an account is gone. No client
--    writes either table; transfer_caseload (SECURITY DEFINER) does.
-- ---------------------------------------------------------------------------
create table if not exists public.caseload_transfers (
  id                      uuid primary key default gen_random_uuid(),
  firm_id                 uuid not null references public.firms(id) on delete cascade,
  from_counselor_id       uuid references public.profiles(id) on delete set null,
  from_name               text check (from_name is null or length(from_name) <= 200),
  requested_by            uuid references public.profiles(id) on delete set null,
  requested_by_name       text check (requested_by_name is null or length(requested_by_name) <= 200),
  mode                    text not null check (mode in ('one_person', 'per_student')),
  practice_to             uuid references public.profiles(id) on delete set null,
  practice_items_moved    boolean not null default false,
  member_removed          boolean not null default false,
  student_count           integer not null check (student_count between 0 and 500),
  summary                 jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at              timestamptz not null default now()
);
create index if not exists caseload_transfers_firm_idx
  on public.caseload_transfers (firm_id, created_at desc);
create index if not exists caseload_transfers_from_idx
  on public.caseload_transfers (from_counselor_id) where from_counselor_id is not null;

create table if not exists public.caseload_transfer_students (
  transfer_id      uuid not null references public.caseload_transfers(id) on delete cascade,
  student_id       uuid not null references public.profiles(id) on delete cascade,
  student_name     text check (student_name is null or length(student_name) <= 200),
  to_counselor_id  uuid references public.profiles(id) on delete set null,
  to_name          text check (to_name is null or length(to_name) <= 200),
  created_at       timestamptz not null default now(),
  primary key (transfer_id, student_id)
);
create index if not exists caseload_transfer_students_student_idx
  on public.caseload_transfer_students (student_id, created_at desc);
create index if not exists caseload_transfer_students_to_idx
  on public.caseload_transfer_students (to_counselor_id) where to_counselor_id is not null;

-- The policies on the two tables ask about each other; these helpers read past
-- RLS so neither policy re-enters the other (the meeting_attendees pattern).
create or replace function private.caseload_transfer_admin_or_from(p_transfer uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null and exists (
    select 1 from public.caseload_transfers t
     where t.id = p_transfer
       and (t.from_counselor_id = p_viewer or private.crm_firm_admin(t.firm_id, p_viewer))
  );
$$;

create or replace function private.caseload_transfer_receiver(p_transfer uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null and exists (
    select 1 from public.caseload_transfer_students s
     where s.transfer_id = p_transfer
       and (s.to_counselor_id = p_viewer or private.can_view_student(s.student_id, p_viewer))
  );
$$;

revoke all on function private.caseload_transfer_admin_or_from(uuid, uuid) from public, anon;
revoke all on function private.caseload_transfer_receiver(uuid, uuid) from public, anon;
grant execute on function private.caseload_transfer_admin_or_from(uuid, uuid) to authenticated;
grant execute on function private.caseload_transfer_receiver(uuid, uuid) to authenticated;

alter table public.caseload_transfers enable row level security;
alter table public.caseload_transfer_students enable row level security;
revoke all on public.caseload_transfers from public, anon, authenticated;
revoke all on public.caseload_transfer_students from public, anon, authenticated;
grant select on public.caseload_transfers to authenticated;
grant select on public.caseload_transfer_students to authenticated;

-- Firm owners/admins, the consultant whose students moved, and counselors who
-- received (or can now see) one of the students. Never a student.
drop policy if exists caseload_transfers_select on public.caseload_transfers;
create policy caseload_transfers_select on public.caseload_transfers
  for select to authenticated
  using (
    private.is_counselor((select auth.uid()))
    and (private.crm_firm_admin(firm_id, (select auth.uid()))
         or from_counselor_id = (select auth.uid())
         or private.caseload_transfer_receiver(id, (select auth.uid())))
  );

-- A student's row: whoever can view that student now (the receiver, a
-- collaborator), and the firm's admins and the old counselor for the transfer.
drop policy if exists caseload_transfer_students_select on public.caseload_transfer_students;
create policy caseload_transfer_students_select on public.caseload_transfer_students
  for select to authenticated
  using (
    private.is_counselor((select auth.uid()))
    and (to_counselor_id = (select auth.uid())
         or private.can_view_student(student_id, (select auth.uid()))
         or private.caseload_transfer_admin_or_from(transfer_id, (select auth.uid())))
  );

select private.attach_approval_gate('public.caseload_transfers');
select private.attach_approval_gate('public.caseload_transfer_students');

comment on table public.caseload_transfers is
  'One row per caseload transfer (transfer_caseload). Frozen names; written only by the function.';
comment on table public.caseload_transfer_students is
  'One row per student moved by a caseload transfer, with the receiver. Written only by transfer_caseload.';

-- ---------------------------------------------------------------------------
-- 2. The firm's setting: what Remove offers when someone leaves.
--    per_student (default): the admin assigns each student.
--    one_person: everything to one receiver, the default receiver if set.
--    Firm rows only; a solo row keeps the default and no receiver.
-- ---------------------------------------------------------------------------
alter table public.practice_settings
  add column if not exists caseload_transfer_mode text not null default 'per_student',
  add column if not exists caseload_default_receiver uuid references public.profiles(id) on delete set null;

alter table public.practice_settings drop constraint if exists practice_settings_caseload_transfer_mode_check;
alter table public.practice_settings add constraint practice_settings_caseload_transfer_mode_check
  check (caseload_transfer_mode in ('one_person', 'per_student'));

grant update (caseload_transfer_mode, caseload_default_receiver) on public.practice_settings to authenticated;

-- The default receiver must be someone who could receive: an approved
-- counselor who is a member of this firm. Checked on every write of the
-- column, by the client or anyone else.
create or replace function private.practice_settings_receiver_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.caseload_default_receiver is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.caseload_default_receiver is not distinct from old.caseload_default_receiver
     and new.firm_id is not distinct from old.firm_id then
    return new;
  end if;
  if new.firm_id is null then
    raise exception 'A default receiver is a firm setting' using errcode = '23514';
  end if;
  if not (private.is_counselor(new.caseload_default_receiver)
          and private.crm_firm_member(new.firm_id, new.caseload_default_receiver)
          and exists (select 1 from public.profiles p
                       where p.id = new.caseload_default_receiver and p.firm_id = new.firm_id)) then
    raise exception 'The default receiver must be an approved consultant in this firm' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.practice_settings_receiver_guard() from public, anon, authenticated;

drop trigger if exists practice_settings_receiver_guard on public.practice_settings;
create trigger practice_settings_receiver_guard
  before insert or update on public.practice_settings
  for each row execute function private.practice_settings_receiver_guard();

-- ---------------------------------------------------------------------------
-- 3. A closed cycle's outcome row is locked against edits (20261005010003).
--    A transfer changes only who owns the row; that is allowed when the write
--    comes from a SECURITY DEFINER function (current_user is not
--    `authenticated`) and nothing but counselor_id and firm_id changed. A
--    client write is refused exactly as before. Body otherwise unchanged.
--    Deliberately NOT security definer: the guard keys off current_user.
-- ---------------------------------------------------------------------------
create or replace function private.admission_outcomes_lock_guard()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
begin
  if tg_op = 'DELETE' then
    if old.locked then
      raise exception 'That outcome is part of a closed cycle and cannot be removed' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.locked then
    if current_user <> 'authenticated'
       and (to_jsonb(new) - 'counselor_id' - 'firm_id' - 'updated_at')
           = (to_jsonb(old) - 'counselor_id' - 'firm_id' - 'updated_at') then
      return new;
    end if;
    raise exception 'That outcome is part of a closed cycle and cannot be edited' using errcode = '42501';
  end if;
  if new.locked and not old.locked then
    new.locked_at := now();
  end if;
  return new;
end;
$$;
