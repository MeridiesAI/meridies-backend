-- The AI document tracker, per task.
--
-- Two signals already exist and are NOT duplicated here:
--   activity  -> public.progress_events (the absence of rows is the stall)
--   quality   -> public.draft_quality_checks (effort / likely-AI, per essay)
--
-- What neither answers is the brief's actual question: does this document do
-- what the task asked for? That is assignment-relative, so it needs the
-- assignment as an input and a verdict of its own.
--
--   on-track        -- moving, and what's there matches the instructions
--   no-activity     -- nothing has happened inside the stall window
--   below-the-brief -- there IS work, but it doesn't answer the assignment
--
-- One row per check, append-only in practice: the history is how a counselor
-- shows a family that this was flagged three weeks ago.

create table if not exists public.deliverable_tracker_checks (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.profiles(id) on delete cascade,
  deliverable_id      uuid not null references public.deliverables(id) on delete cascade,
  -- The document actually judged, when the verdict is about one. Null for a
  -- pure no-activity verdict, where the point is that nothing was uploaded.
  document_id         uuid references public.documents(id) on delete set null,
  verdict             text not null check (verdict in ('on-track','no-activity','below-the-brief')),
  -- One line, counselor-facing, human-readable. Deliberately short: this is the
  -- sentence that appears next to the task in the UI.
  note                text not null check (length(btrim(note)) between 1 and 300),
  -- 0..1, how well the work matches the assignment text. Null when there was
  -- nothing to compare.
  alignment_score     numeric(4,3) check (alignment_score between 0 and 1),
  -- The stall arithmetic that produced a no-activity verdict, kept so the
  -- verdict can be explained without recomputing it.
  days_since_activity integer check (days_since_activity >= 0),
  stall_after_days    integer check (stall_after_days between 1 and 90),
  documents_checked   integer not null default 0 check (documents_checked >= 0),
  -- Short, specific observations; never prose the student could paste.
  findings            jsonb not null default '[]'::jsonb,
  -- 'system' when the stall rules alone decided it, 'ai' when a model compared
  -- the document against the assignment.
  source              text not null default 'system' check (source in ('system','ai','counselor')),
  ai_run_id           uuid,
  checked_by          uuid references public.profiles(id) on delete set null,
  checked_at          timestamptz not null default now()
);

create index if not exists deliverable_tracker_checks_deliverable_idx
  on public.deliverable_tracker_checks (deliverable_id, checked_at desc);
create index if not exists deliverable_tracker_checks_student_idx
  on public.deliverable_tracker_checks (student_id, checked_at desc);
create index if not exists deliverable_tracker_checks_attention_idx
  on public.deliverable_tracker_checks (student_id, checked_at desc)
  where verdict <> 'on-track';

comment on table public.deliverable_tracker_checks is
  'Assignment-relative verdict for one deliverable. Complements progress_events (activity) and draft_quality_checks (quality); neither of those knows what the task asked for.';

select private.attach_student_policies('deliverable_tracker_checks');

-- The tracker's latest verdict per deliverable, so the roster view is one read
-- rather than one read per task. Security-invoker so the caller's RLS applies.
create or replace view public.deliverable_tracker_latest
with (security_invoker = true) as
select distinct on (c.deliverable_id)
  c.deliverable_id,
  c.student_id,
  c.id as check_id,
  c.verdict,
  c.note,
  c.alignment_score,
  c.days_since_activity,
  c.source,
  c.checked_at
from public.deliverable_tracker_checks c
order by c.deliverable_id, c.checked_at desc;

grant select on public.deliverable_tracker_latest to authenticated;

-- ---------------------------------------------------------------------------
-- The tracker and the essay reviewer are new AI modules; ai_runs constrains
-- `module`, so widen it rather than letting the audit insert fail silently.
-- ---------------------------------------------------------------------------

alter table public.ai_runs drop constraint if exists ai_runs_module_check;
alter table public.ai_runs add constraint ai_runs_module_check check (module in (
  'profile-summary','narrative-coherence','family-report','school-reframing',
  'college-list','college-fit','concierge','scholarship-match','award-appeal',
  'aid-report','draft-quality','essay-advice','visualizer','chat',
  -- new: assignment-relative document tracking, two-dimensional essay review,
  -- and the link reader behind Upload links.
  'document-tracker','essay-review','link-digest'
));
