-- Learning from Build College Lists: what the list builder showed, and what people then did with each school.
-- Kept so ranking weights can be learned later. Nothing in this file (or its code) changes a ranking.
--
--   firms.exclude_from_learning   true for our team, demo and test firms (set by hand, as postgres). The code
--                                 writes nothing for a student whose counselor's firm has it. Clients can read it
--                                 on their own firm but never write it (firms' UPDATE grant is per column).
--   list_builder_impressions      one row per school a POST /colleges/list-builder answer showed
--   list_builder_choices          one row per school added to or removed from a student's list (any path), or
--                                 recommended to them; linked to the most recent impression of that school for
--                                 that student in the last 30 days, when there is one
--   college_core_features         empty for now: one 0-1 value per (college, feature), with the quote it came from
--   college_opportunities         empty for now: programs a college offers, with a 384-dimension embedding
--
-- The two logging tables are service-role only, like ai_runs: no grants and no policies for anon or authenticated.
-- They hold ids, numbers and fixed labels only, never a name or free text about a student (lib/listLearning.ts:
-- the criteria's majors become the fields the ranking matched on, its origin only whether one was set).
-- Deleting a student's account deletes their rows (student_id cascades). Deleting the account that acted keeps
-- the row about the student and drops who acted (actor_id set null). Neither table is in the data export: the
-- export reads as the caller under RLS, and these tables are readable by no client.
--
-- The college_* tables are catalog data, like college_site_info: any signed-in user reads them (a pending
-- counselor reads nothing, the approval gate); only service_role writes.
--
-- Deploy order: either. Before this file the code logs nothing: its first write fails, it warns once and stays
-- quiet for five minutes, and the list builder and every list write work as before (the logging is never awaited).
-- With this file and the previous build, nothing writes the new tables. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. The exclude flag
-- ---------------------------------------------------------------------------

alter table public.firms add column if not exists exclude_from_learning boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. list_builder_impressions
-- ---------------------------------------------------------------------------

create table if not exists public.list_builder_impressions (
  id          uuid primary key default gen_random_uuid(),
  -- The same for every row of one POST /colleges/list-builder answer.
  run_id      uuid not null,
  -- The student's practice: their counselor's firm. Null for a solo counselor without a firm.
  firm_id     uuid references public.firms(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_role  text not null check (actor_role in ('counselor', 'student')),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  college_id  uuid not null references public.colleges(id) on delete cascade,
  -- 1-based place in its band's column, top first, as shown (after the offset's rotation).
  position    integer not null check (position between 1 and 100),
  band        text not null check (band in ('reach', 'target', 'likely')),
  -- The fit model's odds for this student, a percent (0.5-94); null when the school publishes no admit rate.
  odds        numeric(5, 2) check (odds is null or odds between 0 and 100),
  -- The ListCriteria used, without free text: see lib/listLearning.ts learningCriteria.
  criteria    jsonb not null check (jsonb_typeof(criteria) = 'object' and octet_length(criteria::text) <= 8000),
  -- The ListSchool fields the ranking read, plus miles, the school's rank in its whole band and the band's size.
  features    jsonb not null check (jsonb_typeof(features) = 'object' and octet_length(features::text) <= 4000),
  created_at  timestamptz not null default now()
);

-- The choice lookup: the newest impression of this school for this student.
create index if not exists list_builder_impressions_student_college_idx
  on public.list_builder_impressions (student_id, college_id, created_at desc);
create index if not exists list_builder_impressions_run_idx on public.list_builder_impressions (run_id);
-- Account deletion sets actor_id null; without an index that is a scan of the whole table.
create index if not exists list_builder_impressions_actor_idx on public.list_builder_impressions (actor_id);
create index if not exists list_builder_impressions_created_idx on public.list_builder_impressions (created_at);

alter table public.list_builder_impressions enable row level security;
revoke all on public.list_builder_impressions from public, anon, authenticated;
grant all on public.list_builder_impressions to service_role;
select private.attach_approval_gate('public.list_builder_impressions');

-- ---------------------------------------------------------------------------
-- 3. list_builder_choices
-- ---------------------------------------------------------------------------

create table if not exists public.list_builder_choices (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid references public.firms(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_role  text not null check (actor_role in ('counselor', 'student')),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  college_id  uuid not null references public.colleges(id) on delete cascade,
  -- 'recommended': a counselor put the school in the student's Recommended column (Build College Lists' own
  -- button for a counselor is Recommend, so without it a counselor's reaction would show only once accepted).
  action      text not null check (action in ('added', 'removed', 'recommended')),
  -- Where the change was made: the Build College Lists screen, AxIS, or by hand anywhere else.
  source      text not null check (source in ('list_builder', 'manual', 'axis')),
  -- The most recent impression run for this student that showed this school in the last 30 days, and the
  -- school's position in it. No foreign key: a run is many rows.
  run_id      uuid,
  position    integer check (position is null or position between 1 and 100),
  created_at  timestamptz not null default now(),
  constraint list_builder_choices_run_position check ((run_id is null) = (position is null))
);

create index if not exists list_builder_choices_student_idx on public.list_builder_choices (student_id, created_at desc);
create index if not exists list_builder_choices_run_idx on public.list_builder_choices (run_id) where run_id is not null;
create index if not exists list_builder_choices_actor_idx on public.list_builder_choices (actor_id);
create index if not exists list_builder_choices_created_idx on public.list_builder_choices (created_at);

alter table public.list_builder_choices enable row level security;
revoke all on public.list_builder_choices from public, anon, authenticated;
grant all on public.list_builder_choices to service_role;
select private.attach_approval_gate('public.list_builder_choices');

-- ---------------------------------------------------------------------------
-- 4. pgvector, and the two catalog tables the matching work will fill
-- ---------------------------------------------------------------------------

create extension if not exists vector with schema extensions;

create table if not exists public.college_core_features (
  college_id   uuid not null references public.colleges(id) on delete cascade,
  feature_key  text not null check (feature_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- 0-1; null = unknown.
  value        numeric check (value is null or (value >= 0 and value <= 1)),
  quote        text check (quote is null or length(quote) <= 2000),
  source_url   text check (source_url is null or (source_url ~ '^https?://' and length(source_url) <= 2000)),
  extracted_at timestamptz not null default now(),
  primary key (college_id, feature_key)
);

alter table public.college_core_features enable row level security;
drop policy if exists college_core_features_select on public.college_core_features;
create policy college_core_features_select on public.college_core_features
  for select to authenticated using (true);
revoke all on public.college_core_features from public, anon, authenticated;
grant select on public.college_core_features to authenticated;
grant all on public.college_core_features to service_role;
select private.attach_approval_gate('public.college_core_features');

create table if not exists public.college_opportunities (
  id            uuid primary key default gen_random_uuid(),
  college_id    uuid not null references public.colleges(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 300),
  category      text check (category is null or length(btrim(category)) between 1 and 60),
  description   text check (description is null or length(description) <= 4000),
  quote         text check (quote is null or length(quote) <= 2000),
  source_url    text check (source_url is null or (source_url ~ '^https?://' and length(source_url) <= 2000)),
  embedding     extensions.vector(384),
  content_hash  text check (content_hash is null or length(content_hash) between 1 and 128),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  active        boolean not null default true
);

create index if not exists college_opportunities_college_idx on public.college_opportunities (college_id);
create index if not exists college_opportunities_embedding_idx
  on public.college_opportunities using hnsw (embedding extensions.vector_cosine_ops);

alter table public.college_opportunities enable row level security;
drop policy if exists college_opportunities_select on public.college_opportunities;
create policy college_opportunities_select on public.college_opportunities
  for select to authenticated using (true);
revoke all on public.college_opportunities from public, anon, authenticated;
grant select on public.college_opportunities to authenticated;
grant all on public.college_opportunities to service_role;
select private.attach_approval_gate('public.college_opportunities');
