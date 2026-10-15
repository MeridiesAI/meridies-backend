-- More College Scorecard figures on college_stats. Additive only.
--
-- Safe in either order with the code:
--   * Before this migration the ingest still writes every existing column: the
--     college_stats upsert is retried without these columns when PostgREST
--     refuses them (lib/ingest/scorecard.ts upsertStats), the run is recorded
--     as degraded and the scorecard-ingest heartbeat is not counted clean, so
--     GET /internal/status reports it until this is applied.
--   * Every reader selects "*" or names older columns, so nothing breaks
--     before or after. Not in REQUIRED_SCHEMA: no request needs these.
--
-- The new columns are null (or {}) until the next Scorecard run. After
-- applying, run the ingest once: POST /internal/ingest/scorecard, or
-- npx tsx --env-file=.env scripts/ingest/scorecard.ts
--
-- No new table, so no new policies: college_stats keeps its select policy for
-- authenticated, its approval_gate and its service-role-only writes, and the
-- table-level grant covers added columns.

alter table public.college_stats
  -- IPEDS Graduation Rates, first-time full-time degree/certificate seekers.
  -- Four-year institutions report the 4-year cohort (C100_4, C150_4: within
  -- 4 and 6 years for a bachelor's); less-than-four-year institutions report
  -- C100_L4 / C150_L4 (100% / 150% of normal time for their programs). The
  -- three completion columns always come from one cohort, named here.
  add column if not exists completion_basis text
    check (completion_basis in ('four-year', 'less-than-four-year')),
  add column if not exists grad_rate_on_time numeric(5,4)
    check (grad_rate_on_time between 0 and 1),
  add column if not exists grad_rate_150 numeric(5,4)
    check (grad_rate_150 between 0 and 1),
  -- C150_4_<race> or C150_L4_<race> (same basis), 0-1, keyed white, black,
  -- hispanic, asian, aian, nhpi, two_or_more, non_resident_alien, unknown.
  -- A missing key is suppressed or not reported.
  add column if not exists completion_by_race jsonb not null default '{}'::jsonb
    check (jsonb_typeof(completion_by_race) = 'object'),
  -- First-time full-time students back for a second fall (RET_FT4 or RET_FTL4,
  -- pooled and suppressed for small cohorts, as Scorecard shows it).
  add column if not exists retention_rate numeric(5,4)
    check (retention_rate between 0 and 1),
  -- Share of degree/certificate-seeking undergraduates enrolled part time (PPTUG_EF).
  add column if not exists part_time_share numeric(5,4)
    check (part_time_share between 0 and 1),
  -- Undergraduates per instructional staff member, full-time equivalents (STUFACR).
  add column if not exists student_faculty_ratio smallint
    check (student_faculty_ratio between 1 and 200),
  -- Graduate students enrolled (GRADS).
  add column if not exists grad_students integer
    check (grad_students >= 0),
  -- UGDS_* shares (0-1) of degree-seeking undergraduates: women, men and the
  -- nine race/ethnicity keys above.
  add column if not exists demographics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(demographics) = 'object'),
  -- Cost of attendance parts, dollars (ROOMBOARD_ON, BOOKSUPPLY).
  add column if not exists room_board_on_campus integer
    check (room_board_on_campus >= 0),
  add column if not exists books_supplies integer
    check (books_supplies >= 0),
  -- Median earnings of federally aided students, working and not enrolled,
  -- 6 years after entry (MD_EARN_WNE_P6), dollars.
  add column if not exists median_earnings_6yr integer
    check (median_earnings_6yr >= 0),
  -- Median federal debt of completers as a 10-year monthly payment
  -- (GRAD_DEBT_MDN10YR), and of students who left without finishing
  -- (WDRAW_DEBT_MDN), dollars.
  add column if not exists median_debt_monthly integer
    check (median_debt_monthly >= 0),
  add column if not exists median_debt_noncompleters integer
    check (median_debt_noncompleters >= 0),
  -- Carnegie Classification, basic (CCBASIC).
  add column if not exists carnegie_basic smallint;

comment on column public.college_stats.completion_basis is
  'IPEDS cohort the completion columns come from: four-year (C100_4/C150_4) or less-than-four-year (C100_L4/C150_L4). Never mixed.';
comment on column public.college_stats.completion_by_race is
  'College Scorecard C150_4_* or C150_L4_* (per completion_basis) by race/ethnicity, 0-1. Missing keys are suppressed or not reported.';
comment on column public.college_stats.demographics is
  'College Scorecard UGDS_* shares (0-1) of degree-seeking undergraduates. Sourced; never curated.';
