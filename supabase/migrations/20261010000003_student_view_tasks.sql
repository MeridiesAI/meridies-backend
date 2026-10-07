-- Student view (SV Demo v2), 3 of 5: the student's To-Do.
--
-- The student sees the tasks their counselor assigned and ticks them (and
-- their steps) off. They may not rename, re-date, re-scope or delete what the
-- counselor assigned. They may add tasks of their own; those rows say so
-- (source = 'student', created_by = the student), show on the counselor's
-- view of the student page, and are the only tasks the student may edit or
-- delete.
--
-- deliverables, deliverable_stages and deliverable_documents were all stamped
-- with attach_student_policies, which lets the student write anything on
-- their own rows. That stays true for the student's own tasks and is narrowed
-- everywhere else:
--
--   deliverables           insert: counselor (source 'counselor') or the
--                          student for themselves (source 'student');
--                          update: as before, but a trigger limits what the
--                          student may change on a counselor's task to its
--                          progress (status, words, percent, last activity);
--                          delete: counselor, or the student on their own task.
--   deliverable_stages     insert/delete counselor-only; on update the student
--                          may only tick a step done.
--   deliverable_documents  writes counselor-only (the counselor attaches the
--                          material a task is worked off).
--
-- Policies decide rows; the triggers decide columns, because a column grant
-- can't tell a counselor's task from a student's own.
--
-- Depends on private.counselor_can_edit_student (20261010000002).

alter table public.deliverables
  add column if not exists source     text not null default 'counselor'
                                      check (source in ('counselor','student')),
  add column if not exists created_by uuid references public.profiles(id) on delete set null;

comment on column public.deliverables.source is
  'SV Demo v2: counselor = assigned by the counselor (the student may only record progress); student = added by the student for themselves (theirs to edit or delete; the counselor sees it on the student page).';

update public.deliverables set created_by = assigned_by
 where created_by is null and assigned_by is not null;

create index if not exists deliverables_student_source_idx
  on public.deliverables (student_id, source);

-- ---- deliverables: rows -----------------------------------------------------

drop policy if exists deliverables_insert on public.deliverables;
create policy deliverables_insert on public.deliverables
  for insert to authenticated
  with check (
    (source = 'counselor'
      and private.counselor_can_edit_student(student_id, (select auth.uid())))
    or (source = 'student'
      and student_id = (select auth.uid())
      and created_by = (select auth.uid())
      and assigned_by is null)
  );

drop policy if exists deliverables_update on public.deliverables;
create policy deliverables_update on public.deliverables
  for update to authenticated
  using (private.can_edit_student(student_id, (select auth.uid())))
  with check (private.can_edit_student(student_id, (select auth.uid())));

drop policy if exists deliverables_delete on public.deliverables;
create policy deliverables_delete on public.deliverables
  for delete to authenticated
  using (
    private.counselor_can_edit_student(student_id, (select auth.uid()))
    or (source = 'student' and student_id = (select auth.uid()))
  );

-- ---- deliverables: columns --------------------------------------------------

create or replace function private.deliverables_guard_student_edits()
returns trigger
language plpgsql
security invoker
set search_path to 'private','public','pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  -- What a student may move on a task their counselor assigned: its progress.
  v_progress text[] := array['status','current_words','progress_pct','last_activity_at','updated_at'];
begin
  -- Service-role work (the sweep, deliveries) runs without a user.
  if v_uid is null then
    return new;
  end if;

  -- Who a task is for, who made it and which kind it is never change.
  if new.student_id is distinct from old.student_id
     or new.source is distinct from old.source
     or new.created_by is distinct from old.created_by then
    raise exception 'A task''s student, origin and author can''t change' using errcode = '42501';
  end if;

  if v_uid <> old.student_id then
    return new;
  end if;

  if old.source = 'counselor' then
    if (to_jsonb(new) - v_progress) is distinct from (to_jsonb(old) - v_progress) then
      raise exception 'Only your counselor can change this task' using errcode = '42501';
    end if;
  else
    -- The student's own task: anything of theirs, but never dress it up as
    -- an assignment.
    if new.assigned_by is distinct from old.assigned_by
       or new.assigned_at is distinct from old.assigned_at then
      raise exception 'Only your counselor assigns tasks' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.deliverables_guard_student_edits() from public, anon, authenticated;

drop trigger if exists deliverables_guard_student_edits on public.deliverables;
create trigger deliverables_guard_student_edits
  before update on public.deliverables
  for each row execute function private.deliverables_guard_student_edits();

-- ---- deliverable_stages -----------------------------------------------------

drop policy if exists deliverable_stages_insert on public.deliverable_stages;
create policy deliverable_stages_insert on public.deliverable_stages
  for insert to authenticated
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists deliverable_stages_delete on public.deliverable_stages;
create policy deliverable_stages_delete on public.deliverable_stages
  for delete to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())));

create or replace function private.deliverable_stages_guard_student_edits()
returns trigger
language plpgsql
security invoker
set search_path to 'private','public','pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tick text[] := array['done','done_at','completed_by','updated_at'];
begin
  if v_uid is null then
    return new;
  end if;
  if new.student_id is distinct from old.student_id
     or new.deliverable_id is distinct from old.deliverable_id then
    raise exception 'A step stays on its task' using errcode = '42501';
  end if;
  if v_uid = old.student_id
     and (to_jsonb(new) - v_tick) is distinct from (to_jsonb(old) - v_tick) then
    raise exception 'You can tick a step done; only your counselor changes it' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.deliverable_stages_guard_student_edits() from public, anon, authenticated;

drop trigger if exists deliverable_stages_guard_student_edits on public.deliverable_stages;
create trigger deliverable_stages_guard_student_edits
  before update on public.deliverable_stages
  for each row execute function private.deliverable_stages_guard_student_edits();

-- ---- deliverable_documents --------------------------------------------------

drop policy if exists deliverable_documents_insert on public.deliverable_documents;
create policy deliverable_documents_insert on public.deliverable_documents
  for insert to authenticated
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists deliverable_documents_update on public.deliverable_documents;
create policy deliverable_documents_update on public.deliverable_documents
  for update to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())))
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists deliverable_documents_delete on public.deliverable_documents;
create policy deliverable_documents_delete on public.deliverable_documents
  for delete to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())));
