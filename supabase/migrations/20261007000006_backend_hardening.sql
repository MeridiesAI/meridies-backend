-- The rest of the backend (BACKEND_TODO §6).
--
-- 1. Guardian contacts. Students could rewrite or delete their own guardians,
--    which means redirecting the parent alerts their counselor sends. The
--    product call: a student may still ADD a guardian (they often know the
--    details first), but one a student adds receives no alerts until a
--    counselor switches them on, and only the counselor side (assigned
--    counselor or a write collaborator) changes or removes a guardian.
-- 2. Firm teams: invitations to a firm, and the SECURITY DEFINER functions
--    that move profiles.firm_id (a column clients can't update directly):
--    create a firm, accept an invitation, change a seat, remove a member.
-- 3. Delivery webhooks: message_deliveries learns when a provider reported
--    delivered / bounced / failed.
-- 4. Job heartbeats, so monitoring can see a cron that stopped running.

-- ---------------------------------------------------------------------------
-- 1. Guardians
-- ---------------------------------------------------------------------------

create or replace function private.can_manage_guardians(p_student uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select p_student <> p_viewer and private.can_edit_student(p_student, p_viewer)
$$;
revoke all on function private.can_manage_guardians(uuid, uuid) from public, anon;
grant execute on function private.can_manage_guardians(uuid, uuid) to authenticated;

drop policy if exists guardians_update on public.guardians;
create policy guardians_update on public.guardians
  for update to authenticated
  using (private.can_manage_guardians(student_id, (select auth.uid())))
  with check (private.can_manage_guardians(student_id, (select auth.uid())));

drop policy if exists guardians_delete on public.guardians;
create policy guardians_delete on public.guardians
  for delete to authenticated
  using (private.can_manage_guardians(student_id, (select auth.uid())));

-- Insert stays with can_edit_student (the student or their counselor side);
-- a student's own addition starts with alerts off.
create or replace function private.guardians_student_insert_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.student_id = (select auth.uid()) then
    new.alerts_enabled := false;
  end if;
  return new;
end;
$$;
revoke all on function private.guardians_student_insert_guard() from public, anon, authenticated;

drop trigger if exists guardians_student_insert_guard on public.guardians;
create trigger guardians_student_insert_guard before insert on public.guardians
  for each row execute function private.guardians_student_insert_guard();

-- ---------------------------------------------------------------------------
-- 2. Firm teams
-- ---------------------------------------------------------------------------

create table if not exists public.firm_invitations (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null references public.firms(id) on delete cascade,
  email        text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 320),
  seat_role    text not null default 'counselor' check (seat_role in ('admin', 'counselor', 'assistant')),
  -- sha256 of the token in the link; the token itself is never stored.
  token_hash   text not null unique,
  invited_by   uuid references public.profiles(id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  accepted_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_at  timestamptz
);

create index if not exists firm_invitations_firm_idx on public.firm_invitations (firm_id, created_at desc);
create unique index if not exists firm_invitations_open_key
  on public.firm_invitations (firm_id, lower(email)) where status = 'pending';

alter table public.firm_invitations enable row level security;
drop policy if exists firm_invitations_select_admin on public.firm_invitations;
create policy firm_invitations_select_admin on public.firm_invitations
  for select to authenticated
  using (private.is_firm_admin(firm_id, (select auth.uid())));
drop policy if exists firm_invitations_insert_admin on public.firm_invitations;
create policy firm_invitations_insert_admin on public.firm_invitations
  for insert to authenticated
  with check (private.is_firm_admin(firm_id, (select auth.uid())) and invited_by = (select auth.uid()));
drop policy if exists firm_invitations_revoke_admin on public.firm_invitations;
create policy firm_invitations_revoke_admin on public.firm_invitations
  for update to authenticated
  using (private.is_firm_admin(firm_id, (select auth.uid())))
  with check (private.is_firm_admin(firm_id, (select auth.uid())) and status in ('pending', 'revoked'));
revoke all on public.firm_invitations from public, anon, authenticated;
grant select, insert on public.firm_invitations to authenticated;
grant update (status) on public.firm_invitations to authenticated;

-- A solo counselor starts a firm and becomes its owner.
create or replace function public.create_firm(p_name text)
returns uuid
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  v_me uuid := (select auth.uid());
  v_firm uuid;
begin
  if not private.is_counselor(v_me) then
    raise exception 'Only counselors can start a firm' using errcode = '42501';
  end if;
  if (select firm_id from public.profiles where id = v_me) is not null then
    raise exception 'You''re already part of a firm' using errcode = 'P0001';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200 then
    raise exception 'Give the firm a name' using errcode = '22023';
  end if;
  -- Billing is parked, so nothing sells seats yet; a firm starts with room for
  -- a small team (firms.seats defaults to 1, which the owner fills). When billing
  -- returns, the subscription sets seats instead.
  insert into public.firms (name, owner_id, plan, seats) values (btrim(p_name), v_me, 'practice', 10) returning id into v_firm;
  insert into public.firm_members (firm_id, profile_id, seat_role, invited_by) values (v_firm, v_me, 'owner', v_me);
  update public.profiles set firm_id = v_firm where id = v_me;
  return v_firm;
end;
$$;
revoke all on function public.create_firm(text) from public, anon;
grant execute on function public.create_firm(text) to authenticated;

-- A counselor accepts an invitation sent to their own address.
create or replace function public.accept_firm_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path to 'private', 'public', 'extensions', 'pg_temp'
as $$
declare
  v_me uuid := (select auth.uid());
  v_inv public.firm_invitations;
  v_email text;
  v_seats integer;
  v_members integer;
begin
  if not private.is_counselor(v_me) then
    raise exception 'Only counselors can join a firm' using errcode = '42501';
  end if;
  select * into v_inv from public.firm_invitations
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;
  if not found or v_inv.status <> 'pending' or v_inv.expires_at < now() then
    raise exception 'That invitation isn''t valid any more' using errcode = 'P0002';
  end if;
  select lower(btrim(email)) into v_email from public.profiles where id = v_me;
  if v_email is distinct from lower(btrim(v_inv.email)) then
    raise exception 'That invitation was sent to a different address' using errcode = '42501';
  end if;
  if (select firm_id from public.profiles where id = v_me) is not null then
    raise exception 'Leave your current firm before joining another' using errcode = 'P0001';
  end if;
  select seats into v_seats from public.firms where id = v_inv.firm_id;
  select count(*) into v_members from public.firm_members where firm_id = v_inv.firm_id;
  if v_members >= v_seats then
    raise exception 'This firm has no open seats' using errcode = 'P0001';
  end if;

  insert into public.firm_members (firm_id, profile_id, seat_role, invited_by)
  values (v_inv.firm_id, v_me, v_inv.seat_role, v_inv.invited_by)
  on conflict (firm_id, profile_id) do nothing;
  update public.profiles set firm_id = v_inv.firm_id where id = v_me;
  update public.firm_invitations set status = 'accepted', accepted_by = v_me, accepted_at = now() where id = v_inv.id;
  return v_inv.firm_id;
end;
$$;
revoke all on function public.accept_firm_invitation(text) from public, anon;
grant execute on function public.accept_firm_invitation(text) to authenticated;

-- An owner/admin changes a member's seat. The owner's seat doesn't change here.
create or replace function public.set_firm_member_role(p_profile uuid, p_role text)
returns void
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  v_me uuid := (select auth.uid());
  v_firm uuid := (select firm_id from public.profiles where id = v_me);
begin
  if v_firm is null or not private.is_firm_admin(v_firm, v_me) then
    raise exception 'Only a firm owner or admin can change seats' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'counselor', 'assistant') then
    raise exception 'That isn''t a seat' using errcode = '22023';
  end if;
  if exists (select 1 from public.firms where id = v_firm and owner_id = p_profile) then
    raise exception 'The owner''s seat can''t change' using errcode = 'P0001';
  end if;
  update public.firm_members set seat_role = p_role where firm_id = v_firm and profile_id = p_profile;
  if not found then
    raise exception 'That person isn''t in your firm' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_firm_member_role(uuid, text) from public, anon;
grant execute on function public.set_firm_member_role(uuid, text) to authenticated;

-- An owner/admin removes a member, or a member leaves. The owner can't leave
-- their own firm. Students stay with the counselor they belong to.
create or replace function public.remove_firm_member(p_profile uuid)
returns void
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  v_me uuid := (select auth.uid());
  v_firm uuid := (select firm_id from public.profiles where id = v_me);
begin
  if v_firm is null then
    raise exception 'You''re not part of a firm' using errcode = 'P0002';
  end if;
  if p_profile <> v_me and not private.is_firm_admin(v_firm, v_me) then
    raise exception 'Only a firm owner or admin can remove someone' using errcode = '42501';
  end if;
  if exists (select 1 from public.firms where id = v_firm and owner_id = p_profile) then
    raise exception 'The owner can''t leave their own firm' using errcode = 'P0001';
  end if;
  delete from public.firm_members where firm_id = v_firm and profile_id = p_profile;
  if not found then
    raise exception 'That person isn''t in your firm' using errcode = 'P0002';
  end if;
  update public.profiles set firm_id = null where id = p_profile and firm_id = v_firm;
end;
$$;
revoke all on function public.remove_firm_member(uuid) from public, anon;
grant execute on function public.remove_firm_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Delivery webhooks
-- ---------------------------------------------------------------------------

alter table public.message_deliveries
  add column if not exists delivered_at    timestamptz,
  add column if not exists provider_status text check (provider_status is null or length(provider_status) <= 60),
  add column if not exists last_event_at   timestamptz;

create index if not exists message_deliveries_provider_idx
  on public.message_deliveries (provider, provider_message_id) where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Job heartbeats (service_role only)
-- ---------------------------------------------------------------------------

create table if not exists public.job_heartbeats (
  job           text primary key check (job in ('accountability-sweep', 'message-dispatch', 'scorecard-ingest', 'resources-link-check')),
  last_ok_at    timestamptz,
  last_error_at timestamptz,
  last_error    text check (length(last_error) <= 500),
  -- How often it should run; monitoring calls it stale after twice this.
  expected_every interval not null,
  updated_at    timestamptz not null default now()
);

insert into public.job_heartbeats (job, expected_every) values
  ('accountability-sweep', interval '15 minutes'),
  ('message-dispatch', interval '15 minutes'),
  ('scorecard-ingest', interval '31 days'),
  ('resources-link-check', interval '7 days')
on conflict (job) do nothing;

alter table public.job_heartbeats enable row level security;
revoke all on public.job_heartbeats from public, anon, authenticated;
