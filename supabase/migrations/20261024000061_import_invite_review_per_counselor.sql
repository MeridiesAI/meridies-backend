-- Import invitations: Meridies looks once per counselor, not once per import
-- (spec §5.1).
--
-- 20261023020003 held only a counselor's FIRST saved import, and only when
-- that one import invited more than 50. Splitting a list into imports of 50,
-- or saving a one-row import first, sent any number of invitations with no
-- review. Now a commit holds its invitations whenever Meridies has approved
-- none of the counselor's imports yet (invites_approved_at on any of them)
-- and the invitations their saved imports have sent or still hold (an item
-- tied to an invitation, or waiting to be invited), plus this import's, come
-- to more than 50. Approving one import (invites_approved_at) releases it
-- and every later import of that counselor. The body is otherwise
-- 20261023020003's, unchanged.
--
-- The API applies the same rule itself (lib/imports/invitations.ts
-- inviteReview: after a commit request, and again before every send), so
-- the hold works before this file is applied; this makes the database hold
-- on its own as well.
--
-- Deploy order: either. Apply after 20261023020003 (it replaces that file's
-- request_import_commit with the same signature). Code first: the API holds
-- through the service role. This first: the previous code's commit and send
-- paths read invites_held_reason as before. Not in REQUIRED_SCHEMA: nothing
-- new for a request to need.

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
  v_prior integer := 0;
  v_hold boolean := false;
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
  if v.permission_confirmed_at is not null and v_invites > 0 and v.invites_approved_at is null
     and not exists (select 1 from public.roster_imports o
                      where o.counselor_id = v.counselor_id and o.permission_confirmed_at is not null
                        and o.invites_approved_at is not null) then
    select count(*) into v_prior
    from public.import_items it
    join public.roster_imports o on o.id = it.import_id
    where o.counselor_id = v.counselor_id and o.id <> p_import
      and o.permission_confirmed_at is not null and o.committed_at is not null
      and (it.match_status = 'new_invite' or it.invitation_id is not null);
    v_hold := v_prior + v_invites > 50;
  end if;
  update public.roster_imports
     set status = 'committing', job_actor = v_me, job_requested_at = now(), job_error = null,
         invites_held_reason = case when v_hold then 'first-import-review' else invites_held_reason end
   where id = p_import;
end;
$$;
revoke all on function public.request_import_commit(uuid, integer) from public, anon;
grant execute on function public.request_import_commit(uuid, integer) to authenticated;
