-- Every US college, from official data (BACKEND_TODO §2).
--
-- The catalog was ~40 schools translated from demo fixtures. This adds what an
-- ingest of the U.S. Department of Education's College Scorecard needs:
--
--   colleges                 + unitid (the IPEDS id, the join key to every
--                              federal dataset), ope_id, zip, where the row came
--                              from, and when official data last touched it
--   college_stats            one row per school: admissions, test ranges, cost
--                              and net price by income, aid, outcomes, and the
--                              descriptive flags search filters on
--   college_fields_of_study  majors offered, by CIP code and credential, with
--                              earnings and debt where Scorecard publishes them
--   ingest_runs              one row per load: source, counts, errors, duration
--
-- Rules the ingest (src/lib/ingest/scorecard.ts) keeps, and this schema backs:
--   - A Meridies-curated row ('meridies') keeps its name, slug, aliases,
--     colours, deadlines and test policy; official data fills facts only.
--   - Everything official is provenance 'sourced' with the Scorecard URL and
--     the ingest time as source_verified_at, so a stale row can be flagged
--     rather than served as current.
--   - Clients read; only service_role writes.

-- ---------------------------------------------------------------------------
-- colleges: external ids and freshness
-- ---------------------------------------------------------------------------

alter table public.colleges
  add column if not exists unitid            integer,
  add column if not exists ope_id            text check (ope_id is null or ope_id ~ '^[0-9]{6,8}$'),
  add column if not exists zip               text check (zip is null or length(zip) <= 10),
  add column if not exists catalog_source    text not null default 'meridies'
                                               check (catalog_source in ('meridies', 'scorecard')),
  add column if not exists last_ingested_at  timestamptz,
  add column if not exists data_year         text check (data_year is null or length(data_year) <= 20);

create unique index if not exists colleges_unitid_key on public.colleges (unitid) where unitid is not null;

-- The seeded schools, linked to their IPEDS ids (checked against Scorecard on
-- 10/6) so the ingest updates them instead of adding a duplicate.
update public.colleges c set unitid = m.unitid
from (values
  ('binghamton', 196079), ('boston-college', 164924), ('bu', 164988), ('brown', 217156),
  ('bucknell', 211291), ('caltech', 110404), ('cmu', 211440), ('cwru', 201645),
  ('colgate', 190099), ('columbia', 190150), ('cornell', 190415), ('dartmouth', 182670),
  ('hamilton', 191515), ('ithaca-college', 191968), ('jhu', 162928), ('lehigh', 213543),
  ('mit', 166683), ('nyu', 193900), ('northeastern', 167358), ('penn-state', 214777),
  ('rit', 195003), ('rutgers', 186380), ('stanford', 243744), ('stony-brook', 196097),
  ('swarthmore', 216287), ('syracuse', 196413), ('ohio-state', 204796), ('tufts', 168148),
  ('union', 196866), ('buffalo', 196088), ('uc-berkeley', 110635), ('umich', 170976),
  ('penn', 215062), ('pitt', 215293), ('rochester', 195030), ('ut-austin', 228778),
  ('uvm', 231174), ('uw-seattle', 236948), ('vassar', 197133), ('yale', 130794)
) as m(slug, unitid)
where c.slug = m.slug and c.unitid is null;

-- ---------------------------------------------------------------------------
-- college_stats
-- ---------------------------------------------------------------------------

create table if not exists public.college_stats (
  college_id              uuid primary key references public.colleges(id) on delete cascade,
  unitid                  integer not null unique,
  -- Admissions
  admit_rate              numeric(5,4) check (admit_rate between 0 and 1),
  open_admissions         boolean,
  -- IPEDS "test requirements": 1 required, 2 recommended, 3 neither, 5 considered not required.
  test_requirements       smallint check (test_requirements between 1 and 5),
  sat_ebrw_25             smallint check (sat_ebrw_25 between 200 and 800),
  sat_ebrw_75             smallint check (sat_ebrw_75 between 200 and 800),
  sat_math_25             smallint check (sat_math_25 between 200 and 800),
  sat_math_75             smallint check (sat_math_75 between 200 and 800),
  sat_total_25            smallint generated always as (sat_ebrw_25 + sat_math_25) stored,
  sat_total_75            smallint generated always as (sat_ebrw_75 + sat_math_75) stored,
  act_25                  smallint check (act_25 between 1 and 36),
  act_75                  smallint check (act_75 between 1 and 36),
  -- Size and shape
  undergrad_enrollment    integer check (undergrad_enrollment >= 0),
  control                 text check (control in ('public', 'private', 'private-for-profit')),
  predominant_degree      smallint check (predominant_degree between 0 and 4),
  -- IPEDS locale code (11 large city ... 43 remote rural).
  locale                  smallint,
  carnegie_size_setting   smallint,
  religious_affiliation   smallint,
  hbcu                    boolean not null default false,
  hsi                     boolean not null default false,
  tribal                  boolean not null default false,
  women_only              boolean not null default false,
  men_only                boolean not null default false,
  latitude                double precision check (latitude between -90 and 90),
  longitude               double precision check (longitude between -180 and 180),
  -- Cost (dollars, as published)
  cost_of_attendance      integer check (cost_of_attendance >= 0),
  tuition_in_state        integer check (tuition_in_state >= 0),
  tuition_out_of_state    integer check (tuition_out_of_state >= 0),
  avg_net_price           integer,
  -- {"0-30000": 8697, "30001-48000": 2991, "48001-75000": ..., "75001-110000": ..., "110001-plus": ...}
  net_price_by_income     jsonb not null default '{}'::jsonb,
  price_calculator_url    text,
  -- Aid and outcomes
  pell_rate               numeric(5,4) check (pell_rate between 0 and 1),
  federal_loan_rate       numeric(5,4) check (federal_loan_rate between 0 and 1),
  median_debt             integer check (median_debt >= 0),
  grad_rate               numeric(5,4) check (grad_rate between 0 and 1),
  median_earnings_10yr    integer check (median_earnings_10yr >= 0),
  -- Provenance
  data_year               text,
  provenance              text not null default 'sourced' check (provenance = 'sourced'),
  source_url              text not null,
  source_verified_at      timestamptz not null,
  updated_at              timestamptz not null default now()
);

create index if not exists college_stats_admit_idx on public.college_stats (admit_rate);
create index if not exists college_stats_net_price_idx on public.college_stats (avg_net_price);
create index if not exists college_stats_enrollment_idx on public.college_stats (undergrad_enrollment);

alter table public.college_stats enable row level security;
drop policy if exists college_stats_select on public.college_stats;
create policy college_stats_select on public.college_stats for select to authenticated using (true);
revoke all on public.college_stats from public, anon, authenticated;
grant select on public.college_stats to authenticated;

-- ---------------------------------------------------------------------------
-- college_fields_of_study
-- ---------------------------------------------------------------------------

create table if not exists public.college_fields_of_study (
  college_id         uuid not null references public.colleges(id) on delete cascade,
  -- 4-digit CIP family, e.g. '1107' Computer Science.
  cip_code           text not null check (cip_code ~ '^[0-9]{4}$'),
  title              text not null check (length(title) between 1 and 300),
  -- Scorecard credential level: 1 certificate, 2 associate, 3 bachelor's, 4 post-bacc
  -- certificate, 5 master's, 6 doctoral, 7 first professional, 8 graduate certificate.
  credential_level   smallint not null check (credential_level between 1 and 8),
  awards             integer check (awards >= 0),
  earnings_4yr       integer check (earnings_4yr >= 0),
  median_debt        integer check (median_debt >= 0),
  source_verified_at timestamptz not null,
  primary key (college_id, cip_code, credential_level)
);

create index if not exists college_fields_cip_idx on public.college_fields_of_study (cip_code, credential_level);
create index if not exists college_fields_title_idx on public.college_fields_of_study (lower(title));

alter table public.college_fields_of_study enable row level security;
drop policy if exists college_fields_select on public.college_fields_of_study;
create policy college_fields_select on public.college_fields_of_study for select to authenticated using (true);
revoke all on public.college_fields_of_study from public, anon, authenticated;
grant select on public.college_fields_of_study to authenticated;

-- ---------------------------------------------------------------------------
-- ingest_runs
-- ---------------------------------------------------------------------------

create table if not exists public.ingest_runs (
  id             uuid primary key default gen_random_uuid(),
  source         text not null check (source in ('scorecard', 'ipeds', 'resources-link-check')),
  trigger        text not null default 'manual' check (trigger in ('manual', 'cron', 'script')),
  status         text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  rows_upserted  integer not null default 0,
  rows_skipped   integer not null default 0,
  errors         jsonb not null default '[]'::jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer
);

create index if not exists ingest_runs_source_idx on public.ingest_runs (source, started_at desc);

-- Operational log: service_role only.
alter table public.ingest_runs enable row level security;
revoke all on public.ingest_runs from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- college_admission_factors (IPEDS Admissions survey, loaded yearly by
-- scripts/ingest/ipeds-admissions.ts). What each school says it weighs: the
-- same considerations as Common Data Set section C7, as IPEDS collects them.
-- ---------------------------------------------------------------------------

create table if not exists public.college_admission_factors (
  college_id          uuid primary key references public.colleges(id) on delete cascade,
  unitid              integer not null unique,
  -- The IPEDS collection year, e.g. '2023' (fall 2023 applicants).
  data_year           text not null check (data_year ~ '^[0-9]{4}$'),
  gpa                 text check (gpa in ('required', 'recommended', 'considered', 'not-considered')),
  class_rank          text check (class_rank in ('required', 'recommended', 'considered', 'not-considered')),
  record              text check (record in ('required', 'recommended', 'considered', 'not-considered')),
  college_prep        text check (college_prep in ('required', 'recommended', 'considered', 'not-considered')),
  recommendations     text check (recommendations in ('required', 'recommended', 'considered', 'not-considered')),
  competencies        text check (competencies in ('required', 'recommended', 'considered', 'not-considered')),
  test_scores         text check (test_scores in ('required', 'recommended', 'considered', 'not-considered')),
  english_proficiency text check (english_proficiency in ('required', 'recommended', 'considered', 'not-considered')),
  work_experience     text check (work_experience in ('required', 'recommended', 'considered', 'not-considered')),
  essay               text check (essay in ('required', 'recommended', 'considered', 'not-considered')),
  legacy              text check (legacy in ('required', 'recommended', 'considered', 'not-considered')),
  -- Derived from test_scores: required / optional (considered) / blind (not considered).
  test_policy         text check (test_policy in ('required', 'optional', 'blind', 'recommended')),
  provenance          text not null default 'sourced' check (provenance = 'sourced'),
  source_url          text not null,
  source_verified_at  timestamptz not null
);

create index if not exists college_admission_factors_test_idx on public.college_admission_factors (test_policy);

alter table public.college_admission_factors enable row level security;
drop policy if exists college_admission_factors_select on public.college_admission_factors;
create policy college_admission_factors_select on public.college_admission_factors
  for select to authenticated using (true);
revoke all on public.college_admission_factors from public, anon, authenticated;
grant select on public.college_admission_factors to authenticated;
