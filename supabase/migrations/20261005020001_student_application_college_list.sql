-- v10 sync, student-application (1 of 4): the College list section.
--
-- Demo: lib/collegeList.ts (in-place edits on every column), lib/collegeBoard.ts
-- (the board Recommended -> Interested -> Applying -> Applied, dragged between
-- columns), components/student/CollegeListSheet.tsx.
--
-- The board's three list columns ARE the row's application status
-- (not-started / in-progress / submitted), so a drag is the same write as
-- changing the status anywhere else. The fourth column, Recommended, is its
-- own table: schools the counselor (College List Builder) or AxIS suggested
-- that are not on the list yet.

-- ---------------------------------------------------------------------------
-- Catalog: the application fee (Common Data Set C13) and supplement prompts.
-- ---------------------------------------------------------------------------

alter table public.colleges
  add column if not exists application_fee_cents integer
    check (application_fee_cents between 0 and 100000);

comment on column public.colleges.application_fee_cents is
  'Published first-year application fee, in cents (Common Data Set C13).';

-- One row per published prompt, per admission cycle. A school that changes its
-- prompts gets new rows under the new cycle; last cycle''s stay, so a document
-- written against them can be flagged outdated rather than silently rewritten.
create table if not exists public.college_supplements (
  id                  uuid primary key default gen_random_uuid(),
  college_id          uuid not null references public.colleges(id) on delete cascade,
  admission_cycle     text not null check (admission_cycle ~ '^\d{4}-\d{4}$'),
  title               text not null check (length(btrim(title)) between 1 and 120),
  prompt              text not null check (length(btrim(prompt)) between 1 and 2000),
  word_limit          integer check (word_limit between 1 and 5000),
  scope               text not null default 'universal'
                      check (scope in ('universal','major','scholarship')),
  major_or_program    text check (length(major_or_program) <= 200),
  required            boolean not null default true,
  sort_order          integer not null default 0,
  source_url          text check (source_url ~ '^https://'),
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint college_supplements_slot unique (college_id, admission_cycle, sort_order)
);

create index if not exists college_supplements_college_idx
  on public.college_supplements (college_id, admission_cycle, sort_order);
drop trigger if exists college_supplements_set_updated_at on public.college_supplements;
create trigger college_supplements_set_updated_at before update on public.college_supplements
  for each row execute function public.set_updated_at();

-- Catalog data: everyone signed in reads it, only the service role writes it,
-- like every other college_* table.
alter table public.college_supplements enable row level security;
revoke all on public.college_supplements from anon, authenticated;
grant select on public.college_supplements to authenticated;
drop policy if exists college_supplements_select on public.college_supplements;
create policy college_supplements_select on public.college_supplements
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- A student's list: the columns the board card and its "More" drawer edit.
-- ---------------------------------------------------------------------------

alter table public.student_colleges drop constraint if exists student_colleges_round_check;
alter table public.student_colleges add constraint student_colleges_round_check
  check (round in ('ED','ED2','EA','REA','SCEA','RD','rolling','priority'));

-- The demo's three working statuses replace v5's considering / applying, and
-- the decision statuses stay for the outcome rows and alumni.
alter table public.student_colleges drop constraint if exists student_colleges_status_check;
update public.student_colleges set status = 'not-started' where status = 'considering';
update public.student_colleges set status = 'in-progress' where status = 'applying';
alter table public.student_colleges alter column status set default 'not-started';
alter table public.student_colleges add constraint student_colleges_status_check check (status in
  ('not-started','in-progress','submitted','accepted','denied','waitlisted','deferred','enrolled','withdrawn'));

alter table public.student_colleges
  add column if not exists custom_deadline       date,
  add column if not exists intended_major        text check (length(intended_major) <= 200),
  add column if not exists recs_required         smallint check (recs_required between 0 and 10),
  add column if not exists recs_in_hand          smallint check (recs_in_hand between 0 and 10),
  add column if not exists testing               text check (testing in ('required','optional','flexible','blind')),
  add column if not exists application_fee_cents integer check (application_fee_cents between 0 and 100000);

alter table public.student_colleges drop constraint if exists student_colleges_recs_consistent;
alter table public.student_colleges add constraint student_colleges_recs_consistent check (
  recs_in_hand is null or (recs_required is not null and recs_in_hand <= recs_required));

comment on column public.student_colleges.custom_deadline is
  'The internal date the counselor holds the student to ("Your deadline"). Counselor-written.';
comment on column public.student_colleges.recs_required is '0 = "Not required"; null = not recorded.';
comment on column public.student_colleges.testing is 'Per-student override; null reads colleges.test_policy.';
comment on column public.student_colleges.application_fee_cents is
  'Per-student override (a waiver, a different program); null reads colleges.application_fee_cents.';

-- "Add to list" dedupes by catalog identity as well as by name. An existing
-- list can already hold the same school twice under different names ("MIT"
-- and "Massachusetts Institute of Technology"). Deleting the newer row would
-- cascade through deliverables, the aid checklist, net price estimates and fit
-- rows, and lose whatever status it carried, so the newer row is unlinked from
-- the catalog instead: it stays on the list as a free-text school, exactly as
-- a counselor-typed school does, and the counselor can remove it by hand.
update public.student_colleges a
   set college_id = null
  from public.student_colleges b
 where a.college_id is not null
   and a.student_id = b.student_id
   and a.college_id = b.college_id
   and (a.created_at, a.id) > (b.created_at, b.id);
create unique index if not exists student_colleges_unique_college
  on public.student_colleges (student_id, college_id) where college_id is not null;

-- Fit (Reach / Target / Safety) and the counselor's own deadline are the
-- counselor's judgement. attach_student_policies lets the student write their
-- own rows (they move schools on the board too), so the database refuses a
-- student who sets or changes either column. The service role passes.
create or replace function private.student_colleges_counselor_columns()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or caller <> new.student_id then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.fit is not null or new.custom_deadline is not null then
      raise exception 'Only a counselor sets fit or the counselor deadline' using errcode = '42501';
    end if;
  elsif new.fit is distinct from old.fit or new.custom_deadline is distinct from old.custom_deadline then
    raise exception 'Only a counselor sets fit or the counselor deadline' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.student_colleges_counselor_columns() from public, anon, authenticated;

drop trigger if exists student_colleges_counselor_columns on public.student_colleges;
create trigger student_colleges_counselor_columns
  before insert or update on public.student_colleges
  for each row execute function private.student_colleges_counselor_columns();

-- ---------------------------------------------------------------------------
-- The board's Recommended column.
-- ---------------------------------------------------------------------------

create table if not exists public.student_college_recommendations (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.profiles(id) on delete cascade,
  college_id          uuid references public.colleges(id) on delete set null,
  name                text not null check (length(btrim(name)) between 1 and 300),
  fit                 text check (fit in ('reach','target','likely')),
  -- 'counselor': a person put it there (College List Builder, by hand).
  -- 'axis': the model suggested it. The card says which.
  suggested_by        text not null default 'counselor' check (suggested_by in ('counselor','axis')),
  why                 text check (length(why) <= 600),
  status              text not null default 'open' check (status in ('open','dismissed','added')),
  recommended_by      uuid references public.profiles(id) on delete set null,
  ai_run_id           uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists student_college_recommendations_unique_name
  on public.student_college_recommendations (student_id, lower(name));
create index if not exists student_college_recommendations_student_idx
  on public.student_college_recommendations (student_id, status, created_at);
drop trigger if exists student_college_recommendations_set_updated_at on public.student_college_recommendations;
create trigger student_college_recommendations_set_updated_at
  before update on public.student_college_recommendations
  for each row execute function public.set_updated_at();

-- A recommendation is the counselor's: the student may read it, never write it
-- (otherwise a student could fill the column with "suggested by AxIS" rows).
alter table public.student_college_recommendations enable row level security;
revoke all on public.student_college_recommendations from anon, authenticated;
grant select, insert, update, delete on public.student_college_recommendations to authenticated;

drop policy if exists student_college_recommendations_select on public.student_college_recommendations;
create policy student_college_recommendations_select on public.student_college_recommendations
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists student_college_recommendations_write on public.student_college_recommendations;
create policy student_college_recommendations_write on public.student_college_recommendations
  for all to authenticated
  using (
    student_id <> (select auth.uid())
    and private.can_edit_student(student_id, (select auth.uid()))
  )
  with check (
    student_id <> (select auth.uid())
    and private.can_edit_student(student_id, (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Seed: fees and this cycle's prompts for the profiled colleges, from the
-- meridies-demo fixtures (lib/collegeData.ts). Public facts, but unverified:
-- source_verified_at stays null until someone checks each school's own page.
-- Guarded so a re-run never overwrites a hand correction.
-- ---------------------------------------------------------------------------

update public.colleges c set application_fee_cents = v.fee
  from (values
    ('stanford', 9000), ('mit', 7500), ('uc-berkeley', 8000), ('umich', 7500),
    ('ut-austin', 7500), ('nyu', 8000), ('uw-seattle', 8000), ('caltech', 7500)
  ) as v(slug, fee)
 where c.slug = v.slug and c.application_fee_cents is null;

insert into public.college_supplements (college_id, admission_cycle, title, prompt, word_limit, sort_order, source_url)
select c.id, '2026-2027', v.title, v.prompt, v.word_limit, v.sort_order, c.website
  from (values
    ('stanford', 0, 'Society''s challenge', 'What is the most significant challenge that society faces today?', 50),
    ('stanford', 1, 'Last two summers', 'How did you spend your last two summers?', 50),
    ('stanford', 2, 'Intellectual vitality', 'The Stanford community is deeply curious and driven to learn. Reflect on an idea or experience that makes you genuinely excited about learning.', 250),
    ('stanford', 3, 'What matters to you', 'Tell us about something that is meaningful to you and why.', 250),
    ('mit', 0, 'Field of study', 'What field of study appeals to you the most right now?', 100),
    ('mit', 1, 'For the pleasure of it', 'We know you lead a busy life, full of activities. What do you do simply for the pleasure of it?', 200),
    ('mit', 2, 'Collaboration', 'Describe how you have collaborated with people who are different from you.', 200),
    ('mit', 3, 'A challenge', 'Tell us about a significant challenge you''ve faced.', 200),
    ('uc-berkeley', 0, 'PIQ 1 · Leadership', 'Describe an example of your leadership experience.', 350),
    ('uc-berkeley', 1, 'PIQ 2 · Creativity', 'Every person has a creative side. Describe how you express yours.', 350),
    ('uc-berkeley', 2, 'PIQ 4 · Educational opportunity', 'Describe how you have taken advantage of a significant educational opportunity.', 350),
    ('uc-berkeley', 3, 'PIQ 7 · Community', 'What have you done to make your school or community a better place?', 350),
    ('umich', 0, 'Community', 'Everyone belongs to many different communities. Describe the community you belong to and your place within it.', 300),
    ('umich', 1, 'Why Michigan', 'Describe the unique qualities that attract you to the specific undergraduate College or School to which you are applying.', 550),
    ('ut-austin', 0, 'First-choice major', 'Why are you interested in the major you indicated as your first-choice major?', 300),
    ('ut-austin', 1, 'Impact', 'Describe how your experiences, perspectives, talents, and/or your involvement in leadership activities will help you to make an impact.', 300),
    ('nyu', 0, 'Why NYU', 'We would like to know more about your interest in NYU. What motivated you to apply?', 250),
    ('nyu', 1, 'Bridge builder', 'In a world where disconnection seems to often prevail, we are looking for students who embody the qualities of bridge builders.', 250),
    ('uw-seattle', 0, 'Your story', 'Tell a story from your life, describing an experience that either demonstrates your character or helped to shape it.', 650),
    ('uw-seattle', 1, 'Your world', 'Our families and communities often define us and our individual worlds. Tell us about your world.', 300),
    ('caltech', 0, 'STEM experience', 'Describe your experience of the world of STEM.', 200),
    ('caltech', 1, 'Creativity', 'The creativity, inventiveness, and innovation of Caltech''s students are critical to the campus. Tell us how you use creativity in your life.', 250)
  ) as v(slug, sort_order, title, prompt, word_limit)
  join public.colleges c on c.slug = v.slug
on conflict (college_id, admission_cycle, sort_order) do nothing;
