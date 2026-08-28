-- Privilege-escalation fix.
--
-- `profiles_update_self` lets a user update their own row, and RLS has no
-- notion of columns — so a signed-in student could PATCH /rest/v1/profiles with
-- {"role":"counselor"} using the anon key that ships in the browser bundle, and
-- become a counselor. Same story for counselor_id, which would let someone
-- attach themselves to a roster without an invite. Verified against the live
-- policies before and after: before this, the UPDATE succeeded.
--
-- Note the shape of the fix. A column-level REVOKE alone does nothing here,
-- because Supabase grants table-level UPDATE on public.profiles to
-- `authenticated`, and a table-level privilege implies every column. The table
-- grant has to go first, then UPDATE is granted back on exactly the writable
-- columns. role, role_confirmed, counselor_id, firm_id, id, email and
-- created_at are absent by design.

revoke update on public.profiles from authenticated, anon;

grant update (
  full_name, avatar_url, phone, timezone, title, headline, hometown,
  high_school, high_school_id, grad_year, onboarding_step, onboarding_complete,
  profile, archived_at, last_active_at, updated_at
) on public.profiles to authenticated;

-- The one legitimate role write: an OAuth sign-up choosing its role, once.
-- SECURITY DEFINER so it can set the protected columns, with the once-only
-- check inside the function rather than trusted to the caller.
create or replace function public.confirm_user_role(p_role text)
returns public.profiles
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_row  public.profiles;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_role not in ('student','counselor') then
    raise exception 'Unknown role' using errcode = '22023';
  end if;

  update public.profiles
     set role = p_role, role_confirmed = true
   where id = v_user
     and role_confirmed = false
  returning * into v_row;

  if not found then
    raise exception 'Your role is already set' using errcode = '23505';
  end if;

  return v_row;
end;
$function$;

revoke all on function public.confirm_user_role(text) from public, anon;
grant execute on function public.confirm_user_role(text) to authenticated;

comment on function public.confirm_user_role(text) is
  'The only path that may write profiles.role. Succeeds exactly once, while role_confirmed is false (i.e. an OAuth sign-up that never picked a role). Direct column UPDATE is revoked from authenticated.';
