-- A student manages the parents they added themselves (onboarding's Parents step, Settings › Parents).
--
-- The rows stay `public.guardians`, the same ones the counselor's Communication page, Parent contacts, blasts and
-- alerts read, so a parent a student adds shows up everywhere the counselor looks with nothing copied.
--
-- 20261007000006 made the product call this file keeps: a student may ADD a guardian, one a student adds receives
-- no alerts until a counselor switches them on, and a student can't rewrite or remove the guardians alerts go to.
-- What changes is that a student may now correct or remove a parent THEY added, within these limits:
--
--   * `added_by` records who added the row: stamped by the insert trigger from auth.uid(), never from the client
--     (null for rows from before this file and for service-role inserts). The update trigger keeps it as it was.
--   * Update (guardians_update_student_own): the student's own row, one they added. While the counselor hasn't
--     switched it on (alerts_enabled false) they may change the name, relationship, email and phone. Once it is
--     switched on, the email and phone are where the counselor's alerts go, so only the name and relationship may
--     change (the trigger refuses the rest with 42501). The student never changes alerts_enabled,
--     receives_reports, preferred_channel, is_primary, student_id or added_by (the trigger keeps the old values).
--   * Delete (guardians_delete_student_own): a row the student added and the counselor hasn't switched on.
--   * A guardian the counselor added stays the counselor's: nothing here lets a student touch it.
--
-- The counselor side is unchanged (can_manage_guardians: the assigned counselor or a write collaborator, never
-- the student).
--
-- Deploy order: either. The API's /me/guardians routes read `added_by` and answer 503 `guardians_unavailable`
-- (the app shows "isn't switched on yet") until this file is applied; nothing else reads the column without a
-- fallback. With this file first, the previous build ignores the column and the new policies only widen what a
-- student may do to their own additions.

alter table public.guardians
  add column if not exists added_by uuid references public.profiles(id) on delete set null;

-- Insert: stamp who added the row; a student's own addition still starts with alerts off.
create or replace function private.guardians_student_insert_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.student_id = (select auth.uid()) then
    new.alerts_enabled := false;
  end if;
  new.added_by := (select auth.uid());
  return new;
end;
$$;
revoke all on function private.guardians_student_insert_guard() from public, anon, authenticated;

-- Update: provenance never changes, and a student changes only their own words.
create or replace function private.guardians_student_update_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  new.added_by := old.added_by;
  if old.student_id = (select auth.uid()) then
    new.student_id := old.student_id;
    new.alerts_enabled := old.alerts_enabled;
    new.receives_reports := old.receives_reports;
    new.preferred_channel := old.preferred_channel;
    new.is_primary := old.is_primary;
    if old.alerts_enabled
       and (new.email is distinct from old.email or new.phone is distinct from old.phone) then
      raise exception 'Your counselor has switched this parent on. Ask them to change the email or phone.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guardians_student_update_guard() from public, anon, authenticated;

drop trigger if exists guardians_student_update_guard on public.guardians;
create trigger guardians_student_update_guard before update on public.guardians
  for each row
  when (current_setting('meridies.axis_restore', true) is distinct from 'on')
  execute function private.guardians_student_update_guard();

drop policy if exists guardians_update_student_own on public.guardians;
create policy guardians_update_student_own on public.guardians
  for update to authenticated
  using (student_id = (select auth.uid()) and added_by = (select auth.uid()))
  with check (student_id = (select auth.uid()) and added_by = (select auth.uid()));

drop policy if exists guardians_delete_student_own on public.guardians;
create policy guardians_delete_student_own on public.guardians
  for delete to authenticated
  using (student_id = (select auth.uid()) and added_by = (select auth.uid()) and alerts_enabled = false);
