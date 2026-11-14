-- The 3D stat solid's extra nodes (Leadership, Awards, Service, Research, Arts, School fit): the
-- AI's 0-100 read of each, with the reason, written by the same "Estimate with AI" click that
-- scores the polygon's axes (POST /ai/polygon-estimate, 20261125000002).
--
-- These are deliberately NOT polygon axes: student_polygon_axes drives the 2D chart, the ten-axis
-- cap and the growth history, and none of those should move. One row per (student, node).
--
-- Written only by a counselor who can edit the student (the polygon is the counselor's
-- assessment); the student and their counselors read it. Whether a student may SEE their strength
-- profile (their switch, their counselor's) is decided by the routes that serve it, exactly as for
-- the axes, and the reason (ai_rationale) is blanked for a student there.
--
-- Deploy order: either. The route that writes it degrades (the axes still save, the answer says
-- nodes aren't switched on) and the polygon read omits `nodes` until this is applied. Not in
-- REQUIRED_SCHEMA. Additive and idempotent.

create table if not exists public.student_stat_nodes (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  key           text not null check (key in ('leadership','awards','service','research','arts','school-fit')),
  ai_score      numeric(6,2) check (ai_score >= 0 and ai_score <= 100),
  ai_rationale  text check (length(ai_rationale) <= 600),
  ai_scored_at  timestamptz,
  updated_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (student_id, key)
);

comment on table public.student_stat_nodes is
  'AI estimates for the 3D stat solid''s extra nodes. Not polygon axes: the 2D chart, the axis cap and the history are unaffected.';

drop trigger if exists student_stat_nodes_set_updated_at on public.student_stat_nodes;
create trigger student_stat_nodes_set_updated_at before update on public.student_stat_nodes
  for each row execute function public.set_updated_at();

alter table public.student_stat_nodes enable row level security;
revoke all on public.student_stat_nodes from public, anon, authenticated;
grant select on public.student_stat_nodes to authenticated;
grant insert (student_id, key, ai_score, ai_rationale, ai_scored_at, updated_by) on public.student_stat_nodes to authenticated;
-- student_id and key are updatable only because an upsert names them; the policies' WITH CHECK
-- (a counselor who can edit that student) still decides every row.
grant update (student_id, key, ai_score, ai_rationale, ai_scored_at, updated_by) on public.student_stat_nodes to authenticated;
grant delete on public.student_stat_nodes to authenticated;

drop policy if exists student_stat_nodes_select on public.student_stat_nodes;
create policy student_stat_nodes_select on public.student_stat_nodes
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists student_stat_nodes_insert on public.student_stat_nodes;
create policy student_stat_nodes_insert on public.student_stat_nodes
  for insert to authenticated
  with check (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  );

drop policy if exists student_stat_nodes_update on public.student_stat_nodes;
create policy student_stat_nodes_update on public.student_stat_nodes
  for update to authenticated
  using (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  )
  with check (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  );

drop policy if exists student_stat_nodes_delete on public.student_stat_nodes;
create policy student_stat_nodes_delete on public.student_stat_nodes
  for delete to authenticated
  using (
    private.user_role((select auth.uid())) = 'counselor'
    and private.counselor_can_edit_student(student_id, (select auth.uid()))
  );

-- An unapproved counselor's database is their own profile row and nothing else.
select private.attach_approval_gate('public.student_stat_nodes');
