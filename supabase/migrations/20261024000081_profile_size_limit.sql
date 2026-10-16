-- A bound on profiles.profile for every writer, PostgREST included.
--
-- The column is in the authenticated UPDATE grant (20260828000016), so a
-- signed-in user can write their own profile JSON straight through
-- PostgREST with no size check at all, and PATCH /auth/me used to check only
-- the patch, not the value it merges into. The counselor's roster
-- (GET /students) reads the whole row for every student, and a save of
-- intakeAnswers runs the questionnaire sync, so one oversized profile slows
-- every page that loads the roster. The API now checks the merged value
-- (lib/profileSize.ts, 200,000 characters of JSON.stringify); this trigger is
-- the same rule in the database.
--
-- The number here is on Postgres's own text form of the jsonb, which prints
-- ", " and ": " where JSON.stringify prints "," and ":" (at most about one and
-- a half times longer for a value of tiny keys), so it is set at 400,000:
-- anything the API accepts fits, and nothing much larger does.
--
-- A trigger rather than a CHECK on purpose: a CHECK is evaluated on every
-- UPDATE of the row, so a profile already over the bound would block
-- accept_invitation, a caseload transfer or a name change. The trigger fires
-- only when the profile itself is written, and refuses only a value over the
-- bound that is larger than the one stored, so a profile over it can still
-- shrink.
--
-- Deploy order: either. The code before this migration already checks the
-- merged value; this only adds the PostgREST backstop. The previous build
-- never writes a profile over the bound through the API. Not in
-- REQUIRED_SCHEMA: nothing reads it.

create or replace function private.profiles_profile_size()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new integer := coalesce(length(new.profile::text), 0);
begin
  if v_new > 400000
     and (tg_op = 'INSERT' or v_new > coalesce(length(old.profile::text), 0)) then
    raise exception 'Profile is too large' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.profiles_profile_size() from public, anon, authenticated;

drop trigger if exists profiles_profile_size on public.profiles;
create trigger profiles_profile_size
  before insert or update of profile on public.profiles
  for each row execute function private.profiles_profile_size();

comment on function private.profiles_profile_size() is
  'Refuses a profiles.profile over 400,000 characters of jsonb text that is larger than the stored one (the API bound is 200,000 of JSON).';
