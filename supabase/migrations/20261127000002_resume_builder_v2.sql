-- Resume builder v2: eight formats, one document shared by the student and their Consultant.
--
-- Extends `student_resumes` (20261028000006); no second table. The app stores `{ version: 2, ... }` in `content`
-- (lib/resumeDoc.ts) and the format in the new `template_key`. The old `template` column and its CHECK are left alone
-- (nothing is dropped): v2 reads and writes `template_key` only, and an old row (template_key null) is read as an
-- empty document by the app and is never touched here.
--
-- Who may write: the student their own row (as before) AND the Consultants who can edit that student
-- (`private.can_edit_student`). Select still goes through `private.can_view_student`. Parents get nothing.
-- `updated_by` is set by a trigger from the caller, never trusted from the request.
--
-- Deploy order: either. Additive only. Until this is applied the resume routes answer 503 `resume_unavailable`
-- (the new columns are not in REQUIRED_SCHEMA, so /health is unaffected).

alter table public.student_resumes
  add column if not exists template_key text,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.student_resumes'::regclass and conname = 'student_resumes_template_key_check'
  ) then
    alter table public.student_resumes
      add constraint student_resumes_template_key_check
      check (template_key is null or template_key in
        ('general', 'business', 'stem', 'premed', 'music', 'athletics', 'academy', 'research'));
  end if;
end;
$$;

-- Column grants: the new format column is writable by the client; `updated_by` is not (the trigger sets it).
grant insert (template_key) on public.student_resumes to authenticated;
grant update (template_key) on public.student_resumes to authenticated;

create or replace function private.student_resumes_set_updated_by()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists student_resumes_set_updated_by on public.student_resumes;
create trigger student_resumes_set_updated_by before insert or update on public.student_resumes
  for each row execute function private.student_resumes_set_updated_by();

-- The student's Consultant(s) may write the resume too. The student's own policies (20261028000006) are unchanged.
drop policy if exists student_resumes_insert_counselor on public.student_resumes;
create policy student_resumes_insert_counselor on public.student_resumes
  for insert to authenticated
  with check (private.can_edit_student(student_id, (select auth.uid())));

drop policy if exists student_resumes_update_counselor on public.student_resumes;
create policy student_resumes_update_counselor on public.student_resumes
  for update to authenticated
  using (private.can_edit_student(student_id, (select auth.uid())))
  with check (private.can_edit_student(student_id, (select auth.uid())));

-- The approval gate stays as it is (20261028000006): a pending or revoked Consultant reads and writes nothing.
