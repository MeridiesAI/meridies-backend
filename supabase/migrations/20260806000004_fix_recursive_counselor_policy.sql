-- Backfilled from the live project (version 20260806133323). Verbatim.

drop policy "profiles_select_own_counselor" on public.profiles;

create or replace function public.get_user_counselor_id(user_id uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select counselor_id from public.profiles where id = user_id;
$$;

revoke all on function public.get_user_counselor_id(uuid) from public;
grant execute on function public.get_user_counselor_id(uuid) to authenticated;

create policy "profiles_select_own_counselor" on public.profiles
  for select using (id = public.get_user_counselor_id(auth.uid()));
