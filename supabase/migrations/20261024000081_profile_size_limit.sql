-- Bounds on every profiles column a signed-in user can write, PostgREST
-- included.
--
-- The authenticated UPDATE grant on profiles (20260828000016) covers
-- full_name, avatar_url, phone, timezone, title, headline, hometown,
-- high_school, grad_year and the free-form profile JSON, with no length check
-- in the database, and signup copies full_name and avatar_url from the user's
-- own metadata (handle_new_user). So a student could PATCH
-- /rest/v1/profiles?id=eq.<self> with megabytes in any of them, and the
-- counselor's roster (GET /students) would carry that row on every page load.
-- PATCH /auth/me also used to check only the profile patch, not the value it
-- merges into. The API now checks the merged profile (lib/profileSize.ts) and
-- its own field limits; this trigger is the same rule for every writer.
--
-- The bounds (characters, at or above every API limit on the same field):
--   full_name, hometown, high_school, title  200
--   headline                                 300
--   avatar_url                               2048
--   phone                                    40
--   timezone                                 80
--   grad_year                                10
--   profile   300,000 bytes: octet_length(profile::text), the UTF-8 bytes of
--             Postgres's own jsonb text. lib/profileSize.ts computes that same
--             form in the API (profileBytes, the same 300,000), so the two
--             agree on what fits: a profile the database accepted can grow to
--             the same bound through the API, and nothing the API accepts is
--             much larger than what the database would.
--
-- A trigger rather than CHECKs on purpose. A CHECK is evaluated on every
-- UPDATE of the row, so a row already over a bound (written before this
-- migration) would block accept_invitation, a caseload transfer or a name
-- change. On UPDATE the trigger refuses only a value over its bound that is
-- longer than the one stored, so an oversized value can still shrink and the
-- row's other columns stay writable. On INSERT (signup, from the user's own
-- auth metadata) the short text columns are clipped instead of refused, so
-- an account is never lost to a long name, and the profile JSON is refused
-- over its bound.
--
-- Deploy order: either. The code before this migration already checks the
-- merged profile and its own field limits; this only adds the database's
-- bound for direct writes. Neither the previous build nor this one writes a
-- value over these bounds through the API (a refusal from this trigger is
-- answered 400 "Profile is too large" on the two profile routes). Not in
-- REQUIRED_SCHEMA: nothing reads it.

create or replace function private.profiles_column_bounds()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new integer;
  v_old integer;
begin
  if tg_op = 'INSERT' then
    new.full_name   := left(new.full_name, 200);
    new.hometown    := left(new.hometown, 200);
    new.high_school := left(new.high_school, 200);
    new.title       := left(new.title, 200);
    new.headline    := left(new.headline, 300);
    new.phone       := left(new.phone, 40);
    new.timezone    := left(new.timezone, 80);
    new.grad_year   := left(new.grad_year, 10);
    -- A link cut short is no link: drop it rather than store half of one.
    if length(new.avatar_url) > 2048 then new.avatar_url := null; end if;
    if coalesce(octet_length(new.profile::text), 0) > 300000 then
      raise exception 'Profile is too large' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE: refuse growth past a bound, allow shrinking.
  if length(new.full_name) > 200 and length(new.full_name) > coalesce(length(old.full_name), 0)
     or length(new.hometown) > 200 and length(new.hometown) > coalesce(length(old.hometown), 0)
     or length(new.high_school) > 200 and length(new.high_school) > coalesce(length(old.high_school), 0)
     or length(new.title) > 200 and length(new.title) > coalesce(length(old.title), 0)
     or length(new.headline) > 300 and length(new.headline) > coalesce(length(old.headline), 0)
     or length(new.avatar_url) > 2048 and length(new.avatar_url) > coalesce(length(old.avatar_url), 0)
     or length(new.phone) > 40 and length(new.phone) > coalesce(length(old.phone), 0)
     or length(new.timezone) > 80 and length(new.timezone) > coalesce(length(old.timezone), 0)
     or length(new.grad_year) > 10 and length(new.grad_year) > coalesce(length(old.grad_year), 0) then
    raise exception 'That value is too long' using errcode = '23514';
  end if;

  if new.profile is distinct from old.profile then
    v_new := coalesce(octet_length(new.profile::text), 0);
    if v_new > 300000 then
      v_old := coalesce(octet_length(old.profile::text), 0);
      if v_new > v_old then
        raise exception 'Profile is too large' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.profiles_column_bounds() from public, anon, authenticated;

-- An earlier draft of this file named the trigger profiles_profile_size; a
-- local stack that applied it drops it here (production never had it).
drop trigger if exists profiles_profile_size on public.profiles;
drop function if exists private.profiles_profile_size();

drop trigger if exists profiles_column_bounds on public.profiles;
create trigger profiles_column_bounds
  before insert or update of full_name, avatar_url, phone, timezone, title, headline,
                             hometown, high_school, grad_year, profile
  on public.profiles
  for each row execute function private.profiles_column_bounds();

comment on function private.profiles_column_bounds() is
  'Bounds every client-writable profiles text column and the profile JSON (300,000 bytes of jsonb text, the API''s lib/profileSize.ts bound); on update a value over its bound may shrink, never grow; on insert the short columns are clipped.';
