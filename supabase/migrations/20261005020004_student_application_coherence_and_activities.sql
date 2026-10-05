-- v10 sync, student-application (4 of 4): the Narrative Coherence popup's
-- report, and Activities Build's recommendations.
--
-- Demo: lib/coherenceReport.ts + components/student/CoherencePopup.tsx
-- (storyline, contradictions and flags each assignable as a task, where to go
-- next), lib/coherence.ts (which documents were read); and
-- app/.../application/activities-build/page.tsx + lib/programs.ts.
--
-- The demo's program catalog is invented, so nothing is seeded. Activities
-- Build asks the model for real, named programs (the concierge's rules) and
-- stores each one as an opportunity_matches row awaiting counselor review;
-- curated `opportunities` rows, when a curator adds them, are matched first.

-- ---------------------------------------------------------------------------
-- Coherence reports
-- ---------------------------------------------------------------------------

create table if not exists public.coherence_reports (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  -- { statement, activities, awards, supplementEssayIds[] } as ticked.
  criteria      jsonb not null default '{}'::jsonb check (jsonb_typeof(criteria) = 'object'),
  -- What was actually read ("Personal statement", "MIT supplements", ...).
  read_labels   text[] not null default '{}',
  -- Bullets addressed to the counselor; each passed enforceNoProse.
  storyline     text[] not null default '{}',
  next_steps    text[] not null default '{}',
  created_by    uuid references public.profiles(id) on delete set null,
  ai_run_id     uuid,
  created_at    timestamptz not null default now()
);

create index if not exists coherence_reports_student_idx
  on public.coherence_reports (student_id, created_at desc);

-- A professional read of the student's application: counselor-only, like
-- narrative_flags (a flag reaches the student only when it is assigned as a
-- task, which is its own row).
alter table public.coherence_reports enable row level security;
revoke all on public.coherence_reports from anon, authenticated;
grant select, insert, delete on public.coherence_reports to authenticated;

drop policy if exists coherence_reports_select on public.coherence_reports;
create policy coherence_reports_select on public.coherence_reports
  for select to authenticated
  using (student_id <> (select auth.uid()) and private.can_view_student(student_id, (select auth.uid())));

drop policy if exists coherence_reports_insert on public.coherence_reports;
create policy coherence_reports_insert on public.coherence_reports
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and student_id <> (select auth.uid())
    and private.can_edit_student(student_id, (select auth.uid()))
  );

drop policy if exists coherence_reports_delete on public.coherence_reports;
create policy coherence_reports_delete on public.coherence_reports
  for delete to authenticated
  using (student_id <> (select auth.uid()) and private.can_edit_student(student_id, (select auth.uid())));

-- Flags belong to the report that raised them, say where they sit, and
-- remember the task they were assigned as ("Assigned" on the row).
alter table public.narrative_flags
  add column if not exists report_id     uuid references public.coherence_reports(id) on delete cascade,
  add column if not exists location      text check (length(location) <= 400),
  add column if not exists assigned_task_id uuid references public.deliverables(id) on delete set null;

create index if not exists narrative_flags_report_idx
  on public.narrative_flags (report_id) where report_id is not null;

-- ---------------------------------------------------------------------------
-- Activities Build
-- ---------------------------------------------------------------------------

alter table public.opportunity_matches
  add column if not exists program_type text
    check (program_type in ('Job','Internship','Summer program','Lab','Research','Volunteer','Competition','Course','Other')),
  add column if not exists duration text
    check (duration in ('Under 1 day','1 day to 2 weeks','2+ weeks','Ongoing')),
  add column if not exists location text check (length(location) <= 200),
  add column if not exists online boolean,
  add column if not exists topics text[] not null default '{}',
  -- 'catalog': a curated opportunities row. 'axis': named by the model; the
  -- card says so and the counselor verifies it before sending it on.
  add column if not exists source text not null default 'axis' check (source in ('catalog','axis')),
  add column if not exists assigned_task_id uuid references public.deliverables(id) on delete set null;

create index if not exists opportunity_matches_request_idx
  on public.opportunity_matches (request_id) where request_id is not null;
