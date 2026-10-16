-- A student can't archive (or unarchive) themselves.
--
-- archived_at is in the profiles UPDATE column grant (20260828000016) and
-- profiles_update_self lets anyone update their own row, so a student could
-- set their own archived_at through PostgREST (or PATCH /students/<own id>).
-- An archived student drops out of the escalation sweep, the counselor's
-- "behind" list, scheduled parent messages and due reminders, and off the
-- roster: exactly the "switch off the alerts my counselor sends about me"
-- outcome student_alert_prefs is counselor-written to prevent. The reverse
-- let a student the counselor archived put themselves back on the roster.
--
-- After this file a client may not change archived_at on their own row.
-- The counselor still archives and restores through
-- profiles_update_counselor_of_student (primary counselor, approved), as
-- before. SECURITY DEFINER functions and the service role are unaffected.
--
-- Deploy order: either. PATCH /students/:id refuses `archived` from anyone
-- but a counselor writing about someone else, with or without this file.
-- Not in REQUIRED_SCHEMA.

-- Deliberately NOT security definer: the guard keys off current_user.
create or replace function private.profiles_guard_self_archive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.archived_at is distinct from old.archived_at and old.id = auth.uid() then
    raise exception 'Only your counselor can archive or restore you' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.profiles_guard_self_archive() from public, anon, authenticated;

drop trigger if exists profiles_guard_self_archive on public.profiles;
create trigger profiles_guard_self_archive
  before update of archived_at on public.profiles
  for each row execute function private.profiles_guard_self_archive();
