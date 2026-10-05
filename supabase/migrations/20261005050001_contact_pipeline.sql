-- Contact Pipeline (demo v7-v10): every family from first inquiry to active
-- student, as stage columns of contact cards.
--
-- This is the practice's private CRM. A student never reads any of it, not
-- even a contact row that has since become them.
--
-- Workspace. A counselor in a firm shares one pipeline with the firm's other
-- members; a solo counselor has their own. Every row carries `firm_id`
-- (null for solo) and `counselor_id` (who created it), and
-- `private.crm_can_access` reads them: firm rows are open to the firm's
-- members, solo rows to their counselor. New rows are pinned to the caller's
-- current workspace by the insert policies, so a client cannot file a contact
-- into somebody else's firm.
--
-- Stages are the practice's own (renamed in place, reordered by drag, added,
-- deleted with their contacts moved to the stage before). v9 groups them into
-- four lifecycle groups (Prospect, Lead, Client, Current); the group is a
-- property of the STAGE, so a contact's group follows it from column to column
-- and is never stored on the contact.
--
-- Days in stage is derived from `stage_entered_at`, which a trigger resets
-- whenever `stage_id` changes, so no route can forget to and no client can
-- backdate it (the column is not client-updatable).
--
-- A contact becomes a student through the existing email invitation: the
-- contact records the invitation it sent, and when that invitation is
-- accepted `student_id` is filled in by a trigger. Both linkage columns are
-- withheld from the client UPDATE grant.

-- ---------------------------------------------------------------------------
-- Workspace helpers
-- ---------------------------------------------------------------------------

-- Membership counts the firm's owner too: firms are created by hand today and
-- an owner is not guaranteed a firm_members row.
create or replace function private.crm_firm_member(p_firm uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select p_firm is not null and p_viewer is not null and (
    exists (select 1 from public.firm_members m where m.firm_id = p_firm and m.profile_id = p_viewer)
    or exists (select 1 from public.firms f where f.id = p_firm and f.owner_id = p_viewer)
  );
$$;

create or replace function private.crm_firm_admin(p_firm uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select p_firm is not null and p_viewer is not null and (
    exists (select 1 from public.firm_members m
            where m.firm_id = p_firm and m.profile_id = p_viewer and m.seat_role in ('owner', 'admin'))
    or exists (select 1 from public.firms f where f.id = p_firm and f.owner_id = p_viewer)
  );
$$;

-- The caller's workspace firm: their profile's firm, but only while they are
-- actually a member of it.
create or replace function private.crm_workspace_firm(p_viewer uuid)
returns uuid
language sql stable security definer set search_path to 'private', 'public'
as $$
  select p.firm_id from public.profiles p
  where p.id = p_viewer and p.firm_id is not null and private.crm_firm_member(p.firm_id, p_viewer);
$$;

create or replace function private.crm_can_access(p_firm uuid, p_counselor uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select private.is_counselor(p_viewer) and (
    case when p_firm is null then p_counselor = p_viewer
         else private.crm_firm_member(p_firm, p_viewer) end
  );
$$;

-- The row is being written into the caller's own current workspace.
create or replace function private.crm_is_own_workspace(p_firm uuid, p_counselor uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select private.is_counselor(p_viewer)
     and p_counselor = p_viewer
     and p_firm is not distinct from private.crm_workspace_firm(p_viewer);
$$;

revoke all on function private.crm_firm_member(uuid, uuid) from public, anon;
revoke all on function private.crm_firm_admin(uuid, uuid) from public, anon;
revoke all on function private.crm_workspace_firm(uuid) from public, anon;
revoke all on function private.crm_can_access(uuid, uuid, uuid) from public, anon;
revoke all on function private.crm_is_own_workspace(uuid, uuid, uuid) from public, anon;
grant execute on function private.crm_firm_member(uuid, uuid) to authenticated;
grant execute on function private.crm_firm_admin(uuid, uuid) to authenticated;
grant execute on function private.crm_workspace_firm(uuid) to authenticated;
grant execute on function private.crm_can_access(uuid, uuid, uuid) to authenticated;
grant execute on function private.crm_is_own_workspace(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Stages
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_stages (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid references public.firms(id) on delete cascade,
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  position         integer not null default 0 check (position between 0 and 1000),
  lifecycle_group  text not null default 'prospect'
                   check (lifecycle_group in ('prospect', 'lead', 'client', 'current')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pipeline_stages_firm_idx on public.pipeline_stages (firm_id, position)
  where firm_id is not null;
create index if not exists pipeline_stages_solo_idx on public.pipeline_stages (counselor_id, position)
  where firm_id is null;

drop trigger if exists pipeline_stages_set_updated_at on public.pipeline_stages;
create trigger pipeline_stages_set_updated_at before update on public.pipeline_stages
  for each row execute function public.set_updated_at();

alter table public.pipeline_stages enable row level security;

drop policy if exists pipeline_stages_select on public.pipeline_stages;
create policy pipeline_stages_select on public.pipeline_stages
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_stages_insert on public.pipeline_stages;
create policy pipeline_stages_insert on public.pipeline_stages
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_stages_update on public.pipeline_stages;
create policy pipeline_stages_update on public.pipeline_stages
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_stages_delete on public.pipeline_stages;
create policy pipeline_stages_delete on public.pipeline_stages
  for delete to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

revoke all on public.pipeline_stages from public, anon, authenticated;
grant select, insert, delete on public.pipeline_stages to authenticated;
grant update (name, position, lifecycle_group) on public.pipeline_stages to authenticated;

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_contacts (
  id                uuid primary key default gen_random_uuid(),
  firm_id           uuid references public.firms(id) on delete cascade,
  counselor_id      uuid not null references public.profiles(id) on delete cascade,
  stage_id          uuid not null references public.pipeline_stages(id) on delete restrict,
  position          integer not null default 0 check (position between 0 and 100000),
  student_name      text not null default '' check (length(student_name) <= 200),
  grad_year         integer check (grad_year between 2000 and 2100),
  student_email     text not null default '' check (length(student_email) <= 320),
  student_phone     text not null default '' check (length(student_phone) <= 40),
  parent_name       text not null default '' check (length(parent_name) <= 200),
  parent_email      text not null default '' check (length(parent_email) <= 320),
  parent_phone      text not null default '' check (length(parent_phone) <= 40),
  next_step         text not null default '' check (length(next_step) <= 300),
  -- A consultant in the workspace (checked by trigger), not free text.
  owner_id          uuid references public.profiles(id) on delete set null,
  -- The info-card fields a contact has before they are a student (high
  -- school, GPA, scores, address...). Validated key by key in the API.
  info              jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(info) = 'object' and pg_column_size(info) <= 16384),
  stage_entered_at  timestamptz not null default now(),
  -- Conversion: the invitation this contact was sent, and the student it
  -- became once accepted. Written by trigger / API checks only.
  invitation_id     uuid references public.invitations(id) on delete set null,
  invited_at        timestamptz,
  student_id        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists pipeline_contacts_stage_idx on public.pipeline_contacts (stage_id, position);
create index if not exists pipeline_contacts_firm_idx on public.pipeline_contacts (firm_id) where firm_id is not null;
create index if not exists pipeline_contacts_solo_idx on public.pipeline_contacts (counselor_id) where firm_id is null;
create index if not exists pipeline_contacts_invitation_idx on public.pipeline_contacts (invitation_id)
  where invitation_id is not null;

drop trigger if exists pipeline_contacts_set_updated_at on public.pipeline_contacts;
create trigger pipeline_contacts_set_updated_at before update on public.pipeline_contacts
  for each row execute function public.set_updated_at();

-- Integrity a policy can't express: the stage is in the contact's workspace,
-- the owner is a consultant there, a stage change restarts the clock, and an
-- invitation link is the caller's own invitation to this contact.
create or replace function private.pipeline_contacts_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  s public.pipeline_stages;
  inv public.invitations;
  caller uuid := (select auth.uid());
begin
  select * into s from public.pipeline_stages where id = new.stage_id;
  if not found
     or s.firm_id is distinct from new.firm_id
     or (new.firm_id is null and s.counselor_id <> new.counselor_id) then
    raise exception 'That stage is not in this pipeline' using errcode = '23514';
  end if;

  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) then
    if not (
      (new.firm_id is null and new.owner_id = new.counselor_id)
      or (new.firm_id is not null and private.crm_firm_member(new.firm_id, new.owner_id))
    ) then
      raise exception 'The owner must be a consultant in this practice' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.stage_entered_at := now();
    new.student_id := null;
    if new.invitation_id is not null then
      raise exception 'Link an invitation after the contact exists' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    new.stage_entered_at := now();
  end if;

  if new.invitation_id is distinct from old.invitation_id then
    if new.invitation_id is null then
      new.invited_at := null;
    else
      select * into inv from public.invitations where id = new.invitation_id;
      -- caller is null for the service role; otherwise it must be the
      -- caller's own invitation, to this contact's student address.
      if not found
         or (caller is not null and inv.counselor_id <> caller)
         or lower(btrim(inv.email)) <> lower(btrim(new.student_email)) then
        raise exception 'That invitation does not belong to this contact' using errcode = '42501';
      end if;
      new.invited_at := inv.created_at;
      if inv.status = 'accepted' and inv.accepted_by is not null then
        new.student_id := inv.accepted_by;
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.pipeline_contacts_guard() from public, anon, authenticated;

drop trigger if exists pipeline_contacts_guard on public.pipeline_contacts;
create trigger pipeline_contacts_guard before insert or update on public.pipeline_contacts
  for each row execute function private.pipeline_contacts_guard();

alter table public.pipeline_contacts enable row level security;

drop policy if exists pipeline_contacts_select on public.pipeline_contacts;
create policy pipeline_contacts_select on public.pipeline_contacts
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_contacts_insert on public.pipeline_contacts;
create policy pipeline_contacts_insert on public.pipeline_contacts
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_contacts_update on public.pipeline_contacts;
create policy pipeline_contacts_update on public.pipeline_contacts
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_contacts_delete on public.pipeline_contacts;
create policy pipeline_contacts_delete on public.pipeline_contacts
  for delete to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

revoke all on public.pipeline_contacts from public, anon, authenticated;
grant select, insert, delete on public.pipeline_contacts to authenticated;
grant update (
  stage_id, position, student_name, grad_year, student_email, student_phone,
  parent_name, parent_email, parent_phone, next_step, owner_id, info, invitation_id
) on public.pipeline_contacts to authenticated;

-- When an invitation is accepted, the contact it was sent from learns which
-- student it became. accept_invitation() is SECURITY DEFINER, so this runs
-- with the same rights; it touches nothing but the linkage column.
create or replace function private.pipeline_contacts_on_invitation_accepted()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.status = 'accepted' and new.accepted_by is not null
     and (old.status is distinct from 'accepted' or old.accepted_by is distinct from new.accepted_by) then
    update public.pipeline_contacts
       set student_id = new.accepted_by
     where invitation_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_contacts_on_invitation_accepted() from public, anon, authenticated;

drop trigger if exists invitations_link_pipeline_contact on public.invitations;
create trigger invitations_link_pipeline_contact after update of status, accepted_by on public.invitations
  for each row execute function private.pipeline_contacts_on_invitation_accepted();

-- ---------------------------------------------------------------------------
-- Operations that must be atomic
-- ---------------------------------------------------------------------------

-- Seed the default stages the first time a workspace opens its pipeline. The
-- names and groups are the brief's (v7 stages, v9 groups); they are product
-- defaults, not data. Serialized per workspace so two tabs can't seed twice.
create or replace function public.ensure_pipeline_stages()
returns void
language plpgsql
security invoker
set search_path to 'public', 'private'
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_firm uuid;
begin
  if v_uid is null or not private.is_counselor(v_uid) then
    raise exception 'Only counselors have a pipeline' using errcode = '42501';
  end if;
  v_firm := private.crm_workspace_firm(v_uid);
  perform pg_advisory_xact_lock(hashtext('pipeline-stages:' || coalesce(v_firm, v_uid)::text));

  if exists (
    select 1 from public.pipeline_stages s
    where (v_firm is not null and s.firm_id = v_firm)
       or (v_firm is null and s.firm_id is null and s.counselor_id = v_uid)
  ) then
    return;
  end if;

  insert into public.pipeline_stages (firm_id, counselor_id, name, position, lifecycle_group)
  select v_firm, v_uid, d.name, d.position, d.grp
  from (values
    ('Inquiry received', 0, 'prospect'),
    ('Consultant assigned', 1, 'prospect'),
    ('Consult scheduled', 2, 'lead'),
    ('Follow-up', 3, 'lead'),
    ('Booked', 4, 'lead'),
    ('Contract signed', 5, 'client'),
    ('Payment confirmed', 6, 'client'),
    ('Officially onboarded', 7, 'client'),
    ('Active student', 8, 'current')
  ) as d(name, position, grp);
end;
$$;

-- Delete a stage and move its contacts to the stage before it, or, for the
-- first stage, to the last. Moved cards go to the bottom of their new column
-- and their days-in-stage restart (the guard trigger does that). Returns the
-- stage the contacts went to.
create or replace function public.delete_pipeline_stage(p_stage uuid)
returns uuid
language plpgsql
security invoker
set search_path to 'public', 'private'
as $$
declare
  v_stage  public.pipeline_stages;
  v_ids    uuid[];
  v_at     integer;
  v_target uuid;
  v_next   integer;
begin
  select * into v_stage from public.pipeline_stages where id = p_stage;
  if not found then
    raise exception 'That stage is not in your pipeline' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtext('pipeline-stages:' || coalesce(v_stage.firm_id, v_stage.counselor_id)::text));

  select array_agg(s.id order by s.position, s.created_at) into v_ids
  from public.pipeline_stages s
  where s.firm_id is not distinct from v_stage.firm_id
    and (v_stage.firm_id is not null or s.counselor_id = v_stage.counselor_id);

  if coalesce(array_length(v_ids, 1), 0) <= 1 then
    raise exception 'A pipeline needs at least one stage' using errcode = 'P0001';
  end if;

  v_at := array_position(v_ids, p_stage);
  v_target := case when v_at = 1 then v_ids[array_length(v_ids, 1)] else v_ids[v_at - 1] end;

  select coalesce(max(position) + 1, 0) into v_next from public.pipeline_contacts where stage_id = v_target;

  update public.pipeline_contacts c
     set stage_id = v_target,
         position = v_next + o.rn - 1
    from (
      select id, row_number() over (order by position, created_at) as rn
      from public.pipeline_contacts where stage_id = p_stage
    ) o
   where c.id = o.id;

  delete from public.pipeline_stages where id = p_stage;

  update public.pipeline_stages s
     set position = o.rn - 1
    from (
      select id, row_number() over (order by position, created_at) as rn
      from public.pipeline_stages
      where id = any (v_ids) and id <> p_stage
    ) o
   where s.id = o.id and s.position <> o.rn - 1;

  return v_target;
end;
$$;

-- Reorder every stage of the caller's workspace. The ids must be exactly the
-- workspace's stages, so a stale client can't half-apply an order.
create or replace function public.reorder_pipeline_stages(p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path to 'public', 'private'
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_firm uuid := private.crm_workspace_firm(v_uid);
  v_have uuid[];
begin
  perform pg_advisory_xact_lock(hashtext('pipeline-stages:' || coalesce(v_firm, v_uid)::text));
  select array_agg(s.id order by s.id) into v_have
  from public.pipeline_stages s
  where (v_firm is not null and s.firm_id = v_firm)
     or (v_firm is null and s.firm_id is null and s.counselor_id = v_uid);

  if v_have is null
     or array_length(p_ids, 1) is distinct from array_length(v_have, 1)
     or (select array_agg(x order by x) from (select distinct unnest(p_ids) as x) d) is distinct from v_have then
    raise exception 'That order does not match your stages. Refresh and try again.' using errcode = '22023';
  end if;

  update public.pipeline_stages s
     set position = o.ord - 1
    from unnest(p_ids) with ordinality as o(id, ord)
   where s.id = o.id and s.position <> o.ord - 1;
end;
$$;

-- Write the board's layout back after a drag: { stageId: [contactId, ...] }.
-- Every stage and contact named must be in the caller's workspace.
create or replace function public.apply_pipeline_layout(p_layout jsonb)
returns void
language plpgsql
security invoker
set search_path to 'public', 'private'
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_firm  uuid := private.crm_workspace_firm(v_uid);
  v_stage text;
  v_ids   jsonb;
  v_count integer;
  v_found integer;
begin
  if jsonb_typeof(p_layout) <> 'object' then
    raise exception 'Layout must be an object of stage ids' using errcode = '22023';
  end if;

  for v_stage, v_ids in select key, value from jsonb_each(p_layout) loop
    if jsonb_typeof(v_ids) <> 'array' then
      raise exception 'Each stage needs a list of contacts' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.pipeline_stages s
      where s.id = v_stage::uuid
        and ((v_firm is not null and s.firm_id = v_firm)
             or (v_firm is null and s.firm_id is null and s.counselor_id = v_uid))
    ) then
      raise exception 'That stage is not in your pipeline' using errcode = 'P0002';
    end if;

    v_count := jsonb_array_length(v_ids);
    with o as (
      select (e.value #>> '{}')::uuid as id, e.ord - 1 as pos
      from jsonb_array_elements(v_ids) with ordinality as e(value, ord)
    ), u as (
      update public.pipeline_contacts c
         set stage_id = v_stage::uuid, position = o.pos
        from o
       where c.id = o.id
         and c.firm_id is not distinct from v_firm
         and (v_firm is not null or c.counselor_id = v_uid)
      returning c.id
    )
    select count(*) into v_found from u;

    if v_found <> v_count then
      raise exception 'A contact on that board is no longer in your pipeline. Refresh and try again.'
        using errcode = 'P0002';
    end if;
  end loop;
end;
$$;

revoke all on function public.ensure_pipeline_stages() from public, anon;
revoke all on function public.delete_pipeline_stage(uuid) from public, anon;
revoke all on function public.reorder_pipeline_stages(uuid[]) from public, anon;
revoke all on function public.apply_pipeline_layout(jsonb) from public, anon;
grant execute on function public.ensure_pipeline_stages() to authenticated;
grant execute on function public.delete_pipeline_stage(uuid) to authenticated;
grant execute on function public.reorder_pipeline_stages(uuid[]) to authenticated;
grant execute on function public.apply_pipeline_layout(jsonb) to authenticated;

-- The caller's workspace, for the API: which firm (null when solo) and whether
-- they administer it. A solo counselor administers their own practice.
create or replace function public.crm_my_workspace()
returns table (firm_id uuid, is_admin boolean)
language sql
stable
security definer
set search_path to 'public', 'private'
as $$
  select f.firm_id,
         case when f.firm_id is null then true else private.crm_firm_admin(f.firm_id, (select auth.uid())) end
  from (select private.crm_workspace_firm((select auth.uid())) as firm_id) f
  where private.is_counselor((select auth.uid()));
$$;

revoke all on function public.crm_my_workspace() from public, anon;
grant execute on function public.crm_my_workspace() to authenticated;
