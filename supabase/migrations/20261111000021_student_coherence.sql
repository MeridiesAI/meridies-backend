-- Narrative Coherence, run by the student (the practice's "Let students use AI tools" switch, 20261111000001).
--
-- A Coherence report was the counselor's alone: coherence_reports and narrative_flags let only the student's
-- counselor in. A student who runs it themself needs to write and read ONE kind of row: the reports they ran, and
-- the flags those reports raised. Nothing else opens:
--
--   * coherence_reports: a student reads, inserts and deletes only a report they created about themself
--     (created_by = student_id = the caller). A counselor's report about the student stays invisible to them, and a
--     student can't write a report onto anyone else. There is still no UPDATE grant: a report is never edited.
--   * narrative_flags: a student reads and writes only flags whose report_id is one of those reports (the insert
--     starts them open, unshared, unassigned and unresolved), and a trigger limits a student's UPDATE to the
--     status of a flag and the task it was assigned as, so a flag's words, severity and sharing can't be changed.
--     A counselor-run report's flags stay readable to the student only when the counselor shared them
--     (shared_with_student), exactly as before.
--   * The counselor reads every report and flag about their student, so a student-run report appears on their side
--     with no change (ranBy is derived from created_by in the API).
--
-- Known limit, the same as any row a user may write: a student could write the CONTENT of a flag on their own
-- report by hand over PostgREST. It is only ever shown as theirs, to them and to their counselor (marked as the
-- student's); the API, which is how the app writes it, applies the essay guardrail to what the model returns.
--
-- No table is created, so there is no approval gate to attach (the existing restrictive approval_gate policy on both
-- tables still applies to every caller).
--
-- Deploy order: either.
--   * Code first: a student's run is refused at the practice switch (off by default); a counselor's is unchanged.
--   * Migration first: the previous build never lets a student reach these tables, and counselor access is unchanged.
-- Not in REQUIRED_SCHEMA: no request depends on it.

-- ---- coherence_reports ----

drop policy if exists coherence_reports_select on public.coherence_reports;
create policy coherence_reports_select on public.coherence_reports
  for select to authenticated
  using (
    (student_id <> (select auth.uid()) and private.can_view_student(student_id, (select auth.uid())))
    or (student_id = (select auth.uid()) and created_by = (select auth.uid()))
  );

drop policy if exists coherence_reports_insert on public.coherence_reports;
create policy coherence_reports_insert on public.coherence_reports
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (
      (student_id <> (select auth.uid()) and private.can_edit_student(student_id, (select auth.uid())))
      or (
        student_id = (select auth.uid())
        and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'student')
      )
    )
  );

drop policy if exists coherence_reports_delete on public.coherence_reports;
create policy coherence_reports_delete on public.coherence_reports
  for delete to authenticated
  using (
    (student_id <> (select auth.uid()) and private.can_edit_student(student_id, (select auth.uid())))
    or (student_id = (select auth.uid()) and created_by = (select auth.uid()))
  );

-- ---- narrative_flags: the flags of the reports a student ran ----

drop policy if exists narrative_flags_student_select on public.narrative_flags;
create policy narrative_flags_student_select on public.narrative_flags
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and report_id is not null
    and exists (
      select 1 from public.coherence_reports r
       where r.id = narrative_flags.report_id
         and r.student_id = (select auth.uid())
         and r.created_by = (select auth.uid())
    )
  );

drop policy if exists narrative_flags_student_insert on public.narrative_flags;
create policy narrative_flags_student_insert on public.narrative_flags
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and report_id is not null
    and status = 'open'
    and not shared_with_student
    and assigned_task_id is null
    and resolved_by is null
    and resolved_at is null
    and exists (
      select 1 from public.coherence_reports r
       where r.id = narrative_flags.report_id
         and r.student_id = (select auth.uid())
         and r.created_by = (select auth.uid())
    )
  );

drop policy if exists narrative_flags_student_update on public.narrative_flags;
create policy narrative_flags_student_update on public.narrative_flags
  for update to authenticated
  using (
    student_id = (select auth.uid())
    and report_id is not null
    and exists (
      select 1 from public.coherence_reports r
       where r.id = narrative_flags.report_id
         and r.student_id = (select auth.uid())
         and r.created_by = (select auth.uid())
    )
  )
  with check (
    student_id = (select auth.uid())
    and report_id is not null
    and exists (
      select 1 from public.coherence_reports r
       where r.id = narrative_flags.report_id
         and r.student_id = (select auth.uid())
         and r.created_by = (select auth.uid())
    )
  );

-- A student changes the status of a flag, and the task it was assigned as, and nothing else about it. A counselor
-- (the caller is not the flag's student) and the service role are not held by this.
create or replace function private.narrative_flags_student_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or caller <> new.student_id then
    return new;
  end if;
  if (to_jsonb(new) - '{status,resolved_by,resolved_at,assigned_task_id,updated_at}'::text[])
     is distinct from (to_jsonb(old) - '{status,resolved_by,resolved_at,assigned_task_id,updated_at}'::text[]) then
    raise exception 'A student can only change the status of a flag' using errcode = '42501';
  end if;
  if new.resolved_by is not null and new.resolved_by <> caller then
    raise exception 'A flag is resolved by the person who resolves it' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.narrative_flags_student_guard() from public, anon, authenticated;

drop trigger if exists narrative_flags_student_guard on public.narrative_flags;
create trigger narrative_flags_student_guard
  before update on public.narrative_flags
  for each row execute function private.narrative_flags_student_guard();
