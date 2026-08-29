-- Email invitations replace shareable invite codes.
--
-- A counselor invites a student by email; the backend emails a tokenized link
-- (via Resend). When the student signs up and accepts, accept_invitation() sets
-- their profiles.counselor_id -- the one linkage column authenticated users may
-- not write directly (its UPDATE grant is withheld), so this SECURITY DEFINER
-- function is the only path, exactly as redeem_invite_code() was.
--
-- The token is the capability: it is emailed only to the invited address and
-- can't be enumerated (no SELECT policy exposes a pending invite to a redeemer).

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  counselor_id uuid not null references public.profiles(id) on delete cascade,
  email        text not null,
  token        text not null unique,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'revoked')),
  accepted_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_at  timestamptz,
  constraint invitations_email_nonempty check (btrim(email) <> '')
);

create index if not exists invitations_counselor_idx on public.invitations (counselor_id);
create index if not exists invitations_email_idx on public.invitations (lower(email));
create index if not exists invitations_status_idx on public.invitations (status);

alter table public.invitations enable row level security;

-- A counselor sees and manages only their own invitations. Students never read
-- this table directly -- preview and accept go through the SECURITY DEFINER
-- functions below, so a pending invite's token stays unguessable.
drop policy if exists invitations_select_owner on public.invitations;
create policy invitations_select_owner on public.invitations
  for select to authenticated
  using (counselor_id = (select auth.uid()));

drop policy if exists invitations_insert_owner on public.invitations;
create policy invitations_insert_owner on public.invitations
  for insert to authenticated
  with check (
    counselor_id = (select auth.uid())
    and exists (
      select 1 from public.profiles
      where id = (select auth.uid()) and role = 'counselor'
    )
  );

drop policy if exists invitations_update_owner on public.invitations;
create policy invitations_update_owner on public.invitations
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

drop policy if exists invitations_delete_owner on public.invitations;
create policy invitations_delete_owner on public.invitations
  for delete to authenticated
  using (counselor_id = (select auth.uid()));

-- Link the signed-in student to the inviting counselor. Mirrors
-- redeem_invite_code(): re-checks auth.uid() inside, validates preconditions,
-- and is the only writer of counselor_id for this flow.
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_role          text;
  v_counselor     uuid;
  v_inv           public.invitations;
  v_inviter_role  text;
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

  select role into v_inviter_role from public.profiles where id = v_inv.counselor_id;
  if v_inviter_role is distinct from 'counselor' then
    raise exception 'That invitation is no longer valid' using errcode = 'P0001';
  end if;

  update public.invitations
     set status = 'accepted', accepted_by = v_user, accepted_at = now()
   where id = v_inv.id;

  update public.profiles
     set counselor_id = v_inv.counselor_id
   where id = v_user;

  return v_inv.counselor_id;
end;
$function$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- Non-sensitive preview for the accept landing page, callable before the
-- student has an account (anon). Returns only who invited them + the invited
-- address (which the holder of the token already knows -- it's their inbox).
create or replace function public.invitation_preview(p_token text)
returns table (counselor_name text, invited_email text, valid boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inv  public.invitations;
  v_name text;
begin
  select * into v_inv from public.invitations where token = p_token;
  if not found then
    return query select null::text, null::text, false;
    return;
  end if;

  select full_name into v_name from public.profiles where id = v_inv.counselor_id;

  return query select
    v_name,
    v_inv.email,
    (v_inv.status = 'pending' and v_inv.expires_at >= now());
end;
$function$;

revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated;
