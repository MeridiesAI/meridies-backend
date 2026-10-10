-- Counselor approval gate (docs/superpowers/specs/2026-10-10-counselor-approval-gate-design.md).
--
-- A counselor account is pending until Meridies approves it. The one fact is
-- profiles.counselor_approved_at; private.is_counselor reads it, so every
-- policy and function that asks "is this a counselor" now asks "an approved
-- one". Users cannot write the new columns: profiles UPDATE is granted per
-- column (20260828000016) and these are not on that list.

-- ---------------------------------------------------------------------------
-- 1. The columns. Everyone who is a counselor today keeps working. Guarded on
--    the column's absence, so re-running this file never re-approves an
--    account that was revoked afterwards.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'counselor_approved_at'
  ) then
    alter table public.profiles
      add column counselor_approved_at  timestamptz,
      add column counselor_approved_via text
        constraint profiles_counselor_approved_via_check
        check (counselor_approved_via is null or counselor_approved_via in ('grandfathered', 'team', 'firm_invite')),
      add column counselor_revoked_at   timestamptz;

    update public.profiles
       set counselor_approved_at = now(), counselor_approved_via = 'grandfathered'
     where role = 'counselor';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Review requests. The emailed token is stored as its sha256 only.
-- ---------------------------------------------------------------------------
create table if not exists public.counselor_access_requests (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  used_at      timestamptz,
  -- The newer request that retired this one, so cancelling that request (its
  -- email could not be sent) can bring this link back. No foreign key: the
  -- newer row is written after this one is retired.
  superseded_by uuid
);
create index if not exists counselor_access_requests_profile_idx
  on public.counselor_access_requests (profile_id, requested_at desc);
-- At most one live request per account: two simultaneous asks cannot both mint a link.
create unique index if not exists counselor_access_requests_one_unused
  on public.counselor_access_requests (profile_id) where used_at is null;

alter table public.counselor_access_requests enable row level security;
-- No policies: service role only.
revoke all on public.counselor_access_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. "Is a counselor" now means "is an approved counselor".
-- ---------------------------------------------------------------------------
create or replace function private.is_counselor(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select coalesce(
    (select role = 'counselor' and counselor_approved_at is not null
       from public.profiles where id = user_id),
    false);
$$;

-- A revoked owner or admin administers nothing.
create or replace function private.is_firm_admin(firm uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select private.is_counselor(viewer) and exists (
    select 1 from public.firm_members m
    where m.firm_id = firm and m.profile_id = viewer and m.seat_role in ('owner','admin')
  );
$$;

-- Imports: the three request_* functions and the three job functions all ask
-- can_manage_import, which asks this.
create or replace function private.can_view_import(p_import uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null and private.is_counselor(p_viewer) and exists (
    select 1 from public.roster_imports i
    where i.id = p_import
      and (
        (i.counselor_id = p_viewer
         and (i.firm_id is null or private.crm_firm_member(i.firm_id, p_viewer)))
        or (i.firm_id is not null and private.crm_firm_admin(i.firm_id, p_viewer))
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 3b. A roster is closed to its counselor while they are not approved.
--     The student-scoped tables (about 130 policies, plus the documents bucket)
--     never ask is_counselor: they ask is_counselor_of / can_view_student /
--     can_edit_student. So the counselor and collaborator branches ask about
--     approval here. The `student = viewer` branches are untouched: a student
--     keeps their own record whatever happens to their counselor.
-- ---------------------------------------------------------------------------
create or replace function private.is_counselor_of(student uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select private.is_counselor(viewer) and (
    exists (
      select 1 from public.profiles p
      where p.id = student and p.counselor_id = viewer
    ) or exists (
      select 1 from public.student_collaborators c
      where c.student_id = student and c.counselor_id = viewer
    )
  );
$$;

create or replace function private.can_edit_student(student uuid, viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select student = viewer
      or (private.is_counselor(viewer) and (
            exists (select 1 from public.profiles p
                    where p.id = student and p.counselor_id = viewer)
         or exists (select 1 from public.student_collaborators c
                    where c.student_id = student and c.counselor_id = viewer and c.access = 'write')));
$$;

-- The two original profiles policies compared counselor_id alone.
drop policy if exists "profiles_select_counselor_of_student" on public.profiles;
create policy "profiles_select_counselor_of_student" on public.profiles
  for select using ((select auth.uid()) = counselor_id and private.is_counselor((select auth.uid())));

drop policy if exists "profiles_update_counselor_of_student" on public.profiles;
create policy "profiles_update_counselor_of_student" on public.profiles
  for update using ((select auth.uid()) = counselor_id and private.is_counselor((select auth.uid())));

-- Only an approved primary counselor may share a student out.
drop policy if exists student_collaborators_write_primary on public.student_collaborators;
create policy student_collaborators_write_primary on public.student_collaborators
  for all to authenticated
  using ((select auth.uid()) = private.get_user_counselor_id(student_id)
         and private.is_counselor((select auth.uid())))
  with check ((select auth.uid()) = private.get_user_counselor_id(student_id)
              and private.is_counselor((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 3c. The blanket rule. Many policies key on ownership alone (a file's
--     uploader, a row's counselor_id), so no list of helpers can be complete.
--     One restrictive policy on every table says it once: a counselor who is
--     not approved sees and writes nothing, except their own profiles row.
--     Restrictive policies AND with everything else, so nobody gains access;
--     students and approved counselors pass it untouched. It is wrapped in
--     (select ...) so Postgres evaluates it once per statement.
--     NEW TABLES: call private.attach_approval_gate('public.<table>') in the
--     migration that creates them (approval-db.test.mjs fails otherwise).
-- ---------------------------------------------------------------------------
create or replace function private.account_open(viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private','public'
as $$
  select not exists (
    select 1 from public.profiles p
    where p.id = viewer and p.role = 'counselor' and p.counselor_approved_at is null
  );
$$;
revoke all on function private.account_open(uuid) from public, anon;
grant execute on function private.account_open(uuid) to authenticated;

create or replace function private.attach_approval_gate(p_table regclass)
returns void
language plpgsql
as $$
begin
  execute format('drop policy if exists approval_gate on %s', p_table);
  execute format(
    'create policy approval_gate on %s as restrictive for all to authenticated '
    'using ((select private.account_open((select auth.uid())))) '
    'with check ((select private.account_open((select auth.uid()))))', p_table);
end;
$$;
revoke all on function private.attach_approval_gate(regclass) from public, anon, authenticated;

do $$
declare
  t record;
begin
  for t in
    select c.oid::regclass as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
      and c.relname <> 'profiles'
  loop
    perform private.attach_approval_gate(t.tbl);
  end loop;
end;
$$;

-- profiles: the one row an unapproved counselor keeps is their own.
drop policy if exists approval_gate on public.profiles;
create policy approval_gate on public.profiles as restrictive for all to authenticated
  using ((select private.account_open((select auth.uid()))) or id = (select auth.uid()))
  with check ((select private.account_open((select auth.uid()))) or id = (select auth.uid()));

-- Files: Storage lets an uploader read their own objects whatever the
-- documents row says.
drop policy if exists approval_gate on storage.objects;
create policy approval_gate on storage.objects as restrictive for all to authenticated
  using ((select private.account_open((select auth.uid()))))
  with check ((select private.account_open((select auth.uid()))));

-- ---------------------------------------------------------------------------
-- 4. Policies that checked the role directly.
-- ---------------------------------------------------------------------------
drop policy if exists firms_insert_owner on public.firms;
create policy firms_insert_owner on public.firms
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

drop policy if exists invitations_insert_owner on public.invitations;
create policy invitations_insert_owner on public.invitations
  for insert to authenticated
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

drop policy if exists roster_imports_insert_own on public.roster_imports;
create policy roster_imports_insert_own on public.roster_imports
  for insert to authenticated
  with check (counselor_id = (select auth.uid()) and private.is_counselor((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 5. Joining a firm. A pending counselor may join (role alone); joining grants
--    nothing by itself. Approval rides on the invitation only when the inviter
--    is, right now, an approved owner or admin of this firm, and the joiner was
--    never revoked by Meridies. Body otherwise unchanged from 20261007000006.
-- ---------------------------------------------------------------------------
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
  if private.user_role(v_me) is distinct from 'counselor' then
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

  if v_inv.invited_by is not null and private.is_firm_admin(v_inv.firm_id, v_inv.invited_by) then
    update public.profiles
       set counselor_approved_at = now(), counselor_approved_via = 'firm_invite'
     where id = v_me and counselor_approved_at is null and counselor_revoked_at is null;
    if found then
      -- Meridies did not make this approval; leave it where the team can see it.
      insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
      values (v_inv.invited_by, 'counselor.access.approved', 'profile', v_me,
              jsonb_build_object('via', 'firm_invite', 'firm_id', v_inv.firm_id,
                                 'invited_by', v_inv.invited_by, 'invitation_id', v_inv.id));
    end if;
  end if;
  return v_inv.firm_id;
end;
$$;
revoke all on function public.accept_firm_invitation(text) from public, anon;
grant execute on function public.accept_firm_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. A student's invitation is only as good as the counselor who sent it.
--    Body otherwise unchanged from 20261014000007.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user             uuid := auth.uid();
  v_role             text;
  v_counselor        uuid;
  v_inv              public.invitations;
  v_inviter_role     text;
  v_inviter_approved timestamptz;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select role, counselor_id into v_role, v_counselor
  from public.profiles where id = v_user;

  if v_role is distinct from 'student' then
    raise exception 'Only students can accept an invitation' using errcode = '42501';
  end if;
  if v_counselor is not null then
    raise exception 'You are already connected to a counselor' using errcode = '23505';
  end if;

  select * into v_inv
  from public.invitations
  where token = p_token
  for update;

  if not found then
    raise exception 'That invitation link is not valid' using errcode = 'P0002';
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'That invitation was revoked' using errcode = 'P0001';
  end if;
  if v_inv.status = 'accepted' then
    raise exception 'That invitation has already been used' using errcode = '23505';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'That invitation link has expired' using errcode = 'P0001';
  end if;
  if v_inv.counselor_id = v_user then
    raise exception 'You cannot accept your own invitation' using errcode = 'P0001';
  end if;

  select role, counselor_approved_at into v_inviter_role, v_inviter_approved
  from public.profiles where id = v_inv.counselor_id;
  if v_inviter_role is distinct from 'counselor' then
    raise exception 'That invitation is no longer valid' using errcode = 'P0001';
  end if;
  if v_inviter_approved is null then
    raise exception 'That invitation is not available' using errcode = 'P0001';
  end if;

  update public.invitations
     set status = 'accepted', accepted_by = v_user, accepted_at = now()
   where id = v_inv.id;

  update public.profiles
     set counselor_id = v_inv.counselor_id,
         grad_year    = coalesce(nullif(grad_year, ''), v_inv.grad_year::text),
         timezone     = coalesce(nullif(timezone, ''), v_inv.timezone)
   where id = v_user;

  update public.import_items it
     set match_status = 'awaiting_counselor', student_id = v_user,
         held_until = now() + interval '30 days', invitation_id = v_inv.id
    from public.invitations i
   where i.id = it.invitation_id and it.match_status = 'new_invite'
     and (i.id = v_inv.id
          or (i.counselor_id = v_inv.counselor_id and lower(i.email) = lower(v_inv.email)
              and i.status in ('pending','revoked')));

  perform private.import_hold_legacy_rows(v_inv.id, v_user);

  return v_inv.counselor_id;
end;
$function$;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

create or replace function public.invitation_preview(p_token text)
returns table (counselor_name text, invited_email text, valid boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inv      public.invitations;
  v_name     text;
  v_approved boolean;
begin
  select * into v_inv from public.invitations where token = p_token;
  if not found then
    return query select null::text, null::text, false;
    return;
  end if;

  select full_name, (role = 'counselor' and counselor_approved_at is not null)
    into v_name, v_approved
  from public.profiles where id = v_inv.counselor_id;

  return query select
    v_name,
    v_inv.email,
    (v_inv.status = 'pending' and v_inv.expires_at >= now() and coalesce(v_approved, false));
end;
$function$;
revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Approve by emailed token. One statement consumes the token, so it works
--    once. In public because the API reaches Postgres through PostgREST; only
--    the service role may execute it.
-- ---------------------------------------------------------------------------
create or replace function public.approve_counselor_by_token(p_token_hash text)
returns table (profile_id uuid, email text, full_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.counselor_access_requests;
begin
  update public.counselor_access_requests r
     set used_at = now()
   where r.token_hash = p_token_hash and r.used_at is null and r.expires_at > now()
  returning r.* into v_req;
  if not found then
    return;
  end if;

  update public.profiles p
     set counselor_approved_at = now(), counselor_approved_via = 'team'
   where p.id = v_req.profile_id and p.role = 'counselor';

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'counselor.access.approved', 'profile', v_req.profile_id,
          jsonb_build_object('via', 'team', 'request_id', v_req.id));

  return query
    select p.id, p.email::text, p.full_name::text from public.profiles p where p.id = v_req.profile_id;
end;
$$;
revoke all on function public.approve_counselor_by_token(text) from public, anon, authenticated;
grant execute on function public.approve_counselor_by_token(text) to service_role;

-- ---------------------------------------------------------------------------
-- 7b. Opening a review request, and taking one back when its email could not
--     be sent. Each is one transaction, serialized per account by a row lock,
--     so two tabs asking at once open one link, and a failed send never costs
--     the team the link they already hold.
-- ---------------------------------------------------------------------------
create or replace function public.open_counselor_access_request(p_profile uuid, p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid := gen_random_uuid();
  v_last timestamptz;
begin
  perform 1 from public.profiles
   where id = p_profile and role = 'counselor' and counselor_approved_at is null
     for update;
  if not found then
    return null;
  end if;

  -- At most one review email per account per 24 hours.
  select max(requested_at) into v_last
  from public.counselor_access_requests where profile_id = p_profile;
  if v_last is not null and v_last > now() - interval '24 hours' then
    return null;
  end if;

  update public.counselor_access_requests
     set used_at = now(), superseded_by = v_id
   where profile_id = p_profile and used_at is null;

  insert into public.counselor_access_requests (id, profile_id, token_hash)
  values (v_id, p_profile, p_token_hash);
  return v_id;
end;
$$;
revoke all on function public.open_counselor_access_request(uuid, text) from public, anon, authenticated;
grant execute on function public.open_counselor_access_request(uuid, text) to service_role;

create or replace function public.cancel_counselor_access_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
begin
  select profile_id into v_profile from public.counselor_access_requests where id = p_id;
  if not found then
    return;
  end if;
  perform 1 from public.profiles where id = v_profile for update;

  delete from public.counselor_access_requests where id = p_id and used_at is null;
  if found then
    update public.counselor_access_requests
       set used_at = null, superseded_by = null
     where superseded_by = p_id;
  end if;
end;
$$;
revoke all on function public.cancel_counselor_access_request(uuid) from public, anon, authenticated;
grant execute on function public.cancel_counselor_access_request(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Revoke. Run by hand:  select private.revoke_counselor_access('<profile id>');
--    Revoking an owner or admin does not revoke members already approved
--    through their invitations; revoke each of those on their own if needed.
-- ---------------------------------------------------------------------------
create or replace function private.revoke_counselor_access(p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role        text;
  v_invitations integer;
  v_firm        integer;
begin
  select role into v_role from public.profiles where id = p_profile;
  if v_role is distinct from 'counselor' then
    raise exception 'That profile is not a counselor account' using errcode = 'P0002';
  end if;

  update public.profiles
     set counselor_approved_at = null, counselor_revoked_at = now()
   where id = p_profile;

  update public.invitations set status = 'revoked'
   where counselor_id = p_profile and status = 'pending';
  get diagnostics v_invitations = row_count;

  update public.firm_invitations set status = 'revoked'
   where invited_by = p_profile and status = 'pending';
  get diagnostics v_firm = row_count;

  update public.counselor_access_requests set used_at = now()
   where profile_id = p_profile and used_at is null;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'counselor.access.revoked', 'profile', p_profile,
          jsonb_build_object('invitations_revoked', v_invitations, 'firm_invitations_revoked', v_firm));

  return jsonb_build_object('revoked', p_profile,
                            'invitations_revoked', v_invitations,
                            'firm_invitations_revoked', v_firm);
end;
$$;
revoke all on function private.revoke_counselor_access(uuid) from public, anon, authenticated;
grant execute on function private.revoke_counselor_access(uuid) to service_role;
