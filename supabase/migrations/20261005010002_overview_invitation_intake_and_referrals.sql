-- Overview (demo v6-v10): what an invitation carries, and referrals.
--
-- 1. New student (v8). "Create student & build profile" puts a student on the
--    counselor's list before they have an account. An account only exists once
--    Supabase Auth creates it, so the card is an *invitation* that carries the
--    basics the counselor typed (name, grade, timezone) and what they asked the
--    student for. It reads "Building profile" until the student has joined and
--    their intake is in.
--
-- 2. Mass invite (v10) and the roster import record where an invitation came
--    from, so the Invitations page can say so.
--
-- 3. Referrals (v6, "post-application referral management"). Once a student's
--    applications are in, the counselor asks the family for referrals; every
--    family they name is followed through to intake. The stored status is the
--    counselor's last move; from "invited" on, the invitation decides (accepted
--    is "signed", revoked or expired falls back), so the two cannot disagree.
--    Counselor-only in both directions: business development about a family
--    is not part of the student's record.

alter table public.invitations
  add column if not exists full_name       text check (full_name is null or length(btrim(full_name)) between 1 and 200),
  add column if not exists grade_level     text check (grade_level is null or length(grade_level) <= 40),
  add column if not exists grad_year       integer check (grad_year is null or grad_year between 2000 and 2100),
  add column if not exists timezone        text check (timezone is null or length(timezone) <= 80),
  add column if not exists note            text check (note is null or length(note) <= 1000),
  add column if not exists audience        text not null default 'student' check (audience in ('student','family')),
  add column if not exists source          text not null default 'single'
                                             check (source in ('single','intake','mass','roster','referral')),
  -- [{ id, label, provided }]: what the counselor needs from the student, and
  -- whether they already had it when they created the card.
  add column if not exists intake_requests jsonb not null default '[]'::jsonb
                                             check (jsonb_typeof(intake_requests) = 'array'
                                                    and jsonb_array_length(intake_requests) <= 30),
  -- When "Send to student" went out with the open requests.
  add column if not exists requested_at    timestamptz,
  -- The counselor took the "Building profile" card off Overview.
  add column if not exists dismissed_at    timestamptz;

create index if not exists invitations_building_idx
  on public.invitations (counselor_id, created_at desc)
  where source = 'intake' and dismissed_at is null;

-- The basics the counselor typed become the student's own once they join,
-- where the student has not already set them. Same function, same checks as
-- 20260829000001; only the profile update grew.
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
     set counselor_id = v_inv.counselor_id,
         grad_year    = coalesce(nullif(grad_year, ''), v_inv.grad_year::text),
         timezone     = coalesce(nullif(timezone, ''), v_inv.timezone)
   where id = v_user;

  return v_inv.counselor_id;
end;
$function$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Referrals
-- ---------------------------------------------------------------------------

create table if not exists public.referrals (
  id              uuid primary key default gen_random_uuid(),
  counselor_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  -- The student whose family is referring.
  from_student_id uuid not null references public.profiles(id) on delete cascade,
  -- The referred family's surname, once named.
  family_name     text check (family_name is null or length(btrim(family_name)) between 1 and 200),
  contact_email   text check (contact_email is null or (length(contact_email) <= 320 and contact_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  status          text not null default 'asked' check (status in ('asked','introduced','invited')),
  invitation_id   uuid references public.invitations(id) on delete set null,
  -- The message that carried the ask, when the Communication composer sent it.
  -- No FK: the outbound-message table belongs to the composer's area.
  ask_message_id  uuid,
  asked_at        timestamptz not null default now(),
  introduced_at   timestamptz,
  invited_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint referrals_named_once_introduced
    check (status = 'asked' or (family_name is not null and contact_email is not null)),
  constraint referrals_invited_has_invitation
    check (status <> 'invited' or invitation_id is not null or invited_at is not null)
);

-- One open ask per family: a second ask refreshes the first.
create unique index if not exists referrals_one_open_ask
  on public.referrals (counselor_id, from_student_id) where status = 'asked';
create index if not exists referrals_counselor_idx on public.referrals (counselor_id, updated_at desc);
create index if not exists referrals_invitation_idx on public.referrals (invitation_id) where invitation_id is not null;

drop trigger if exists referrals_set_updated_at on public.referrals;
create trigger referrals_set_updated_at before update on public.referrals
  for each row execute function public.set_updated_at();

comment on table public.referrals is
  'Post-application referrals, asked of a family and followed to intake. Counselor-only both ways.';

alter table public.referrals enable row level security;
revoke all on table public.referrals from anon;
grant select, insert, update, delete on table public.referrals to authenticated;

drop policy if exists referrals_counselor on public.referrals;
create policy referrals_counselor on public.referrals
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (
    counselor_id = (select auth.uid())
    and private.is_counselor_of(from_student_id, (select auth.uid()))
    and (
      invitation_id is null
      or exists (
        select 1 from public.invitations i
        where i.id = invitation_id and i.counselor_id = (select auth.uid())
      )
    )
  );
