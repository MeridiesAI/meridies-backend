-- One address, one student's held data, decided where the data moves
-- (spec §1, §5.5: no path delivers one student's data to another account).
--
-- accept_invitation moves the held import data (new_invite import_items) of
-- every pending or revoked invitation the same counselor sent to the same
-- address onto the account that accepts, so a re-import or a resend follows
-- the student's email. It never asked whose data it was: an import invited
-- Mia at a parent's address, the counselor then invited her brother Leo
-- there (by hand, by Mass invite, from the pipeline, a referral, the old
-- roster flow or another import), which revoked Mia's invitation, and Leo
-- accepting landed Mia's data in Leo's Ready to apply queue. The API refuses
-- such an invitation (lib/invites.ts), but a check in each route can race and
-- can be forgotten by the next route.
--
-- Now the sweep moves another invitation's items only when both invitations
-- name the same student: the same full name, ignoring case and spacing, and
-- never a blank one. Import invitations carry the imported name and a resend
-- copies it, so re-imports and resends still follow the email; items of a
-- different or unknown name stay with their own invitation and expire with
-- it. The accepted invitation's own items always move. The body is otherwise
-- 20261017000001's, unchanged.
--
-- Deploy order: either. Code first: the API's own check refuses the
-- invitations that would merge (a race between two sends at the same instant
-- is closed only by this file). This first: the previous code's invitations
-- carry the names this compares. Not in REQUIRED_SCHEMA: nothing new for a
-- request to need.

create or replace function private.invitation_same_student(p_a text, p_b text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_a, '')), '\s+', ' ', 'g')), '') is not null
     and lower(regexp_replace(btrim(p_a), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(coalesce(p_b, '')), '\s+', ' ', 'g'));
$$;
revoke all on function private.invitation_same_student(text, text) from public, anon, authenticated;

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
              and i.status in ('pending','revoked')
              and private.invitation_same_student(i.full_name, v_inv.full_name)));

  perform private.import_hold_legacy_rows(v_inv.id, v_user);

  return v_inv.counselor_id;
end;
$function$;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

