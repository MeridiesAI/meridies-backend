-- A student's name and class year are labels, not free text (security review,
-- "AI guardrails").
--
-- AxIS reads a student's name and class year on every change turn as
-- counselor-trusted labels (lib/context/identity.ts). Both are in the
-- student's own column grant (20260828000016), and only the API's zod schemas
-- bounded them: a student could PATCH /rest/v1/profiles with a grad_year or a
-- full_name of any length and have their own instructions read as trusted
-- text. The code now reduces both to the shape of a name and a year whatever
-- is stored; this says the same in the database for new values:
--
--   * grad_year: four digits, or empty/null.
--   * full_name: at most 200 characters.
--
-- A trigger, not a CHECK, so a row that already holds an odd value keeps
-- working (a CHECK is evaluated on every update of the row, whichever column
-- changed): an update is refused only when it sets one of these two columns to
-- a new value of the wrong shape (23514). An insert (handle_new_user copies
-- the sign-up metadata) is normalised instead of refused, so a sign-up never
-- fails over its name: the name is cut to 200 characters and a malformed class
-- year dropped.
--
-- Deploy order: either.
--   * Code first: the API's routes already refuse a malformed class year
--     (/auth/me, /students/:id, the student page) and AxIS shows only the
--     name's and year's shape, so nothing depends on this.
--   * Migration first: the previous build writes only four-digit years and
--     names under 200 characters through its routes; nothing it sends is
--     refused.
-- Not in REQUIRED_SCHEMA: no request depends on it.

create or replace function private.profiles_guard_identity_text()
returns trigger
language plpgsql
security invoker
set search_path to 'private', 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'INSERT' then
    if new.full_name is not null and char_length(new.full_name) > 200 then
      new.full_name := left(new.full_name, 200);
    end if;
    if new.grad_year is not null and btrim(new.grad_year) <> '' and btrim(new.grad_year) !~ '^[0-9]{4}$' then
      new.grad_year := null;
    end if;
    return new;
  end if;

  if new.full_name is distinct from old.full_name
     and new.full_name is not null and char_length(new.full_name) > 200 then
    raise exception 'A name is at most 200 characters.' using errcode = '23514';
  end if;
  if new.grad_year is distinct from old.grad_year
     and new.grad_year is not null and btrim(new.grad_year) <> ''
     and btrim(new.grad_year) !~ '^[0-9]{4}$' then
    raise exception 'A graduation year is four digits, like 2027.' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function private.profiles_guard_identity_text() from public;

drop trigger if exists profiles_guard_identity_text on public.profiles;
create trigger profiles_guard_identity_text
  before insert or update of full_name, grad_year on public.profiles
  for each row execute function private.profiles_guard_identity_text();
