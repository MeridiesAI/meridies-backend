-- Student accountability + parent communication.
--
-- The product thesis here: cut out excuses. Deliverable progress is measured
-- (word count + document activity), a red flag is raised when it stalls, the
-- student sees it, and if nothing moves before `escalate_at` a parent alert
-- fires automatically. Alerts are rate-limited by a per-counselor check period
-- so this can never become spam, can be turned off, and can be sent by hand.
--
-- There is deliberately no in-app messaging table: outbound goes to real email
-- and SMS via `message_deliveries`, because students don't check portals.

-- ---------------------------------------------------------------------------
-- Deliverables — the things with a progress bar.
-- ---------------------------------------------------------------------------

create table if not exists public.deliverables (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references public.profiles(id) on delete cascade,
  kind              text not null check (kind in
                      ('essay','common-app-section','activity-list','document',
                       'test-registration','recommendation','aid-form','custom')),
  title             text not null,
  essay_id          uuid references public.essays(id) on delete cascade,
  student_college_id uuid references public.student_colleges(id) on delete cascade,
  deadline_id       uuid references public.deadlines(id) on delete set null,
  target_words      integer check (target_words >= 0),
  current_words     integer not null default 0 check (current_words >= 0),
  -- 0..100. Word-count driven where a target exists, otherwise counselor-set.
  progress_pct      integer not null default 0 check (progress_pct between 0 and 100),
  status            text not null default 'not-started' check (status in
                      ('not-started','in-progress','stalled','review','complete')),
  due_date          date,
  last_activity_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists deliverables_student_idx on public.deliverables (student_id, status);
create index if not exists deliverables_stalled_idx
  on public.deliverables (last_activity_at) where status <> 'complete';
drop trigger if exists deliverables_set_updated_at on public.deliverables;
create trigger deliverables_set_updated_at before update on public.deliverables
  for each row execute function public.set_updated_at();
select private.attach_student_policies('deliverables');

-- Append-only activity log. "No document progress" is the absence of rows here.
create table if not exists public.progress_events (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.profiles(id) on delete cascade,
  deliverable_id  uuid references public.deliverables(id) on delete cascade,
  entity_type     text not null check (entity_type in
                    ('essay','activity','document','college','intake','deliverable')),
  entity_id       uuid,
  event           text not null check (event in
                    ('created','edited','uploaded','word-count-changed','status-changed','viewed')),
  word_delta      integer not null default 0,
  word_count      integer,
  actor_id        uuid references public.profiles(id) on delete set null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists progress_events_student_idx
  on public.progress_events (student_id, created_at desc);
create index if not exists progress_events_deliverable_idx
  on public.progress_events (deliverable_id, created_at desc);

alter table public.progress_events enable row level security;
drop policy if exists progress_events_select on public.progress_events;
create policy progress_events_select on public.progress_events
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));
drop policy if exists progress_events_insert on public.progress_events;
create policy progress_events_insert on public.progress_events
  for insert to authenticated
  with check (private.can_edit_student(student_id, (select auth.uid())));
-- No update/delete policy: the log is append-only.

-- ---------------------------------------------------------------------------
-- Draft quality — flags low-effort or likely-AI-generated drafts.
-- ---------------------------------------------------------------------------

create table if not exists public.draft_quality_checks (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references public.profiles(id) on delete cascade,
  essay_id       uuid references public.essays(id) on delete cascade,
  deliverable_id uuid references public.deliverables(id) on delete cascade,
  word_count     integer,
  ai_likelihood  numeric(4,3) check (ai_likelihood between 0 and 1),
  quality_score  numeric(4,3) check (quality_score between 0 and 1),
  verdict        text check (verdict in ('ok','low-effort','likely-ai','needs-review')),
  findings       jsonb not null default '[]'::jsonb,
  ai_run_id      uuid,
  checked_at     timestamptz not null default now()
);

create index if not exists draft_quality_checks_student_idx
  on public.draft_quality_checks (student_id, checked_at desc);
select private.attach_student_policies('draft_quality_checks');

-- ---------------------------------------------------------------------------
-- Accountability settings — the throttle that keeps alerts from being spam.
-- Scoped to a counselor, optionally overridden for one student.
-- ---------------------------------------------------------------------------

create table if not exists public.accountability_settings (
  id                       uuid primary key default gen_random_uuid(),
  counselor_id             uuid not null references public.profiles(id) on delete cascade,
  student_id               uuid references public.profiles(id) on delete cascade,
  enabled                  boolean not null default true,
  -- How long with no progress before a deliverable counts as stalled.
  stall_after_days         integer not null default 7 check (stall_after_days between 1 and 90),
  -- How long a student has to act on a red flag before parents are told.
  escalate_after_hours     integer not null default 72 check (escalate_after_hours between 1 and 720),
  -- Hard floor between two alerts about the same student. Anti-spam.
  min_days_between_alerts  integer not null default 7 check (min_days_between_alerts between 1 and 90),
  auto_send_parent_alerts  boolean not null default false,
  alert_on_low_quality     boolean not null default true,
  quiet_hours_start        smallint check (quiet_hours_start between 0 and 23),
  quiet_hours_end          smallint check (quiet_hours_end between 0 and 23),
  timezone                 text not null default 'America/New_York',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists accountability_settings_scope
  on public.accountability_settings
     (counselor_id, coalesce(student_id, '00000000-0000-0000-0000-000000000000'::uuid));
drop trigger if exists accountability_settings_set_updated_at on public.accountability_settings;
create trigger accountability_settings_set_updated_at before update on public.accountability_settings
  for each row execute function public.set_updated_at();

alter table public.accountability_settings enable row level security;
drop policy if exists accountability_settings_owner on public.accountability_settings;
create policy accountability_settings_owner on public.accountability_settings
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Red flags — visible to the student: "this is critical, do it now."
-- ---------------------------------------------------------------------------

create table if not exists public.red_flags (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references public.profiles(id) on delete cascade,
  deliverable_id    uuid references public.deliverables(id) on delete set null,
  deadline_id       uuid references public.deadlines(id) on delete set null,
  severity          text not null default 'critical' check (severity in ('critical','high','medium')),
  title             text not null,
  message           text not null,
  action_items      text[] not null default '{}',
  trigger           text not null default 'no-progress' check (trigger in
                      ('no-progress','low-quality','likely-ai','missed-deadline','manual')),
  issued_by         text not null default 'system' check (issued_by in ('system','counselor')),
  issued_by_id      uuid references public.profiles(id) on delete set null,
  -- Baseline the escalation check compares against.
  baseline_words    integer,
  escalate_at       timestamptz,
  escalated_at      timestamptz,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  status            text not null default 'open' check (status in
                      ('open','acknowledged','escalated','resolved','cancelled')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists red_flags_student_idx on public.red_flags (student_id, status);
create index if not exists red_flags_pending_escalation_idx
  on public.red_flags (escalate_at) where status = 'open';
drop trigger if exists red_flags_set_updated_at on public.red_flags;
create trigger red_flags_set_updated_at before update on public.red_flags
  for each row execute function public.set_updated_at();

alter table public.red_flags enable row level security;

drop policy if exists red_flags_select on public.red_flags;
create policy red_flags_select on public.red_flags
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

-- Only the counselor may raise or cancel a flag; the student may acknowledge
-- theirs (the UPDATE policy is intentionally the only student write path).
drop policy if exists red_flags_write_counselor on public.red_flags;
create policy red_flags_write_counselor on public.red_flags
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

drop policy if exists red_flags_acknowledge_self on public.red_flags;
create policy red_flags_acknowledge_self on public.red_flags
  for update to authenticated
  using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Parent alerts — queued, throttled, reviewable, sendable by hand.
-- ---------------------------------------------------------------------------

create table if not exists public.parent_alerts (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references public.profiles(id) on delete cascade,
  guardian_id    uuid references public.guardians(id) on delete set null,
  red_flag_id    uuid references public.red_flags(id) on delete set null,
  counselor_id   uuid references public.profiles(id) on delete set null,
  trigger        text not null check (trigger in
                   ('no-progress','low-quality','likely-ai','missed-deadline','manual','escalation')),
  urgency        text not null default 'high' check (urgency in ('critical','high','normal')),
  subject        text not null,
  body           text not null,
  action_items   text[] not null default '{}',
  channel        text not null default 'email' check (channel in ('email','sms','both')),
  status         text not null default 'queued' check (status in
                   ('queued','scheduled','sent','failed','cancelled','suppressed')),
  suppressed_reason text,
  scheduled_for  timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists parent_alerts_student_idx on public.parent_alerts (student_id, created_at desc);
create index if not exists parent_alerts_due_idx on public.parent_alerts (scheduled_for)
  where status in ('queued','scheduled');
drop trigger if exists parent_alerts_set_updated_at on public.parent_alerts;
create trigger parent_alerts_set_updated_at before update on public.parent_alerts
  for each row execute function public.set_updated_at();

alter table public.parent_alerts enable row level security;

-- Counselors only. A student cannot read or suppress alerts about themselves.
drop policy if exists parent_alerts_counselor on public.parent_alerts;
create policy parent_alerts_counselor on public.parent_alerts
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Outbound delivery log — email/SMS instead of an in-app inbox.
-- ---------------------------------------------------------------------------

create table if not exists public.message_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid references public.profiles(id) on delete cascade,
  parent_alert_id     uuid references public.parent_alerts(id) on delete set null,
  family_report_id    uuid references public.family_reports(id) on delete set null,
  recipient_kind      text not null check (recipient_kind in ('guardian','student','counselor')),
  recipient_id        uuid,
  to_email            text,
  to_phone            text,
  channel             text not null check (channel in ('email','sms')),
  provider            text,
  provider_message_id text,
  template            text,
  subject             text,
  body                text,
  status              text not null default 'queued' check (status in
                        ('queued','sent','delivered','bounced','failed','cancelled')),
  error               text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists message_deliveries_student_idx
  on public.message_deliveries (student_id, created_at desc);
drop trigger if exists message_deliveries_set_updated_at on public.message_deliveries;
create trigger message_deliveries_set_updated_at before update on public.message_deliveries
  for each row execute function public.set_updated_at();

alter table public.message_deliveries enable row level security;
drop policy if exists message_deliveries_counselor on public.message_deliveries;
create policy message_deliveries_counselor on public.message_deliveries
  for select to authenticated
  using (student_id is not null and private.is_counselor_of(student_id, (select auth.uid())));
-- Writes happen from the backend as service_role; there is no client insert path.
