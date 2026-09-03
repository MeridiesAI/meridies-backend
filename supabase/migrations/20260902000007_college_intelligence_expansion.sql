-- College intelligence the September 2026 brief adds.
--
-- What already exists and is NOT rebuilt here: colleges, college_admission_stats
-- (class profile per cohort), scattergram_points, combined_programs,
-- college_aid_profiles, net_price_estimates, high_schools.
--
-- What is new is mostly *per major*, which is a repeating group and therefore a
-- table, not more columns on `colleges`:
--
--   college_intel_profiles     -- school-level: admission model, rank policy,
--                                 grad vs undergrad size
--   college_majors             -- department size, admission model, durability,
--                                 program health, graduation rate
--   college_major_admit_stats  -- the admit profile broken down by major, by year
--   college_cds_factors        -- AP/IB weight and class rank, from Common Data Sets
--   college_course_requirements-- class-specific requirements, school or major
--   college_rigor_flags        -- rigor red flags
--   college_aid_ratings        -- the curated Meridies generosity rating, 1-10
--
-- PROVENANCE IS THE POINT. Several of these are proprietary judgements, and a
-- curated rating presented as a federal statistic is the one mistake that would
-- cost a counselor their credibility with a family. Every row therefore carries
-- the same `provenance` domain beside `source_url` / `source_verified_at`, the
-- way college_admission_stats already models a sourced fact — and the curated
-- rating lives in its own table whose rows cannot claim to be anything else.

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'data_provenance' and typnamespace = 'public'::regnamespace
  ) then
    create domain public.data_provenance as text
      not null
      default 'sourced'
      check (value in ('sourced','curated','estimated'));
  end if;
end
$$;

comment on domain public.data_provenance is
  'sourced = published by the institution or a government dataset, with source_url. curated = a Meridies judgement. estimated = derived/modelled. The UI must label anything that is not sourced.';

grant usage on type public.data_provenance to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- School-level intelligence.
-- ---------------------------------------------------------------------------

create table if not exists public.college_intel_profiles (
  college_id                uuid primary key references public.colleges(id) on delete cascade,
  -- How you get into a major here at all. 'mixed' when it varies by school
  -- within the university, which is the common case at large publics.
  default_admission_model   text check (default_admission_model in
                              ('direct-admit','pre-major','secondary-admission','open','mixed')),
  admission_model_note      text check (length(admission_model_note) <= 2000),
  -- Whether the COLLEGE considers class rank. The high school's own ranking
  -- practice is on public.high_schools; the two are different questions and
  -- conflating them is how a counselor gives bad advice about a school that
  -- doesn't rank.
  class_rank_considered     text check (class_rank_considered in
                              ('very-important','important','considered','not-considered','not-reported')),
  class_rank_note           text check (length(class_rank_note) <= 1000),
  undergrad_enrollment      integer check (undergrad_enrollment >= 0),
  graduate_enrollment       integer check (graduate_enrollment >= 0),
  -- Graduate program size relative to undergrad: a 3:1 graduate campus teaches
  -- undergraduates very differently from a 1:10 one.
  grad_to_undergrad_ratio   numeric(8,4) generated always as (
                              case when undergrad_enrollment > 0
                                   then round(graduate_enrollment::numeric / undergrad_enrollment, 4)
                              end
                            ) stored,
  research_designation      text check (length(research_designation) <= 100),
  cds_year                  integer check (cds_year between 1990 and 2100),
  cds_url                   text,
  provenance                public.data_provenance,
  source_url                text,
  source_verified_at        timestamptz,
  curated_by                uuid references public.profiles(id) on delete set null,
  curator_note              text check (length(curator_note) <= 2000),
  updated_at                timestamptz not null default now()
);

drop trigger if exists college_intel_profiles_set_updated_at on public.college_intel_profiles;
create trigger college_intel_profiles_set_updated_at before update on public.college_intel_profiles
  for each row execute function public.set_updated_at();

alter table public.college_intel_profiles enable row level security;
drop policy if exists college_intel_profiles_select on public.college_intel_profiles;
create policy college_intel_profiles_select on public.college_intel_profiles
  for select to authenticated using (true);
-- Catalog data: maintained by service_role only, like every other college table.

-- ---------------------------------------------------------------------------
-- Majors / departments.
-- ---------------------------------------------------------------------------

create table if not exists public.college_majors (
  id                       uuid primary key default gen_random_uuid(),
  college_id               uuid not null references public.colleges(id) on delete cascade,
  name                     text not null check (length(btrim(name)) between 1 and 200),
  department               text check (length(department) <= 200),
  school_or_college        text check (length(school_or_college) <= 200),
  cip_code                 text check (length(cip_code) <= 12),
  discipline               text check (length(discipline) <= 100),

  -- Department size. "20 faculty for 900 majors" is the fact that decides
  -- whether a student ever meets a professor.
  faculty_count            integer check (faculty_count >= 0),
  majors_enrolled          integer check (majors_enrolled >= 0),
  students_per_faculty     numeric(8,2) generated always as (
                             case when faculty_count > 0
                                  then round(majors_enrolled::numeric / faculty_count, 2)
                             end
                           ) stored,
  graduate_enrolled        integer check (graduate_enrolled >= 0),
  grad_to_undergrad_ratio  numeric(8,4) generated always as (
                             case when majors_enrolled > 0
                                  then round(graduate_enrolled::numeric / majors_enrolled, 4)
                             end
                           ) stored,

  -- Direct admit vs pre-major vs secondary admission, per discipline. The
  -- secondary rate is the number nobody publishes prominently and every CS
  -- applicant needs.
  admission_model          text check (admission_model in
                             ('direct-admit','pre-major','secondary-admission','open')),
  admission_model_note     text check (length(admission_model_note) <= 2000),
  secondary_admit_rate     numeric(5,4) check (secondary_admit_rate between 0 and 1),
  secondary_admit_note     text check (length(secondary_admit_note) <= 1000),
  capacity_constrained     boolean,

  -- Durability: is this program growing, or is it being cut out from under a
  -- freshman? Requires a source, because "being cut" is an accusation.
  durability               text check (durability in ('growing','stable','under-review','being-cut')),
  durability_note          text check (length(durability_note) <= 2000),
  durability_source_url    text,
  durability_verified_at   timestamptz,

  -- Program outcomes and health.
  graduation_rate          numeric(5,4) check (graduation_rate between 0 and 1),
  graduation_rate_years    smallint check (graduation_rate_years between 3 and 8),
  program_health           text check (program_health in ('well-funded','stable','watch','at-risk')),
  program_health_note      text check (length(program_health_note) <= 2000),
  funding_note             text check (length(funding_note) <= 2000),
  endowed_chairs           integer check (endowed_chairs >= 0),

  provenance               public.data_provenance,
  source_url               text,
  source_verified_at       timestamptz,
  curated_by               uuid references public.profiles(id) on delete set null,
  curator_note             text check (length(curator_note) <= 2000),
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- A durability call and a health call are judgements; they must be
  -- attributable to something, sourced or curated, never anonymous.
  constraint college_majors_durability_is_attributed check (
    durability is null
    or durability_source_url is not null
    or provenance = 'curated'
  )
);

create unique index if not exists college_majors_unique
  on public.college_majors (college_id, lower(name));
create index if not exists college_majors_college_idx on public.college_majors (college_id);
create index if not exists college_majors_discipline_idx on public.college_majors (lower(discipline));
create index if not exists college_majors_durability_idx
  on public.college_majors (durability) where durability in ('under-review','being-cut');

drop trigger if exists college_majors_set_updated_at on public.college_majors;
create trigger college_majors_set_updated_at before update on public.college_majors
  for each row execute function public.set_updated_at();

alter table public.college_majors enable row level security;
drop policy if exists college_majors_select on public.college_majors;
create policy college_majors_select on public.college_majors
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Admit profile broken down by major, per cohort.
--
-- Separate from college_admission_stats on purpose: the university-wide rate is
-- the number that misleads. Engineering at a 40%-admit public is not 40%.
-- ---------------------------------------------------------------------------

create table if not exists public.college_major_admit_stats (
  id                  uuid primary key default gen_random_uuid(),
  college_major_id    uuid not null references public.college_majors(id) on delete cascade,
  college_id          uuid not null references public.colleges(id) on delete cascade,
  cohort_year         integer not null check (cohort_year between 1990 and 2100),
  entry_point         text not null default 'freshman'
                      check (entry_point in ('freshman','secondary-admission','transfer')),
  applicants          integer check (applicants >= 0),
  admits              integer check (admits >= 0),
  enrolled            integer check (enrolled >= 0),
  acceptance_rate     numeric(5,4) check (acceptance_rate between 0 and 1),
  ed_acceptance_rate  numeric(5,4) check (ed_acceptance_rate between 0 and 1),
  ea_acceptance_rate  numeric(5,4) check (ea_acceptance_rate between 0 and 1),
  gpa_avg             numeric(4,3),
  gpa_25              numeric(4,3),
  gpa_75              numeric(4,3),
  sat_25 integer, sat_50 integer, sat_75 integer,
  act_25 integer, act_50 integer, act_75 integer,
  rigor_note          text check (length(rigor_note) <= 1000),
  provenance          public.data_provenance,
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now()
);

create unique index if not exists college_major_admit_stats_unique
  on public.college_major_admit_stats (college_major_id, cohort_year, entry_point);
create index if not exists college_major_admit_stats_college_idx
  on public.college_major_admit_stats (college_id, cohort_year);

alter table public.college_major_admit_stats enable row level security;
drop policy if exists college_major_admit_stats_select on public.college_major_admit_stats;
create policy college_major_admit_stats_select on public.college_major_admit_stats
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Common Data Set factors — how much a school says each thing weighs.
--
-- This is where "how much does AP/IB actually count here" comes from, and it is
-- a published answer (CDS section C7), so every row is sourced with the year it
-- was published. It also carries class rank, which is why the school-level
-- column above is a summary of these rows rather than a separate opinion.
-- ---------------------------------------------------------------------------

create table if not exists public.college_cds_factors (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid not null references public.colleges(id) on delete cascade,
  cds_year            integer not null check (cds_year between 1990 and 2100),
  factor              text not null check (factor in (
                        'ap-coursework','ib-coursework','rigor-of-record','class-rank',
                        'academic-gpa','standardized-tests','application-essay',
                        'recommendations','interview','extracurriculars','talent-ability',
                        'character','first-generation','alumni-relation','geographical-residence',
                        'state-residency','religious-affiliation','racial-ethnic-status',
                        'volunteer-work','work-experience','level-of-interest')),
  weight              text not null check (weight in
                        ('very-important','important','considered','not-considered')),
  note                text check (length(note) <= 1000),
  provenance          public.data_provenance,
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now()
);

create unique index if not exists college_cds_factors_unique
  on public.college_cds_factors (college_id, cds_year, factor);
create index if not exists college_cds_factors_factor_idx
  on public.college_cds_factors (factor, weight);

comment on table public.college_cds_factors is
  'Common Data Set C7 weights. The AP/IB rows are the defensible answer to "does taking six APs actually matter here"; sourced, dated, and quotable to a family.';

alter table public.college_cds_factors enable row level security;
drop policy if exists college_cds_factors_select on public.college_cds_factors;
create policy college_cds_factors_select on public.college_cds_factors
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Class-specific course requirements, school-wide or per major.
-- ---------------------------------------------------------------------------

create table if not exists public.college_course_requirements (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid not null references public.colleges(id) on delete cascade,
  -- Null = applies to the whole institution.
  college_major_id    uuid references public.college_majors(id) on delete cascade,
  subject             text not null check (length(btrim(subject)) between 1 and 100),
  -- The specific class where one is named: "Calculus BC", "Physics with lab".
  requirement         text check (length(requirement) <= 300),
  years_required      numeric(3,1) check (years_required between 0 and 8),
  minimum_level       text check (minimum_level in
                        ('any','honors','ap-ib','dual-enrollment','college-level')),
  kind                text not null default 'required'
                      check (kind in ('required','recommended','expected')),
  note                text check (length(note) <= 1000),
  provenance          public.data_provenance,
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists college_course_requirements_college_idx
  on public.college_course_requirements (college_id, subject);
create index if not exists college_course_requirements_major_idx
  on public.college_course_requirements (college_major_id);

drop trigger if exists college_course_requirements_set_updated_at on public.college_course_requirements;
create trigger college_course_requirements_set_updated_at
  before update on public.college_course_requirements
  for each row execute function public.set_updated_at();

alter table public.college_course_requirements enable row level security;
drop policy if exists college_course_requirements_select on public.college_course_requirements;
create policy college_course_requirements_select on public.college_course_requirements
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Rigor red flags — "applying here for this, without that, reads badly".
-- ---------------------------------------------------------------------------

create table if not exists public.college_rigor_flags (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid not null references public.colleges(id) on delete cascade,
  college_major_id    uuid references public.college_majors(id) on delete cascade,
  title               text not null check (length(btrim(title)) between 1 and 200),
  detail              text not null check (length(detail) <= 2000),
  severity            text not null default 'medium'
                      check (severity in ('critical','high','medium','low')),
  -- Machine-checkable trigger against the student's record where possible:
  -- { "missing_subject": "calculus" } / { "max_ap_count": 2 }.
  trigger_rule        jsonb not null default '{}'::jsonb,
  provenance          public.data_provenance,
  source_url          text,
  source_verified_at  timestamptz,
  curated_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists college_rigor_flags_college_idx
  on public.college_rigor_flags (college_id, severity);
create index if not exists college_rigor_flags_major_idx
  on public.college_rigor_flags (college_major_id);

drop trigger if exists college_rigor_flags_set_updated_at on public.college_rigor_flags;
create trigger college_rigor_flags_set_updated_at before update on public.college_rigor_flags
  for each row execute function public.set_updated_at();

alter table public.college_rigor_flags enable row level security;
drop policy if exists college_rigor_flags_select on public.college_rigor_flags;
create policy college_rigor_flags_select on public.college_rigor_flags
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- The curated aid generosity rating, 1-10.
--
-- Deliberately its OWN table rather than a column on college_aid_profiles,
-- which holds sourced federal and institutional figures. A rating is a Meridies
-- judgement; mixing it in beside pct_need_met would make it look like one more
-- reported statistic. `rating_kind` is pinned by a CHECK so no future writer can
-- relabel it as federal data.
-- ---------------------------------------------------------------------------

create table if not exists public.college_aid_ratings (
  college_id        uuid primary key references public.colleges(id) on delete cascade,
  rating            smallint not null check (rating between 1 and 10),
  rating_kind       text not null default 'meridies-curated'
                    check (rating_kind = 'meridies-curated'),
  headline          text check (length(headline) <= 200),
  rationale         text check (length(rationale) <= 4000),
  -- "What families get caught by here" — the renewal clause, the first-year-only
  -- merit award, the CSS non-custodial parent requirement.
  gotchas           text[] not null default '{}',
  merit_reality     text check (length(merit_reality) <= 2000),
  -- The sourced figures the judgement leans on, so the rating is arguable
  -- rather than a vibe. Points at college_aid_profiles / IPEDS URLs.
  evidence          jsonb not null default '[]'::jsonb,
  methodology_url   text,
  rated_by          uuid references public.profiles(id) on delete set null,
  rated_at          timestamptz not null default now(),
  review_due_at     date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists college_aid_ratings_rating_idx on public.college_aid_ratings (rating desc);

drop trigger if exists college_aid_ratings_set_updated_at on public.college_aid_ratings;
create trigger college_aid_ratings_set_updated_at before update on public.college_aid_ratings
  for each row execute function public.set_updated_at();

comment on table public.college_aid_ratings is
  'A curated MeridiesAI rating (1-10) of how generous a school actually is. NOT a federal statistic and never to be displayed as one: rating_kind is pinned by a CHECK constraint, and the sourced figures it reasons from live in college_aid_profiles.';
comment on column public.college_aid_ratings.gotchas is
  'What families get caught by: renewal conditions, one-time awards, non-custodial parent forms, aid that drops after year one.';

alter table public.college_aid_ratings enable row level security;
drop policy if exists college_aid_ratings_select on public.college_aid_ratings;
create policy college_aid_ratings_select on public.college_aid_ratings
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- High-school ranking transparency.
--
-- The other half of the class-rank question: many schools do not rank publicly
-- but do maintain an internal ranking, and the school profile is where a
-- college learns it. Recording the practice is what lets the app tell a family
-- "your school doesn't rank, so this college's 'class rank: important' means
-- something different for you".
-- ---------------------------------------------------------------------------

alter table public.high_schools
  add column if not exists reports_class_rank    boolean,
  add column if not exists ranking_practice      text check (ranking_practice in
                                                   ('exact','decile','quintile','quartile','none','internal-only','unknown')),
  add column if not exists internal_ranking_note text check (length(internal_ranking_note) <= 2000),
  add column if not exists rank_transparency     text check (rank_transparency in
                                                   ('published','on-request','internal-only','not-ranked','unknown')),
  add column if not exists school_profile_url    text,
  add column if not exists profile_verified_at   timestamptz,
  add column if not exists grading_scale         text check (length(grading_scale) <= 100),
  add column if not exists weights_gpa           boolean,
  add column if not exists ap_courses_offered    integer check (ap_courses_offered >= 0),
  add column if not exists ib_program            boolean,
  add column if not exists provenance            public.data_provenance;

comment on column public.high_schools.ranking_practice is
  'What the school actually does internally, from its school profile. "internal-only" is the common and most misleading case: the family believes there is no rank, and colleges are told one.';
