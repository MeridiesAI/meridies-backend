# Monthly ROI report ("time Meridies saved you") — design

Date: 2026-10-26 · Status: approved by Elvin 2026-10-26 · Repos: meridies-backend, meridies-app

## Why

Consultants (and the organizations that pay for them) need a believable, monthly answer to "is Meridies worth it?" —
"you saved 14 hours across 22 students this month." The same data, anonymized and aggregated, becomes proof for
prospects. Believable beats impressive: one number a consultant knows is inflated poisons the whole report.

## Audiences

| Who | Sees | Never sees |
|---|---|---|
| Consultant (independent or in a firm) | Their own detailed report: per-task breakdown, per-student detail, how every number was calculated | Anyone else's data |
| Org admin (firm `owner`/`admin`) | Firm totals only, and only when 3+ consultants contributed that month | Any per-person breakdown, rates or time |
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
- Becoming a surveillance tool for orgs: admins never see per-person numbers, and raw activity signals are not kept.
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

- The app sends lightweight heartbeats while the consultant is on a page tied to a trackable item (student + task
  type + item id): on start, then periodically while there's input/focus, and on completion.
- **Heartbeats carry no durations (decided).** The server computes each increment from its own receive timestamps:
  it adds the gap since that task's last heartbeat only if the gap is under the 10-minute idle limit.
- **One last-heartbeat timestamp per task (decided)**, so several open tabs can't double count.
- **The heartbeat endpoint** checks that the task belongs to the signed-in consultant and is rate-limited to about
  one per 30 seconds per task.
- **Abandoned tasks (decided):** an in-progress task with no activity for 14 days is deleted and never counted.
- Re-runs/edits of the same item in the same month add their active time to that one completion (honest cost of
  re-running). *(Claude's call — see "Calls made".)*
- **Retention (decided):** store only the computed per-task duration. Raw pings and idle-detection signals are rolled
  up into a per-item running total of active seconds and **deleted within 24 hours** of being computed (a scheduled
  purge, plus purge on completion). Nothing finer-grained than "active seconds on this item" is ever kept.

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
| `meeting` | **New explicit "Notes sent" mark** on a held meeting (a record-only mark like `/reports/family/:id/sent`; Meridies does not email anything) | meeting (via `meetings.meeting_note_id`) | **Must be added** — today notes only have a `visibility` flag, no send event |
| `family_report` | `family_reports.status → 'sent'` (`sent_at`); if an export/download path exists without "send", add an explicit "Exported" event | report | Send exists; export TBD by builder |
| `activity_list` | Accepting activities research recommendations (`research_runs.feature='activities'`), last run per question | student + month | Exists; builder confirms whether a resume/list "finalize" moment exists — if not, **add an explicit one** |

Rule: when an item lacks a clear completion event, **add an explicit user action**; never infer completion from
idle time or page views.

## Data (shape decided; names/columns are builder's call)

- **`kpi_baselines`** — per consultant: per-task `manual_minutes`, `meridies_minutes`, each with an `edited` flag;
  plus `hourly_rate`, `hours_per_student_year`, each with `edited`. RLS: the consultant only; org admins never read
  rates directly.
- **`kpi_task_sessions`** — per (consultant, task type, item): running total of active seconds only. Raw pings live
  in a short-lived table (or are folded in on arrival) and are purged within 24 hours (see Retention).
- **`kpi_completions`** — the ledger. One row per completion with **snapshots taken at completion time**:
  `manual_minutes`, `manual_is_estimate`, `meridies_minutes`, `measure_method`, `saved_minutes`, `hourly_rate`,
  `rate_is_estimate`, plus consultant, firm (at that time), student, task type, source entity, dedupe key, month.
  Reports read only this table; they never look up current settings.
  Unique on (consultant, task type, dedupe key) so retries/re-runs can't double count.
- **Undo (decided):** a month is **finalized** when the monthly job sends (or would send) that consultant's report.
  If the completing action is undone before then (list deactivated/deleted, accepted recommendation's row or task
  deleted, family report un-marked sent, "Notes sent" un-marked, essay feedback round reopened), its completion is
  removed and its time no longer counts. After finalization the month is locked and never changes. Each completion
  source needs a matching reversal hook; the builder lists them.
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

**Org admin summary email + org page**: firm totals only (hours saved, value of time computed as the sum of each
consultant's own snapshot rate × hours, plus completions and students served). **No per-person breakdown.** Firm totals
appear **only when 3+ consultants contributed that month**; otherwise the page (and email) says "Firm totals appear
once 3 or more consultants are active this month." This stops an admin subtracting their own stats to reveal a
colleague's. Every consultant, admins included, still sees their own detailed report.

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
- A 2-consultant firm's admin gets no firm totals (the "appear once 3 or more" message).
- Undo before the month is finalized removes that task's time; undo after the report is sent changes nothing.
- Raw activity rows are purged after their duration is computed (none older than 24 hours remain).
- Two tabs heartbeating the same task over the same 5 minutes count 5 minutes.
- A 2-hour gap between heartbeats adds nothing.
- A heartbeat for another consultant's task is rejected.
- An in-progress task with no activity for 14 days is purged and never counted.
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

- A task item still in progress keeps only its running active-seconds total between sessions (no raw pings).

## Privacy policy (decided — blocks launch)

Add to the privacy policy (landing PR #38, or a follow-up PR if #38 has merged): Meridies measures time spent on
tasks to calculate time saved; shows it only to the consultant and, as firm totals, to their organization; and uses
anonymized averages across many consultants in marketing. **This must merge before time tracking ships** (gate the
pings behind a flag that stays off until then).

## Decided by Elvin after review

- Visibility: consultants see their own detail; org admins see firm totals only, no per-person breakdown.
- Firm totals only with 3+ contributing consultants that month.
- Undo before finalization removes the time; after the report is sent, nothing changes.
- Raw activity purged within 24 hours; only per-task duration kept.
- "Notes sent" on a meeting is a manual mark (no email sent by Meridies).
- Privacy policy update merges before tracking ships.
- Heartbeats carry no durations; one last-heartbeat timestamp per task; 1 per ~30s per task; ownership checked;
  in-progress tasks idle 14 days are deleted.

## Left to the builder

Table/column names, ping transport and interval, exact page layout and email template, how sessions roll up,
which routes emit completion events, migration split, and confirming the "finished" moment for essay feedback and
activity lists (adding an explicit action where it's fuzzy).
