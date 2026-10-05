-- v10 sync, student-aid-comms (2 of 3): the Financial aid page (demo v8-v10).
--
-- 1. FAFSA, reconciled. v4 asked for FAFSA status and a per-school FAFSA
--    column; v5 deleted both ("potential privacy and data leaks would be
--    catastrophic and the data isn't needed by counselors"); v8's Financial aid
--    sketch brings back exactly two facts: the FAFSA's status (not started, in
--    progress, submitted) and its due date. Nothing from inside the form, no
--    per-school FAFSA row, and no Social Security number anywhere.
--    - fafsa_status narrows to the three v8 values. 'verified' was a submitted
--      form; 'corrections-needed' is one still being worked on;
--      'not-applicable' had no v8 equivalent and reads as not started.
--    - fafsa_submitted_at goes (a fact from the filing, not its status), and so
--      does efc_estimate: the EFC is a figure computed from the form, retired
--      in 2024-25. The SAI stays — it is the one number the aid conversation
--      turns on, and it is held without naming the form it came from.
--    - each form gets a due date the counselor may set; left empty, the page
--      derives it from the earliest priority aid deadline on the list.
--    - the per-school checklist loses its 'fafsa' item; existing rows go.
--    School-level aid *policy* ("FAFSA only") is published by the school and
--    stays in college_aid_profiles.aid_methodology.
--
-- 2. The detailed report's family financials (v8): parent AGI and the four
--    circumstances that change an offer, each with a way to decline.
--
-- 3. Scholarship matching (v8): the counselor's answers per student, and the
--    catalog fields the questions filter on — whether an application asks for
--    an essay, and the family circumstance an award is reserved for. The six
--    v8 awards gated on a circumstance are added from the demo's catalog, each
--    a real, published program with its source URL.

-- ---------------------------------------------------------------------------
-- 1. FAFSA: status and due date only
-- ---------------------------------------------------------------------------

alter table public.student_aid_profiles drop constraint if exists student_aid_profiles_fafsa_status_check;

update public.student_aid_profiles set fafsa_status = case fafsa_status
    when 'verified' then 'submitted'
    when 'corrections-needed' then 'in-progress'
    when 'not-applicable' then 'not-started'
    else fafsa_status
  end
where fafsa_status not in ('not-started','in-progress','submitted');

alter table public.student_aid_profiles add constraint student_aid_profiles_fafsa_status_check
  check (fafsa_status in ('not-started','in-progress','submitted'));

alter table public.student_aid_profiles drop column if exists fafsa_submitted_at;
alter table public.student_aid_profiles drop column if exists efc_estimate;

alter table public.student_aid_profiles
  add column if not exists fafsa_due_date date,
  add column if not exists css_due_date   date;

comment on column public.student_aid_profiles.fafsa_status is
  'v8: the FAFSA''s status only, never its contents. No SSN, no form detail, no per-school FAFSA column — see meridies-demo lib/financialAid.ts.';
comment on column public.student_aid_profiles.fafsa_due_date is
  'Set by the counselor; null means the page derives it from the earliest priority aid deadline on the student''s list.';
comment on column public.student_aid_profiles.css_due_date is
  'Set by the counselor; null means the earliest priority aid deadline among the schools that ask for the CSS Profile.';

delete from public.student_aid_checklist where item = 'fafsa';
alter table public.student_aid_checklist drop constraint if exists student_aid_checklist_item_check;
alter table public.student_aid_checklist add constraint student_aid_checklist_item_check check (item in
  ('css-profile','idoc','verification','institutional-form',
   'award-letter','appeal','scholarship-application','tax-transcript'));

-- ---------------------------------------------------------------------------
-- 2. Family financials
-- ---------------------------------------------------------------------------

alter table public.student_aid_profiles
  add column if not exists parent_agi_cents    bigint check (parent_agi_cents is null or parent_agi_cents between 0 and 100000000000),
  add column if not exists home_equity         text check (home_equity is null or home_equity in
                                                 ('renting','under-100k','100k-300k','over-300k','declined')),
  add column if not exists family_business     text check (family_business is null or family_business in
                                                 ('none','under-100','100-plus','farm','declined')),
  add column if not exists parent_status       text check (parent_status is null or parent_status in
                                                 ('married','divorced-separated','single','remarried','declined')),
  add column if not exists siblings_in_college text check (siblings_in_college is null or siblings_in_college in
                                                 ('none','one','two-plus','declined'));

comment on column public.student_aid_profiles.home_equity is
  'Asked because institutional methodology counts it. ''declined'' is the family choosing not to say, which is an answer, not a gap.';

-- ---------------------------------------------------------------------------
-- 3. Scholarship matching
-- ---------------------------------------------------------------------------

alter table public.scholarships
  add column if not exists essay_required boolean;

comment on column public.scholarships.essay_required is
  'Whether the application asks for an essay, as the sponsor states it. Null when the listing does not say.';

create table if not exists public.scholarship_match_prefs (
  student_id         uuid primary key references public.profiles(id) on delete cascade,
  -- Family connections and circumstances an award may be reserved for.
  audience           text[] not null default '{}' check (audience <@ array[
                       'union','military-family','first-responder','language','disability',
                       'hardship','single-parent','military-service']::text[]),
  other_connection   text check (other_connection is null or length(other_connection) <= 120),
  home_language      text check (home_language is null or length(home_language) <= 60),
  -- Smallest award worth the student's time, in cents. 0 = any.
  min_award_cents    bigint not null default 0 check (min_award_cents between 0 and 10000000),
  essays_ok          boolean not null default true,
  basis              text not null default 'any' check (basis in ('any','merit','need')),
  max_applications   integer not null default 8 check (max_applications between 1 and 99),
  updated_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists scholarship_match_prefs_set_updated_at on public.scholarship_match_prefs;
create trigger scholarship_match_prefs_set_updated_at before update on public.scholarship_match_prefs
  for each row execute function public.set_updated_at();

comment on table public.scholarship_match_prefs is
  'Scholarship matching''s answers (v8), per student. Student-scoped: they are the family''s own circumstances.';

revoke all on table public.scholarship_match_prefs from anon;
grant select, insert, update, delete on table public.scholarship_match_prefs to authenticated;
select private.attach_student_policies('scholarship_match_prefs');

-- A recommendation is one match row per award per student.
create index if not exists scholarship_matches_catalog_idx
  on public.scholarship_matches (student_id, scholarship_id) where scholarship_id is not null;

-- The v8 awards gated on a family circumstance, and the essay flag where the
-- sponsor states it. Generated from meridies-demo lib/scholarships.ts; insert
-- only where absent, update only where unset, so hand corrections survive.

insert into public.scholarships (name, sponsor, description, url, amount_cents, amount_note, renewable, opens_at, deadline, eligibility, tags, source_url, essay_required)
select 'Union Plus Scholarship', 'Union Plus', 'Children of members of a participating union. Four essays and a transcript.', 'https://www.unionplus.org/benefits/education/union-plus-scholarship', 200000, '$500–$4,000', false, '2026-09-15', '2027-01-31', '{"need_based":true,"audience":["union"]}'::jsonb, array['both', 'national']::text[], 'https://www.unionplus.org/benefits/education/union-plus-scholarship', true
where not exists (select 1 from public.scholarships where name = 'Union Plus Scholarship' and sponsor is not distinct from 'Union Plus');

update public.scholarships set essay_required = true where name = 'Union Plus Scholarship' and sponsor is not distinct from 'Union Plus' and essay_required is null;

insert into public.scholarships (name, sponsor, description, url, amount_cents, amount_note, renewable, opens_at, deadline, eligibility, tags, source_url, essay_required)
select 'Scholarships for Military Children', 'Fisher House Foundation', 'Dependent children of service members, retirees or reservists, with a short essay.', 'https://militaryscholar.org/', 200000, '$2,000', false, '2026-12-01', '2027-02-15', '{"need_based":false,"audience":["military-family"]}'::jsonb, array['merit', 'national']::text[], 'https://militaryscholar.org/', true
where not exists (select 1 from public.scholarships where name = 'Scholarships for Military Children' and sponsor is not distinct from 'Fisher House Foundation');

update public.scholarships set essay_required = true where name = 'Scholarships for Military Children' and sponsor is not distinct from 'Fisher House Foundation' and essay_required is null;

insert into public.scholarships (name, sponsor, description, url, amount_cents, amount_note, renewable, opens_at, deadline, eligibility, tags, source_url, essay_required)
select 'First Responders Children''s Foundation Scholarship', 'First Responders Children''s Foundation', 'Children of police officers, firefighters and EMTs, with priority to families facing hardship.', 'https://1stresponderschildren.org/', 500000, 'Up to $5,000', false, '2026-10-01', '2027-03-31', '{"need_based":true,"audience":["first-responder"]}'::jsonb, array['need', 'national']::text[], 'https://1stresponderschildren.org/', true
where not exists (select 1 from public.scholarships where name = 'First Responders Children''s Foundation Scholarship' and sponsor is not distinct from 'First Responders Children''s Foundation');

update public.scholarships set essay_required = true where name = 'First Responders Children''s Foundation Scholarship' and sponsor is not distinct from 'First Responders Children''s Foundation' and essay_required is null;

insert into public.scholarships (name, sponsor, description, url, amount_cents, amount_note, renewable, opens_at, deadline, eligibility, tags, source_url, essay_required)
select 'Dell Scholars Program', 'Michael & Susan Dell Foundation', 'Pell-eligible seniors who have overcome significant obstacles; essays and a college-readiness program.', 'https://www.dellscholars.org/', 2000000, '$20,000 plus a laptop', false, '2026-10-01', '2026-12-01', '{"need_based":true,"grade_levels":["11"],"audience":["hardship","single-parent"]}'::jsonb, array['need', 'national']::text[], 'https://www.dellscholars.org/', true
where not exists (select 1 from public.scholarships where name = 'Dell Scholars Program' and sponsor is not distinct from 'Michael & Susan Dell Foundation');

update public.scholarships set essay_required = true where name = 'Dell Scholars Program' and sponsor is not distinct from 'Michael & Susan Dell Foundation' and essay_required is null;

insert into public.scholarships (name, sponsor, description, url, amount_cents, amount_note, renewable, opens_at, deadline, eligibility, tags, source_url, essay_required)
select 'Army ROTC Four-Year Scholarship', 'U.S. Army Cadet Command', 'Students who commit to serve as Army officers after graduation. Interview and fitness test.', 'https://www.goarmy.com/careers-and-jobs/find-your-path/army-officers/rotc/scholarships', 4000000, 'Full tuition and fees', true, '2026-06-12', '2027-01-10', '{"need_based":false,"grade_levels":["11"],"audience":["military-service"]}'::jsonb, array['merit', 'national']::text[], 'https://www.goarmy.com/careers-and-jobs/find-your-path/army-officers/rotc/scholarships', false
where not exists (select 1 from public.scholarships where name = 'Army ROTC Four-Year Scholarship' and sponsor is not distinct from 'U.S. Army Cadet Command');

update public.scholarships set essay_required = false where name = 'Army ROTC Four-Year Scholarship' and sponsor is not distinct from 'U.S. Army Cadet Command' and essay_required is null;

insert into public.scholarships (name, sponsor, description, url, amount_cents, amount_note, renewable, opens_at, deadline, eligibility, tags, source_url, essay_required)
select 'Incight Go Beyond Scholarship', 'Incight', 'Students with a documented disability or chronic illness; a short essay on goals.', 'https://incight.org/scholarship', 150000, '$500–$2,500', true, '2026-10-15', '2027-03-01', '{"need_based":true,"audience":["disability"]}'::jsonb, array['both', 'regional']::text[], 'https://incight.org/scholarship', true
where not exists (select 1 from public.scholarships where name = 'Incight Go Beyond Scholarship' and sponsor is not distinct from 'Incight');

update public.scholarships set essay_required = true where name = 'Incight Go Beyond Scholarship' and sponsor is not distinct from 'Incight' and essay_required is null;
