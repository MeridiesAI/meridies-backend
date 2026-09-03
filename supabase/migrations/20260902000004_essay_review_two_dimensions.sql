-- Two-dimensional essay review.
--
-- "AI scores essays on two dimensions (content quality + grammar/usage) —
-- marks down where there are problems in the document instead of directly
-- making changes; can also make direct changes."
--
-- `draft_quality_checks.quality_score` was one number. It stays (it is the
-- effort/authenticity signal the accountability engine already reads) and gains
-- the two product dimensions beside it. The marks live in their own table
-- because they are spans, not a score: commenting mode renders them inline and
-- editing mode applies them.
--
-- THE GUARDRAIL IS IN THE SCHEMA, not only in the prompt and the route.
-- MeridiesAI must stay well clear of writing essay prose, so a mark may carry a
-- suggested replacement ONLY on the grammar/usage dimension, and only a short
-- mechanical one. A content-quality mark can say what is wrong; it can never
-- ship the words to fix it.

alter table public.draft_quality_checks
  -- 0..1. Content quality: does it answer the prompt, is it specific, does it
  -- show rather than assert. Judgement, not mechanics.
  add column if not exists content_score  numeric(4,3) check (content_score between 0 and 1),
  -- 0..1. Grammar and usage: spelling, agreement, punctuation, tense.
  add column if not exists grammar_score  numeric(4,3) check (grammar_score between 0 and 1),
  add column if not exists content_note   text check (length(content_note) <= 500),
  add column if not exists grammar_note   text check (length(grammar_note) <= 500),
  add column if not exists mark_count     integer not null default 0 check (mark_count >= 0),
  add column if not exists reviewed_body_chars integer check (reviewed_body_chars >= 0);

comment on column public.draft_quality_checks.quality_score is
  'Effort/authenticity signal for the accountability engine. Product-facing scoring is content_score + grammar_score.';
comment on column public.draft_quality_checks.content_score is
  'Content quality, 0..1. Paired with grammar_score; the two are reported separately because a clean essay about nothing and a messy essay about something need different conversations.';

-- ---------------------------------------------------------------------------
-- Inline marks — one per problem, anchored to a span of the draft.
-- ---------------------------------------------------------------------------

create table if not exists public.essay_marks (
  id                     uuid primary key default gen_random_uuid(),
  student_id             uuid not null references public.profiles(id) on delete cascade,
  essay_id               uuid not null references public.essays(id) on delete cascade,
  quality_check_id       uuid references public.draft_quality_checks(id) on delete set null,
  dimension              text not null check (dimension in ('content','grammar')),
  severity               text not null default 'suggestion'
                         check (severity in ('critical','major','minor','suggestion')),
  category               text check (length(category) <= 60),
  -- Character offsets into essays.body at the moment of review.
  start_offset           integer not null check (start_offset >= 0),
  end_offset             integer not null check (end_offset >= 0),
  -- The text the offsets pointed at. Kept so an accept can verify the draft
  -- hasn't moved under the mark before it edits anything.
  quoted_text            text not null check (length(quoted_text) between 1 and 2000),
  -- What's wrong and why, in the counselor's voice. Two sentences, hard cap.
  comment                text not null check (length(btrim(comment)) between 1 and 240),
  -- Editing mode. Grammar/usage mechanics only, and short by construction.
  suggested_replacement  text,
  status                 text not null default 'open'
                         check (status in ('open','accepted','rejected','stale')),
  applied_at             timestamptz,
  applied_by             uuid references public.profiles(id) on delete set null,
  created_by             text not null default 'ai' check (created_by in ('ai','counselor')),
  author_id              uuid references public.profiles(id) on delete set null,
  ai_run_id              uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint essay_marks_span check (end_offset >= start_offset),
  -- The product constraint, expressed as data: direct changes are mechanics.
  constraint essay_marks_edits_are_mechanics check (
    suggested_replacement is null
    or (dimension = 'grammar' and length(suggested_replacement) <= 200)
  )
);

create index if not exists essay_marks_essay_idx
  on public.essay_marks (essay_id, start_offset);
create index if not exists essay_marks_open_idx
  on public.essay_marks (essay_id) where status = 'open';
create index if not exists essay_marks_student_idx
  on public.essay_marks (student_id, created_at desc);

drop trigger if exists essay_marks_set_updated_at on public.essay_marks;
create trigger essay_marks_set_updated_at before update on public.essay_marks
  for each row execute function public.set_updated_at();

comment on constraint essay_marks_edits_are_mechanics on public.essay_marks is
  'MeridiesAI does not write essay prose. A content-quality mark may describe the problem but may never carry replacement text; a grammar mark may, capped at 200 characters. The route enforces a tighter limit still.';

select private.attach_student_policies('essay_marks');
