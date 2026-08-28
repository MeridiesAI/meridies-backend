-- College List Builder intelligence: the data that makes school selection
-- defensible rather than a guess.
--
--   high_schools            -- so outcomes can be sliced by the student's school
--   college_admission_stats -- published class profile per college per year
--   scattergram_points      -- GPA/SAT outcome dots, by school and worldwide
--   combined_programs       -- BA/MD, BS/MD and friends; almost nowhere else
--   student_college_fit     -- per-student admit probability + why-fit copy

create table if not exists public.high_schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  ceeb_code   text unique,
  city        text,
  state       text,
  country     text not null default 'US',
  region      text,
  type        text check (type in ('public','private','charter','boarding','international','homeschool')),
  created_at  timestamptz not null default now()
);

create index if not exists high_schools_name_idx on public.high_schools (lower(name));

alter table public.high_schools enable row level security;
drop policy if exists high_schools_select on public.high_schools;
create policy high_schools_select on public.high_schools
  for select to authenticated using (true);

alter table public.profiles
  add column if not exists high_school_id uuid references public.high_schools(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Published admission statistics per college per cohort.
-- ---------------------------------------------------------------------------

create table if not exists public.college_admission_stats (
  id                    uuid primary key default gen_random_uuid(),
  college_id            uuid not null references public.colleges(id) on delete cascade,
  cohort_year           integer not null check (cohort_year between 1990 and 2100),
  applicants            integer,
  admits                integer,
  acceptance_rate       numeric(5,4) check (acceptance_rate between 0 and 1),
  ed_acceptance_rate    numeric(5,4) check (ed_acceptance_rate between 0 and 1),
  ea_acceptance_rate    numeric(5,4) check (ea_acceptance_rate between 0 and 1),
  gpa_avg               numeric(4,3),
  sat_25                integer, sat_50 integer, sat_75 integer,
  act_25                integer, act_50 integer, act_75 integer,
  yield_rate            numeric(5,4) check (yield_rate between 0 and 1),
  source_url            text,
  source_verified_at    timestamptz,
  created_at            timestamptz not null default now()
);

create unique index if not exists college_admission_stats_unique
  on public.college_admission_stats (college_id, cohort_year);

alter table public.college_admission_stats enable row level security;
drop policy if exists college_admission_stats_select on public.college_admission_stats;
create policy college_admission_stats_select on public.college_admission_stats
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Scattergram: one dot = one outcome. Deliberately de-identified — no student
-- reference, so a counselor can never read another practice's roster from it.
-- ---------------------------------------------------------------------------

create table if not exists public.scattergram_points (
  id              uuid primary key default gen_random_uuid(),
  college_id      uuid not null references public.colleges(id) on delete cascade,
  high_school_id  uuid references public.high_schools(id) on delete set null,
  cohort_year     integer check (cohort_year between 1990 and 2100),
  gpa             numeric(4,3),
  gpa_scale       text,
  sat             integer check (sat between 400 and 1600),
  act             integer check (act between 1 and 36),
  outcome         text not null check (outcome in ('accepted','denied','waitlisted','deferred','enrolled')),
  applied_round   text,
  region          text,
  country         text,
  source          text not null default 'aggregate'
                  check (source in ('school-reported','self-reported','aggregate','partner')),
  created_at      timestamptz not null default now()
);

create index if not exists scattergram_college_idx on public.scattergram_points (college_id, cohort_year);
create index if not exists scattergram_school_idx on public.scattergram_points (high_school_id, college_id);

alter table public.scattergram_points enable row level security;
drop policy if exists scattergram_points_select on public.scattergram_points;
create policy scattergram_points_select on public.scattergram_points
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Combined / accelerated programs (BA-MD, BS-MD, BS-DDS, 3+2 engineering).
-- ---------------------------------------------------------------------------

create table if not exists public.combined_programs (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid references public.colleges(id) on delete cascade,
  name                text not null,
  partner_institution text,
  track               text not null check (track in
                        ('ba-md','bs-md','bs-dds','bs-do','bs-pharmd','bs-jd','bs-mba','engineering-3-2','other')),
  years               numeric(3,1),
  degree_awarded      text,
  description         text,
  requirements        text,
  min_gpa             numeric(4,3),
  min_sat             integer,
  min_act             integer,
  seats               integer,
  acceptance_rate     numeric(5,4) check (acceptance_rate between 0 and 1),
  deadline            date,
  binding             boolean,
  url                 text,
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists combined_programs_track_idx on public.combined_programs (track);
drop trigger if exists combined_programs_set_updated_at on public.combined_programs;
create trigger combined_programs_set_updated_at before update on public.combined_programs
  for each row execute function public.set_updated_at();

alter table public.combined_programs enable row level security;
drop policy if exists combined_programs_select on public.combined_programs;
create policy combined_programs_select on public.combined_programs
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Per-student fit: the "why this school" the builder has to show.
-- ---------------------------------------------------------------------------

create table if not exists public.student_college_fit (
  id                    uuid primary key default gen_random_uuid(),
  student_id            uuid not null references public.profiles(id) on delete cascade,
  college_id            uuid references public.colleges(id) on delete cascade,
  student_college_id    uuid references public.student_colleges(id) on delete cascade,
  combined_program_id   uuid references public.combined_programs(id) on delete set null,
  -- Overall, and narrowed to students from this high school / region.
  admit_probability     numeric(5,4) check (admit_probability between 0 and 1),
  admit_prob_school     numeric(5,4) check (admit_prob_school between 0 and 1),
  admit_prob_region     numeric(5,4) check (admit_prob_region between 0 and 1),
  sample_size           integer,
  fit                   text check (fit in ('reach','target','likely')),
  why_fit               text,
  factors               jsonb not null default '[]'::jsonb,
  citations             jsonb not null default '[]'::jsonb,
  ai_run_id             uuid,
  computed_at           timestamptz not null default now()
);

create index if not exists student_college_fit_student_idx
  on public.student_college_fit (student_id, computed_at desc);
select private.attach_student_policies('student_college_fit');
