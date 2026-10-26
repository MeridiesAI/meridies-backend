# Monthly ROI report ("time Meridies saved you") — design

Date: 2026-10-26 · Status: draft for Elvin's review · Repos: meridies-backend, meridies-app

## Why

Consultants (and the organizations that pay for them) need a believable, monthly answer to "is Meridies worth it?" —
"you saved 14 hours across 22 students this month." The same data, anonymized and aggregated, becomes proof for
prospects. Believable beats impressive: one number a consultant knows is inflated poisons the whole report.

## Audiences

| Who | Sees | Never sees |
|---|---|---|
| Consultant | Their own report: per-task breakdown, per-student detail, how every number was calculated | Anyone else's data |
| Org admin (firm `owner`/`admin`) | Firm totals across its consultants | Individual consultants' hourly rates |
| Prospects (via Meridies marketing) | Anonymized averages only | Any firm's or student's data |

## Goals

- Every number traces to things the consultant actually finished in Meridies and shows its arithmetic.
- Zero extra work for the consultant after a short signup step.
- Monthly in-app report page (source of truth) + monthly summary email.

## Non-goals

- No public, live "stats" widget on the landing site. Prospect averages come from an internal query Elvin's team uses.
- No billing/pricing changes, no student- or parent-facing version.
- No tracking of time outside Meridies.

## Anti-goals (failure even if it works)

- Inflated or unexplained numbers; adding "value of time" and "extra students" together.
- Becoming a surveillance tool for orgs (rates hidden; see open question on per-consultant rows).
- Any student name or detail in an email, an org summary that leaks a single consultant's rate, or a prospect figure.

## The math (decided)

For each **completion** (one finished item, see "What counts"):

- `saved_minutes = manual_minutes − meridies_minutes`
  - `manual_minutes`: the consultant's signup figure for that task type.
  - `meridies_minutes`: measured active time in Meridies on that item (below); fallback rules below.
- **Hours saved (month)** = sum of `saved_minutes` over the month's completions, **including negatives**.
- **Extra students** = (hours saved over the last 12 months) ÷ (consultant's "hours per student per year").
  Shown as **"up to N more students"**, rounded down.
- **Value of time saved** = hours saved × hourly rate. Never called "money saved".
- The report shows value and extra students as **either/or** ("…worth $X of your time, *or* room for up to N more
  students"), never summed.
- UI: a task type whose month total is ≤ 0 shows **"no time saved yet"** instead of a negative number.
  Every completion with `saved_minutes < 0` is also logged as an internal product metric (slower-than-manual).
- Each line shows its working, e.g. "College list · 90 min by hand − 15 min in Meridies = 75 min saved".

## Signup step (decided)

Added to counselor onboarding (`meridies-app/app/onboarding/counselor`), one screen, pre-filled defaults:

| Task type (`task_type`) | Asks |
|---|---|
| `college_list` — college list | min by hand · min with Meridies |
| `essay_feedback` — one essay feedback round | same |
| `meeting` — meeting prep + follow-up | same |
| `family_report` — family progress report | same |
| `activity_list` — activity list / resume | same |
| (per consultant) | hourly rate · hours per student per year |

- Every figure stores whether the consultant **edited** it. Unedited defaults are labeled **"estimated"** everywhere
  they appear (page and email) and are **excluded from prospect averages**.
- Editable later in Settings. Edits never rewrite past completions (snapshots, below).
- Consultants who signed up before this ships get the same screen as a one-time prompt (first visit to the report
  page or the dashboard, dismissible; defaults apply until they answer).
- "With Meridies" signup figures are a starting point; measured time replaces them as soon as it exists.

## Measuring time in Meridies (decided)

Primary: **active time**, from the item's start to its completion, **excluding idle gaps of 10+ minutes with no activity**.

- The app sends lightweight activity pings while the consultant is on a page tied to a trackable item (student + task
  type + item id): on start, then about every 60s while there's input/focus, and on completion. Server stores sessions;
  a gap of ≥10 min between pings is not counted.
- Re-runs/edits of the same item in the same month add their active time to that one completion (honest cost of
  re-running). *(Builder's/Claude's call — see "Calls made".)*

Fallback when active-time can't be measured for an item (e.g. a completion with no pings):

1. If the consultant has **5+ measured completions** of that task type: use their median measured time, and in any
   case **cap** a measured value at **3× that median**.
2. Otherwise use their signup "with Meridies" figure.

The completion record stores which method was used (`active`, `capped`, `signup`) so the page can say so.

## What counts as one completion (decided)

**One completion per finished item per period**; raw usage (every AI run, every research run) is counted and shown
separately as "activity," never as savings. Re-running five times = one completion.

| Task type | Completion event | Dedupe key (one per…) | Status in code |
|---|---|---|---|
| `college_list` | Consultant saves/activates an AI-assisted list (`college_list_variants`, `generated_by='ai'`) or accepts college-list research recommendations (`research/accept.ts`) | student + month | Events exist |
| `essay_feedback` | Consultant finishes reviewing a draft-quality check (`draft_quality_checks` → `essay_marks` decided) | essay + quality check | Exists; builder confirms the "finished" moment (e.g. first decided mark vs. explicit "Feedback sent") — if fuzzy, **add an explicit "Feedback sent" action** |
| `meeting` | **New explicit "Notes sent" action** on a held meeting's notes | meeting | **Must be added** — today notes only have a `visibility` flag, no send event |
| `family_report` | `family_reports.status → 'sent'` (`sent_at`); if an export/download path exists without "send", add an explicit "Exported" event | report | Send exists; export TBD by builder |
| `activity_list` | Accepting activities research recommendations (`research_runs.feature='activities'`), last run per question | student + month | Exists; builder confirms whether a resume/list "finalize" moment exists — if not, **add an explicit one** |

Rule: when an item lacks a clear completion event, **add an explicit user action**; never infer completion from
idle time or page views.

## Data (shape decided; names/columns are builder's call)

- **`kpi_baselines`** — per consultant: per-task `manual_minutes`, `meridies_minutes`, each with an `edited` flag;
  plus `hourly_rate`, `hours_per_student_year`, each with `edited`. RLS: the consultant only; org admins never read
  rates directly.
- **`kpi_task_sessions`** — activity pings rolled into active seconds per (consultant, task type, item).
- **`kpi_completions`** — the ledger. One row per completion with **snapshots taken at completion time**:
  `manual_minutes`, `manual_is_estimate`, `meridies_minutes`, `measure_method`, `saved_minutes`, `hourly_rate`,
  `rate_is_estimate`, plus consultant, firm (at that time), student, task type, source entity, dedupe key, month.
  Reports read only this table; they never look up current settings.
  Unique on (consultant, task type, dedupe key) so retries/re-runs can't double count.
- **`kpi_email_sends`** — one row per (recipient, month, kind) so a re-run of the job never double-sends.
- Email preference on the consultant/admin: monthly ROI email on/off (one-click unsubscribe token).
- Follow existing new-table rules in `AGENTS.md`: RLS in the same migration, `private.attach_approval_gate(...)`
  on every new table, stated deploy order, not in `REQUIRED_SCHEMA` (the feature degrades — e.g. report page says
  "not available yet" — rather than 500s before its migration is applied). Ledger writes go through the service
  client (like `ai_runs` / `audit_log`), never client-writable. "Org admin" = firm owner or `admin` seat (owners count
  without a `firm_members` row).
- Family report "sent" is recorded by `/reports/family/:id/sent` (the counselor sends outside Meridies and marks it).

## Delivery (decided)

**In-app report page — source of truth.** Month picker; headline (hours saved · students served · either/or value vs.
extra students); per-task-type breakdown with each line's calculation and method; per-student list (names OK — it's the
consultant's own caseload); "estimated" labels on any default figure; separate "Activity" section with raw usage.

**Monthly consultant email** (Resend, existing `lib/email.ts`): 2–3 headline totals, link to the page, unsubscribe link,
**no student names**, keeps "estimated" labels. **First email waits until the consultant has 2+ weeks of use.**

**Org admin summary email + org page**: firm totals (hours saved, completions, students served, value of time computed
as the sum of each consultant's own snapshot rate × hours — shown only as a total). No individual rates.

Scheduling: a monthly job behind the existing `/internal` cron-secret pattern, recorded in `job_heartbeats`
(add a job name). Sends after month close (e.g. the 1st–2nd), idempotent via `kpi_email_sends`.

## Prospect averages (decided)

- Internal-only query/endpoint (staff), not a public page.
- Returns figures only when the pool has **≥10 consultants from ≥5 firms** (a solo consultant's own firm counts as one
  firm); below that, returns **nothing**, not a partial number.
- Uses only figures the consultant **edited** (unedited defaults excluded per figure).
- Aggregates only (averages/medians per task type, hours/month); no firm names, no students.

## Tests (required)

- A month that crosses a settings change: completions before and after use their own snapshots.
- An item re-run five times counts as one completion (and its time adds up).
- An aggregate below the 10-consultant / 5-firm threshold returns nothing.
- Plus builder's usual coverage: RLS (consultant can't read others; admin can't read rates), idle-gap exclusion,
  cap/fallback switching at 5 completions, negative totals render as "no time saved yet", email has no student names,
  first email held until 2 weeks of use, job re-run doesn't double-send.

## Calls made (Claude's, not confirmed by Elvin)

- Re-runs of the same item add their active time to the one completion (counts once, costs honestly).
- "Up to N more students" uses actual hours saved over the available months (up to 12), without projecting; page says
  "based on N months" when fewer than 12.
- "2+ weeks of use" = 14 days since the consultant's first counted completion.
- `college_list` and `activity_list` dedupe per student per month; the rest per item.
- Draft defaults (to be tuned): college list 240/30 min, essay feedback round 45/15, meeting prep + follow-up 45/15,
  family report 60/10, activity list 90/20; hourly rate $150; 40 hours per student per year.
- Existing consultants get a one-time, dismissible prompt for the signup figures.

## Left to the builder

Table/column names, ping transport and interval, exact page layout and email template, how sessions roll up,
which routes emit completion events, migration split, and confirming the "finished" moment for essay feedback and
activity lists (adding an explicit action where it's fuzzy).
