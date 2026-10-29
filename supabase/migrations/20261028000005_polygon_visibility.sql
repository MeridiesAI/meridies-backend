-- The strength profile (stat polygon) is optional: a student can hide it from
-- their own dashboard, and their counselor can hide it from them.
--
--   * `student_preferences.show_strength_profile`  the student's own switch
--     (default on). The table is student-written, so this one is too.
--   * `student_polygon_settings.hidden_by_counselor`  the counselor's override,
--     in its own table because `student_preferences` is student-writable and a
--     student must not be able to undo it. The counselor writes it (RLS:
--     `private.counselor_can_edit_student`); the student reads it.
--
-- Hiding changes what the student sees. The counselor still has the polygon
-- on the student's page, and the axes, scores and history are untouched.
--
-- Deploy order: either. Additive only. The new code must degrade (every
-- student keeps seeing their strength profile) until this is applied; it is
-- not in REQUIRED_SCHEMA.

alter table public.student_preferences
  add column if not exists show_strength_profile boolean not null default true;

create table if not exists public.student_polygon_settings (
  student_id          uuid primary key references public.profiles(id) on delete cascade,
  hidden_by_counselor boolean not null default false,
  updated_at          timestamptz not null default now()
);

drop trigger if exists student_polygon_settings_set_updated_at on public.student_polygon_settings;
create trigger student_polygon_settings_set_updated_at before update on public.student_polygon_settings
  for each row execute function public.set_updated_at();

alter table public.student_polygon_settings enable row level security;
revoke all on public.student_polygon_settings from public, anon, authenticated;
grant select on public.student_polygon_settings to authenticated;
grant insert (student_id, hidden_by_counselor) on public.student_polygon_settings to authenticated;
-- `student_id` is updatable only because an upsert names it; the policies' WITH CHECK
-- (a counselor who can edit that student) still decides every row.
grant update (student_id, hidden_by_counselor) on public.student_polygon_settings to authenticated;

-- The student and anyone who can see the student read it.
drop policy if exists student_polygon_settings_select on public.student_polygon_settings;
create policy student_polygon_settings_select on public.student_polygon_settings
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

-- Only a counselor who can edit the student writes it; a student never does.
drop policy if exists student_polygon_settings_insert on public.student_polygon_settings;
create policy student_polygon_settings_insert on public.student_polygon_settings
  for insert to authenticated
  with check (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  );

drop policy if exists student_polygon_settings_update on public.student_polygon_settings;
create policy student_polygon_settings_update on public.student_polygon_settings
  for update to authenticated
  using (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  )
  with check (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  );

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.student_polygon_settings');
