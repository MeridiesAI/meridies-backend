# Monthly ROI Report ("Time Saved") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track time Meridies saves each consultant per finished task and show it monthly (in-app page + email), with firm totals for org admins and anonymized averages for marketing.

**Architecture:** The database does the counting. Heartbeats go through one SQL function that keeps a single last-heartbeat timestamp and a running active-seconds total per task; triggers on the source tables (family reports, meetings, AI college lists, research recommendations, essay marks) record or reverse a completion with all figures snapshotted. The API serves the report from the ledger; one monthly cron finalizes months, sends emails and purges stale signals.

**Tech Stack:** Supabase Postgres (migrations, RLS, SECURITY DEFINER functions), Fastify 5 + zod (meridies-backend), Next.js (meridies-app), Resend via `lib/email.ts`, node:test (unit + integration harness).

**Spec:** `docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md` (approved 2026-10-26). Read it first.

## Global Constraints

- Task types, exactly: `college_list`, `essay_feedback`, `meeting`, `family_report`, `activity_list`.
- Defaults (unedited = "estimated"): college list 240 by hand / 30 with Meridies; essay feedback 45/15; meeting 45/15; family report 60/10; activity list 90/20; hourly rate $150; 40 hours per student per year.
- Idle limit: a gap of 10 minutes or more adds nothing. Heartbeats carry no durations; the server uses its own receive time.
- One last-heartbeat timestamp per task; at most one counted heartbeat per 30 s per task.
- In-progress task with no activity for 14 days: deleted, never counted. Heartbeat timestamps older than 24 h: cleared.
- Fallback: 5+ measured completions of that type → cap measured at 3× median, and use the median when unmeasured; else signup "with Meridies" figure. Store `measure_method` in `active | capped | median | signup`.
- `saved_minutes` may be negative and is summed as is; a task type whose month total is ≤ 0 displays "no time saved yet".
- "Value of time saved" (never "money saved") and "up to N more students" are either/or, never added.
- Firm totals only when 3+ consultants contributed that month; otherwise exactly: "Firm totals appear once 3 or more consultants are active this month." No per-person breakdown for admins, ever.
- Prospect averages: only with ≥10 consultants from ≥5 firms (a solo consultant = one firm), only edited figures; otherwise nothing.
- Emails: no student names; keep "estimated" labels; unsubscribe link; first consultant email only 14+ days after their first completion.
- Month locked once finalized; undo before that removes the completion.
- Every new table: RLS in the same migration + `private.attach_approval_gate('public.<table>')`; nothing added to `REQUIRED_SCHEMA`; routes degrade with `503 { code: "kpi_unavailable" }` before the migration is applied.
- Heartbeats are ignored (202, `{ tracked: false }`) unless env `KPI_TRACKING_ENABLED=true`. It stays off in production until the privacy-policy line has merged (Task 11).

## Review Focus

- A consultant who leaves a firm mid-month: completions keep the `firm_id` snapshotted when they happened, so last month's firm totals don't change → test in Task 6.
- Completion recorded by a service-role or `transfer_caseload` write (no `auth.uid()`): credit goes to the row's counselor column, never null → test in Task 3.
- A month boundary in the consultant's time zone (11:30 pm on the 31st, Los Angeles) counts in that month, not the next → test in Task 3.
- A heartbeat for a subject that was deleted (meeting deleted mid-session) → 404, no session row created → test in Task 2.
- A consultant with zero completions in the month: page shows an empty state, and no email is sent → test in Task 7.

---

### Task 1: Schema

**Files:**
- Create: `supabase/migrations/20261027000001_kpi_schema.sql`
- Test: `test/integration/kpi-schema.test.mjs`

**Interfaces:**
- Produces tables:
  - `kpi_baselines(counselor_id pk → profiles, manual jsonb, meridies jsonb, manual_edited jsonb, meridies_edited jsonb, hourly_rate numeric(8,2), rate_edited bool, hours_per_student_year numeric(6,1), hours_edited bool, monthly_email bool default true, unsubscribe_token_hash text, prompt_dismissed_at timestamptz, updated_at)`. The jsonb maps are keyed by task type, with integer minutes 1–1440.
  - `kpi_task_sessions(counselor_id, task_type, subject_id uuid, active_seconds int default 0, last_heartbeat_at timestamptz null, last_active_on date not null, pk(counselor_id, task_type, subject_id))`.
  - `kpi_completions(id, counselor_id, firm_id null, student_id null, task_type, dedupe_key text, month date /*first of month*/, completed_at, manual_minutes int, manual_is_estimate bool, measured_seconds int, meridies_minutes numeric, measure_method text, saved_minutes numeric, hourly_rate numeric, rate_is_estimate bool, unique(counselor_id, task_type, dedupe_key))`.
  - `kpi_completion_sources(completion_id → kpi_completions on delete cascade, source_table text, source_id uuid, pk(source_table, source_id))`.
  - `kpi_months(counselor_id, month date, finalized_at timestamptz, pk(counselor_id, month))`.
  - `kpi_email_sends(recipient_id, month date, kind text check in ('consultant','firm'), firm_id null, sent_at, unique(recipient_id, month, kind, firm_id))`.
  - `meetings.notes_sent_at timestamptz null`.
  - `'kpi-monthly'` added to the `job_heartbeats.job` CHECK (read the current list back, as `ai_runs_module_check` migrations do), plus a seed row with `expected_every = interval '1 month'`.
- RLS: a consultant can SELECT their own `kpi_baselines` / `kpi_completions` / `kpi_months` only. Nothing is client-writable except `kpi_baselines` (own row, through the API). Sessions, sources and email sends are service-role only.

- [ ] **Step 1: Write the failing test.** `kpi-schema.test.mjs`: (a) each table exists and has the approval gate (reuse `approval-db.test.mjs`'s check); (b) counselor A cannot select B's `kpi_completions`; (c) an authenticated insert into `kpi_completions` / `kpi_task_sessions` fails.
- [ ] **Step 2: Run** `npm run test:integration -- test/integration/kpi-schema.test.mjs`. Expected: FAIL (tables missing).
- [ ] **Step 3: Write the migration.** Include the deploy-order header used by other migrations: "either order; not in REQUIRED_SCHEMA".
- [ ] **Step 4: Run** `supabase db reset` (local), then the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): schema for time-saved ledger`.

### Task 2: Heartbeat function and route

**Files:**
- Create: `supabase/migrations/20261027000002_kpi_heartbeat.sql`, `src/routes/kpi.ts`, `src/lib/kpi/subjects.ts`
- Modify: `src/app.ts` (register `kpiRoutes` with prefix `/kpi`), `src/env.ts` (`KPI_TRACKING_ENABLED` boolean, default false)
- Test: `test/integration/kpi-heartbeat.test.mjs`

**Interfaces:**
- SQL: `public.kpi_heartbeat(p_task_type text, p_subject uuid) returns text`. SECURITY DEFINER, uses `auth.uid()`, returns `'started' | 'counted' | 'throttled' | 'idle-reset'`. Runs as one statement with a row lock:
  ```
  no row          → insert (last_heartbeat_at = now(), last_active_on = today) → 'started'
  last is null    → set last = now()                                          → 'started'
  now-last < 30s  → no change                                                 → 'throttled'
  now-last < 10m  → active_seconds += extract(epoch from now-last); last = now() → 'counted'
  else            → last = now() (gap not added)                              → 'idle-reset'
  every non-throttled call also sets last_active_on = current_date
  ```
- `src/lib/kpi/subjects.ts`: `assertOwnsSubject(request, taskType: TaskType, subjectId: string): Promise<{ studentId: string }>`. `college_list`, `activity_list` and `family_report` take a student id → `resolveStudentId(request, id, "edit")`. `essay_feedback` takes an essay id → load the essay on `request.db`, then resolve its student with `"edit"`. `meeting` takes a meeting id → `request.db` select, and require `counselor_id === request.auth.userId`. A missing row → 404.
- Route: `POST /kpi/heartbeat` with body `{ taskType, subjectId }` (strict), using `[app.authenticate, requireRole("counselor"), limit("kpi:heartbeat", 120, 60)]`. Answers `202 { tracked: boolean, result? }`. When the env flag is off it answers `{ tracked: false }` before any DB call.
- Exports `type TaskType` and `TASK_TYPES` from `src/lib/kpi/types.ts` (create it here; later tasks import it).

- [ ] **Step 1: Write the failing tests** (API started with `KPI_TRACKING_ENABLED=true`). Use `sql()` from the harness to backdate `last_heartbeat_at` instead of sleeping:
  - `two tabs over the same 5 minutes count 5 minutes`: simulate 10 heartbeats from 2 tokens of the same counselor at server times t0…t0+300 s, interleaved every 15 s, by backdating between calls. Expected `active_seconds` between 270 and 300.
  - `a 2-hour gap adds nothing`: heartbeat, backdate 2 h, heartbeat. Expected `active_seconds = 0` and result `'idle-reset'`.
  - `heartbeat for another consultant's task is rejected`: B posts A's student or meeting id. Expected 403/404, and no session row exists for B.
  - `deleted subject`: a meeting id that has been deleted → 404 and no row.
  - `flag off`: API without the flag → `{ tracked: false }` and no row.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the function, subjects and route.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): server-timed heartbeats`.

### Task 3: Recording completions (triggers)

**Files:**
- Create: `supabase/migrations/20261027000003_kpi_completions.sql`
- Test: `test/integration/kpi-completions.test.mjs`

**Interfaces:**
- `private.kpi_record(p_counselor uuid, p_task_type text, p_subject uuid, p_student uuid, p_dedupe text, p_source_table text, p_source_id uuid)`:
  - `month` = first day of `now()` in `profiles.time_zone` (UTC if unset).
  - Takes the session `(p_counselor, p_task_type, p_subject)`'s `active_seconds`, then deletes the session.
  - On insert, snapshots baselines (defaults from Global Constraints when no row exists or a key is missing) and `firm_id` (the counselor's current firm, via the same lookup `crm_my_workspace()` uses; null when solo).
  - On a dedupe conflict it adds `measured_seconds` to the existing row and recomputes. It never re-snapshots the baselines.
  - Computes `meridies_minutes` and `measure_method` per the Global Constraints fallback (the median comes from that counselor's prior `active`/`capped` rows of the type), and `saved_minutes = manual − meridies`.
  - Inserts a `kpi_completion_sources` row. Does nothing if the month is in `kpi_months` with `finalized_at` set.
- `private.kpi_unrecord(p_source_table text, p_source_id uuid)`: deletes that source. If its completion has no sources left and the month isn't finalized, it deletes the completion.
- Counselor credited = `auth.uid()` when it is an approved counselor, else the source row's counselor column (`counselor_id` / `created_by`).
- Triggers (AFTER, `security definer`, each in its own `begin … exception when others then raise warning` block so a ledger failure never blocks the user's save):

| Task | Record when | Subject | Dedupe | Unrecord when |
|---|---|---|---|---|
| `family_report` | `family_reports.status` → `'sent'` | student_id | report id | status leaves `'sent'`, or row deleted |
| `meeting` | `meetings.notes_sent_at` null → set | meeting id | meeting id | set → null, or row deleted |
| `college_list` | insert `college_list_variants` with `generated_by='ai'`; `recommendations` (feature `college_list`) → `'accepted'` | student_id | `student_id:YYYY-MM` | variant deleted (recommendations can't be un-accepted: no reversal) |
| `activity_list` | `recommendations` (feature `activities`) → `'accepted'` | student_id | `student_id:YYYY-MM` | the task in `accepted_as` deleted (trigger on `deliverables` delete looks up the source by that id; record the source as `('deliverables', task id)`) |
| `essay_feedback` | first `essay_marks` row of a `quality_check_id` leaving `'open'` for `accepted`/`rejected` | essay_id | `essay_id:quality_check_id` | none (marks can't be reopened) |

- [ ] **Step 1: Write the failing tests:**
  - `settings change mid-month`: complete a family report, change the baseline, complete another → each row keeps its own `manual_minutes`.
  - `re-run five times counts once`: accept 5 `college_list` recommendations for one student in one month → 1 completion, `measured_seconds` = the sum of the sessions consumed.
  - `undo before finalize removes time`: mark a report sent, then unmark it → no completion.
  - `undo after report sent changes nothing`: insert a finalized `kpi_months` row, then unmark → the completion stays.
  - `service-role write credits the row's counselor`.
  - `month boundary in consultant time zone`: profile `America/Los_Angeles`, `now()` faked by inserting with `completed_at` via the function's test seam `private.kpi_record_at(..., p_now timestamptz)`. Expose that variant and have `kpi_record` call it with `now()`.
  - `cap at 3x median`: seed 5 active rows of 10 min, then complete one with 60 min measured → `measure_method='capped'`, `meridies_minutes=30`.
  - `no session, under 5 history → signup figure`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the migration.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): completion ledger triggers`.

### Task 4: Baselines API and "Notes sent"

**Files:**
- Modify: `src/routes/kpi.ts`, `src/routes/meetings.ts`
- Create: `src/lib/kpi/defaults.ts`
- Test: `test/unit/kpi-defaults.test.ts`, `test/integration/kpi-api.test.mjs`

**Interfaces:**
- `defaults.ts`: `DEFAULT_BASELINES: Record<TaskType, { manual: number; meridies: number }>`, `DEFAULT_RATE = 150`, `DEFAULT_HOURS_PER_STUDENT = 40`.
- `GET /kpi/baselines` → `{ tasks: Record<TaskType, { manual, meridies, manualEdited, meridiesEdited }>, hourlyRate, rateEdited, hoursPerStudentYear, hoursEdited, monthlyEmail, needsPrompt }`. `needsPrompt` is true when there's no row and `prompt_dismissed_at` is null.
- `PUT /kpi/baselines` (strict zod; minutes 1–1440, rate 1–2000, hours 1–500). A field counts as edited when the request marks it `edited: true`, which the client sends for fields the user touched. Also accepts `{ dismissPrompt: true }`.
- `POST /meetings/:id/notes-sent` and `DELETE /meetings/:id/notes-sent`: owner only (`counselor_id === caller`), meeting `status = 'held'`, `limit("meetings:notes-sent", 60, 60)`. Set / clear `notes_sent_at`. AxIS: add an op `meetings.mark_notes_sent` to `ops/catalog`, tier `auto`, with the DELETE as its undo.

- [ ] **Step 1: Write the failing tests.** Defaults equal the spec values. PUT then GET round-trips, and the edited flags persist. Notes-sent on a non-held meeting → 409. Notes-sent by a write collaborator → 403. Mark then unmark → `notes_sent_at` null. `axis-ops.test.ts` passes with the new op.
- [ ] **Step 2: Run** `npm test` and the integration file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): baselines API and notes-sent mark`.

### Task 5: Consultant report

**Files:**
- Create: `src/lib/kpi/report.ts`
- Modify: `src/routes/kpi.ts`
- Test: `test/unit/kpi-report.test.ts`

**Interfaces:**
- `buildReport(rows: CompletionRow[], last12: CompletionRow[], baselines: Baselines, activity: ActivityCounts, month: string): KpiReport` is a pure function. `KpiReport = { month, hoursSaved: number, students: number, valueOfTime: number | null, valueIsEstimate: boolean, extraStudents: { upTo: number, basedOnMonths: number } | null, byTask: Array<{ taskType, completions, savedMinutes, display: "saved" | "no-time-saved-yet", lines: Array<{ studentId, studentName, manual, meridies, method, saved, estimate: boolean, calc: string }> }>, activity: ActivityCounts, empty: boolean }`.
- `calc` string, exactly: `` `${manual} min estimate − ${meridies} min in Meridies` ``. Append `" (estimated)"` when `manual_is_estimate`.
- `extraStudents.upTo` = floor(sum of `saved_minutes` over the last ≤12 months / 60 ÷ hours per student). Null when ≤ 0.
- `valueOfTime` = Σ(`saved_minutes`/60 × each row's snapshotted `hourly_rate`).
- `GET /kpi/report?month=YYYY-MM` (counselor, own data via `request.db`; `ActivityCounts` from `ai_runs` by module where `actor_id` = me, and `research_runs` by feature where `counselor_id` = me, in that month).

- [ ] **Step 1: Write failing unit tests:** a negative type total → `display: "no-time-saved-yet"`; value and extra students are both present but never summed into one field; the 4-month history → `basedOnMonths: 4`; the calc string matches exactly; zero rows → `empty: true`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): consultant report`.

### Task 6: Firm totals

**Files:**
- Create: `supabase/migrations/20261027000004_kpi_firm.sql`
- Modify: `src/routes/kpi.ts`
- Test: `test/integration/kpi-firm.test.mjs`

**Interfaces:**
- `public.kpi_firm_month(p_firm uuid, p_month date) returns jsonb`. SECURITY DEFINER. Raises 42501 unless the caller is the firm owner or an `admin` seat. Returns `{ available: false }` when fewer than 3 distinct `counselor_id` values appear in that firm-month's completions (using the snapshotted `firm_id`). Otherwise returns `{ available: true, hoursSaved, valueOfTime, completions, students }`. It never returns any per-counselor field.
- `GET /kpi/firm?month=YYYY-MM` → that JSON. When `available: false`, the app shows the exact copy from the Global Constraints.

- [ ] **Step 1: Write the failing tests:** a 2-consultant firm admin → `available: false`; 3 consultants → totals equal the sum; a non-admin member → 403; a consultant who left mid-month still counts in that month (snapshot); the response keys contain no counselor ids.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): firm totals with 3-consultant floor`.

### Task 7: Monthly job, emails, purge, unsubscribe

**Files:**
- Create: `src/lib/kpi/monthly.ts`, `src/lib/kpi/emails.ts`
- Modify: `src/routes/internal.ts`, `src/routes/kpi.ts`, `src/lib/heartbeat.ts` (add `"kpi-monthly"` to `Job`), `test/unit/service-callsites.test.ts` (review the new elevated call sites)
- Test: `test/unit/kpi-emails.test.ts`, `test/integration/kpi-monthly.test.mjs`

**Interfaces:**
- `POST /internal/kpi/monthly` (`requireCronSecret`, 202, lease `kpi-monthly`) runs `runMonthly(now = new Date())`:
  1. `purgeSignals()`: `update kpi_task_sessions set last_heartbeat_at = null where last_heartbeat_at < now() - 24h`, then `delete … where last_active_on < current_date - 14`. **Also called daily:** the same route with `?purgeOnly=1`. Railway cron: daily `0 7 * * *`, and the full run on the 2nd at `0 14 2 * *`.
  2. For each approved counselor (`approvedCounselorIds`) with completions in the previous month: insert `kpi_months` (finalized). Then, if `monthly_email`, no `kpi_email_sends` row exists, and their first completion is ≥14 days old, send the consultant email and record it.
  3. For each firm admin: if `kpi_firm_month(...).available` and `monthly_email` is on, send the firm email once.
  4. `beat("kpi-monthly", ok)`.
- `renderConsultantEmail(r: KpiReport, link: string, unsubscribeUrl: string): { subject, html, text }` and `renderFirmEmail(...)`. These are pure, contain no student names, include "estimated" when applicable, show 2–3 headline totals, and set the `List-Unsubscribe` header.
- Unsubscribe, following the `accessReview` pattern: `GET /kpi/unsubscribe/:token` renders a page and changes nothing. `POST` sets `monthly_email = false` (`allowPending: true`, no auth, the token is looked up by sha256 hash).

- [ ] **Step 1: Write the failing tests:**
  - unit: rendered email contains no student name from the fixture; contains "estimated" when the rate is a default; has an unsubscribe URL.
  - integration: `raw activity rows are purged after computing` (a backdated 25 h heartbeat → null); `abandoned task purged after 14 days` (`last_active_on` 15 days ago → row gone, and a later completion of that subject uses the fallback); `job run twice sends once`; `first email held under 14 days`; `zero completions → no email`; `undo after finalize changes nothing` (end-to-end through the job).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): monthly finalize, emails, purge`.

### Task 8: Prospect averages (internal)

**Files:**
- Create: `supabase/migrations/20261027000005_kpi_prospect.sql`
- Modify: `src/routes/internal.ts`
- Test: `test/integration/kpi-prospect.test.mjs`

**Interfaces:**
- `public.kpi_prospect_averages(p_from date, p_to date) returns jsonb`. EXECUTE to `service_role` only. Per task type, uses only rows with `manual_is_estimate = false`. Hours per consultant-month uses only consultants whose rate was edited for value. Returns `{ available: false }` unless ≥10 distinct counselors from ≥5 distinct firms, where a null `firm_id` counts as its own firm per counselor. Otherwise returns `{ available: true, consultants, firms, medianHoursPerMonth, byTask: {…medians} }`.
- `GET /internal/kpi/prospect-averages?from=&to=` (cron secret).

- [ ] **Step 1: Write the failing tests:** 9 consultants → nothing; 10 consultants from 4 firms → nothing; 10 from 5 → figures; unedited rows are excluded.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(kpi): prospect averages with privacy floor`.

### Task 9: App, signup figures (meridies-app)

**Files:**
- Create: `components/kpi/BaselinesForm.tsx`, `lib/kpi.ts` (typed `apiFetch` wrappers for every `/kpi/*` route above)
- Modify: `app/onboarding/counselor/page.tsx` (add the step), `app/dashboard/counselor/settings/page.tsx` (a "Time saved" section with the same form), `app/dashboard/counselor/OverviewClient.tsx` (a one-time dismissible prompt when `needsPrompt`)

**Interfaces:** `BaselinesForm({ initial, onSaved, mode: "onboarding" | "settings" })`. Every field is pre-filled with the defaults, a field is marked edited only once the user changes it, and the form has a Skip button in onboarding.

- [ ] **Step 1:** Add a Playwright test in `e2e/` (signed-in project): onboarding shows the five tasks plus rate and hours; Skip leaves `rateEdited=false`; changing the rate saves `rateEdited=true`.
- [ ] **Step 2:** Run `npm run e2e:stack -- -g "time saved"`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again, plus `npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kpi): signup figures` (app repo, its own branch `feat/kpi-time-saved`).

### Task 10: App, heartbeats, report pages, "Notes sent"

**Files:**
- Create: `lib/useKpiHeartbeat.ts`, `app/dashboard/counselor/time-saved/page.tsx`, `components/kpi/TimeSavedReport.tsx`, `components/kpi/FirmTotals.tsx`
- Modify: `components/student/ApplicationClient.tsx` (college list: `college_list`, student id), `components/student/ActivitiesBuildClient.tsx` (`activity_list`), the essay review surface in `components/student/StudentSections.tsx` (`essay_feedback`, essay id), the family report editor (`app/actions.ts` callers; `family_report`, student id), the meeting surface that edits notes (`components/dashboard/MeetingMeta.ts` consumers) with a "Mark notes sent" toggle (`meeting`, meeting id), `app/dashboard/counselor/firm/page.tsx` (render `FirmTotals` for owners/admins), the sidebar nav (a "Time saved" link)

**Interfaces:** `useKpiHeartbeat(taskType: TaskType, subjectId: string | null)` sends one beat on mount, then every 30 s while `document.visibilityState === "visible"` and there was input or focus in the last 60 s. It never sends a duration and swallows errors.
- Report page: month picker, a headline with the either/or line, per-task lines showing `calc`, per-student list, "estimated" badges, an Activity section, and an empty state.
- Firm section: exact copy when unavailable.

- [ ] **Step 1:** Playwright tests: the report page shows "no time saved yet" for a negative type; the firm page for a 2-person firm shows the exact unavailable copy; the "Mark notes sent" toggle round-trips.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, plus typecheck and lint. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kpi): heartbeats and time-saved pages`.

### Task 11: Privacy policy line (meridies-landing) and launch gate

**Files:** Modify the privacy page in PR landing #38 (or a follow-up PR off `main` if #38 has merged). Modify `LAUNCH_CHECKLIST.md` in meridies-backend.

- [ ] **Step 1:** Add this text: "Meridies measures time spent on tasks in the app to calculate the time it saves you. We show this only to you and, as firm-wide totals, to your organization's administrators. In our marketing we use only anonymized averages across many consultants."
- [ ] **Step 2:** In `LAUNCH_CHECKLIST.md`: "`KPI_TRACKING_ENABLED=true` on Railway only after the privacy line is live on the landing site; add the two Railway crons for `/internal/kpi/monthly` (daily `?purgeOnly=1` at `0 7 * * *`; full run `0 14 2 * *`)."
- [ ] **Step 3:** Commit, then open the PRs (backend, app, landing). Elvin merges backend; landing and app wait for bcha.
