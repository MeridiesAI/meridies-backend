-- ---------------------------------------------------------------------------
-- Demo v5 feature parity.
--
-- The demo (`MeridiesAI/meridies-demo`) prototyped a batch of features that had
-- no table behind them because nothing in that repo persists. This migration is
-- the real storage for the ones that are genuinely user-authored, plus the two
-- reference-data shapes the v5 brief changed:
--
--   preference_cards / student_preference_cards  -- the subjective card sort
--   polygon_axis_history                         -- a real time series, not back-modelling
--   student_alert_prefs                          -- who is copied on alerts
--   student_status_overrides                     -- the counselor's own read on a student
--   meetings                                     -- scheduled sessions, not just their notes
--   high_school_rank_bands + high_schools.*      -- published GPA cut-offs, for percentile
--   college_aid_ratings (reshaped)               -- generosity is THREE ratings, not one
--   college_aid_band_ratings                     -- the per-income-band table behind the third
--   roster_imports / roster_import_rows          -- CSV + suite roster ingest
--
-- Every table ships its own RLS. Where the standard student-scoped shape is
-- right, `private.attach_student_policies()` stamps it; where it is wrong —
-- because the row is a judgement ABOUT a student rather than a record OF one —
-- the policies are hand-written and say so.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Preference cards.
--
-- 26 situations a student sorts love -> really bad. The deck is catalog data so
-- that two students' answers are comparable and a card can be retired without
-- rewriting anyone's history; the ratings are the student's own.
--
-- `counselor_note` is deliberately on the card and deliberately not shown to
-- the student: it is why a counselor cares about the answer, and showing it
-- would coach the answer it is trying to read.
-- ---------------------------------------------------------------------------

create table if not exists public.preference_cards (
  id              uuid primary key default gen_random_uuid(),
  card_key        text not null unique check (card_key ~ '^[a-z0-9-]{1,60}$'),
  category        text not null check (category in
                    ('campus-life-and-food','location-and-seasons','financial-outlook',
                     'academics-and-teaching','social-and-size','studying-outside-the-us')),
  category_label  text not null check (length(btrim(category_label)) between 1 and 80),
  -- The situation, in the second person, short enough to read in one beat.
  prompt          text not null check (length(btrim(prompt)) between 1 and 400),
  counselor_note  text check (length(counselor_note) <= 600),
  -- A school this is genuinely true of, so the card is concrete.
  example         text check (length(example) <= 200),
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists preference_cards_deck_idx
  on public.preference_cards (category, sort_order) where is_active;

drop trigger if exists preference_cards_set_updated_at on public.preference_cards;
create trigger preference_cards_set_updated_at before update on public.preference_cards
  for each row execute function public.set_updated_at();

comment on table public.preference_cards is
  'The subjective college-preference deck. Catalog data, maintained by service_role — a card is never authored from a client.';
comment on column public.preference_cards.counselor_note is
  'Why a counselor cares about the answer. Served only to counselors: showing it to the student would coach the answer.';

alter table public.preference_cards enable row level security;
drop policy if exists preference_cards_select on public.preference_cards;
create policy preference_cards_select on public.preference_cards
  for select to authenticated using (true);

create table if not exists public.student_preference_cards (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  card_id     uuid not null references public.preference_cards(id) on delete cascade,
  rating      text not null check (rating in ('love','good','okay','bad','really-bad')),
  rated_by    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists student_preference_cards_one_per_card
  on public.student_preference_cards (student_id, card_id);
create index if not exists student_preference_cards_student_idx
  on public.student_preference_cards (student_id, updated_at desc);

drop trigger if exists student_preference_cards_set_updated_at on public.student_preference_cards;
create trigger student_preference_cards_set_updated_at before update on public.student_preference_cards
  for each row execute function public.set_updated_at();

comment on table public.student_preference_cards is
  'A student''s card sort. The counselor may also record it — the sort often happens out loud in a session — which is why the standard student-scoped policies apply rather than student-only ones.';

select private.attach_student_policies('student_preference_cards');

-- ---------------------------------------------------------------------------
-- Polygon history.
--
-- The demo fabricates growth backwards from today's scores because it has
-- nowhere to put the past. This is that missing table. It is append-only: a
-- history a counselor can edit is a chart, not a record. Rows are written by a
-- trigger on the axes themselves, so no route can forget to record a change.
-- ---------------------------------------------------------------------------

create table if not exists public.polygon_axis_history (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  axis_key     text not null check (axis_key ~ '^[a-z0-9-]{1,40}$'),
  label        text not null,
  score        numeric(6,2) not null,
  max_score    integer not null default 100,
  -- Which number moved: the derived one, or the counselor's override.
  is_manual    boolean not null default false,
  source       text not null default 'default' check (source in ('default','custom')),
  recorded_by  uuid references public.profiles(id) on delete set null,
  recorded_at  timestamptz not null default now()
);

create index if not exists polygon_axis_history_series_idx
  on public.polygon_axis_history (student_id, axis_key, recorded_at desc);
create index if not exists polygon_axis_history_student_idx
  on public.polygon_axis_history (student_id, recorded_at desc);

comment on table public.polygon_axis_history is
  'Append-only time series of polygon axis scores. Select and insert policies only — there is deliberately no update or delete path.';

alter table public.polygon_axis_history enable row level security;

drop policy if exists polygon_axis_history_select on public.polygon_axis_history;
create policy polygon_axis_history_select on public.polygon_axis_history
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists polygon_axis_history_insert on public.polygon_axis_history;
create policy polygon_axis_history_insert on public.polygon_axis_history
  for insert to authenticated
  with check (private.can_edit_student(student_id, (select auth.uid())));

-- SECURITY DEFINER so the append always happens: the history must not depend on
-- the writer also holding an insert grant on a second table.
create or replace function private.polygon_axes_record_history()
returns trigger
language plpgsql
security definer
set search_path to 'private','public','pg_temp'
as $function$
begin
  -- `score` is generated from auto_score/manual_score, so this catches every
  -- real movement and ignores relabels, reorders and note edits.
  if tg_op = 'UPDATE' and new.score is not distinct from old.score then
    return new;
  end if;

  insert into public.polygon_axis_history
    (student_id, axis_key, label, score, max_score, is_manual, source, recorded_by)
  values
    (new.student_id, new.key, new.label, new.score, new.max_score,
     new.manual_score is not null, new.source, auth.uid());

  return new;
end;
$function$;

revoke all on function private.polygon_axes_record_history() from public, anon, authenticated;

drop trigger if exists student_polygon_axes_record_history on public.student_polygon_axes;
create trigger student_polygon_axes_record_history
  after insert or update on public.student_polygon_axes
  for each row execute function private.polygon_axes_record_history();

-- ---------------------------------------------------------------------------
-- Alert recipient preferences.
--
-- Per student: are the guardians copied on alerts and family updates, is the
-- student themselves copied. NOT `attach_student_policies` — the standard shape
-- would let a student switch off the alerts their counselor sends about them,
-- which is the one thing this switch must not allow.
-- ---------------------------------------------------------------------------

create table if not exists public.student_alert_prefs (
  student_id     uuid primary key references public.profiles(id) on delete cascade,
  copy_parents   boolean not null default true,
  copy_student   boolean not null default false,
  note           text check (length(note) <= 1000),
  updated_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists student_alert_prefs_set_updated_at on public.student_alert_prefs;
create trigger student_alert_prefs_set_updated_at before update on public.student_alert_prefs
  for each row execute function public.set_updated_at();

comment on table public.student_alert_prefs is
  'Who is copied on accountability alerts and family updates. Counselor-written: a student must not be able to switch off alerts about themselves. Readable by the student so the arrangement is not a secret.';

alter table public.student_alert_prefs enable row level security;

drop policy if exists student_alert_prefs_select on public.student_alert_prefs;
create policy student_alert_prefs_select on public.student_alert_prefs
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists student_alert_prefs_write on public.student_alert_prefs;
create policy student_alert_prefs_write on public.student_alert_prefs
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Counselor status override.
--
-- The roster derives a status from the work; this is the counselor overruling
-- it because they were in the room. Counselor-only in both directions: "at
-- risk" is a private professional assessment, and the same reasoning that keeps
-- `parent_alerts` away from the student it concerns applies here.
-- ---------------------------------------------------------------------------

create table if not exists public.student_status_overrides (
  student_id   uuid primary key references public.profiles(id) on delete cascade,
  status       text not null check (status in ('on-track','at-risk','ahead')),
  note         text check (length(note) <= 2000),
  set_by       uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists student_status_overrides_set_updated_at on public.student_status_overrides;
create trigger student_status_overrides_set_updated_at before update on public.student_status_overrides
  for each row execute function public.set_updated_at();

comment on table public.student_status_overrides is
  'A counselor''s own read on a student, overruling the derived status. Counselor-only for select as well as write — it is an assessment about the student, not a record belonging to them.';

alter table public.student_status_overrides enable row level security;

drop policy if exists student_status_overrides_counselor on public.student_status_overrides;
create policy student_status_overrides_counselor on public.student_status_overrides
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Meetings.
--
-- `meeting_notes` records what was said; nothing recorded that a meeting was
-- going to happen. Modes are Google Meet, in person and phone — Zoom was
-- dropped in the v5 brief and is not a missing value.
-- ---------------------------------------------------------------------------

create table if not exists public.meetings (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references public.profiles(id) on delete cascade,
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 300),
  mode             text not null default 'google-meet'
                   check (mode in ('google-meet','in-person','phone')),
  location         text check (length(location) <= 300),
  join_url         text check (join_url ~ '^https?://'),
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  status           text not null default 'scheduled'
                   check (status in ('scheduled','held','cancelled','no-show')),
  agenda           text check (length(agenda) <= 4000),
  guardians_invited boolean not null default false,
  meeting_note_id  uuid references public.meeting_notes(id) on delete set null,
  deadline_id      uuid references public.deadlines(id) on delete set null,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint meetings_end_after_start check (ends_at is null or ends_at > starts_at)
);

create index if not exists meetings_student_idx on public.meetings (student_id, starts_at desc);
create index if not exists meetings_counselor_idx on public.meetings (counselor_id, starts_at);
create index if not exists meetings_upcoming_idx
  on public.meetings (counselor_id, starts_at) where status = 'scheduled';

drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at before update on public.meetings
  for each row execute function public.set_updated_at();

comment on column public.meetings.mode is
  'Google Meet, in person or phone. Zoom was removed in the v5 brief — do not add it back as a "missing" value.';

alter table public.meetings enable row level security;

drop policy if exists meetings_select on public.meetings;
create policy meetings_select on public.meetings
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

-- The counselor owns the calendar. A student sees their meetings and cannot
-- move them.
drop policy if exists meetings_write on public.meetings;
create policy meetings_write on public.meetings
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- High school profiles: the published numbers, and the rank bands.
--
-- A weighted GPA means nothing until it is read against the school's own
-- published cut-offs. Roughly one school in six publishes no profile at all,
-- so every read of this has to be able to return "unknown" rather than guess.
-- ---------------------------------------------------------------------------

-- The existing `type` already carries the school's sector; it just never had
-- the two values an independent-counselor roster is full of.
alter table public.high_schools drop constraint if exists high_schools_type_check;
alter table public.high_schools add constraint high_schools_type_check check (type in (
  'public','private','independent','parochial','charter','magnet',
  'boarding','international','homeschool','other'
));

alter table public.high_schools
  add column if not exists enrollment            integer check (enrollment >= 0),
  add column if not exists graduating_class      integer check (graduating_class >= 0),
  add column if not exists weighted_scale_max    numeric(4,2) check (weighted_scale_max between 0 and 20),
  add column if not exists unweighted_scale_max  numeric(4,2) check (unweighted_scale_max between 0 and 20),
  add column if not exists ap_cap                text check (length(ap_cap) <= 200),
  add column if not exists ib_courses_offered    integer check (ib_courses_offered >= 0),
  add column if not exists median_sat            integer check (median_sat between 400 and 1600),
  add column if not exists median_act            integer check (median_act between 1 and 36),
  add column if not exists students_per_counselor integer check (students_per_counselor >= 0),
  add column if not exists matriculation         text[] not null default '{}',
  add column if not exists profile_notes         text[] not null default '{}',
  add column if not exists source_label          text check (length(source_label) <= 300);

comment on column public.high_schools.ap_cap is
  'Cap the school places on how many APs a student may take per year, if any. A "light" course load reads differently when the school forbids a heavier one.';
comment on column public.high_schools.students_per_counselor is
  'The number that explains the caseload, and therefore how much of the school''s own guidance a family has actually had.';

create table if not exists public.high_school_rank_bands (
  id                  uuid primary key default gen_random_uuid(),
  high_school_id      uuid not null references public.high_schools(id) on delete cascade,
  -- "Top decile", "Top quartile", "Top half" — the school's own wording.
  label               text not null check (length(btrim(label)) between 1 and 80),
  min_weighted_gpa    numeric(4,3) not null check (min_weighted_gpa between 0 and 20),
  percentile          smallint not null check (percentile between 1 and 100),
  sort_order          integer not null default 0,
  provenance          public.data_provenance,
  source_url          text,
  source_verified_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists high_school_rank_bands_label
  on public.high_school_rank_bands (high_school_id, lower(label));
create index if not exists high_school_rank_bands_curve_idx
  on public.high_school_rank_bands (high_school_id, min_weighted_gpa desc);

drop trigger if exists high_school_rank_bands_set_updated_at on public.high_school_rank_bands;
create trigger high_school_rank_bands_set_updated_at before update on public.high_school_rank_bands
  for each row execute function public.set_updated_at();

comment on table public.high_school_rank_bands is
  'Published weighted-GPA cut-offs per band. A school with no rows here publishes nothing, and a percentile must be reported as unknown rather than interpolated from a national assumption.';

alter table public.high_school_rank_bands enable row level security;
drop policy if exists high_school_rank_bands_select on public.high_school_rank_bands;
create policy high_school_rank_bands_select on public.high_school_rank_bands
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Aid generosity is three ratings, not one.
--
-- v5: need-based, merit-based, and income-band-specific — the third read as
-- CONSISTENCY across bands, so 10 means the headline holds wherever the family
-- sits and a low score means the per-band table below is the only honest
-- answer. The table shipped with a single row per college; it now takes three,
-- and `rating_kind` stays pinned to 'meridies-curated' because that is the
-- label that keeps a Meridies judgement out of a grid of federal statistics.
-- ---------------------------------------------------------------------------

alter table public.college_aid_ratings
  add column if not exists kind  text not null default 'need-based',
  add column if not exists label text check (length(label) <= 120);

alter table public.college_aid_ratings drop constraint if exists college_aid_ratings_kind_check;
alter table public.college_aid_ratings add constraint college_aid_ratings_kind_check
  check (kind in ('need-based','merit-based','income-band-consistency'));

alter table public.college_aid_ratings drop constraint if exists college_aid_ratings_pkey;
alter table public.college_aid_ratings add constraint college_aid_ratings_pkey
  primary key (college_id, kind);

comment on column public.college_aid_ratings.kind is
  'Which of the three v5 generosity ratings this row is. "income-band-consistency" scores how steady the headline is across income bands, not how generous the school is to one band.';
comment on column public.college_aid_ratings.rating_kind is
  'Always "meridies-curated". This is the label that keeps the rating from being read as a reported statistic.';

create table if not exists public.college_aid_band_ratings (
  college_id          uuid not null references public.colleges(id) on delete cascade,
  -- Machine key; `band_label` is what a family reads.
  band                text not null check (band in
                        ('under-60k','60-110k','110-150k','150-200k','200-250k','250k-plus')),
  band_label          text not null check (length(btrim(band_label)) between 1 and 40),
  rating              smallint not null check (rating between 1 and 10),
  note                text check (length(note) <= 1000),
  sort_order          integer not null default 0,
  rating_kind         text not null default 'meridies-curated'
                      check (rating_kind = 'meridies-curated'),
  provenance          public.data_provenance,
  source_url          text,
  rated_by            uuid references public.profiles(id) on delete set null,
  rated_at            timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (college_id, band)
);

create index if not exists college_aid_band_ratings_order_idx
  on public.college_aid_band_ratings (college_id, sort_order);

drop trigger if exists college_aid_band_ratings_set_updated_at on public.college_aid_band_ratings;
create trigger college_aid_band_ratings_set_updated_at before update on public.college_aid_band_ratings
  for each row execute function public.set_updated_at();

comment on table public.college_aid_band_ratings is
  'Generosity band by band — the whole argument behind the income-band-consistency rating. When that rating is low this table, not the headline, is the answer.';

alter table public.college_aid_band_ratings enable row level security;
drop policy if exists college_aid_band_ratings_select on public.college_aid_band_ratings;
create policy college_aid_band_ratings_select on public.college_aid_band_ratings
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Roster imports.
--
-- A CSV or a suite file becomes invitations, never profiles: an account is
-- created by Supabase Auth when the student accepts, so an import stages the
-- rows and the counselor sends from there. The detected column mapping is
-- stored with the import because "which column was GPA" is the question asked
-- when a number later looks wrong.
-- ---------------------------------------------------------------------------

create table if not exists public.roster_imports (
  id             uuid primary key default gen_random_uuid(),
  counselor_id   uuid not null references public.profiles(id) on delete cascade,
  filename       text not null check (length(btrim(filename)) between 1 and 300),
  source         text not null default 'csv'
                 check (source in ('csv','google','microsoft','manual')),
  -- { "<source column>": "<meridies field>" } as confirmed by the counselor,
  -- not as detected.
  mapping        jsonb not null default '{}'::jsonb,
  status         text not null default 'mapping'
                 check (status in ('mapping','importing','complete','failed')),
  rows_total     integer not null default 0 check (rows_total >= 0),
  rows_imported  integer not null default 0 check (rows_imported >= 0),
  rows_skipped   integer not null default 0 check (rows_skipped >= 0),
  rows_failed    integer not null default 0 check (rows_failed >= 0),
  error          text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists roster_imports_counselor_idx
  on public.roster_imports (counselor_id, created_at desc);

drop trigger if exists roster_imports_set_updated_at on public.roster_imports;
create trigger roster_imports_set_updated_at before update on public.roster_imports
  for each row execute function public.set_updated_at();

alter table public.roster_imports enable row level security;
drop policy if exists roster_imports_owner on public.roster_imports;
create policy roster_imports_owner on public.roster_imports
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

create table if not exists public.roster_import_rows (
  id                uuid primary key default gen_random_uuid(),
  import_id         uuid not null references public.roster_imports(id) on delete cascade,
  counselor_id      uuid not null references public.profiles(id) on delete cascade,
  row_number        integer not null check (row_number >= 1),
  full_name         text check (length(full_name) <= 200),
  email             text check (length(email) <= 320),
  phone             text check (length(phone) <= 40),
  grade_level       text check (length(grade_level) <= 40),
  grad_year         integer check (grad_year between 1900 and 2200),
  high_school       text check (length(high_school) <= 200),
  gpa_weighted      numeric(4,3) check (gpa_weighted between 0 and 20),
  gpa_unweighted    numeric(4,3) check (gpa_unweighted between 0 and 20),
  sat_total         integer check (sat_total between 400 and 1600),
  act_composite     integer check (act_composite between 1 and 36),
  intended_major    text check (length(intended_major) <= 200),
  status            text not null default 'pending'
                    check (status in ('pending','invited','skipped','failed')),
  skip_reason       text check (length(skip_reason) <= 300),
  invitation_id     uuid references public.invitations(id) on delete set null,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists roster_import_rows_row_number
  on public.roster_import_rows (import_id, row_number);
create index if not exists roster_import_rows_pending_idx
  on public.roster_import_rows (import_id, status);

drop trigger if exists roster_import_rows_set_updated_at on public.roster_import_rows;
create trigger roster_import_rows_set_updated_at before update on public.roster_import_rows
  for each row execute function public.set_updated_at();

comment on table public.roster_import_rows is
  'Staged rows. Importing never writes public.profiles — an account exists only once Supabase Auth creates it, so a row becomes an invitation and waits.';

alter table public.roster_import_rows enable row level security;
drop policy if exists roster_import_rows_owner on public.roster_import_rows;
create policy roster_import_rows_owner on public.roster_import_rows
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Suite integrations: one consent covers a whole provider.
--
-- The demo models a single Google or Microsoft grant that lights up Drive,
-- Gmail and Calendar together, rather than three separate connections. The
-- granular provider values stay for the imports that really are separate.
-- ---------------------------------------------------------------------------

alter table public.integrations
  add column if not exists scopes text[] not null default '{}';

-- One grant per provider per owner. Nothing had a route to write this table
-- until now, so any duplicate here is noise from a manual insert; keep the most
-- recently updated row so a reconnect wins over a stale one.
delete from public.integrations a
  using public.integrations b
 where a.owner_id = b.owner_id
   and a.provider = b.provider
   and (a.updated_at, a.id) < (b.updated_at, b.id);

create unique index if not exists integrations_owner_provider
  on public.integrations (owner_id, provider);

alter table public.integrations drop constraint if exists integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check check (provider in (
  'google','microsoft',
  'google-drive','google-calendar','onedrive',
  'common-app','scoir','maialearning','csv','gmail','outlook','twilio'
));

comment on column public.integrations.scopes is
  'OAuth scopes actually granted, so the Manage panel can show what was consented to rather than what was asked for. Never the tokens themselves — those stay out of band.';

-- ---------------------------------------------------------------------------
-- New AI modules: the parent-alert draft and the filing suggestion.
-- ---------------------------------------------------------------------------

alter table public.ai_runs drop constraint if exists ai_runs_module_check;
alter table public.ai_runs add constraint ai_runs_module_check check (module in (
  'profile-summary','narrative-coherence','family-report','school-reframing',
  'college-list','college-fit','concierge','scholarship-match','award-appeal',
  'aid-report','draft-quality','essay-advice','visualizer','chat',
  'document-tracker','essay-review','link-digest',
  -- new: the parent alert a counselor edits before sending, and the folder
  -- suggestion a counselor confirms before a dropped file is filed.
  'parent-alert','file-filing'
));
