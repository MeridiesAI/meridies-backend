-- Intake overlay + answers, uploaded documents, external integrations,
-- guardian contacts, and the single notifications table the student "Updates"
-- page reads.

-- ---------------------------------------------------------------------------
-- Intake: the counselor's overlay (was localStorage) and the student's answers.
-- ---------------------------------------------------------------------------

create table if not exists public.intake_configs (
  id            uuid primary key default gen_random_uuid(),
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  name          text not null default 'Default intake',
  is_default    boolean not null default true,
  -- Keyed by section id -> { order[], disabled[], custom[] }; see lib/intakeConfig.ts
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists intake_configs_one_default
  on public.intake_configs (counselor_id) where is_default;
drop trigger if exists intake_configs_set_updated_at on public.intake_configs;
create trigger intake_configs_set_updated_at before update on public.intake_configs
  for each row execute function public.set_updated_at();

alter table public.intake_configs enable row level security;

drop policy if exists intake_configs_owner on public.intake_configs;
create policy intake_configs_owner on public.intake_configs
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

-- A student must be able to read the intake their counselor authored.
drop policy if exists intake_configs_select_assigned_student on public.intake_configs;
create policy intake_configs_select_assigned_student on public.intake_configs
  for select to authenticated
  using (counselor_id = private.get_user_counselor_id((select auth.uid())));

create table if not exists public.intake_responses (
  student_id         uuid primary key references public.profiles(id) on delete cascade,
  config_id          uuid references public.intake_configs(id) on delete set null,
  -- Flat AggregatorData map: { fieldId: value }. Grids store arrays of rows.
  answers            jsonb not null default '{}'::jsonb,
  completed_sections text[] not null default '{}',
  submitted_at       timestamptz,
  updated_at         timestamptz not null default now()
);

drop trigger if exists intake_responses_set_updated_at on public.intake_responses;
create trigger intake_responses_set_updated_at before update on public.intake_responses
  for each row execute function public.set_updated_at();
select private.attach_student_policies('intake_responses');

-- ---------------------------------------------------------------------------
-- Documents — transcripts, resumes, essays, award letters. `storage_path`
-- points at a Supabase Storage object; the row is the metadata + parse result.
-- ---------------------------------------------------------------------------

create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid references public.profiles(id) on delete cascade,
  owner_id       uuid not null references public.profiles(id) on delete cascade,
  bucket         text not null default 'student-documents',
  storage_path   text not null,
  filename       text not null,
  mime_type      text,
  size_bytes     bigint check (size_bytes >= 0),
  kind           text not null default 'other' check (kind in
                   ('transcript','resume','essay','test-report','award-letter',
                    'financial','common-app','other')),
  parse_status   text not null default 'pending'
                 check (parse_status in ('pending','parsing','parsed','failed','skipped')),
  parsed_data    jsonb not null default '{}'::jsonb,
  parse_error    text,
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists documents_student_idx on public.documents (student_id, created_at desc);
create unique index if not exists documents_bucket_path on public.documents (bucket, storage_path);
drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at before update on public.documents
  for each row execute function public.set_updated_at();

alter table public.documents enable row level security;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents
  for all to authenticated
  using (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_edit_student(student_id, (select auth.uid())))
  )
  with check (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_edit_student(student_id, (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- Data Hub integrations
-- ---------------------------------------------------------------------------

create table if not exists public.integrations (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles(id) on delete cascade,
  provider        text not null check (provider in
                    ('google-drive','common-app','scoir','maialearning','csv','gmail','outlook','twilio')),
  status          text not null default 'disconnected'
                  check (status in ('disconnected','connected','error','syncing')),
  -- Never store raw OAuth secrets here; the backend keeps them out of band.
  config          jsonb not null default '{}'::jsonb,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists integrations_owner_provider
  on public.integrations (owner_id, provider);
drop trigger if exists integrations_set_updated_at on public.integrations;
create trigger integrations_set_updated_at before update on public.integrations
  for each row execute function public.set_updated_at();

alter table public.integrations enable row level security;
drop policy if exists integrations_owner on public.integrations;
create policy integrations_owner on public.integrations
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Guardians — parents/carers who receive alerts and family reports. They are
-- contacts, not user accounts; nothing here grants app access.
-- ---------------------------------------------------------------------------

create table if not exists public.guardians (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null references public.profiles(id) on delete cascade,
  full_name          text not null check (length(btrim(full_name)) between 1 and 200),
  email              text,
  phone              text,
  relationship       text,
  preferred_channel  text not null default 'email' check (preferred_channel in ('email','sms','both')),
  alerts_enabled     boolean not null default true,
  receives_reports   boolean not null default true,
  is_primary         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint guardians_need_a_channel check (email is not null or phone is not null)
);

create index if not exists guardians_student_idx on public.guardians (student_id);
drop trigger if exists guardians_set_updated_at on public.guardians;
create trigger guardians_set_updated_at before update on public.guardians
  for each row execute function public.set_updated_at();
select private.attach_student_policies('guardians');

-- ---------------------------------------------------------------------------
-- Notifications — the student "Updates" feed and counselor alerts, one table.
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  student_id    uuid references public.profiles(id) on delete cascade,
  kind          text not null check (kind in
                  ('deadline','red-flag','report','invite','ai','policy',
                   'scholarship','aid','opportunity','system')),
  urgency       text not null default 'normal' check (urgency in ('critical','high','normal','low')),
  title         text not null,
  body          text,
  href          text,
  action_items  text[] not null default '{}',
  created_by    uuid references public.profiles(id) on delete set null,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (recipient_id) where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated using (recipient_id = (select auth.uid()));

-- Recipients may only mark their own notifications read.
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

-- A counselor may notify a student they own; nobody may forge a sender.
drop policy if exists notifications_insert_counselor on public.notifications;
create policy notifications_insert_counselor on public.notifications
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.can_view_student(recipient_id, (select auth.uid()))
  );
