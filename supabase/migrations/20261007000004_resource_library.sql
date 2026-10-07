-- The resource library, and the curated per-school datasets it points to
-- (BACKEND_TODO §4).
--
-- Two kinds of source:
--   - Reference sites (College Board, BigFuture, FairTest, Common App, FSA...)
--     are rows in `library_resources` (the older, unused `resources` table from
--     20260828000011 is left alone): a link with our own description, dates, audience
--     and state scope. Sites whose terms forbid scraping (Chegg, CollegeXpress,
--     BigFuture, LinkedIn) are links only, never fetched for content; the
--     weekly link check only asks whether the page still answers.
--   - Structured facts go on the school they describe: `college_policies`
--     (superscore, self-reported scores, CSS Profile, STARS, FairTest status),
--     `college_application_requirements` (per cycle, from the Common App grid,
--     the UC application and Cal State Apply) and `college_major_admit_rates`
--     (UC and CSU by major and campus, SJSU's eligibility index). These are
--     curated: every field carries where it came from and when it was checked,
--     and they are loaded by scripts/ingest/curated-csv.ts, never invented.

-- ---------------------------------------------------------------------------
-- library_resources
-- ---------------------------------------------------------------------------

create table if not exists public.library_resources (
  id                 uuid primary key default gen_random_uuid(),
  category           text not null check (category in ('testing', 'research', 'applications', 'aid')),
  title              text not null check (length(btrim(title)) between 1 and 200),
  url                text not null check (url ~ '^https?://' and length(url) <= 2000),
  description        text not null default '' check (length(description) <= 1200),
  -- The current cycle's window, e.g. Common App opens 2026-08-01.
  opens_on           date,
  closes_on          date,
  cycle              text check (cycle is null or cycle ~ '^[0-9]{4}-[0-9]{2}$'),
  audience           text not null default 'both' check (audience in ('counselor', 'student', 'both')),
  -- Two-letter state the resource applies to (CA for Cal Grant); null = everywhere.
  state_scope        text check (state_scope is null or state_scope ~ '^[A-Z]{2}$'),
  -- Links only: never fetched for content (the site's terms forbid scraping).
  link_only          boolean not null default false,
  -- Null owner = the Meridies library; otherwise a practice's own resource.
  firm_id            uuid references public.firms(id) on delete cascade,
  counselor_id       uuid references public.profiles(id) on delete cascade,
  link_status        text not null default 'unknown' check (link_status in ('ok', 'broken', 'blocked', 'unknown')),
  last_status_code   integer,
  last_checked_at    timestamptz,
  source_verified_at timestamptz,
  created_by         uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint library_resources_window check (closes_on is null or opens_on is null or closes_on >= opens_on),
  -- A practice row has its counselor; a firm row also its firm.
  constraint library_resources_owner check (firm_id is null or counselor_id is not null)
);

create index if not exists library_resources_category_idx on public.library_resources (category);
create index if not exists library_resources_owner_idx on public.library_resources (counselor_id, firm_id);
create unique index if not exists library_resources_library_url_key on public.library_resources (url) where counselor_id is null;

drop trigger if exists library_resources_set_updated_at on public.library_resources;
create trigger library_resources_set_updated_at before update on public.library_resources
  for each row execute function public.set_updated_at();

alter table public.library_resources enable row level security;

drop policy if exists library_resources_select on public.library_resources;
create policy library_resources_select on public.library_resources
  for select to authenticated
  using (
    -- The library: counselors see all of it; students what is meant for them.
    (counselor_id is null and (private.is_counselor((select auth.uid())) or audience in ('student', 'both')))
    -- A practice's own rows: its consultants.
    or (counselor_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  );

drop policy if exists library_resources_insert on public.library_resources;
create policy library_resources_insert on public.library_resources
  for insert to authenticated
  with check (
    counselor_id is not null
    and private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid()))
  );

drop policy if exists library_resources_update on public.library_resources;
create policy library_resources_update on public.library_resources
  for update to authenticated
  using (counselor_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (counselor_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists library_resources_delete on public.library_resources;
create policy library_resources_delete on public.library_resources
  for delete to authenticated
  using (counselor_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

revoke all on public.library_resources from public, anon, authenticated;
grant select, insert, delete on public.library_resources to authenticated;
grant update (category, title, url, description, opens_on, closes_on, cycle, audience, state_scope)
  on public.library_resources to authenticated;

-- ---------------------------------------------------------------------------
-- library_resource_pins: a resource pinned to a student, or to a college for a practice
-- ---------------------------------------------------------------------------

create table if not exists public.library_resource_pins (
  id            uuid primary key default gen_random_uuid(),
  resource_id   uuid not null references public.library_resources(id) on delete cascade,
  student_id    uuid references public.profiles(id) on delete cascade,
  college_id    uuid references public.colleges(id) on delete cascade,
  -- College pins belong to a practice, like the pipeline.
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  note          text check (note is null or length(note) <= 500),
  created_at    timestamptz not null default now(),
  constraint library_resource_pins_target check ((student_id is null) <> (college_id is null))
);

create unique index if not exists library_resource_pins_student_key
  on public.library_resource_pins (resource_id, student_id) where student_id is not null;
create unique index if not exists library_resource_pins_college_key
  on public.library_resource_pins (resource_id, college_id, counselor_id) where college_id is not null;
create index if not exists library_resource_pins_student_idx on public.library_resource_pins (student_id);
create index if not exists library_resource_pins_college_idx on public.library_resource_pins (college_id);

alter table public.library_resource_pins enable row level security;

drop policy if exists library_resource_pins_select on public.library_resource_pins;
create policy library_resource_pins_select on public.library_resource_pins
  for select to authenticated
  using (
    (student_id is not null and private.can_view_student(student_id, (select auth.uid())))
    or (college_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  );

drop policy if exists library_resource_pins_insert on public.library_resource_pins;
create policy library_resource_pins_insert on public.library_resource_pins
  for insert to authenticated
  with check (
    private.is_counselor((select auth.uid()))
    and counselor_id = (select auth.uid())
    and (
      (student_id is not null and private.can_edit_student(student_id, (select auth.uid())))
      or (college_id is not null and firm_id is not distinct from private.crm_workspace_firm((select auth.uid())))
    )
  );

drop policy if exists library_resource_pins_delete on public.library_resource_pins;
create policy library_resource_pins_delete on public.library_resource_pins
  for delete to authenticated
  using (
    private.is_counselor((select auth.uid()))
    and (
      (student_id is not null and private.can_edit_student(student_id, (select auth.uid())))
      or (college_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
    )
  );

revoke all on public.library_resource_pins from public, anon, authenticated;
grant select, insert, delete on public.library_resource_pins to authenticated;

-- ---------------------------------------------------------------------------
-- college_policies (curated, one row per school)
-- ---------------------------------------------------------------------------

create table if not exists public.college_policies (
  college_id            uuid primary key references public.colleges(id) on delete cascade,
  -- Which tests the school superscores.
  superscore            text check (superscore in ('sat', 'act', 'both', 'none')),
  -- Accepts self-reported scores at application (official scores on enrolling).
  self_report_scores    boolean,
  css_profile_required  boolean,
  -- Requires a STARS record (Self-Reported Transcript and Academic Record System, formerly SRAR/SSAR).
  stars_required        boolean,
  -- FairTest's reading: required, optional, blind, or flexible.
  fairtest_status       text check (fairtest_status in ('required', 'optional', 'blind', 'flexible')),
  -- {"superscore": {"url": "...", "checkedAt": "2026-10-07"}, "css_profile_required": {...}}
  sources               jsonb not null default '{}'::jsonb,
  provenance            text not null default 'curated' check (provenance = 'curated'),
  updated_at            timestamptz not null default now()
);

create index if not exists college_policies_superscore_idx on public.college_policies (superscore);

alter table public.college_policies enable row level security;
drop policy if exists college_policies_select on public.college_policies;
create policy college_policies_select on public.college_policies for select to authenticated using (true);
revoke all on public.college_policies from public, anon, authenticated;
grant select on public.college_policies to authenticated;

-- ---------------------------------------------------------------------------
-- college_application_requirements (curated, per school per cycle)
-- ---------------------------------------------------------------------------

create table if not exists public.college_application_requirements (
  college_id               uuid not null references public.colleges(id) on delete cascade,
  cycle                    text not null check (cycle ~ '^[0-9]{4}-[0-9]{2}$'),
  platforms                text[] not null default '{}'
                             check (platforms <@ array['common-app', 'coalition', 'uc', 'cal-state-apply', 'applytexas', 'institution']),
  application_fee_cents    integer check (application_fee_cents between 0 and 100000),
  fee_waiver               boolean,
  personal_essay_required  boolean,
  supplement_count         smallint check (supplement_count between 0 and 30),
  teacher_recs             smallint check (teacher_recs between 0 and 5),
  counselor_rec            boolean,
  testing                  text check (testing in ('required', 'optional', 'blind', 'flexible')),
  portfolio                text check (portfolio in ('required', 'optional', 'some-programs')),
  stars_required           boolean,
  source_url               text not null,
  source_verified_at       timestamptz not null,
  primary key (college_id, cycle)
);

alter table public.college_application_requirements enable row level security;
drop policy if exists college_app_requirements_select on public.college_application_requirements;
create policy college_app_requirements_select on public.college_application_requirements
  for select to authenticated using (true);
revoke all on public.college_application_requirements from public, anon, authenticated;
grant select on public.college_application_requirements to authenticated;

-- ---------------------------------------------------------------------------
-- college_major_admit_rates (UC by discipline and campus, CSU by major,
-- SJSU's eligibility index), one row per school/major/cycle/residency
-- ---------------------------------------------------------------------------

create table if not exists public.college_major_admit_rates (
  id                 uuid primary key default gen_random_uuid(),
  college_id         uuid not null references public.colleges(id) on delete cascade,
  system             text not null check (system in ('uc', 'csu', 'other')),
  major              text not null check (length(btrim(major)) between 1 and 200),
  cip_code           text check (cip_code ~ '^[0-9]{4}$'),
  -- Fall entry year, e.g. 2025.
  entry_year         smallint not null check (entry_year between 2000 and 2100),
  residency          text not null default 'all' check (residency in ('all', 'in-state', 'out-of-state', 'international')),
  applicants         integer check (applicants >= 0),
  admits             integer check (admits >= 0),
  admit_rate         numeric(5,4) check (admit_rate between 0 and 1),
  impacted           boolean,
  -- UC: the major is open to new applicants this cycle.
  open_major         boolean,
  -- SJSU (and other CSUs that publish one): the minimum eligibility index.
  eligibility_index  numeric(7,2),
  source_url         text not null,
  source_verified_at timestamptz not null,
  constraint major_admit_counts check (admits is null or applicants is null or admits <= applicants)
);

create unique index if not exists college_major_admit_rates_key
  on public.college_major_admit_rates (college_id, lower(major), entry_year, residency);
create index if not exists college_major_admit_rates_cip_idx on public.college_major_admit_rates (cip_code);

alter table public.college_major_admit_rates enable row level security;
drop policy if exists college_major_admit_rates_select on public.college_major_admit_rates;
create policy college_major_admit_rates_select on public.college_major_admit_rates
  for select to authenticated using (true);
revoke all on public.college_major_admit_rates from public, anon, authenticated;
grant select on public.college_major_admit_rates to authenticated;

-- ---------------------------------------------------------------------------
-- The Meridies library: the competitor's list, our own descriptions.
-- Dates are the 2026-27 cycle (fall 2027 entry), checked 10/7/2026.
-- ---------------------------------------------------------------------------

insert into public.library_resources (category, title, url, description, opens_on, closes_on, cycle, audience, state_scope, link_only)
values
  ('testing', 'College Board (SAT, AP, PSAT)', 'https://www.collegeboard.org',
   'Register for the SAT, send scores, and look up AP results. Score sends and fee waivers start here.', null, null, null, 'both', null, false),
  ('testing', 'ACT', 'https://www.act.org',
   'Register for the ACT, send scores and see test dates. Some schools superscore the ACT; check each school''s policy.', null, null, null, 'both', null, false),
  ('testing', 'FairTest test-optional list', 'https://fairtest.org/test-optional-list/',
   'FairTest''s running list of test-optional and test-free schools. Cross-check a school''s own admissions page before advising.', null, null, null, 'counselor', null, false),
  ('research', 'BigFuture', 'https://bigfuture.collegeboard.org',
   'College Board''s college search and career explorer. Useful for students browsing on their own.', null, null, null, 'student', null, true),
  ('research', 'LinkedIn', 'https://www.linkedin.com',
   'Look up where graduates of a program work. Links only: Meridies never reads LinkedIn for you.', null, null, null, 'counselor', null, true),
  ('research', 'Challenge Success: A "Fit" Over Rankings', 'https://ed.stanford.edu/sites/default/files/challenge_success_white_paper_on_college_admissions_10.1.2018-reduced.pdf',
   'Stanford-affiliated white paper (2018): engagement in college predicts outcomes better than selectivity. Good for the rankings conversation with families.', null, null, null, 'both', null, false),
  ('research', 'UC majors', 'https://admission.universityofcalifornia.edu/campuses-majors/majors/',
   'Every major at each UC campus, with links to the department.', null, null, null, 'both', 'CA', false),
  ('research', 'UC admissions by campus and residency', 'https://www.universityofcalifornia.edu/about-us/information-center/admissions-residency-and-ethnicity',
   'UC Information Center tables: applicants, admits and enrollees by campus, residency and discipline.', null, null, null, 'counselor', 'CA', false),
  ('research', 'CSU degrees', 'https://www.calstate.edu/attend/degrees-certificates-credentials',
   'Search every Cal State degree program by campus.', null, null, null, 'both', 'CA', false),
  ('research', 'CSU impacted programs', 'https://www.calstate.edu/attend/degrees-certificates-credentials/Pages/impacted-degrees.aspx',
   'Which Cal State majors and campuses are impacted (more qualified applicants than space) and so hold higher criteria.', null, null, null, 'counselor', 'CA', false),
  ('research', 'SJSU impaction and eligibility', 'https://www.sjsu.edu/admissions/impaction/index.php',
   'San José State''s impacted majors and the eligibility index each one needs.', null, null, null, 'counselor', 'CA', false),
  ('research', 'CollegeXpress', 'https://www.collegexpress.com',
   'College lists and scholarship search. Links only.', null, null, null, 'student', null, true),
  ('applications', 'Common App', 'https://www.commonapp.org',
   'The shared application for 1,000+ colleges. The new cycle''s application opens August 1.', '2026-08-01', null, '2026-27', 'both', null, false),
  ('applications', 'UC application', 'https://apply.universityofcalifornia.edu',
   'One application for all nine UC undergraduate campuses. Opens August 1; submit October 1 to November 30.', '2026-08-01', '2026-11-30', '2026-27', 'both', 'CA', false),
  ('applications', 'Cal State Apply', 'https://www.calstate.edu/apply',
   'One application for the 23 Cal State campuses. Filing opens October 1; deadlines vary by campus.', '2026-10-01', null, '2026-27', 'both', 'CA', false),
  ('applications', 'STARS (Self-Reported Transcript and Academic Record System)', 'https://www.selfreportedtranscript.com',
   'The self-reported transcript some public universities require in place of an official one at application. Formerly SRAR/SSAR. Complete once, share with each school that asks.', null, null, null, 'both', null, false),
  ('aid', 'Federal Student Aid (FAFSA)', 'https://studentaid.gov/h/apply-for-aid/fafsa',
   'The FAFSA for 2027-28 opens October 1, 2026. Needed for federal aid and most state and college aid.', '2026-10-01', null, '2026-27', 'both', null, false),
  ('aid', 'Federal Student Aid Estimator', 'https://studentaid.gov/aid-estimator/',
   'Estimates the Student Aid Index and Pell eligibility before the FAFSA is filed.', null, null, null, 'both', null, false),
  ('aid', 'CSS Profile', 'https://cssprofile.collegeboard.org',
   'College Board''s aid application that many private colleges require alongside the FAFSA for their own grants.', '2026-10-01', null, '2026-27', 'both', null, false),
  ('aid', 'CSAC: Cal Grant', 'https://www.csac.ca.gov/cal-grants',
   'California''s grant for in-state students. File the FAFSA or CA Dream Act application and a verified GPA by March 2, 2027.', '2026-10-01', '2027-03-02', '2026-27', 'both', 'CA', false),
  ('aid', 'California Dream Act application', 'https://dream.csac.ca.gov',
   'State aid for undocumented students, TPS and U visa holders in California. Opens October 1; Cal Grant deadline March 2, 2027. File this or the FAFSA, not both.', '2026-10-01', '2027-03-02', '2026-27', 'both', 'CA', false),
  ('aid', 'FinAid', 'https://finaid.org',
   'Long-running guide to financial aid, loans and calculators.', null, null, null, 'both', null, false),
  ('aid', 'Chegg scholarships', 'https://www.chegg.com/scholarships',
   'A large scholarship search. Links only.', null, null, null, 'student', null, true)
on conflict (url) where counselor_id is null do nothing;

-- ---------------------------------------------------------------------------
-- search_colleges gains the curated policy filters: superscore, CSS Profile,
-- STARS. Same function as 20261007000003 otherwise.
-- ---------------------------------------------------------------------------

create or replace function public.search_colleges(
  p_q text default '',
  p_filters jsonb default '{}'::jsonb,
  p_sort text default null,
  p_limit integer default 48,
  p_offset integer default 0
)
returns table (
  college_id uuid,
  match_tier smallint,
  score real,
  odds numeric,
  fit text,
  miles numeric,
  total_count bigint
)
language plpgsql
volatile
security invoker
set search_path to 'public', 'extensions', 'private', 'pg_temp'
as $$
#variable_conflict use_column
begin
  -- The typo tier's thresholds, for this transaction only. (A function's own
  -- SET clause can't name a pg_trgm setting without superuser.)
  perform set_config('pg_trgm.similarity_threshold', '0.3', true);
  perform set_config('pg_trgm.word_similarity_threshold', '0.5', true);

  return query
with params as (
  select
    private.search_norm(left(coalesce(p_q, ''), 120)) as q,
    coalesce(p_filters, '{}'::jsonb) as f,
    greatest(1, least(coalesce(p_limit, 48), 100)) as lim,
    greatest(0, least(coalesce(p_offset, 0), 10000)) as off
),
qp as (
  select p.*,
    -- "uc berk" -> 'uc:* & berk:*' (every word, as a prefix)
    case when p.q = '' then null
         else to_tsquery('simple', array_to_string(array(
           select quote_literal(w) || ':*' from unnest(string_to_array(p.q, ' ')) w where w <> ''
         ), ' & ')) end as tsq,
    (p.f->'student'->>'sat')::numeric as student_sat,
    (p.f->'student'->>'gpa')::numeric as student_gpa,
    (p.f->'near'->>'lat')::float8 as near_lat,
    (p.f->'near'->>'lng')::float8 as near_lng,
    (p.f->'near'->>'miles')::float8 as near_miles,
    coalesce(p.f->'netPrice'->>'band', '') as band
  from params p
),
-- Schools with a bachelor's program whose title has every query word as a
-- prefix ("comp sci" -> Computer Science), found once through the GIN index.
major_hits as (
  select distinct fs.college_id
  from public.college_fields_of_study fs, qp
  where qp.tsq is not null and length(qp.q) >= 4
    and fs.credential_level = 3 and fs.search_title @@ qp.tsq
),
-- With a query, candidates come through the indexes, one branch each, and
-- only they are ranked below. Every tier's condition implies a branch:
-- prefixes and word prefixes are tsquery prefix matches, typos are trigram
-- or word-similarity matches, majors are major_hits.
candidates as (
  select c.id from public.colleges c, qp where qp.q <> '' and c.search_doc @@ qp.tsq
  union select c.id from public.colleges c, qp where qp.q <> '' and c.search_name % qp.q
  union select c.id from public.colleges c, qp where qp.q <> '' and qp.q <% c.search_name
  union select c.id from public.colleges c, qp where qp.q <> '' and qp.q <% c.search_aka
  union select college_id from major_hits
),
base as (
  select
    c.id,
    c.name,
    c.search_name,
    c.search_aka,
    c.search_aka_list,
    c.search_doc,
    c.state,
    coalesce(fa.test_policy, c.test_policy) as test_policy,
    coalesce(s.admit_rate, c.acceptance_rate) as admit_rate,
    coalesce(s.undergrad_enrollment, c.size) as enrollment,
    coalesce(s.control, c.control) as control,
    s.locale,
    s.hbcu, s.hsi, s.women_only, s.religious_affiliation,
    coalesce(s.latitude, lp.latitude) as lat,
    coalesce(s.longitude, lp.longitude) as lng,
    case when s.sat_total_25 is not null and s.sat_total_75 is not null
         then (s.sat_total_25 + s.sat_total_75) / 2.0 else lp.sat_mid end as sat_mid,
    lp.gpa_mid,
    s.avg_net_price,
    s.net_price_by_income,
    pol.superscore,
    pol.css_profile_required,
    pol.stars_required
  from public.colleges c
  cross join qp
  left join public.college_stats s on s.college_id = c.id
  left join public.college_list_profiles lp on lp.college_id = c.id
  left join public.college_admission_factors fa on fa.college_id = c.id
  left join public.college_policies pol on pol.college_id = c.id
  where qp.q = '' or c.id in (select id from candidates)
),
matched as (
  select b.*,
    case
      when qp.q = '' then 6
      when b.search_name = qp.q or qp.q = any(b.search_aka_list) then 0
      when b.search_name like qp.q || '%' or exists (select 1 from unnest(b.search_aka_list) a where a like qp.q || '%') then 1
      -- q is letters, digits and single spaces (search_norm), so it is safe in a regex.
      when b.search_name ~ ('\m' || qp.q) or b.search_aka ~ ('\m' || qp.q) then 2
      -- Typos ("berkly"): the query against the best-matching words of the name.
      when length(qp.q) >= 3 and (
        word_similarity(qp.q, b.search_name) >= 0.5 or word_similarity(qp.q, b.search_aka) >= 0.5
        or similarity(b.search_name, qp.q) >= 0.3) then 3
      when b.search_doc @@ qp.tsq then 4
      when b.id in (select college_id from major_hits) then 5
      else null
    end::smallint as tier,
    case when qp.q = '' then 0
         -- The whole-name match leads and the best word match adds to it, so
         -- "univ of michgan" puts the University of Michigan above schools
         -- that only share the word "michigan" (taking the single best signal
         -- let Michigan Tech's alias win).
         else greatest(similarity(b.search_name, qp.q), similarity(b.search_aka, qp.q))
              + 0.5 * greatest(word_similarity(qp.q, b.search_name), word_similarity(qp.q, b.search_aka)) end::real as sim,
    case when qp.near_lat is null or b.lat is null then null
         else 3959 * 2 * asin(sqrt(
           power(sin(radians(b.lat - qp.near_lat) / 2), 2) +
           cos(radians(qp.near_lat)) * cos(radians(b.lat)) * power(sin(radians(b.lng - qp.near_lng) / 2), 2)
         )) end as dist,
    -- lib/collegesV10.ts studentOdds, the same formula: the admit rate, lifted
    -- or lowered by the student's SAT and GPA against the school's middle.
    case when b.admit_rate is null or (qp.student_sat is null and qp.student_gpa is null) then null
         else greatest(0.5, least(94, (b.admit_rate * 100) * exp(
           0.35 * coalesce((qp.student_sat - b.sat_mid) / 80, 0) +
           0.35 * coalesce((qp.student_gpa - b.gpa_mid) / 0.2, 0)
         ))) end as est_odds,
    case when b.net_price_by_income ? qp.band then (b.net_price_by_income->>qp.band)::numeric
         else b.avg_net_price end as net_price
  from base b cross join qp
),
fitted as (
  select m.*,
    case when (select student_sat from qp) is null and (select student_gpa from qp) is null then null
         when m.est_odds is null or coalesce(m.admit_rate, 0) < 0.15 or m.est_odds < 35 then 'reach'
         when m.est_odds < 70 then 'target'
         else 'likely' end as est_fit
  from matched m
),
filtered as (
  select fi.* from fitted fi cross join qp
  where fi.tier is not null
    and (not (qp.f ? 'states') or fi.state = any(array(select jsonb_array_elements_text(qp.f->'states'))))
    and (qp.near_lat is null or (fi.dist is not null and fi.dist <= coalesce(qp.near_miles, 100)))
    and (not (qp.f ? 'enrollment') or (
          fi.enrollment is not null
          and fi.enrollment >= coalesce((qp.f->'enrollment'->>'min')::int, 0)
          and fi.enrollment <= coalesce((qp.f->'enrollment'->>'max')::int, 2147483647)))
    and (not (qp.f ? 'control') or fi.control = any(array(select jsonb_array_elements_text(qp.f->'control'))))
    and (not (qp.f ? 'admitRate') or (
          fi.admit_rate is not null
          and fi.admit_rate >= coalesce((qp.f->'admitRate'->>'min')::numeric, 0)
          and fi.admit_rate <= coalesce((qp.f->'admitRate'->>'max')::numeric, 1)))
    and (not (qp.f ? 'testPolicy') or fi.test_policy = any(array(select jsonb_array_elements_text(qp.f->'testPolicy'))))
    and (not (qp.f ? 'netPrice') or (fi.net_price is not null and fi.net_price <= (qp.f->'netPrice'->>'max')::numeric))
    and (not (qp.f ? 'majors') or exists (
          select 1 from public.college_fields_of_study fs, jsonb_array_elements_text(qp.f->'majors') want
          where fs.college_id = fi.id and fs.credential_level = 3
            and (fs.cip_code = want or lower(fs.title) like '%' || private.search_norm(want) || '%')))
    and (coalesce((qp.f->>'hbcu')::boolean, false) = false or fi.hbcu)
    and (coalesce((qp.f->>'hsi')::boolean, false) = false or fi.hsi)
    and (coalesce((qp.f->>'womenOnly')::boolean, false) = false or fi.women_only)
    and (coalesce((qp.f->>'religious')::boolean, false) = false or (fi.religious_affiliation is not null and fi.religious_affiliation > 0))
    and (not (qp.f ? 'setting') or (fi.locale / 10) = any(array(
          select case s when 'city' then 1 when 'suburb' then 2 when 'town' then 3 when 'rural' then 4 end
          from jsonb_array_elements_text(qp.f->'setting') s)))
    and (not (qp.f ? 'fit') or fi.est_fit = any(array(select jsonb_array_elements_text(qp.f->'fit'))))
    -- Curated policies (college_policies): a school with no answer on file doesn't pass.
    and (not (qp.f ? 'superscore') or fi.superscore = any(array(select jsonb_array_elements_text(qp.f->'superscore'))))
    and (not (qp.f ? 'cssProfile') or fi.css_profile_required = (qp.f->>'cssProfile')::boolean)
    and (not (qp.f ? 'stars') or fi.stars_required = (qp.f->>'stars')::boolean)
)
select
  fl.id, fl.tier, fl.sim, round(fl.est_odds, 1), fl.est_fit, round(fl.dist::numeric, 1),
  count(*) over ()
from filtered fl cross join qp
order by
  case when coalesce(p_sort, case when qp.q = '' then 'name' else 'relevance' end) = 'relevance' then fl.tier end,
  case when coalesce(p_sort, case when qp.q = '' then 'name' else 'relevance' end) = 'relevance' then fl.sim end desc,
  case when p_sort = 'admit-rate' then fl.admit_rate end asc nulls last,
  case when p_sort = 'net-price' then fl.net_price end asc nulls last,
  case when p_sort = 'enrollment' then fl.enrollment end desc nulls last,
  case when p_sort = 'distance' then fl.dist end asc nulls last,
  fl.name
limit (select lim from qp) offset (select off from qp);
end;
$$;

