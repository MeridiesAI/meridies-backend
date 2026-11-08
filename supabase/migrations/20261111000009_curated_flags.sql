-- Curated college data (item 16, part 1): two more curated policy facts.
--
-- college_policies (20261007000004) gains:
--   personal_statement_read  true = the school reads the Common App personal
--                            statement, false = it doesn't, null = unknown.
--   test_reporting           how the school wants scores at application:
--                            'official-only' (an official report from the
--                            testing agency), 'self-report' (the applicant
--                            types them in; official on enrolling),
--                            'score-send' (official sends, self-report not
--                            accepted), 'not-applicable' (test-blind: no
--                            scores considered); null = unknown.
--
-- self_report_scores stays as it is: it already answers "may an applicant
-- self-report?", and the app reads it. test_reporting is the fuller answer;
-- the two should agree ('self-report' with self_report_scores = true), but
-- each is curated from its own source and either may be blank, so the
-- database doesn't force them together.
--
-- Both are loaded by scripts/ingest/curated-csv.ts (--dataset policies), each
-- stamped in `sources` like the other fields.
--
-- college_supplements (20261005020001) already has source_url (https only)
-- and source_verified_at, which the new `supplements` dataset writes; nothing
-- to add there.
--
-- Column adds only: no table is created, RLS, grants and the approval gate on
-- college_policies are untouched. Deploy order: before the backend that
-- loads these columns (a policies load naming them fails without it).

alter table public.college_policies
  add column if not exists personal_statement_read boolean,
  add column if not exists test_reporting text;

alter table public.college_policies drop constraint if exists college_policies_test_reporting_check;
alter table public.college_policies add constraint college_policies_test_reporting_check
  check (test_reporting in ('official-only', 'self-report', 'score-send', 'not-applicable'));

comment on column public.college_policies.personal_statement_read is
  'Curated: true = the school reads the Common App personal statement; false = it does not; null = unknown.';
comment on column public.college_policies.test_reporting is
  'Curated: how scores are reported at application (official-only | self-report | score-send | not-applicable); null = unknown. '
  'Complements self_report_scores (kept): self-report implies self_report_scores = true, but the two are sourced separately and not enforced together.';
comment on column public.college_policies.self_report_scores is
  'Curated: accepts self-reported scores at application (official on enrolling). See test_reporting for the fuller answer.';
