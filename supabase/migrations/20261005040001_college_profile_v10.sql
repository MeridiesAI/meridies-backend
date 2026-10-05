-- Colleges, v8-v10: what the demo's college profile, Compare and Build College
-- Lists read that the catalog did not hold yet.
--
--   colleges.aka                -- the names a school is also known by ("MIT"),
--                                  so search and research filing match on both
--   colleges.test_policy        -- gains 'flexible' (Yale's published policy)
--   college_profile_facts       -- the profile's sourced facts: overview, ranges,
--                                  graduation and retention, student life,
--                                  application requirements, net price by
--                                  income, popular majors. (The application
--                                  fee and supplement prompts are
--                                  student-application's: colleges.
--                                  application_fee_cents, college_supplements)
--   college_admitted_profiles   -- the admitted-student polygon. CURATED: its own
--                                  table, rating_kind pinned, so it can never be
--                                  read as one more reported statistic
--   college_list_profiles       -- what the seven Build College Lists filters and
--                                  the fit model read: coordinates, campus
--                                  setting, fields taught, rounded score
--                                  midpoints. ESTIMATED by construction
--   college_cds_editions        -- where the Common Data Set is published, by
--                                  edition
--   college_programs            -- combined (BS/MS, coterminal) and special
--                                  programs (UROP, Plan II) a counselor gets
--                                  asked about
--
-- All of it is catalog: SELECT for every signed-in user, written only by
-- service_role (the seed, or a curator). No client write path, same as the
-- rest of the catalog.

-- ---------------------------------------------------------------------------
-- colleges: aka, and the 'flexible' test policy
-- ---------------------------------------------------------------------------

alter table public.colleges
  add column if not exists aka text[] not null default '{}';

comment on column public.colleges.aka is
  'Short names the institution is also known by ("MIT", "UC Berkeley"). Student lists carry the colloquial name and the catalog the legal one, so lookups match on both.';

alter table public.colleges drop constraint if exists colleges_test_policy_check;
alter table public.colleges add constraint colleges_test_policy_check
  check (test_policy in ('required','optional','blind','recommended','flexible'));

create index if not exists colleges_aka_idx on public.colleges using gin (aka);

-- ---------------------------------------------------------------------------
-- Sourced profile facts
-- ---------------------------------------------------------------------------

create table if not exists public.college_profile_facts (
  college_id               uuid primary key references public.colleges(id) on delete cascade,
  address                  text check (length(address) <= 300),
  founded                  smallint check (founded between 1500 and 2100),
  campus_setting           text check (campus_setting in
                             ('Rural','Small city','Major city','Suburban','College town',
                              'City','Suburb','Town')),
  -- Editorial prose written by a person, never a generated summary.
  overview                 text check (length(overview) <= 4000),
  student_faculty_ratio    text check (length(student_faculty_ratio) <= 20),
  graduation_rate_4yr      numeric(5,2) check (graduation_rate_4yr between 0 and 100),
  graduation_rate_6yr      numeric(5,2) check (graduation_rate_6yr between 0 and 100),
  retention_rate           numeric(5,2) check (retention_rate between 0 and 100),
  room_and_board_cents     bigint check (room_and_board_cents >= 0),
  sat_range                text check (length(sat_range) <= 30),
  act_range                text check (length(act_range) <= 30),
  gpa_range                text check (length(gpa_range) <= 30),
  common_app               boolean,
  popular_majors           text[] not null default '{}',
  -- { undergrads, totalStudents, fullTimeUndergradPct, retentionPct,
  --   gender: { femalePct, malePct }, ethnicity: [{ group, pct }], source }
  student_life             jsonb,
  -- { essay, testing, subjectTests, interview: 'Required'|'Optional'|
  --   'Conditional'|'Not accepted', note }
  admission_requirements   jsonb,
  -- [{ band, priceCents }] in band order
  net_price_by_income      jsonb not null default '[]'::jsonb,
  -- Where these figures come from, in the words the profile shows behind its
  -- InfoTip ("Common Data Set 2024-25 and IPEDS ...").
  source_note              text check (length(source_note) <= 500),
  provenance               public.data_provenance,
  source_url               text,
  source_verified_at       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

drop trigger if exists college_profile_facts_set_updated_at on public.college_profile_facts;
create trigger college_profile_facts_set_updated_at before update on public.college_profile_facts
  for each row execute function public.set_updated_at();

comment on table public.college_profile_facts is
  'Sourced institutional facts for the college profile and Compare. Nothing here is a Meridies judgement; curated material lives in college_admitted_profiles and college_aid_ratings.';

alter table public.college_profile_facts enable row level security;
drop policy if exists college_profile_facts_select on public.college_profile_facts;
create policy college_profile_facts_select on public.college_profile_facts
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- The admitted-student polygon (curated)
-- ---------------------------------------------------------------------------

create table if not exists public.college_admitted_profiles (
  college_id    uuid primary key references public.colleges(id) on delete cascade,
  -- [{ label, value }] on the same axes as a student's own polygon, so the two
  -- can be laid over each other.
  axes          jsonb not null check (jsonb_typeof(axes) = 'array'),
  rating_kind   text not null default 'meridies-curated'
                check (rating_kind = 'meridies-curated'),
  note          text check (length(note) <= 1000),
  rated_by      uuid references public.profiles(id) on delete set null,
  rated_at      timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists college_admitted_profiles_set_updated_at on public.college_admitted_profiles;
create trigger college_admitted_profiles_set_updated_at before update on public.college_admitted_profiles
  for each row execute function public.set_updated_at();

comment on table public.college_admitted_profiles is
  'A curated Meridies shape of admitted applicants. Proprietary, not a federal statistic and not a prediction of any individual outcome; rating_kind is pinned so it cannot claim otherwise.';

alter table public.college_admitted_profiles enable row level security;
drop policy if exists college_admitted_profiles_select on public.college_admitted_profiles;
create policy college_admitted_profiles_select on public.college_admitted_profiles
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Build College Lists: the filter and fit inputs (estimated)
-- ---------------------------------------------------------------------------

create table if not exists public.college_list_profiles (
  college_id          uuid primary key references public.colleges(id) on delete cascade,
  latitude            numeric(8,5) not null check (latitude between -90 and 90),
  longitude           numeric(8,5) not null check (longitude between -180 and 180),
  campus_setting      text check (campus_setting in
                        ('Rural','Small city','Major city','Suburban','College town')),
  -- The broad fields a major has to fall in for the Majors filter to keep the
  -- school.
  field_areas         text[] not null default '{}' check (field_areas <@ array[
                        'Engineering','Computer Science','Mathematics','Sciences','Nursing',
                        'Public Health','Business','Economics','Humanities','Arts']::text[]),
  -- Rounded midpoints the fit model reads; never shown as the school's figure.
  sat_mid             smallint check (sat_mid between 400 and 1600),
  gpa_mid             numeric(3,2) check (gpa_mid between 0 and 5),
  -- Share of undergraduates in the largest single racial or ethnic group: the
  -- Diversity filter's input.
  largest_group_pct   numeric(5,2) check (largest_group_pct between 0 and 100),
  provenance          public.data_provenance default 'estimated',
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists college_list_profiles_set_updated_at on public.college_list_profiles;
create trigger college_list_profiles_set_updated_at before update on public.college_list_profiles
  for each row execute function public.set_updated_at();

comment on table public.college_list_profiles is
  'What Build College Lists filters and models fit on. Rounded, derived values (provenance estimated): inputs to a sort, never displayed as the institution''s published figure.';

alter table public.college_list_profiles enable row level security;
drop policy if exists college_list_profiles_select on public.college_list_profiles;
create policy college_list_profiles_select on public.college_list_profiles
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Common Data Set editions
-- ---------------------------------------------------------------------------

create table if not exists public.college_cds_editions (
  college_id          uuid not null references public.colleges(id) on delete cascade,
  -- "2025-26"
  edition             text not null check (edition ~ '^\d{4}[–-]\d{2}$'),
  url                 text not null check (url ~ '^https://'),
  -- "Jun 2026", as the school's release is known; free text because schools
  -- publish on no fixed date.
  released_label      text check (length(released_label) <= 40),
  checked_at          date,
  provenance          public.data_provenance,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (college_id, edition)
);

drop trigger if exists college_cds_editions_set_updated_at on public.college_cds_editions;
create trigger college_cds_editions_set_updated_at before update on public.college_cds_editions
  for each row execute function public.set_updated_at();

alter table public.college_cds_editions enable row level security;
drop policy if exists college_cds_editions_select on public.college_cds_editions;
create policy college_cds_editions_select on public.college_cds_editions
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Combined and special programs
-- ---------------------------------------------------------------------------

create table if not exists public.college_programs (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid not null references public.colleges(id) on delete cascade,
  kind                text not null check (kind in ('combined','special')),
  name                text not null check (length(btrim(name)) between 1 and 300),
  sort_order          integer not null default 0,
  provenance          public.data_provenance default 'curated',
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists college_programs_unique
  on public.college_programs (college_id, kind, lower(name));
create index if not exists college_programs_college_idx
  on public.college_programs (college_id, kind, sort_order);

drop trigger if exists college_programs_set_updated_at on public.college_programs;
create trigger college_programs_set_updated_at before update on public.college_programs
  for each row execute function public.set_updated_at();

alter table public.college_programs enable row level security;
drop policy if exists college_programs_select on public.college_programs;
create policy college_programs_select on public.college_programs
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Grants: catalog reads for signed-in users, writes for service_role only.
-- ---------------------------------------------------------------------------

revoke all on public.college_profile_facts, public.college_admitted_profiles,
  public.college_list_profiles, public.college_cds_editions, public.college_programs
  from anon, authenticated;
grant select on public.college_profile_facts, public.college_admitted_profiles,
  public.college_list_profiles, public.college_cds_editions, public.college_programs
  to authenticated;
grant all on public.college_profile_facts, public.college_admitted_profiles,
  public.college_list_profiles, public.college_cds_editions, public.college_programs
  to service_role;
