-- Import invitations: Meridies looks once per counselor, not once per import
-- (spec §5.1).
--
-- 20261023020003 held only a counselor's FIRST saved import, and only when
-- that one import invited more than 50. Splitting a list into imports of 50,
-- or saving a one-row import first, sent any number of invitations with no
-- review. Now the rule is per counselor: until Meridies has approved one of
-- their imports (invites_approved_at on any of them), the invitations their
-- saved imports have sent or still hold (an item tied to an invitation, or
-- waiting to be invited), with this import's, may come to 50; past that an
-- import's invitations wait. Approving any one of their imports releases
-- every import of theirs, earlier ones included.
--
-- Counted over every import whose counselor_id is theirs, whatever firm it
-- was made in (definer functions, not the caller's RLS, which hides an
-- uploader's imports in a firm they have left and a member's solo imports
-- from a firm admin). Items that came with a caseload transfer count for
-- the receiver.
--
--  - private.import_invite_review_of(counselor, import): the one count.
--  - public.import_invite_review(import): the API's question (lib/imports/
--    invitations.ts), for an import the caller may manage.
--  - request_import_commit holds at commit, import_claim_invites at every
--    send (so an import committed under 50 is held once later ones pass it,
--    and released once any is approved).
-- The bodies are otherwise 20261023020003's, unchanged.
--
-- The API applies the same rule itself (through public.import_invite_review
-- when this file is applied, else on the service role, holding when it has
-- neither), so the hold works before this file is applied.
--
-- Deploy order: either. Apply after 20261023020003 (it replaces that file's
-- request_import_commit and import_claim_invites with the same signatures).
-- Code first: the API holds through the service role. This first: the
-- previous code's commit and send paths read invites_held_reason as before.
-- Not in REQUIRED_SCHEMA: nothing new for a request to need.

create or replace function private.import_invite_review_of(p_counselor uuid, p_import uuid)
returns table (approved boolean, total integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (select 1 from public.roster_imports o
             where o.counselor_id = p_counselor and o.permission_confirmed_at is not null
               and o.invites_approved_at is not null),
    (select count(*)::integer
       from public.import_items it
       join public.roster_imports o on o.id = it.import_id
      where o.counselor_id = p_counselor and o.permission_confirmed_at is not null
        and (o.committed_at is not null or o.id = p_import)
        and (it.match_status = 'new_invite' or it.invitation_id is not null));
$$;
revoke all on function private.import_invite_review_of(uuid, uuid) from public, anon, authenticated;

create or replace function public.import_invite_review(p_import uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
  r record;
begin
  if v_me is null or not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import;
  if v.invites_approved_at is not null then
    return jsonb_build_object('approved', true, 'hold', false, 'total', 0);
  end if;
  select * into r from private.import_invite_review_of(v.counselor_id, p_import);
  return jsonb_build_object('approved', r.approved, 'hold', not r.approved and r.total > 50, 'total', r.total);
end;
$$;
revoke all on function public.import_invite_review(uuid) from public, anon;
grant execute on function public.import_invite_review(uuid) to authenticated;

create or replace function public.request_import_commit(p_import uuid, p_invitations integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
  v_invites integer := 0;
  v_hold boolean := false;
  r record;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if v.status in ('committing','undoing') then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v.status <> 'review' then
    raise exception 'Only an import in review can be saved' using errcode = '55000';
  end if;
  select count(*) into v_invites
  from public.import_items where import_id = p_import and match_status = 'new_invite';
  if (v_invites > 0 or p_invitations is not null) and p_invitations is distinct from v_invites then
    raise exception 'Confirm the % invitations this import will send', v_invites using errcode = 'MI001';
  end if;
  if v.permission_confirmed_at is not null and v_invites > 0 and v.invites_approved_at is null then
    select * into r from private.import_invite_review_of(v.counselor_id, p_import);
    v_hold := not r.approved and r.total > 50;
  end if;
  update public.roster_imports
     set status = 'committing', job_actor = v_me, job_requested_at = now(), job_error = null,
         invites_held_reason = case when v_hold then 'first-import-review' else invites_held_reason end
   where id = p_import;
end;
$$;
revoke all on function public.request_import_commit(uuid, integer) from public, anon;
grant execute on function public.request_import_commit(uuid, integer) to authenticated;

create or replace function public.import_claim_invites(p_import uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
  v_items jsonb;
  v_left integer;
  v_review record;
begin
  if v_me is null or not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if v.permission_confirmed_at is null then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  if v.counselor_id <> v_me then
    raise exception 'Invitations go out in the name of the counselor who uploaded this import' using errcode = 'MI002';
  end if;
  if v.status <> 'committed' then
    raise exception 'Invitations go out after the import is saved' using errcode = '55000';
  end if;
  -- The per-counselor review, at send time too: approval of any of their
  -- imports releases this one; otherwise past 50 in all it waits.
  select * into v_review from private.import_invite_review_of(v.counselor_id, p_import);
  if not v_review.approved and (v.invites_held_reason is not null or v_review.total > 50) then
    if v.invites_held_reason is null then
      update public.roster_imports set invites_held_reason = 'first-import-review' where id = p_import;
    end if;
    return jsonb_build_object('held', true, 'items', '[]'::jsonb, 'remaining',
      (select count(*) from public.import_items
        where import_id = p_import and match_status = 'new_invite' and invite_state in ('unsent','failed')));
  end if;
  if v_review.approved and v.invites_held_reason is not null and v.invites_approved_at is null then
    update public.roster_imports set invites_held_reason = null where id = p_import;
  end if;

  with c as (
    select it.id
    from public.import_items it
    where it.import_id = p_import and it.match_status = 'new_invite'
      and (it.invite_state in ('unsent','failed')
           or (it.invite_state = 'sending' and it.invite_claimed_at < now() - interval '10 minutes'))
    -- Never-tried first, so a retry of failing addresses can't starve the rest.
    order by (it.invite_state = 'failed'), it.created_at, it.id
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  ), u as (
    update public.import_items it
       set invite_state = 'sending', invite_claimed_at = now()
      from c
     where c.id = it.id
    returning it.id, it.match_key, it.imported_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', u.id,
           'email', lower(btrim(u.match_key ->> 'email')),
           'name', u.imported_name,
           'gradYear', case when u.match_key ->> 'gradYear' ~ '^\d{4}$' then (u.match_key ->> 'gradYear')::integer end)), '[]'::jsonb)
    into v_items
    from u;

  select count(*) into v_left from public.import_items
   where import_id = p_import and match_status = 'new_invite' and invite_state in ('unsent','failed');
  return jsonb_build_object('held', false, 'items', v_items, 'remaining', v_left);
end;
$$;
revoke all on function public.import_claim_invites(uuid, integer) from public, anon;
grant execute on function public.import_claim_invites(uuid, integer) to authenticated;
