-- Activities Build, run by the student (the practice's "Let students use AI tools" switch, 20261111000001).
--
-- A counselor's Activities Build waits for their review: every match starts `counselor-review`, and a student sees
-- a program only once it is sent, saved or applied. A student who runs it themself skips that step, so the rows
-- they make are marked as theirs, and the student may read, write and change only those:
--
--   * opportunity_matches.origin: 'counselor' (the default, so every existing row and every counselor-run row is
--     what it was) or 'student'.
--   * A student reads a program that was sent, saved or applied (as before) and every program of their own origin.
--   * A student inserts only their own: origin 'student', status 'suggested', never reviewed, sent, dated or
--     linked to a task on the way in.
--   * A student updates only rows of their own origin, to a status of suggested, saved (Track), applied or
--     dismissed, and a trigger limits that update to the status and the task the program was tracked as: its name,
--     link, host and every other field can't be changed by hand.
--   * A counselor is untouched: they read and write every match of their student (their policy), so what the
--     student ran and tracked shows on their side, and a counselor-run match still waits for review.
--
-- opportunity_requests already lets a student read and write their own rows (can_edit_student), and the API
-- files the student's request under their counselor (its counselor_id is NOT NULL).
--
-- Known limit, the same as any row a user may write: a student could write the CONTENT of a program of their own
-- by hand. It is shown only as theirs, to them and to their counselor, with the same "verify it" badge as any model
-- suggestion, and the API (the app's way in) keeps https links only.
--
-- No table is created, so there is no approval gate to attach (the restrictive approval_gate policy still applies).
--
-- Deploy order: either.
--   * Code first: a student's run is refused at the practice switch (off by default); a counselor's run writes no
--     origin (the default applies) and reads nothing new.
--   * Migration first: the previous build never lets a student reach these rows; counselor access is unchanged.
-- Not in REQUIRED_SCHEMA: no request depends on it.

alter table public.opportunity_matches
  add column if not exists origin text not null default 'counselor'
    check (origin in ('counselor', 'student'));

drop policy if exists opportunity_matches_select on public.opportunity_matches;
create policy opportunity_matches_select on public.opportunity_matches
  for select to authenticated
  using (
    private.is_counselor_of(student_id, (select auth.uid()))
    or (
      student_id = (select auth.uid())
      and (status in ('sent', 'saved', 'applied') or origin = 'student')
    )
  );

drop policy if exists opportunity_matches_student_insert on public.opportunity_matches;
create policy opportunity_matches_student_insert on public.opportunity_matches
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and origin = 'student'
    and status = 'suggested'
    and reviewed_by is null
    and reviewed_at is null
    and sent_at is null
    and deadline_id is null
    and assigned_task_id is null
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'student')
  );

drop policy if exists opportunity_matches_student_update on public.opportunity_matches;
create policy opportunity_matches_student_update on public.opportunity_matches
  for update to authenticated
  using (student_id = (select auth.uid()) and origin = 'student')
  with check (
    student_id = (select auth.uid())
    and origin = 'student'
    and status in ('suggested', 'saved', 'applied', 'dismissed')
  );

-- A student changes the status of a program they found, and the task it became, and nothing else about it. A
-- counselor (the caller is not the row's student) and the service role are not held by this.
create or replace function private.opportunity_matches_student_guard()
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
  if (to_jsonb(new) - '{status,assigned_task_id,updated_at}'::text[])
     is distinct from (to_jsonb(old) - '{status,assigned_task_id,updated_at}'::text[]) then
    raise exception 'A student can only change the status of a program, and the task it became' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.opportunity_matches_student_guard() from public, anon, authenticated;

drop trigger if exists opportunity_matches_student_guard on public.opportunity_matches;
create trigger opportunity_matches_student_guard
  before update on public.opportunity_matches
  for each row execute function private.opportunity_matches_student_guard();
