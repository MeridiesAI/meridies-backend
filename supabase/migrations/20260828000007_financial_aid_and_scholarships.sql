-- Financial Aid & Scholarships.
--
-- Two layers, deliberately separate:
--   informational  -> college_aid_profiles, scholarships  (catalog, shared)
--   per-student    -> student_aid_profiles, checklists, award letters, matches
--
-- Every catalog row carries `source_url` + `source_verified_at` + `citations`
-- so the Source-Verified Data Layer can cite what it shows. Money is stored in
-- integer cents; never float.

-- ---------------------------------------------------------------------------
-- Aid data per college — the subsection on each college info card.
-- ---------------------------------------------------------------------------

create table if not exists public.college_aid_profiles (
  college_id                uuid primary key references public.colleges(id) on delete cascade,
  sticker_price_cents       bigint check (sticker_price_cents >= 0),
  sticker_in_state_cents    bigint check (sticker_in_state_cents >= 0),
  sticker_out_state_cents   bigint check (sticker_out_state_cents >= 0),
  cost_of_attendance_cents  bigint check (cost_of_attendance_cents >= 0),
  avg_need_grant_cents      bigint check (avg_need_grant_cents >= 0),
  pct_need_met              numeric(5,4) check (pct_need_met between 0 and 1),
  pct_receiving_need_aid    numeric(5,4) check (pct_receiving_need_aid between 0 and 1),
  merit_aid_available       boolean,
  avg_merit_award_cents     bigint check (avg_merit_award_cents >= 0),
  pct_receiving_merit       numeric(5,4) check (pct_receiving_merit between 0 and 1),
  css_profile_required      boolean,
  -- FAFSA-only vs institutional methodology changes what a family must file.
  aid_methodology           text check (aid_methodology in ('fafsa-only','institutional','both')),
  meets_full_need           boolean,
  loans_in_initial_package  boolean,
  npc_url                   text,
  aid_office_url            text,
  priority_aid_deadline     date,
  source_url                text,
  source_verified_at        timestamptz,
  citations                 jsonb not null default '[]'::jsonb,
  updated_at                timestamptz not null default now()
);

drop trigger if exists college_aid_profiles_set_updated_at on public.college_aid_profiles;
create trigger college_aid_profiles_set_updated_at before update on public.college_aid_profiles
  for each row execute function public.set_updated_at();

alter table public.college_aid_profiles enable row level security;
drop policy if exists college_aid_profiles_select on public.college_aid_profiles;
create policy college_aid_profiles_select on public.college_aid_profiles
  for select to authenticated using (true);
-- Catalog data is maintained by service_role only.

-- ---------------------------------------------------------------------------
-- The student's own aid picture.
-- ---------------------------------------------------------------------------

create table if not exists public.student_aid_profiles (
  student_id             uuid primary key references public.profiles(id) on delete cascade,
  fafsa_status           text not null default 'not-started' check (fafsa_status in
                           ('not-started','in-progress','submitted','verified','corrections-needed','not-applicable')),
  fafsa_submitted_at     date,
  css_status             text not null default 'not-started' check (css_status in
                           ('not-started','in-progress','submitted','not-required','not-applicable')),
  css_submitted_at       date,
  sai_estimate           integer,
  efc_estimate           integer,
  household_size         integer check (household_size between 1 and 20),
  number_in_college      integer check (number_in_college between 0 and 20),
  income_band            text,
  assets_band            text,
  dependency_status      text check (dependency_status in ('dependent','independent')),
  state_of_residence     text,
  aid_types_pursued      text[] not null default '{}',
  special_circumstances  text,
  -- Free-form inputs the net price calculators need, kept out of columns so a
  -- new school's calculator can ask for something we didn't anticipate.
  npc_inputs             jsonb not null default '{}'::jsonb,
  updated_at             timestamptz not null default now()
);

drop trigger if exists student_aid_profiles_set_updated_at on public.student_aid_profiles;
create trigger student_aid_profiles_set_updated_at before update on public.student_aid_profiles
  for each row execute function public.set_updated_at();
select private.attach_student_policies('student_aid_profiles');

-- Per-school aid checklist. Statuses feed the existing deadline tracker rather
-- than standing up a second one, so `deadline_id` links back to it.
create table if not exists public.student_aid_checklist (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.profiles(id) on delete cascade,
  student_college_id  uuid references public.student_colleges(id) on delete cascade,
  item                text not null check (item in
                        ('fafsa','css-profile','idoc','verification','institutional-form',
                         'award-letter','appeal','scholarship-application','tax-transcript')),
  status              text not null default 'todo' check (status in
                        ('todo','in-progress','submitted','received','waived','not-applicable')),
  due_date            date,
  completed_at        timestamptz,
  deadline_id         uuid references public.deadlines(id) on delete set null,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists student_aid_checklist_student_idx
  on public.student_aid_checklist (student_id, status);
create unique index if not exists student_aid_checklist_unique
  on public.student_aid_checklist (student_id, coalesce(student_college_id, '00000000-0000-0000-0000-000000000000'::uuid), item);
drop trigger if exists student_aid_checklist_set_updated_at on public.student_aid_checklist;
create trigger student_aid_checklist_set_updated_at before update on public.student_aid_checklist
  for each row execute function public.set_updated_at();
select private.attach_student_policies('student_aid_checklist');

-- ---------------------------------------------------------------------------
-- Net price estimate: student profile x published NPC inputs, with citations.
-- ---------------------------------------------------------------------------

create table if not exists public.net_price_estimates (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.profiles(id) on delete cascade,
  college_id          uuid references public.colleges(id) on delete cascade,
  student_college_id  uuid references public.student_colleges(id) on delete cascade,
  estimated_net_cents bigint check (estimated_net_cents >= 0),
  low_cents           bigint check (low_cents >= 0),
  high_cents          bigint check (high_cents >= 0),
  method              text not null default 'npc-published' check (method in
                        ('npc-published','institutional-average','ipeds-band','manual')),
  confidence          text check (confidence in ('high','medium','low')),
  inputs              jsonb not null default '{}'::jsonb,
  citations           jsonb not null default '[]'::jsonb,
  computed_at         timestamptz not null default now()
);

create index if not exists net_price_estimates_student_idx
  on public.net_price_estimates (student_id, computed_at desc);
select private.attach_student_policies('net_price_estimates');

-- ---------------------------------------------------------------------------
-- Award letters + line items -> the side-by-side comparator.
-- ---------------------------------------------------------------------------

create table if not exists public.award_letters (
  id                        uuid primary key default gen_random_uuid(),
  student_id                uuid not null references public.profiles(id) on delete cascade,
  student_college_id        uuid references public.student_colleges(id) on delete set null,
  college_id                uuid references public.colleges(id) on delete set null,
  school_name               text not null,
  document_id               uuid references public.documents(id) on delete set null,
  entry_mode                text not null default 'manual' check (entry_mode in ('manual','upload')),
  academic_year             text,
  cost_of_attendance_cents  bigint check (cost_of_attendance_cents >= 0),
  grants_cents              bigint not null default 0 check (grants_cents >= 0),
  scholarships_cents        bigint not null default 0 check (scholarships_cents >= 0),
  work_study_cents          bigint not null default 0 check (work_study_cents >= 0),
  loans_subsidized_cents    bigint not null default 0 check (loans_subsidized_cents >= 0),
  loans_unsubsidized_cents  bigint not null default 0 check (loans_unsubsidized_cents >= 0),
  parent_loan_cents         bigint not null default 0 check (parent_loan_cents >= 0),
  -- Gift aid only; loans and work study are not aid that reduces what you owe.
  net_price_cents           bigint generated always as (
                              coalesce(cost_of_attendance_cents, 0)
                              - grants_cents - scholarships_cents
                            ) stored,
  renewal_requirements      text,
  appeal_deadline           date,
  received_at               date,
  parsed_data               jsonb not null default '{}'::jsonb,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists award_letters_student_idx on public.award_letters (student_id, created_at desc);
drop trigger if exists award_letters_set_updated_at on public.award_letters;
create trigger award_letters_set_updated_at before update on public.award_letters
  for each row execute function public.set_updated_at();
select private.attach_student_policies('award_letters');

create table if not exists public.award_letter_items (
  id               uuid primary key default gen_random_uuid(),
  award_letter_id  uuid not null references public.award_letters(id) on delete cascade,
  student_id       uuid not null references public.profiles(id) on delete cascade,
  label            text not null,
  category         text not null check (category in
                     ('grant','scholarship','work-study','loan','parent-loan','other')),
  basis            text check (basis in ('need','merit','both','unknown')),
  amount_cents     bigint not null default 0,
  renewable        boolean,
  renewal_note     text,
  sort_order       integer not null default 0
);

create index if not exists award_letter_items_letter_idx
  on public.award_letter_items (award_letter_id, sort_order);
select private.attach_student_policies('award_letter_items');

-- ---------------------------------------------------------------------------
-- Scholarships catalog + per-student matches.
-- ---------------------------------------------------------------------------

create table if not exists public.scholarships (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  sponsor             text,
  description         text,
  url                 text,
  apply_url           text,
  amount_cents        bigint check (amount_cents >= 0),
  amount_note         text,
  renewable           boolean,
  opens_at            date,
  deadline            date,
  -- Machine-checkable gates: majors, states, gpa_min, grade_levels,
  -- citizenship, demographics, need_based. The matcher reads this.
  eligibility         jsonb not null default '{}'::jsonb,
  tags                text[] not null default '{}',
  source_url          text,
  source_verified_at  timestamptz,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists scholarships_deadline_idx on public.scholarships (deadline)
  where is_active;
create index if not exists scholarships_eligibility_idx on public.scholarships using gin (eligibility);
drop trigger if exists scholarships_set_updated_at on public.scholarships;
create trigger scholarships_set_updated_at before update on public.scholarships
  for each row execute function public.set_updated_at();

alter table public.scholarships enable row level security;
drop policy if exists scholarships_select on public.scholarships;
create policy scholarships_select on public.scholarships
  for select to authenticated using (is_active);

create table if not exists public.scholarship_matches (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null references public.profiles(id) on delete cascade,
  scholarship_id     uuid references public.scholarships(id) on delete cascade,
  -- A web-sourced result the catalog doesn't hold yet still needs somewhere to
  -- live, so name/url/deadline are denormalized here.
  name               text not null,
  sponsor            text,
  url                text,
  amount_cents       bigint,
  deadline           date,
  score              numeric(4,3) check (score between 0 and 1),
  why_fit            text,
  eligibility_notes  text,
  status             text not null default 'suggested' check (status in
                       ('suggested','saved','applying','applied','awarded','dismissed')),
  deadline_id        uuid references public.deadlines(id) on delete set null,
  citations          jsonb not null default '[]'::jsonb,
  ai_run_id          uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists scholarship_matches_student_idx
  on public.scholarship_matches (student_id, status, deadline);
drop trigger if exists scholarship_matches_set_updated_at on public.scholarship_matches;
create trigger scholarship_matches_set_updated_at before update on public.scholarship_matches
  for each row execute function public.set_updated_at();
select private.attach_student_policies('scholarship_matches');

-- ---------------------------------------------------------------------------
-- Award Appeal Assistant — draft only, counselor review before it can send.
-- ---------------------------------------------------------------------------

create table if not exists public.award_appeals (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.profiles(id) on delete cascade,
  student_college_id  uuid references public.student_colleges(id) on delete set null,
  award_letter_id     uuid references public.award_letters(id) on delete set null,
  school_name         text not null,
  basis               text[] not null default '{}',
  competing_offers    jsonb not null default '[]'::jsonb,
  circumstances       text,
  draft_body          text,
  status              text not null default 'draft' check (status in
                        ('draft','counselor-review','approved','sent','declined')),
  reviewed_by         uuid references public.profiles(id) on delete set null,
  reviewed_at         timestamptz,
  sent_at             timestamptz,
  ai_run_id           uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists award_appeals_student_idx on public.award_appeals (student_id, status);
drop trigger if exists award_appeals_set_updated_at on public.award_appeals;
create trigger award_appeals_set_updated_at before update on public.award_appeals
  for each row execute function public.set_updated_at();
select private.attach_student_policies('award_appeals');
