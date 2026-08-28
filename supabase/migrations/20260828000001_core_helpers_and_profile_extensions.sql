-- Core RLS helpers + profile columns the app already displays.
--
-- Every helper lives in `private`, is SECURITY DEFINER, and is granted only to
-- `authenticated`. They exist so RLS policies can ask "may I see this student?"
-- without recursing back through the policies on `profiles`.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- profiles: promote the fields the UI reads on every render out of the blob.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists avatar_url     text,
  add column if not exists phone          text,
  add column if not exists timezone       text,
  add column if not exists title          text,
  add column if not exists headline       text,
  add column if not exists hometown       text,
  add column if not exists high_school    text,
  add column if not exists grad_year      text,
  -- False when the role was defaulted (OAuth sign-up, where we never asked).
  -- The /auth/callback route may set the real role exactly once, while this is
  -- false; after that a role change is an admin action, not a query param.
  add column if not exists role_confirmed boolean not null default true,
  add column if not exists archived_at    timestamptz,
  add column if not exists last_active_at timestamptz;

comment on column public.profiles.role_confirmed is
  'False only for OAuth sign-ups where the user never picked a role. Lets /auth/callback set it once.';

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_counselor_id_idx on public.profiles (counselor_id);
create index if not exists profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- handle_new_user: also carries OAuth metadata (Google) onto the profile and
-- records whether the role was actually chosen by the user.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  meta_role text := nullif(new.raw_user_meta_data->>'role', '');
begin
  insert into public.profiles (id, full_name, email, role, role_confirmed, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    case when meta_role in ('student', 'counselor') then meta_role else 'student' end,
    meta_role in ('student', 'counselor'),
    coalesce(
      nullif(new.raw_user_meta_data->>'avatar_url', ''),
      nullif(new.raw_user_meta_data->>'picture', '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS helper predicates
-- ---------------------------------------------------------------------------

create or replace function private.user_role(user_id uuid)
returns text
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select role from public.profiles where id = user_id;
$$;

create or replace function private.is_counselor(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select coalesce((select role from public.profiles where id = user_id) = 'counselor', false);
$$;

-- True when `viewer` is the student's assigned counselor, or a colleague the
-- counselor explicitly shared the student with (see student_collaborators).
create or replace function private.is_counselor_of(student uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = student and p.counselor_id = viewer
  );
$$;

-- The single predicate every student-scoped table's RLS policy uses.
create or replace function private.can_view_student(student uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private', 'public'
as $$
  select student = viewer or private.is_counselor_of(student, viewer);
$$;

revoke all on function private.user_role(uuid)          from public, anon;
revoke all on function private.is_counselor(uuid)       from public, anon;
revoke all on function private.is_counselor_of(uuid, uuid) from public, anon;
revoke all on function private.can_view_student(uuid, uuid) from public, anon;
revoke all on function private.get_user_counselor_id(uuid)  from public, anon;

grant execute on function private.user_role(uuid)             to authenticated;
grant execute on function private.is_counselor(uuid)          to authenticated;
grant execute on function private.is_counselor_of(uuid, uuid) to authenticated;
grant execute on function private.can_view_student(uuid, uuid) to authenticated;
grant execute on function private.get_user_counselor_id(uuid) to authenticated;
