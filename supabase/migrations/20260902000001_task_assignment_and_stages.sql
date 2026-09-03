-- Multi-stage task assignment.
--
-- `public.deliverables` already models "the thing with a progress bar", but the
-- September 2026 brief assigns it: the counselor writes a free-text instruction
-- both parties see, attaches the documents the student works off, sets ONE OR
-- MORE dated stages ("a multi-step process"), and presses Create task — which
-- texts and/or emails the student.
--
-- Three things were missing and are added here:
--   deliverables.instructions + the assignment/notification columns
--   public.deliverable_stages     -- the named, dated steps
--   public.deliverable_documents  -- the documents the task is worked off
--
-- Everything is student-scoped, so `private.attach_student_policies` stamps the
-- standard four policies rather than four hand-written ones.

-- ---------------------------------------------------------------------------
-- The assignment itself
-- ---------------------------------------------------------------------------

alter table public.deliverables
  -- Shown to BOTH parties. This is the assignment the AI tracker later compares
  -- uploaded work against, so it is a first-class column, not a note.
  add column if not exists instructions      text check (length(instructions) <= 8000),
  add column if not exists assigned_by       uuid references public.profiles(id) on delete set null,
  add column if not exists assigned_at       timestamptz,
  -- Channels chosen at assignment time, not global preferences: the counselor
  -- decides per task whether this one is worth a text.
  add column if not exists notify_email      boolean not null default true,
  add column if not exists notify_sms        boolean not null default false,
  add column if not exists notified_at       timestamptz,
  add column if not exists notify_error      text;

comment on column public.deliverables.instructions is
  'Free-text assignment shown to the student and the counselor. The document tracker scores uploaded work against this text.';
comment on column public.deliverables.notify_sms is
  'Chosen per assignment. SMS has no provider wired yet: the delivery row is queued for the outbound worker rather than pretended sent.';

create index if not exists deliverables_assigned_idx
  on public.deliverables (assigned_by, assigned_at desc);

-- ---------------------------------------------------------------------------
-- Stages — "multiple deadlines can be made if it is a multi-step process".
--
-- A single-deadline task simply has one stage (or none, and uses due_date).
-- `deadline_id` lets a stage surface in the existing Deadline Command Center
-- instead of standing up a second deadline tracker.
-- ---------------------------------------------------------------------------

create table if not exists public.deliverable_stages (
  id              uuid primary key default gen_random_uuid(),
  deliverable_id  uuid not null references public.deliverables(id) on delete cascade,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 300),
  detail          text check (length(detail) <= 2000),
  due_date        date,
  sequence        integer not null default 0 check (sequence between 0 and 100),
  done            boolean not null default false,
  done_at         timestamptz,
  completed_by    uuid references public.profiles(id) on delete set null,
  deadline_id     uuid references public.deadlines(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists deliverable_stages_sequence
  on public.deliverable_stages (deliverable_id, sequence);
create index if not exists deliverable_stages_student_idx
  on public.deliverable_stages (student_id, due_date);
create index if not exists deliverable_stages_open_idx
  on public.deliverable_stages (deliverable_id, sequence) where not done;

drop trigger if exists deliverable_stages_set_updated_at on public.deliverable_stages;
create trigger deliverable_stages_set_updated_at before update on public.deliverable_stages
  for each row execute function public.set_updated_at();

select private.attach_student_policies('deliverable_stages');

-- ---------------------------------------------------------------------------
-- The documents a task is worked off.
--
-- Link table rather than documents.deliverable_id: one uploaded rubric or
-- exemplar is routinely attached to several students' tasks, and a task
-- routinely carries several documents.
-- ---------------------------------------------------------------------------

create table if not exists public.deliverable_documents (
  deliverable_id  uuid not null references public.deliverables(id) on delete cascade,
  document_id     uuid not null references public.documents(id) on delete cascade,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'reference'
                  check (role in ('reference','starting-point','rubric','submission','example')),
  note            text check (length(note) <= 500),
  added_by        uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (deliverable_id, document_id)
);

create index if not exists deliverable_documents_document_idx
  on public.deliverable_documents (document_id);
create index if not exists deliverable_documents_student_idx
  on public.deliverable_documents (student_id);

comment on column public.deliverable_documents.role is
  'reference/starting-point/rubric/example are what the counselor gave the student; submission is what the student handed back.';

select private.attach_student_policies('deliverable_documents');

-- ---------------------------------------------------------------------------
-- Delivery log: tie an outbound message back to the task that caused it.
-- `message_deliveries` is written by the backend as service_role; no client
-- insert path exists, so no new policy is needed.
-- ---------------------------------------------------------------------------

alter table public.message_deliveries
  add column if not exists deliverable_id uuid references public.deliverables(id) on delete set null;

create index if not exists message_deliveries_deliverable_idx
  on public.message_deliveries (deliverable_id);
