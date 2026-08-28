-- Stat Polygon (truly a polygon: any number of axes, counselor-editable) and
-- the Program & Opportunity Concierge that works against those axes.

-- ---------------------------------------------------------------------------
-- Stat Polygon
--
-- Activities and awards are ONE axis ("extracurriculars"), because that is how
-- applications read them. Counselors can override any score by hand and add
-- their own axes, so the shape is not fixed at five or six points.
-- ---------------------------------------------------------------------------

create table if not exists public.student_polygon_axes (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  key          text not null check (key ~ '^[a-z0-9-]{1,40}$'),
  label        text not null check (length(btrim(label)) between 1 and 60),
  description  text,
  max_score    integer not null default 100 check (max_score between 1 and 1000),
  -- What the system computed from profile data.
  auto_score   numeric(6,2) check (auto_score >= 0),
  -- What the counselor typed. When set, it wins.
  manual_score numeric(6,2) check (manual_score >= 0),
  score        numeric(6,2) generated always as (coalesce(manual_score, auto_score, 0)) stored,
  note         text,
  source       text not null default 'default' check (source in ('default','custom')),
  sort_order   integer not null default 0,
  updated_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists student_polygon_axes_key
  on public.student_polygon_axes (student_id, key);
create index if not exists student_polygon_axes_student_idx
  on public.student_polygon_axes (student_id, sort_order);
drop trigger if exists student_polygon_axes_set_updated_at on public.student_polygon_axes;
create trigger student_polygon_axes_set_updated_at before update on public.student_polygon_axes
  for each row execute function public.set_updated_at();
select private.attach_student_policies('student_polygon_axes');

-- Seed the default axes for a student, idempotently. Note the single merged
-- `extracurriculars` axis — there is no separate awards axis by design.
create or replace function public.ensure_default_polygon_axes(p_student uuid)
returns void
language plpgsql
security invoker
set search_path to 'public'
as $function$
begin
  insert into public.student_polygon_axes (student_id, key, label, description, sort_order, source)
  values
    (p_student, 'academics',        'Academics',        'GPA, rigor, and coursework',                     0, 'default'),
    (p_student, 'testing',          'Testing',          'SAT / ACT / AP outcomes',                        1, 'default'),
    (p_student, 'extracurriculars', 'Extracurriculars', 'Activities and awards, read together',           2, 'default'),
    (p_student, 'essays',           'Essays',           'Draft progress and quality',                     3, 'default'),
    (p_student, 'narrative',        'Narrative',        'Coherence of the story across the application',  4, 'default'),
    (p_student, 'intangibles',      'Intangibles',      'Recommendations, demonstrated interest, context',5, 'default')
  on conflict (student_id, key) do nothing;
end;
$function$;

revoke all on function public.ensure_default_polygon_axes(uuid) from public, anon;
grant execute on function public.ensure_default_polygon_axes(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Opportunity catalog (POC). Rows must carry a real signup link, a deadline,
-- and machine-checkable eligibility — a recommendation without those is noise.
-- ---------------------------------------------------------------------------

create table if not exists public.opportunities (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  org                 text,
  description         text,
  url                 text,
  apply_url           text,
  category            text check (category in
                        ('summer-program','research','internship','competition','volunteer',
                         'course','fellowship','job','club','other')),
  format              text check (format in ('in-person','virtual','hybrid')),
  location            text,
  region              text,
  country             text,
  cost_cents          bigint check (cost_cents >= 0),
  is_free             boolean,
  financial_aid       boolean,
  grade_levels        text[] not null default '{}',
  subject_tags        text[] not null default '{}',
  -- gpa_min, citizenship, age_min/max, residency, prerequisites
  eligibility         jsonb not null default '{}'::jsonb,
  selectivity         text check (selectivity in ('open','selective','highly-selective')),
  opens_at            date,
  deadline            date,
  session_start       date,
  session_end         date,
  source_url          text,
  source_verified_at  timestamptz,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists opportunities_deadline_idx on public.opportunities (deadline) where is_active;
create index if not exists opportunities_tags_idx on public.opportunities using gin (subject_tags);
drop trigger if exists opportunities_set_updated_at on public.opportunities;
create trigger opportunities_set_updated_at before update on public.opportunities
  for each row execute function public.set_updated_at();

alter table public.opportunities enable row level security;
drop policy if exists opportunities_select on public.opportunities;
create policy opportunities_select on public.opportunities
  for select to authenticated using (is_active);

-- The counselor's query. POC reads stated interests off the profile and this
-- request; it never assumes a single academic theme.
create table if not exists public.opportunity_requests (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references public.profiles(id) on delete cascade,
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  target_axis_key  text,
  interests        text[] not null default '{}',
  directions       text,
  constraints      jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in ('queued','running','complete','failed')),
  ai_run_id        uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists opportunity_requests_student_idx
  on public.opportunity_requests (student_id, created_at desc);
drop trigger if exists opportunity_requests_set_updated_at on public.opportunity_requests;
create trigger opportunity_requests_set_updated_at before update on public.opportunity_requests
  for each row execute function public.set_updated_at();
select private.attach_student_policies('opportunity_requests');

-- Matches go through an explicit review+send workflow rather than being pushed
-- to the student by hand.
create table if not exists public.opportunity_matches (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null references public.profiles(id) on delete cascade,
  opportunity_id     uuid references public.opportunities(id) on delete set null,
  request_id         uuid references public.opportunity_requests(id) on delete set null,
  target_axis_key    text,
  name               text not null,
  org                text,
  url                text,
  apply_url          text,
  summary            text,
  why_fit            text,
  eligibility_notes  text,
  scheduling_notes   text,
  cost_note          text,
  deadline           date,
  score              numeric(4,3) check (score between 0 and 1),
  status             text not null default 'suggested' check (status in
                       ('suggested','counselor-review','approved','sent','saved','applied','dismissed')),
  reviewed_by        uuid references public.profiles(id) on delete set null,
  reviewed_at        timestamptz,
  sent_at            timestamptz,
  deadline_id        uuid references public.deadlines(id) on delete set null,
  citations          jsonb not null default '[]'::jsonb,
  ai_run_id          uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists opportunity_matches_student_idx
  on public.opportunity_matches (student_id, status, deadline);
drop trigger if exists opportunity_matches_set_updated_at on public.opportunity_matches;
create trigger opportunity_matches_set_updated_at before update on public.opportunity_matches
  for each row execute function public.set_updated_at();

alter table public.opportunity_matches enable row level security;

-- A student sees a recommendation only once the counselor has sent it.
drop policy if exists opportunity_matches_select on public.opportunity_matches;
create policy opportunity_matches_select on public.opportunity_matches
  for select to authenticated
  using (
    private.is_counselor_of(student_id, (select auth.uid()))
    or (student_id = (select auth.uid()) and status in ('sent','saved','applied'))
  );

drop policy if exists opportunity_matches_write_counselor on public.opportunity_matches;
create policy opportunity_matches_write_counselor on public.opportunity_matches
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));
