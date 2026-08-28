-- Fixes "Database error saving new user" on every Google sign-up.
--
-- role_confirmed is NOT NULL, and it was being set from:
--     meta_role in ('student','counselor')
-- Google's raw_user_meta_data has no `role` key -- the role travels via the
-- /auth/callback query param by design -- so meta_role is NULL, and
-- `NULL IN (...)` evaluates to NULL rather than false. The NOT NULL violation
-- aborted the trigger, which aborts the auth.users INSERT, which Supabase
-- reports to the client as "Database error saving new user". No user row was
-- ever created, which is why the account never appeared in the dashboard.
--
-- Email sign-up passed `role` in options.data, so it always had a non-null
-- value and never hit this. Hence: every existing account is an Email account.
--
-- Also hardened while here: `email` and `full_name` are NOT NULL too, and a
-- provider is not obliged to give us either. Falling back to a blank-safe value
-- is better than failing the whole sign-up.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  meta_role text := nullif(new.raw_user_meta_data->>'role', '');
  is_chosen boolean := coalesce(meta_role in ('student', 'counselor'), false);
  resolved_email text := coalesce(nullif(new.email, ''), new.id::text || '@no-email.local');
begin
  insert into public.profiles (id, full_name, email, role, role_confirmed, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      nullif(split_part(resolved_email, '@', 1), ''),
      'New user'
    ),
    resolved_email,
    case when is_chosen then meta_role else 'student' end,
    is_chosen,
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
