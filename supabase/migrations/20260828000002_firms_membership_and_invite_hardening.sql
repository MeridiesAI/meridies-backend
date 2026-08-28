-- Firms (multi-seat practices), shared student access, and a real fix for the
-- invite-code enumeration hole.

-- ---------------------------------------------------------------------------
-- Firms
-- ---------------------------------------------------------------------------

create table if not exists public.firms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 200),
  slug        text unique,
  owner_id    uuid not null references public.profiles(id) on delete restrict,
  plan        text not null default 'solo' check (plan in ('solo','practice','association')),
  seats       integer not null default 1 check (seats between 1 and 500),
  website     text,
  logo_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.firm_members (
  firm_id    uuid not null references public.firms(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  seat_role  text not null default 'counselor'
             check (seat_role in ('owner','admin','counselor','assistant')),
  invited_by uuid references public.profiles(id) on delete set null,
  joined_at  timestamptz not null default now(),
  primary key (firm_id, profile_id)
);

create index if not exists firm_members_profile_idx on public.firm_members (profile_id);

alter table public.profiles
  add column if not exists firm_id uuid references public.firms(id) on delete set null;
create index if not exists profiles_firm_idx on public.profiles (firm_id);

-- Firm helpers (SECURITY DEFINER so policies don't recurse through firm_members)
create or replace function private.user_firm_id(user_id uuid)
returns uuid
language sql stable security definer set search_path to 'private','public'
as $$ select firm_id from public.profiles where id = user_id; $$;

create or replace function private.is_firm_member(firm uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select exists (
    select 1 from public.firm_members m
    where m.firm_id = firm and m.profile_id = viewer
  );
$$;

create or replace function private.is_firm_admin(firm uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select exists (
    select 1 from public.firm_members m
    where m.firm_id = firm and m.profile_id = viewer and m.seat_role in ('owner','admin')
  );
$$;

revoke all on function private.user_firm_id(uuid) from public, anon;
revoke all on function private.is_firm_member(uuid, uuid) from public, anon;
revoke all on function private.is_firm_admin(uuid, uuid) from public, anon;
grant execute on function private.user_firm_id(uuid) to authenticated;
grant execute on function private.is_firm_member(uuid, uuid) to authenticated;
grant execute on function private.is_firm_admin(uuid, uuid) to authenticated;

alter table public.firms enable row level security;
alter table public.firm_members enable row level security;

drop policy if exists firms_select_member on public.firms;
create policy firms_select_member on public.firms
  for select to authenticated
  using (private.is_firm_member(id, (select auth.uid())));

drop policy if exists firms_insert_owner on public.firms;
create policy firms_insert_owner on public.firms
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists firms_update_admin on public.firms;
create policy firms_update_admin on public.firms
  for update to authenticated
  using (private.is_firm_admin(id, (select auth.uid())))
  with check (private.is_firm_admin(id, (select auth.uid())));

drop policy if exists firm_members_select_member on public.firm_members;
create policy firm_members_select_member on public.firm_members
  for select to authenticated
  using (profile_id = (select auth.uid()) or private.is_firm_member(firm_id, (select auth.uid())));

drop policy if exists firm_members_write_admin on public.firm_members;
create policy firm_members_write_admin on public.firm_members
  for all to authenticated
  using (private.is_firm_admin(firm_id, (select auth.uid())))
  with check (private.is_firm_admin(firm_id, (select auth.uid())));

drop trigger if exists firms_set_updated_at on public.firms;
create trigger firms_set_updated_at before update on public.firms
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Shared student access — a colleague at the same firm, granted explicitly.
-- ---------------------------------------------------------------------------

create table if not exists public.student_collaborators (
  student_id   uuid not null references public.profiles(id) on delete cascade,
  counselor_id uuid not null references public.profiles(id) on delete cascade,
  access       text not null default 'read' check (access in ('read','write')),
  granted_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (student_id, counselor_id)
);

create index if not exists student_collaborators_counselor_idx
  on public.student_collaborators (counselor_id);

-- Now that the table exists, widen the shared read predicate to include it.
create or replace function private.is_counselor_of(student uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = student and p.counselor_id = viewer
  ) or exists (
    select 1 from public.student_collaborators c
    where c.student_id = student and c.counselor_id = viewer
  );
$$;

create or replace function private.can_edit_student(student uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select student = viewer
      or exists (select 1 from public.profiles p
                 where p.id = student and p.counselor_id = viewer)
      or exists (select 1 from public.student_collaborators c
                 where c.student_id = student and c.counselor_id = viewer and c.access = 'write');
$$;

revoke all on function private.can_edit_student(uuid, uuid) from public, anon;
grant execute on function private.can_edit_student(uuid, uuid) to authenticated;

alter table public.student_collaborators enable row level security;

drop policy if exists student_collaborators_select on public.student_collaborators;
create policy student_collaborators_select on public.student_collaborators
  for select to authenticated
  using (
    counselor_id = (select auth.uid())
    or student_id = (select auth.uid())
    or (select auth.uid()) = private.get_user_counselor_id(student_id)
  );

-- Only the student's primary counselor may share them out.
drop policy if exists student_collaborators_write_primary on public.student_collaborators;
create policy student_collaborators_write_primary on public.student_collaborators
  for all to authenticated
  using ((select auth.uid()) = private.get_user_counselor_id(student_id))
  with check ((select auth.uid()) = private.get_user_counselor_id(student_id));

-- ---------------------------------------------------------------------------
-- invite_codes: close the enumeration hole.
--
-- `invites_select_unredeemed` let ANY signed-in user list every unredeemed
-- code and then claim one. Redemption now goes through a SECURITY DEFINER
-- function that matches an exact code, so a student must already know it.
-- ---------------------------------------------------------------------------

drop policy if exists invites_select_unredeemed on public.invite_codes;
drop policy if exists invites_update_redeem on public.invite_codes;

alter table public.invite_codes
  add column if not exists label      text,
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz;

create index if not exists invite_codes_counselor_idx on public.invite_codes (counselor_id);

drop policy if exists invites_update_owner on public.invite_codes;
create policy invites_update_owner on public.invite_codes
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

drop policy if exists invites_delete_owner on public.invite_codes;
create policy invites_delete_owner on public.invite_codes
  for delete to authenticated
  using (counselor_id = (select auth.uid()) and redeemed_by is null);

-- Redeem by exact code. Returns the counselor id on success; raises otherwise.
create or replace function public.redeem_invite_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user      uuid := auth.uid();
  v_invite    public.invite_codes;
  v_role      text;
  v_existing  uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select role, counselor_id into v_role, v_existing
  from public.profiles where id = v_user;

  if v_role is distinct from 'student' then
    raise exception 'Only students can redeem an invite code' using errcode = '42501';
  end if;
  if v_existing is not null then
    raise exception 'You are already connected to a counselor' using errcode = '23505';
  end if;

  select * into v_invite
  from public.invite_codes
  where code = upper(btrim(p_code))
  for update;

  if not found then
    raise exception 'That invite code does not exist' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'That invite code was revoked' using errcode = 'P0001';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at < now() then
    raise exception 'That invite code has expired' using errcode = 'P0001';
  end if;
  if v_invite.redeemed_by is not null then
    raise exception 'That invite code has already been used' using errcode = '23505';
  end if;
  if v_invite.counselor_id = v_user then
    raise exception 'You cannot redeem your own invite code' using errcode = 'P0001';
  end if;

  update public.invite_codes
     set redeemed_by = v_user, redeemed_at = now()
   where id = v_invite.id;

  update public.profiles
     set counselor_id = v_invite.counselor_id
   where id = v_user;

  return v_invite.counselor_id;
end;
$function$;

revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;
