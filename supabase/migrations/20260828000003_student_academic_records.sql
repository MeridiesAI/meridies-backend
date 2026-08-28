-- Student academic record: the normalized tables behind the profile the
-- counselor edits and the intake populates.
--
-- Every table here is student-scoped and gets the same RLS shape:
--   read  -> the student, their counselor, or a shared collaborator
--   write -> the student, their counselor, or a collaborator with write access
-- `private.attach_student_policies` stamps that shape so no table can drift.

create or replace function private.attach_student_policies(
  p_table text,
  p_student_col text default 'student_id'
)
returns void
language plpgsql
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

-- ---------------------------------------------------------------------------
-- Academics — one row per student.
-- ---------------------------------------------------------------------------

create table if not exists public.student_academics (
  student_id         uuid primary key references public.profiles(id) on delete cascade,
  gpa_unweighted     numeric(4,3) check (gpa_unweighted >= 0 and gpa_unweighted <= 10),
  gpa_weighted       numeric(4,3) check (gpa_weighted   >= 0 and gpa_weighted   <= 10),
  gpa_scale          text,
  gpa_band           text,
  class_rank         text,
  class_rank_value   text,
  rigor_count        integer check (rigor_count between 0 and 60),
  rigor_subjects     text[] not null default '{}',
  rigor_context      text,
  test_status        text check (test_status in
                       ('not-started','prepping','scheduled','taken','retaking','test-optional')),
  sat_ebrw           integer check (sat_ebrw between 200 and 800),
  sat_math           integer check (sat_math between 200 and 800),
  sat_superscore     integer check (sat_superscore between 400 and 1600),
  act_composite      integer check (act_composite between 1 and 36),
  act_sections       jsonb not null default '{}'::jsonb,
  planned_test_date  date,
  test_prep_status   text,
  strength_areas     text[] not null default '{}',
  strength_subjects  text[] not null default '{}',
  updated_at         timestamptz not null default now()
);

drop trigger if exists student_academics_set_updated_at on public.student_academics;
create trigger student_academics_set_updated_at before update on public.student_academics
  for each row execute function public.set_updated_at();

select private.attach_student_policies('student_academics');

-- ---------------------------------------------------------------------------
-- Activities
-- ---------------------------------------------------------------------------

create table if not exists public.activities (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.profiles(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 300),
  position        text,
  organization    text,
  category        text,
  grade_levels    text[] not null default '{}',
  timing          text[] not null default '{}',
  hours_per_week  numeric(5,2) check (hours_per_week >= 0 and hours_per_week <= 168),
  weeks_per_year  integer check (weeks_per_year between 0 and 52),
  continuing      boolean,
  description     text check (length(description) <= 2000),
  uc_description  text check (length(uc_description) <= 2000),
  source          text not null default 'manual'
                  check (source in ('manual','intake','import','ai')),
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists activities_student_idx on public.activities (student_id, sort_order);
drop trigger if exists activities_set_updated_at on public.activities;
create trigger activities_set_updated_at before update on public.activities
  for each row execute function public.set_updated_at();
select private.attach_student_policies('activities');

-- ---------------------------------------------------------------------------
-- Awards
-- ---------------------------------------------------------------------------

create table if not exists public.awards (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 300),
  level        text,
  year         text,
  uc_criteria  text,
  uc_earned    text,
  source       text not null default 'manual'
               check (source in ('manual','intake','import','ai')),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists awards_student_idx on public.awards (student_id, sort_order);
drop trigger if exists awards_set_updated_at on public.awards;
create trigger awards_set_updated_at before update on public.awards
  for each row execute function public.set_updated_at();
select private.attach_student_policies('awards');

-- ---------------------------------------------------------------------------
-- Advanced coursework
-- ---------------------------------------------------------------------------

create table if not exists public.courses (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 300),
  type        text check (type in ('ap','ib','honors','dual-enrollment','college','other')),
  grade       text,
  status      text check (status in ('planned','in-progress','completed')),
  school_year text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists courses_student_idx on public.courses (student_id, sort_order);
drop trigger if exists courses_set_updated_at on public.courses;
create trigger courses_set_updated_at before update on public.courses
  for each row execute function public.set_updated_at();
select private.attach_student_policies('courses');

-- ---------------------------------------------------------------------------
-- Individual test sittings (AP exams, SAT/ACT attempts)
-- ---------------------------------------------------------------------------

create table if not exists public.test_scores (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  exam        text not null check (length(btrim(exam)) between 1 and 200),
  kind        text not null default 'ap' check (kind in ('ap','sat','act','ib','toefl','ielts','other')),
  score       text,
  taken_on    date,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists test_scores_student_idx on public.test_scores (student_id, sort_order);
select private.attach_student_policies('test_scores');

-- ---------------------------------------------------------------------------
-- Essays + version history (the narrative engine reads both)
-- ---------------------------------------------------------------------------

create table if not exists public.essays (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 300),
  prompt      text,
  school      text,
  body        text,
  word_count  integer not null default 0 check (word_count >= 0),
  word_limit  integer check (word_limit between 0 and 20000),
  status      text not null default 'not-started'
              check (status in ('not-started','drafting','review','final')),
  due_date    date,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists essays_student_idx on public.essays (student_id, sort_order);
drop trigger if exists essays_set_updated_at on public.essays;
create trigger essays_set_updated_at before update on public.essays
  for each row execute function public.set_updated_at();
select private.attach_student_policies('essays');

create table if not exists public.essay_versions (
  id          uuid primary key default gen_random_uuid(),
  essay_id    uuid not null references public.essays(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  body        text not null,
  word_count  integer not null default 0 check (word_count >= 0),
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists essay_versions_essay_idx on public.essay_versions (essay_id, created_at desc);
select private.attach_student_policies('essay_versions');
