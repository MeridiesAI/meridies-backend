-- Only accept_invitation marks an invitation accepted, and a task links only
-- to its own student's invitation.
--
-- 1. invitations_update_owner (20260829000001) let a counselor update every
--    column of their own invitations, and invitations had no column grants.
--    So a counselor could write {status: 'accepted', accepted_by: <any
--    profile>} through PostgREST: the Building profile card then treated that
--    profile as the student who joined (send-back emails and notifications
--    went to it), and the pipeline trigger linked a contact to it. The same
--    was possible at insert time.
--
--    After this file a client updates only what the app edits: status (and
--    only pending -> revoked), the New student card's fields, the intake
--    requests, dismissed_at, confirmed_at (only once accepted) and
--    submitted_at (only back to null, the send-back). A client insert starts
--    pending with no acceptance on it. accepted_by, accepted_at, token,
--    email, counselor_id and expires_at are written only by SECURITY DEFINER
--    functions (accept_invitation, submit_intake, caseload transfer, the
--    revoke and import functions), which run as the table owner and pass.
--
-- 2. deliverables_sync_intake_request (20261012000001) is SECURITY DEFINER
--    and wrote the intake_requests of whatever invitation a task named. A
--    counselor could insert a task for their own student pointing at another
--    practice's invitation and tick it complete, marking that practice's
--    request received. Now the link columns are written only by
--    sync_intake_tasks (a client insert or update that sets or changes them
--    is refused), and the sync touches an invitation only when it was
--    accepted by the task's own student.
--
-- Deploy order: either. The API writes only the granted columns on the
-- caller's client, never moves status anywhere but pending -> revoked, and
-- never sets the task link columns; routes/invites.ts also checks, without
-- this file, that the accepted student is on the counselor's roster before
-- acting on an acceptance. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. invitations
-- ---------------------------------------------------------------------------

revoke update on table public.invitations from authenticated, anon;
grant update (status, full_name, grade_level, grad_year, timezone, intake_requests,
              dismissed_at, confirmed_at, submitted_at)
  on table public.invitations to authenticated;

-- Deliberately NOT security definer: the guard keys off current_user, so a
-- SECURITY DEFINER caller (accept_invitation and the rest) is not affected.
create or replace function private.invitations_guard_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'
       or new.accepted_by is not null or new.accepted_at is not null
       or new.submitted_at is not null or new.confirmed_at is not null then
      raise exception 'Only the student accepting it changes an invitation''s state' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'pending' and new.status = 'revoked') then
    raise exception 'Only the student accepting it changes an invitation''s state' using errcode = '42501';
  end if;
  if new.accepted_by is distinct from old.accepted_by
     or new.accepted_at is distinct from old.accepted_at
     or new.counselor_id is distinct from old.counselor_id
     or new.token is distinct from old.token then
    raise exception 'Only the student accepting it changes an invitation''s state' using errcode = '42501';
  end if;
  if new.submitted_at is distinct from old.submitted_at and new.submitted_at is not null then
    raise exception 'Only the student submits their requests' using errcode = '42501';
  end if;
  if new.confirmed_at is distinct from old.confirmed_at and old.status <> 'accepted' then
    raise exception 'They haven''t joined yet' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.invitations_guard_client() from public, anon, authenticated;

drop trigger if exists invitations_guard_client on public.invitations;
create trigger invitations_guard_client
  before insert or update on public.invitations
  for each row execute function private.invitations_guard_client();

-- ---------------------------------------------------------------------------
-- 2. deliverables -> invitation link
-- ---------------------------------------------------------------------------

-- Deliberately NOT security definer: sync_intake_tasks (SECURITY DEFINER) is
-- the one writer of the link and runs as the table owner.
create or replace function private.deliverables_guard_intake_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.intake_invitation_id is not null or new.intake_request_id is not null then
      raise exception 'A task joins an invitation''s requests only when the student accepts it' using errcode = '42501';
    end if;
  elsif new.intake_invitation_id is distinct from old.intake_invitation_id
        or new.intake_request_id is distinct from old.intake_request_id then
    raise exception 'A task joins an invitation''s requests only when the student accepts it' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.deliverables_guard_intake_link() from public, anon, authenticated;

drop trigger if exists deliverables_guard_intake_link on public.deliverables;
create trigger deliverables_guard_intake_link
  before insert or update of intake_invitation_id, intake_request_id on public.deliverables
  for each row execute function private.deliverables_guard_intake_link();

-- Same body as 20261012000001, plus: only an invitation the task's own
-- student accepted.
create or replace function private.deliverables_sync_intake_request()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_done boolean := new.status = 'complete';
begin
  if new.intake_invitation_id is null or new.intake_request_id is null then
    return new;
  end if;
  if (old.status = 'complete') is not distinct from v_done then
    return new;
  end if;

  update public.invitations i
     set intake_requests = (
           select coalesce(jsonb_agg(
                    case when coalesce(nullif(btrim(e->>'id'), ''), md5(left(btrim(coalesce(e->>'label', '')), 300)))
                              = new.intake_request_id
                         then jsonb_set(e, '{provided}', to_jsonb(v_done))
                         else e end
                    order by ord), '[]'::jsonb)
             from jsonb_array_elements(i.intake_requests) with ordinality as t(e, ord))
   where i.id = new.intake_invitation_id
     and i.status = 'accepted'
     and i.accepted_by = new.student_id
     and exists (select 1 from jsonb_array_elements(i.intake_requests) e
                  where coalesce(nullif(btrim(e->>'id'), ''), md5(left(btrim(coalesce(e->>'label', '')), 300)))
                        = new.intake_request_id
                    and coalesce((e->>'provided')::boolean, false) is distinct from v_done);
  return new;
end;
$$;
