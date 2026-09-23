-- Backfilled from the live project (version 20260806133417). Verbatim.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.get_user_counselor_id(user_id uuid)
returns uuid
language sql
security definer
set search_path = private, public
stable
as $$
  select counselor_id from public.profiles where id = user_id;
$$;

drop policy "profiles_select_own_counselor" on public.profiles;
create policy "profiles_select_own_counselor" on public.profiles
  for select using (id = private.get_user_counselor_id(auth.uid()));

drop function public.get_user_counselor_id(uuid);
