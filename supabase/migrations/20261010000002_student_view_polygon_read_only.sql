-- Student view (SV Demo v2), 2 of 5: the student reads their strength profile
-- and never edits it.
--
-- student_polygon_axes was stamped with attach_student_policies, whose standard
-- shape lets the student write their own rows. For the polygon that is wrong:
-- it is the counselor's assessment, and a student who could set their own
-- scores (or tidy them through the history trigger) would make the chart
-- worthless to the counselor. Select stays as it was (the student and their
-- counselors); insert, update and delete become counselor-only.
--
-- polygon_axis_history keeps select-and-insert only. Its insert policy is
-- narrowed the same way; the history trigger is SECURITY DEFINER and is not
-- affected by it.

-- A counselor with write access to the student, never the student themselves.
create or replace function private.counselor_can_edit_student(student uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private','public'
as $$
  select viewer is not null
     and student <> viewer
     and private.can_edit_student(student, viewer);
$$;

revoke all on function private.counselor_can_edit_student(uuid, uuid) from public, anon;
grant execute on function private.counselor_can_edit_student(uuid, uuid) to authenticated;

-- ---- student_polygon_axes --------------------------------------------------

drop policy if exists student_polygon_axes_insert on public.student_polygon_axes;
create policy student_polygon_axes_insert on public.student_polygon_axes
  for insert to authenticated
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists student_polygon_axes_update on public.student_polygon_axes;
create policy student_polygon_axes_update on public.student_polygon_axes
  for update to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())))
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

drop policy if exists student_polygon_axes_delete on public.student_polygon_axes;
create policy student_polygon_axes_delete on public.student_polygon_axes
  for delete to authenticated
  using (private.counselor_can_edit_student(student_id, (select auth.uid())));

-- Select is unchanged (private.can_view_student): re-stated so this file
-- documents the whole shape.
drop policy if exists student_polygon_axes_select on public.student_polygon_axes;
create policy student_polygon_axes_select on public.student_polygon_axes
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

-- ---- polygon_axis_history --------------------------------------------------

drop policy if exists polygon_axis_history_insert on public.polygon_axis_history;
create policy polygon_axis_history_insert on public.polygon_axis_history
  for insert to authenticated
  with check (private.counselor_can_edit_student(student_id, (select auth.uid())));

-- Select stays private.can_view_student: the student reads their own growth.
