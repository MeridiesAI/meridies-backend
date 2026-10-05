-- v10 sync, student-application (2 of 4): Activities and Awards & Honors as
-- Common App / UC sheets on the Application page.
--
-- Demo: lib/applicationSheets.ts, components/student/ApplicationSheets.tsx.
-- One row serves both forms: the fields they share (organization, grades,
-- hours, weeks) are one value, and only the UC's extra prose and categories
-- live in uc_* columns, so switching Common App | UC keeps every row.
--
-- The 150 / 350 / 250 character limits are the UI's (red in the counter); the
-- database keeps its 2000-character sanity caps. The form caps (10 Common App
-- activities, 5 honors, 20 UC entries) are UI rules too; the route refuses past
-- 30 rows per student so a runaway client can't fill the table.
--
-- RLS stays attach_student_policies on both tables: a student edits their own
-- sheets, as in the product.

-- ---------------------------------------------------------------------------
-- Activities
-- ---------------------------------------------------------------------------

-- A blank "+ Add activity" row has no name yet. On the sheet the organization
-- is the row's name.
alter table public.activities alter column name drop not null;
alter table public.activities drop constraint if exists activities_name_check;
alter table public.activities add constraint activities_name_check
  check (name is null or length(btrim(name)) between 1 and 300);
update public.activities set organization = name
 where organization is null and name is not null;

alter table public.activities
  add column if not exists uc_category text
    check (uc_category in ('coursework-other','educational-prep','extracurricular','volunteer','work')),
  add column if not exists uc_org_description text check (length(uc_org_description) <= 2000);

comment on column public.activities.uc_category is
  'UC activity category. The UC asks "About the organization" (uc_org_description) only for volunteer and work.';
comment on column public.activities.description is
  'Common App "Activity description" (150 characters, soft).';
comment on column public.activities.uc_description is
  'UC "What did you do?" (350 characters, soft).';

-- ---------------------------------------------------------------------------
-- Awards & Honors
-- ---------------------------------------------------------------------------

alter table public.awards alter column name drop not null;
alter table public.awards drop constraint if exists awards_name_check;
alter table public.awards add constraint awards_name_check
  check (name is null or length(btrim(name)) between 1 and 300);

alter table public.awards
  add column if not exists grade_levels       text[] not null default '{}',
  add column if not exists recognition_levels text[] not null default '{}',
  add column if not exists uc_type  text check (uc_type in ('academic','non-academic')),
  add column if not exists uc_level text check (uc_level in
    ('school','city-community','state','regional','national','international'));

alter table public.awards drop constraint if exists awards_grade_levels_check;
alter table public.awards add constraint awards_grade_levels_check
  check (grade_levels <@ array['9','10','11','12','PG']::text[]);
alter table public.awards drop constraint if exists awards_recognition_levels_check;
alter table public.awards add constraint awards_recognition_levels_check
  check (recognition_levels <@ array['school','state-regional','national','international']::text[]);
alter table public.awards drop constraint if exists awards_uc_text_caps;
-- NOT VALID: v5 never capped these columns, so an existing row past 2000
-- characters must not fail the migration. New writes are held to the cap.
alter table public.awards add constraint awards_uc_text_caps
  check (coalesce(length(uc_criteria), 0) <= 2000 and coalesce(length(uc_earned), 0) <= 2000) not valid;

comment on column public.awards.recognition_levels is 'Common App "Level of recognition" (multi).';
comment on column public.awards.uc_criteria is 'UC "Eligibility requirements" (250 characters, soft).';
comment on column public.awards.uc_earned is 'UC "What did you do to achieve it?" (350 characters, soft).';

-- Backfill only from what a row states. International before national, since
-- '%national%' matches both. uc_type stays null: nothing on a legacy row says it.
update public.awards set recognition_levels = array[case
    when level ilike '%international%' then 'international'
    when level ilike '%national%' then 'national'
    when level ~* 'state|regional|district' then 'state-regional'
    else 'school' end]
 where level is not null and btrim(level) <> '' and recognition_levels = '{}';
update public.awards set uc_level = case
    when level ilike '%international%' then 'international'
    when level ilike '%national%' then 'national'
    when level ilike '%state%' then 'state'
    when level ilike '%regional%' then 'regional'
    when level ~* 'district|city|community' then 'city-community'
    else 'school' end
 where level is not null and btrim(level) <> '' and uc_level is null;
