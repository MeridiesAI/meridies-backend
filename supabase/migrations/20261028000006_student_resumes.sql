-- Resume builder: a student's resume, kept so they can come back to it.
--
-- `student_resumes` holds one resume per student: the template they chose and
-- the content they built (header, education, activities with bullets, honors,
-- skills). The student writes it; the counselor who can see the student reads
-- it. The AI only drafts bullets from the student's own activity rows
-- (`ai_runs` module `resume`); the student edits and keeps what they want, and
-- nothing here writes essay prose.
--
-- Deploy order: either. Additive only. The new code answers 503
-- `resume_unavailable` until this is applied, and drafting bullets (which stores
-- nothing) works either way once the `resume` module label is in; it is not in
-- REQUIRED_SCHEMA.

create table if not exists public.student_resumes (
  student_id  uuid primary key references public.profiles(id) on delete cascade,
  template    text not null default 'classic' check (template in ('classic', 'compact')),
  content     jsonb not null default '{}'::jsonb
                check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 60000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists student_resumes_set_updated_at on public.student_resumes;
create trigger student_resumes_set_updated_at before update on public.student_resumes
  for each row execute function public.set_updated_at();

alter table public.student_resumes enable row level security;
revoke all on public.student_resumes from public, anon, authenticated;
grant select on public.student_resumes to authenticated;
grant insert (student_id, template, content) on public.student_resumes to authenticated;
-- `student_id` is updatable only because an upsert names it; WITH CHECK (student_id = the caller)
-- still stops a row being handed to anyone else.
grant update (student_id, template, content) on public.student_resumes to authenticated;

drop policy if exists student_resumes_select on public.student_resumes;
create policy student_resumes_select on public.student_resumes
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists student_resumes_insert_self on public.student_resumes;
create policy student_resumes_insert_self on public.student_resumes
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

drop policy if exists student_resumes_update_self on public.student_resumes;
create policy student_resumes_update_self on public.student_resumes
  for update to authenticated
  using (student_id = (select auth.uid()))
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.student_resumes');

-- The AI module label. Read the current CHECK back and add ours, so another
-- area's label is never dropped and re-running this is harmless.
do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if 'resume' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'resume'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
