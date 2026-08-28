-- Counselor working surfaces: meeting notes, narrative flags, family reports,
-- school reframing. These are NOT plain student-scoped tables — a counselor's
-- private notes must not be readable by the student, so each one carries an
-- explicit visibility rule instead of the shared policy shape.

-- ---------------------------------------------------------------------------
-- Meeting notes
-- ---------------------------------------------------------------------------

create table if not exists public.meeting_notes (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  meeting_date  date not null default current_date,
  title         text not null check (length(btrim(title)) between 1 and 300),
  summary       text,
  body          text,
  tags          text[] not null default '{}',
  visibility    text not null default 'private' check (visibility in ('private','shared')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists meeting_notes_student_idx
  on public.meeting_notes (student_id, meeting_date desc);
drop trigger if exists meeting_notes_set_updated_at on public.meeting_notes;
create trigger meeting_notes_set_updated_at before update on public.meeting_notes
  for each row execute function public.set_updated_at();

alter table public.meeting_notes enable row level security;

drop policy if exists meeting_notes_select on public.meeting_notes;
create policy meeting_notes_select on public.meeting_notes
  for select to authenticated
  using (
    private.is_counselor_of(student_id, (select auth.uid()))
    or (student_id = (select auth.uid()) and visibility = 'shared')
  );

drop policy if exists meeting_notes_write on public.meeting_notes;
create policy meeting_notes_write on public.meeting_notes
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Narrative Coherence Engine output
-- ---------------------------------------------------------------------------

create table if not exists public.narrative_flags (
  id                   uuid primary key default gen_random_uuid(),
  student_id           uuid not null references public.profiles(id) on delete cascade,
  severity             text not null default 'medium' check (severity in ('high','medium','low')),
  title                text not null,
  detail               text,
  source_a             text,
  source_b             text,
  suggestion           text,
  citation             jsonb not null default '{}'::jsonb,
  status               text not null default 'open' check (status in ('open','resolved','dismissed')),
  shared_with_student  boolean not null default false,
  ai_run_id            uuid,
  resolved_by          uuid references public.profiles(id) on delete set null,
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists narrative_flags_student_idx
  on public.narrative_flags (student_id, status, severity);
drop trigger if exists narrative_flags_set_updated_at on public.narrative_flags;
create trigger narrative_flags_set_updated_at before update on public.narrative_flags
  for each row execute function public.set_updated_at();

alter table public.narrative_flags enable row level security;

drop policy if exists narrative_flags_select on public.narrative_flags;
create policy narrative_flags_select on public.narrative_flags
  for select to authenticated
  using (
    private.is_counselor_of(student_id, (select auth.uid()))
    or (student_id = (select auth.uid()) and shared_with_student)
  );

drop policy if exists narrative_flags_write on public.narrative_flags;
create policy narrative_flags_write on public.narrative_flags
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Family reports — drafted by the counselor, visible to the student once sent.
-- ---------------------------------------------------------------------------

create table if not exists public.family_reports (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  kind          text not null default 'progress'
                check (kind in ('progress','milestone','monthly','ad-hoc')),
  period_start  date,
  period_end    date,
  summary       text,
  highlights    text[] not null default '{}',
  body          text,
  status        text not null default 'draft' check (status in ('draft','sent','archived')),
  sent_at       timestamptz,
  ai_run_id     uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists family_reports_student_idx
  on public.family_reports (student_id, created_at desc);
drop trigger if exists family_reports_set_updated_at on public.family_reports;
create trigger family_reports_set_updated_at before update on public.family_reports
  for each row execute function public.set_updated_at();

alter table public.family_reports enable row level security;

drop policy if exists family_reports_select on public.family_reports;
create policy family_reports_select on public.family_reports
  for select to authenticated
  using (
    private.is_counselor_of(student_id, (select auth.uid()))
    or (student_id = (select auth.uid()) and status = 'sent')
  );

drop policy if exists family_reports_write on public.family_reports;
create policy family_reports_write on public.family_reports
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- School-specific reframing
-- ---------------------------------------------------------------------------

create table if not exists public.school_reframing (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  college_id    uuid references public.colleges(id) on delete set null,
  school        text not null,
  likes         jsonb not null default '[]'::jsonb,
  reframe_from  text,
  reframe_to    text,
  note          text,
  ai_run_id     uuid,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists school_reframing_student_idx
  on public.school_reframing (student_id, created_at desc);
drop trigger if exists school_reframing_set_updated_at on public.school_reframing;
create trigger school_reframing_set_updated_at before update on public.school_reframing
  for each row execute function public.set_updated_at();
select private.attach_student_policies('school_reframing');
