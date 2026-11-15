-- Official application deadlines, per school, per round, per admission cycle (college_round_deadlines).
--
-- The ONE place a school's published date for a round lives. A student or counselor picks the round a school is
-- applied in on the College list board (student_colleges.round: ED, ED2, EA, REA, SCEA, RD, rolling, priority);
-- the row's date (student_colleges.deadline, "Due" on the board) fills itself from here when this table has that
-- school + round for the current cycle, and is typed by hand when it doesn't. Read by POST
-- /application/college-list (a school added to a list) and PATCH /application/college-list/:id (the round
-- changed): lib/officialDeadlines.ts. Nothing else reads it yet.
--
-- Who writes it: only the service role. A future job that reads colleges' own admissions pages (a scraper), or a
-- curated load, UPSERTS one row per (college_id, admission_cycle, round):
--
--   college_id        the catalog school (public.colleges.id)
--   admission_cycle   '2026-2027': the cycle turns over August 1 (lib/supplementDocs.ts currentCycle), the same
--                     key college_supplements uses
--   round             the same codes as student_colleges.round
--   deadline          the date itself, a real date with its year (not "Nov 1"): between July 1 of the cycle's first
--                     year and August 31 of its second
--   source_url        the page the date was read on (required: nothing here is invented)
--   evidence          the sentence on that page that states it, up to 300 characters (optional)
--   checked_at        when that page was read
--
-- colleges.deadlines (the curated "Regular Decision": "Jan 5" summary from the catalog seed) stays as it is: the
-- college list falls back to it for a school + round this table has no row for, exactly as before this file.
-- Scraped "Look up info & photo" reads (college_site_info.deadlines) are not official and are never read here.
--
-- Public catalog data, like college_supplements: every signed-in user reads it (the college list's auto-fill runs
-- on the caller's own client, a student's or a counselor's); a pending or revoked counselor reads nothing (the
-- approval gate every table carries); no client writes.
--
-- Deploy order: either. Code first: every read answers "no such table", the college list fills dates from
-- colleges.deadlines as it does today (remembered for five minutes, lib/officialDeadlines.ts), and nothing fails.
-- This file first: nothing reads it until the code ships. Not in REQUIRED_SCHEMA (no request depends on it).

create table if not exists public.college_round_deadlines (
  college_id       uuid not null references public.colleges(id) on delete cascade,
  admission_cycle  text not null check (
                     admission_cycle ~ '^\d{4}-\d{4}$'
                     and right(admission_cycle, 4)::int = left(admission_cycle, 4)::int + 1
                   ),
  round            text not null check (round in ('ED', 'ED2', 'EA', 'REA', 'SCEA', 'RD', 'rolling', 'priority')),
  deadline         date not null,
  source_url       text not null check (source_url ~ '^https?://' and length(source_url) <= 2000),
  evidence         text check (evidence is null or length(btrim(evidence)) between 1 and 300),
  checked_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (college_id, admission_cycle, round),
  -- A date that can't belong to the cycle it is filed under (a scraper that read last year's page) is refused.
  constraint college_round_deadlines_in_cycle check (
    deadline between make_date(left(admission_cycle, 4)::int, 7, 1)
                 and make_date(right(admission_cycle, 4)::int, 8, 31)
  )
);

comment on table public.college_round_deadlines is
  'Official application deadlines: one row per school, admission cycle and round. Service role writes (upsert on the primary key); the college list fills student_colleges.deadline from it. See 20261126100002.';
comment on column public.college_round_deadlines.round is
  'The same codes as student_colleges.round: ED, ED2, EA, REA, SCEA, RD, rolling, priority.';
comment on column public.college_round_deadlines.deadline is
  'The date with its year, inside the cycle (July 1 of the first year to August 31 of the second).';
comment on column public.college_round_deadlines.source_url is
  'The page the date was read on.';
comment on column public.college_round_deadlines.evidence is
  'The sentence on source_url that states the date (at most 300 characters).';
comment on column public.college_round_deadlines.checked_at is
  'When source_url was read.';

drop trigger if exists college_round_deadlines_set_updated_at on public.college_round_deadlines;
create trigger college_round_deadlines_set_updated_at before update on public.college_round_deadlines
  for each row execute function public.set_updated_at();

alter table public.college_round_deadlines enable row level security;
revoke all on public.college_round_deadlines from public, anon, authenticated;
grant select on public.college_round_deadlines to authenticated;
grant all on public.college_round_deadlines to service_role;

drop policy if exists college_round_deadlines_select on public.college_round_deadlines;
create policy college_round_deadlines_select on public.college_round_deadlines
  for select to authenticated using (true);

-- A pending or revoked counselor reads nothing here, like every public table.
select private.attach_approval_gate('public.college_round_deadlines');
