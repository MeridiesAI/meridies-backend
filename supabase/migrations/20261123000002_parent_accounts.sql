-- Parent accounts: a parent or guardian signs in to a read-only Parent view (founder's decision, 2026-11-11; it
-- reverses the earlier "no parent portal, no parent login" rule).
--
-- How a parent gets in, and what they may read, is decided here, not in the API:
--
--   * A parent account is a profile with role 'parent' and `parent_email`, the address an invitation was emailed to
--     and that the parent proved by opening it. No client writes either: role through no grant at all (as before),
--     parent_email through no column grant. `parent_invite_redeem` (service role only) sets both, once, on an account
--     the API has just created for that same address.
--   * The link to a student is LIVE: a guardian row whose email is the parent's `parent_email`, on a student profile,
--     that is either switched on by the counselor (alerts_enabled) or one the student added themselves (added_by =
--     student_id, awaiting the counselor's Turn on). Remove the guardian row, change its email, or (for a row the
--     counselor added) switch it off, and the parent loses that student on their next request. Nothing is copied,
--     so a caseload transfer changes nothing: the guardian rows belong to the student.
--   * A parent's database is their own profiles row and nothing else: `private.account_open` (the restrictive
--     approval_gate on every public table and storage.objects) now answers false for a parent, exactly as for a
--     pending counselor. Everything a parent reads comes from the two SECURITY DEFINER functions below, which check
--     the live link and the counselor's per-student family-visibility switches (20261117000001) on every call, and
--     return only what they name: tasks the student can see (title, status, due date), the college list (name,
--     round, status, deadlines), essays as kind, school, status and word counts (never a title, prompt or text),
--     and upcoming meetings (a meeting's title, place and link only when the parents are invited to it). A student
--     whose counselor is not an approved counselor (pending, revoked, none yet) shows no sections at all.
--   * Invitations (`parent_invites`) hold only a sha256 of the token, last 30 days, are single use, are tied to the
--     guardian row's student and address, and are re-checked against the live guardian row when previewed and when
--     redeemed. A new invitation for the same student and address revokes the unused earlier ones; redeeming one
--     uses up every unused invitation to that address.
--
-- Deploy order: after 20261117000001 (family visibility) and 20261122000001 (guardians.added_by), which the
-- functions read; both are older, so the CLI applies them first. Either order with the code: without this file the
-- API's parent routes answer 503 `parent_accounts_unavailable` (the app hides Invite and says the join link "isn't
-- switched on yet"), and the parent notice keeps its old wording. With this file first, the previous build never
-- creates a parent account, and nothing it reads changes. Not in REQUIRED_SCHEMA: only the parent routes need it.

-- ---- the role and the proven address ----------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('student', 'counselor', 'parent'));

alter table public.profiles
  add column if not exists parent_email text
    check (parent_email is null or (parent_email = lower(btrim(parent_email)) and length(parent_email) between 3 and 254));

-- Only a parent carries one, and one account per address.
alter table public.profiles drop constraint if exists profiles_parent_email_role;
alter table public.profiles
  add constraint profiles_parent_email_role check (parent_email is null or role = 'parent');
create unique index if not exists profiles_parent_email_key on public.profiles (parent_email) where parent_email is not null;

-- No client writes it (the UPDATE grant on profiles is per column and never named it); said out loud anyway.
revoke update (parent_email) on public.profiles from authenticated, anon;

-- The parent's link is found by address.
create index if not exists guardians_email_lower_idx on public.guardians (lower(btrim(email)));

-- ---- a parent's database is their own row -------------------------------------------------------------------------

create or replace function private.account_open(viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select not exists (
    select 1 from public.profiles p
    where p.id = viewer
      and ((p.role = 'counselor' and p.counselor_approved_at is null) or p.role = 'parent')
  );
$$;
revoke all on function private.account_open(uuid) from public, anon;
grant execute on function private.account_open(uuid) to authenticated;

-- ---- invitations ----------------------------------------------------------------------------------------------------

create table if not exists public.parent_invites (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  -- The guardian row it was sent for. No foreign key on purpose: guardians is an AxIS-trash table, and the row is
  -- re-checked live (same student, same address) whenever the invitation is read or redeemed.
  guardian_id uuid not null,
  email       text not null check (email = lower(btrim(email)) and length(email) between 3 and 254),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  via         text not null check (via in ('student', 'counselor')),
  invited_by  uuid references public.profiles(id) on delete set null,
  -- The message_deliveries row of the email that carried it (status for the counselor's chip). Plain uuid.
  delivery_id uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '30 days'),
  used_at     timestamptz,
  used_by     uuid references public.profiles(id) on delete set null,
  revoked_at  timestamptz
);
create index if not exists parent_invites_student_email_idx on public.parent_invites (student_id, email, created_at desc);
create index if not exists parent_invites_email_open_idx on public.parent_invites (email) where used_at is null and revoked_at is null;

alter table public.parent_invites enable row level security;
-- No client reads or writes the table: the functions below do, after their own checks.
revoke all on public.parent_invites from anon, authenticated;
select private.attach_approval_gate('public.parent_invites');

-- Whether a guardian row lets its address view the student: switched on by the counselor, or the student's own
-- addition still waiting for the counselor (viewing is not messaging; see the AGENTS "Parent accounts" section).
create or replace function private.guardian_grants_view(g public.guardians)
returns boolean
language sql
immutable
as $$
  select coalesce(g.alerts_enabled, false) or (g.added_by is not null and g.added_by = g.student_id);
$$;
revoke all on function private.guardian_grants_view(public.guardians) from public, anon, authenticated;

-- The live link: the guardian rows (one per student) that give `viewer`, a parent account, a view.
create or replace function private.parent_links(viewer uuid)
returns table (guardian_id uuid, student_id uuid, alerts_enabled boolean)
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select distinct on (g.student_id) g.id, g.student_id, coalesce(g.alerts_enabled, false)
    from public.profiles me
    join public.guardians g on lower(btrim(g.email)) = me.parent_email
    join public.profiles s on s.id = g.student_id and s.role = 'student'
   where me.id = viewer
     and me.role = 'parent'
     and me.parent_email is not null
     and private.guardian_grants_view(g)
   order by g.student_id, coalesce(g.alerts_enabled, false) desc, g.created_at;
$$;
revoke all on function private.parent_links(uuid) from public, anon, authenticated;

/** A new invitation for one guardian row, by the student it belongs to or a counselor who manages the student's parents. */
create or replace function public.parent_invite_create(p_guardian uuid, p_token_hash text)
returns table (id uuid, student_id uuid, email text, expires_at timestamptz, via text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_me   uuid := auth.uid();
  v_role text;
  v_g    public.guardians;
  v_mail text;
  v_via  text;
  v_id   uuid;
  v_exp  timestamptz;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Bad token' using errcode = '22023';
  end if;
  select role into v_role from public.profiles where profiles.id = v_me;
  select * into v_g from public.guardians where guardians.id = p_guardian;
  if not found then
    raise exception 'That parent isn''t on file' using errcode = 'P0002';
  end if;
  if v_role = 'student' and v_g.student_id = v_me then
    v_via := 'student';
  elsif v_role = 'counselor' and private.can_manage_guardians(v_g.student_id, v_me) then
    v_via := 'counselor';
  else
    -- Same answer as a row that doesn't exist: nobody learns whose guardian this is.
    raise exception 'That parent isn''t on file' using errcode = 'P0002';
  end if;
  v_mail := lower(btrim(coalesce(v_g.email, '')));
  if v_mail = '' or position('@' in v_mail) = 0 then
    raise exception 'This parent has no email on file' using errcode = 'P0001', hint = 'no_email';
  end if;
  if not private.guardian_grants_view(v_g) then
    raise exception 'Switch this parent on first' using errcode = 'P0001', hint = 'guardian_off';
  end if;
  if exists (select 1 from public.profiles p where p.parent_email = v_mail) then
    raise exception 'This parent already has a Meridies account' using errcode = 'P0001', hint = 'has_account';
  end if;
  if exists (select 1 from public.profiles p where lower(p.email) = v_mail and p.role <> 'parent') then
    raise exception 'That address already has a Meridies account that isn''t a parent account' using errcode = 'P0001', hint = 'other_account';
  end if;

  update public.parent_invites pi
     set revoked_at = now()
   where pi.student_id = v_g.student_id and pi.email = v_mail and pi.used_at is null and pi.revoked_at is null;

  insert into public.parent_invites (student_id, guardian_id, email, token_hash, via, invited_by)
  values (v_g.student_id, v_g.id, v_mail, p_token_hash, v_via, v_me)
  returning parent_invites.id, parent_invites.expires_at into v_id, v_exp;

  return query select v_id, v_g.student_id, v_mail, v_exp, v_via;
end;
$$;
revoke all on function public.parent_invite_create(uuid, text) from public, anon;
grant execute on function public.parent_invite_create(uuid, text) to authenticated;

/** The email that carried an invitation, for its delivery status. Only the one who made it, right after. */
create or replace function public.parent_invite_set_delivery(p_invite uuid, p_delivery uuid)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  update public.parent_invites
     set delivery_id = p_delivery
   where id = p_invite and invited_by = auth.uid() and delivery_id is null and created_at > now() - interval '10 minutes';
$$;
revoke all on function public.parent_invite_set_delivery(uuid, uuid) from public, anon;
grant execute on function public.parent_invite_set_delivery(uuid, uuid) to authenticated;

/**
 * Where each parent of these students stands, for a counselor who can view them: the latest invitation (when, until
 * when, its email's delivery status) and whether the address already has a parent account. Students the caller
 * can't view are left out.
 */
create or replace function public.parent_invite_status(p_students uuid[])
returns table (
  guardian_id uuid, student_id uuid, has_account boolean, grants_view boolean,
  invited_at timestamptz, expires_at timestamptz, used_at timestamptz,
  delivery_status text, delivery_channel text, delivery_at timestamptz, delivered_at timestamptz, delivery_error text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select g.id, g.student_id,
         exists (select 1 from public.profiles p where p.parent_email = lower(btrim(g.email))),
         private.guardian_grants_view(g),
         inv.created_at, inv.expires_at, inv.used_at,
         d.status, d.channel, coalesce(d.sent_at, d.created_at), d.delivered_at,
         case when d.status in ('bounced', 'failed') then d.error end
    from public.guardians g
    left join lateral (
      select pi.created_at, pi.expires_at, pi.used_at, pi.delivery_id
        from public.parent_invites pi
       where pi.student_id = g.student_id and pi.email = lower(btrim(g.email)) and pi.revoked_at is null
       order by pi.created_at desc
       limit 1
    ) inv on true
    left join public.message_deliveries d on d.id = inv.delivery_id
   where g.student_id = any (p_students[1:500])
     and private.is_counselor(auth.uid())
     and private.can_view_student(g.student_id, auth.uid())
     and g.email is not null;
$$;
revoke all on function public.parent_invite_status(uuid[]) from public, anon;
grant execute on function public.parent_invite_status(uuid[]) to authenticated;

/**
 * The join page, before the parent has an account: whether the link is good and what to greet them with. The token's
 * hash is the secret; this returns nothing the invited parent wasn't already told in the email.
 */
create or replace function public.parent_invite_preview(p_token_hash text)
returns table (valid boolean, reason text, email text, student_first text, counselor_name text, has_account boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_inv  public.parent_invites;
  v_s    public.profiles;
  v_c    text;
  v_has  boolean;
begin
  select * into v_inv from public.parent_invites pi where pi.token_hash = p_token_hash;
  if not found then
    return query select false, 'invalid'::text, null::text, null::text, null::text, false;
    return;
  end if;
  v_has := exists (select 1 from public.profiles p where p.parent_email = v_inv.email);
  if v_inv.used_at is not null then
    return query select false, 'used'::text, null::text, null::text, null::text, v_has;
    return;
  end if;
  if v_inv.revoked_at is not null or v_inv.expires_at < now() then
    return query select false, 'expired'::text, null::text, null::text, null::text, v_has;
    return;
  end if;
  if not exists (select 1 from public.guardians g
                  where g.student_id = v_inv.student_id and lower(btrim(g.email)) = v_inv.email
                    and private.guardian_grants_view(g)) then
    return query select false, 'removed'::text, null::text, null::text, null::text, v_has;
    return;
  end if;
  select * into v_s from public.profiles where id = v_inv.student_id;
  select full_name into v_c from public.profiles where id = v_s.counselor_id and private.is_counselor(id);
  return query select true, null::text, v_inv.email,
    nullif(split_part(btrim(coalesce(v_s.full_name, '')), ' ', 1), ''), v_c, v_has;
end;
$$;
revoke all on function public.parent_invite_preview(text) from public;
grant execute on function public.parent_invite_preview(text) to anon, authenticated;

/**
 * Turn a just-created account into a parent account, once, from a good invitation to its own address. Service role
 * only: the API creates the auth user for the invited address (the email that carried the token is the proof) and
 * calls this in the same request; a failure here makes it delete that user again.
 */
create or replace function public.parent_invite_redeem(p_token_hash text, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_inv   public.parent_invites;
  v_email text;
  v_p     public.profiles;
begin
  select * into v_inv from public.parent_invites pi where pi.token_hash = p_token_hash for update;
  if not found then
    raise exception 'That link isn''t valid' using errcode = 'P0002', hint = 'invalid';
  end if;
  if v_inv.used_at is not null then
    raise exception 'That link has already been used' using errcode = 'P0001', hint = 'used';
  end if;
  if v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'That link has expired' using errcode = 'P0001', hint = 'expired';
  end if;
  if not exists (select 1 from public.guardians g
                  where g.student_id = v_inv.student_id and lower(btrim(g.email)) = v_inv.email
                    and private.guardian_grants_view(g)) then
    raise exception 'That invitation is no longer valid' using errcode = 'P0001', hint = 'removed';
  end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = p_user and u.email_confirmed_at is not null;
  if v_email is distinct from v_inv.email then
    raise exception 'That account isn''t for this invitation' using errcode = '42501', hint = 'wrong_account';
  end if;
  select * into v_p from public.profiles where id = p_user for update;
  if not found or v_p.role_confirmed or v_p.counselor_id is not null or v_p.firm_id is not null then
    raise exception 'That account can''t become a parent account' using errcode = '42501', hint = 'wrong_account';
  end if;

  update public.profiles
     set role = 'parent', role_confirmed = true, onboarding_complete = true, parent_email = v_inv.email
   where id = p_user;
  update public.parent_invites
     set used_at = now(), used_by = p_user
   where email = v_inv.email and used_at is null and revoked_at is null;
  return v_inv.student_id;
end;
$$;
revoke all on function public.parent_invite_redeem(text, uuid) from public, anon, authenticated;
grant execute on function public.parent_invite_redeem(text, uuid) to service_role;

-- ---- what a parent reads --------------------------------------------------------------------------------------------

/** The signed-in parent's students: who they are, their counselor, and whether the parent may message the counselor. */
create or replace function public.parent_children()
returns table (student_id uuid, full_name text, grad_year text, counselor_id uuid, counselor_name text,
               counselor_ready boolean, guardian_id uuid, can_message boolean)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select s.id, s.full_name, s.grad_year, s.counselor_id,
         case when private.is_counselor(s.counselor_id) then c.full_name end,
         coalesce(private.is_counselor(s.counselor_id), false),
         l.guardian_id,
         l.alerts_enabled and coalesce(private.is_counselor(s.counselor_id), false)
    from private.parent_links(auth.uid()) l
    join public.profiles s on s.id = l.student_id
    left join public.profiles c on c.id = s.counselor_id
   order by s.full_name, s.id;
$$;
revoke all on function public.parent_children() from public, anon;
grant execute on function public.parent_children() to authenticated;

/**
 * One student's Parent view. Raises 42501 unless the caller is a parent linked to the student right now. Each
 * section is present only while the counselor's switch for it is on (no prefs row: all on, as everywhere else);
 * meetings have no switch. No section at all while the student's counselor isn't an approved counselor.
 */
create or replace function public.parent_student_view(p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_link   record;
  v_s      public.profiles;
  v_ready  boolean;
  v_tasks  boolean := true;
  v_coll   boolean := true;
  v_essays boolean := true;
  v_out    jsonb;
  v_sec    jsonb := '{}'::jsonb;
begin
  select * into v_link from private.parent_links(auth.uid()) l where l.student_id = p_student;
  if not found then
    raise exception 'Not linked' using errcode = '42501';
  end if;
  select * into v_s from public.profiles where id = p_student;
  v_ready := coalesce(private.is_counselor(v_s.counselor_id), false);
  select coalesce(a.parents_get_tasks, true), coalesce(a.parents_get_colleges, true), coalesce(a.parents_get_essays, true)
    into v_tasks, v_coll, v_essays
    from public.student_alert_prefs a where a.student_id = p_student;
  v_tasks := coalesce(v_tasks, true);
  v_coll := coalesce(v_coll, true);
  v_essays := coalesce(v_essays, true);

  if v_ready then
    if v_tasks then
      v_sec := v_sec || jsonb_build_object('tasks', coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'status', d.status, 'dueDate', d.due_date,
                                            'completedAt', case when d.status = 'complete' then d.updated_at end)
                         order by (d.status = 'complete'), d.due_date nulls last, d.created_at)
          from (select * from public.deliverables
                 where student_id = p_student and visible_to_student
                   and (status <> 'complete' or updated_at > now() - interval '14 days')
                 order by (status = 'complete'), due_date nulls last, created_at
                 limit 100) d), '[]'::jsonb));
    end if;
    if v_coll then
      v_sec := v_sec || jsonb_build_object('colleges', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'round', c.round, 'status', c.status,
                                            'deadline', coalesce(c.custom_deadline, c.deadline),
                                            'decisionDate', c.decision_date, 'binding', coalesce(c.binding, false))
                         order by c.sort_order, c.created_at)
          from (select * from public.student_colleges where student_id = p_student
                 order by sort_order, created_at limit 60) c), '[]'::jsonb));
    end if;
    if v_essays then
      -- Kind, school, status and counts only: never the essay's title, prompt or text.
      v_sec := v_sec || jsonb_build_object('essays', coalesce((
        select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.essay_kind, 'school', e.school, 'status', e.status,
                                            'words', e.word_count, 'wordLimit', e.word_limit, 'dueDate', e.due_date)
                         order by e.sort_order, e.created_at)
          from (select * from public.essays where student_id = p_student
                 order by sort_order, created_at limit 60) e), '[]'::jsonb));
    end if;
    v_sec := v_sec || jsonb_build_object('meetings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'startsAt', m.starts_at, 'endsAt', m.ends_at, 'mode', m.mode,
               'parentsInvited', coalesce(m.guardians_invited, false),
               -- What the counselor chose to send the parents, and only when they did.
               'title', case when m.guardians_invited then m.title end,
               'location', case when m.guardians_invited then m.location end,
               'joinUrl', case when m.guardians_invited then m.join_url end)
             order by m.starts_at)
        from (select * from public.meetings mm
               where mm.status = 'scheduled' and mm.starts_at > now() - interval '2 hours'
                 and (mm.student_id = p_student
                      or exists (select 1 from public.meeting_attendees a where a.meeting_id = mm.id and a.student_id = p_student))
               order by mm.starts_at limit 20) m), '[]'::jsonb));
  end if;

  v_out := jsonb_build_object(
    'student', jsonb_build_object('id', v_s.id, 'fullName', v_s.full_name, 'gradYear', v_s.grad_year, 'timezone', v_s.timezone),
    'counselor', case when v_ready then (select jsonb_build_object('id', c.id, 'name', c.full_name) from public.profiles c where c.id = v_s.counselor_id) end,
    'counselorReady', v_ready,
    'canMessage', v_link.alerts_enabled and v_ready,
    'sections', v_sec);
  return v_out;
end;
$$;
revoke all on function public.parent_student_view(uuid) from public, anon;
grant execute on function public.parent_student_view(uuid) to authenticated;

comment on table public.parent_invites is
  'Parent account invitations (20261123000002): a sha256 of the token, 30 days, single use, re-checked against the live guardian row.';
comment on column public.profiles.parent_email is
  'A parent account''s proven address (the one its invitation was emailed to). Its guardian rows are found by it, live.';
