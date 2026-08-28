-- Advisor follow-up: pin attach_student_policies' search_path, and record why
-- redeem_invite_code is deliberately a SECURITY DEFINER function the
-- `authenticated` role may call.

create or replace function private.attach_student_policies(
  p_table text,
  p_student_col text default 'student_id'
)
returns void
language plpgsql
set search_path to 'private','public','pg_temp'
as $function$
begin
  execute format('alter table public.%I enable row level security', p_table);

  execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
  execute format(
    'create policy %I on public.%I for select to authenticated
       using (private.can_view_student(%I, (select auth.uid())))',
    p_table || '_select', p_table, p_student_col);

  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format(
    'create policy %I on public.%I for insert to authenticated
       with check (private.can_edit_student(%I, (select auth.uid())))',
    p_table || '_insert', p_table, p_student_col);

  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format(
    'create policy %I on public.%I for update to authenticated
       using (private.can_edit_student(%I, (select auth.uid())))
       with check (private.can_edit_student(%I, (select auth.uid())))',
    p_table || '_update', p_table, p_student_col, p_student_col);

  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  execute format(
    'create policy %I on public.%I for delete to authenticated
       using (private.can_edit_student(%I, (select auth.uid())))',
    p_table || '_delete', p_table, p_student_col);
end;
$function$;

revoke all on function private.attach_student_policies(text, text) from public, anon, authenticated;

comment on function public.redeem_invite_code(text) is
  'Intentionally SECURITY DEFINER and callable by authenticated users: it is the ONLY redemption path. Clients cannot SELECT invite_codes they do not own, so a code cannot be enumerated - it must be known. The function re-checks auth.uid(), the caller role, prior counselor linkage, revocation, expiry, and self-redemption before writing.';
