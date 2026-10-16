# Database migrations

## How a migration reaches production

`.github/workflows/migrations.yml` ("Apply migrations") applies `supabase/migrations/*.sql` to the
Supabase project `kerstlpuvpmstiavxblv`. The migration history was reconciled on 2026-10-12 (the
context repo's MASTER_TODO X12), so `supabase db push` is safe against this project and is what the
workflow runs.

1. **Merge the PR that carries the migration.** A push to `main` that touches `supabase/migrations/**`
   starts the workflow. So does a manual run (Actions > Apply migrations > Run workflow, on `main`).
2. **Plan** (no approval). It links the project, runs `supabase db push --dry-run`, and writes to the
   run summary: each pending file in order, the first line of its header comment, and flags for
   statements an approver must read (dropped tables or columns, deleted or updated rows, a changed
   column type, dynamic SQL in a DO block, a new table without RLS or the approval gate). It also runs
   the RLS and approval-gate check (`scripts/migrations/problems.sql`, only when its sha256 matches
   `PROBLEMS_SQL_SHA256` in the workflow) and reports what it finds as warnings. The plan holds
   write-capable production credentials before anyone approves anything; see "What the plan job can
   reach" below.
3. **An approver reads the plan.** The list is everything production hasn't applied, which can be more
   than this PR's files. For any flagged file, confirm a recent backup exists (Supabase > Database >
   Backups) and read the file. Then:
   - **With reviewers** (`MIGRATIONS_REVIEWERS_CONFIGURED` is `true`): approve the `production-db`
     deployment on the run.
   - **Without** (manual mode): run the workflow on `main` with **apply** on and **confirm** set to the
     newest version the plan lists (the summary names it). The person clicking must be in
     `MIGRATION_APPROVERS`; on a re-run, the check is against whoever clicked Re-run.
4. **Apply.** It dry-runs again and refuses if the list or any file's content changed since the plan
   (another apply, a file applied by hand). Then `supabase db push`, then the RLS and approval-gate
   check again: it fails on any table this apply left without RLS or the gate, and only warns about
   problems that were already there.
5. **Check the API.** `/health` reports `schema: true` on the new deployment. If Railway skipped or
   failed its deploy while the apply waited, redeploy it (below).

Without `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` the plan prints a notice, stays green, and
nothing touches the database: apply by hand (the sections further down are the by-hand route).

**Never use `--include-all` on production.** When a pending file is older than the newest version
production has applied, the CLI refuses and the plan fails with "older than the newest one on
production". Give the file a later timestamp in a new PR. `--include-all` would run it out of order
under a version history that says otherwise.

### Code and its migration land minutes apart, not in a fixed order

On a merge, Railway's deploy and this workflow start at the same time.

- **With Railway's "Wait for CI" on**, Railway waits for the GitHub checks on the commit it deploys,
  including this workflow while its apply waits for approval. So the commit that carries the migration
  deploys after it, and not at all if the apply is rejected or fails. That holds for that commit only.
  If another PR that touches no migration merges while the apply waits, it starts no migration run,
  `ci.yml` cancels the earlier commit's CI run, and Railway deploys the newer commit, which already
  contains the earlier code, before the migration is applied.
- **Without "Wait for CI"**, or in manual mode, the code can go live first.

So the protection is still what it was: every migration's PR states what happens if its code runs
before the migration (it degrades safely, or it goes in `REQUIRED_SCHEMA`, and then `/health` answers
503 and Railway keeps the previous deployment after its 120 s healthcheck; redeploy once the apply is
done).

The reverse matters too: the previous build keeps serving while the apply waits and the new build
starts. **A migration must be safe for the code that is already live.** Add first; drop or rename only
in a later PR, after the code that reads the old shape has shipped (the pattern `20261005030002`'s
FAFSA column drops would break today).

A rejected migration's code still reaches production with the next deploy of `main`, and only
`REQUIRED_SCHEMA` holds it back. Revert the PR rather than leave the migration rejected.

### When an apply fails or its check turns red

- **A file fails.** Each file is its own transaction and is recorded as it lands, so the files before
  it stay applied. Railway (with Wait for CI) skips the commit's deploy and `main` shows a red run.
  Fix forward with a new migration in a new PR; its merge runs the workflow again. "Re-run failed jobs"
  reuses the old plan and is refused at the drift check, which is intended: use "Re-run all jobs" or a
  new manual run.
- **The check after the apply is red.** The migration is applied, but a table it created has no RLS or
  no approval gate. Fix it forward with a migration that adds them. Railway skipped the deploy; once
  production is right, redeploy the Railway service by hand.
- **Railway waited too long.** An approval can wait for days. If Railway gave up on the commit, redeploy
  it after the apply. How long Railway waits on a pending check hasn't been measured.

### Setup, once (Elvin or Brandon)

1. **Secrets.** `SUPABASE_ACCESS_TOKEN` (a personal access token of a Supabase org member with access
   to `kerstlpuvpmstiavxblv`; a dedicated machine account is better, since the token can run any SQL
   through the Management API) and `SUPABASE_DB_PASSWORD`. Store them as environment secrets on both
   environments below, so a workflow edited on another branch can't read them. Repository secrets with
   the same names also work, readable from any branch.
2. **Environments.** `production-db-plan`: no reviewers, deployment branches `main` only.
   `production-db`: deployment branches `main` only, required reviewers where the GitHub plan allows
   them, "Prevent self-review" on. GitHub creates an environment named by a workflow automatically
   with no protection, which is why a push applies only when the variable below says reviewers exist.
3. **Variables.** `MIGRATION_APPROVERS` (comma-separated GitHub logins). `MIGRATIONS_REVIEWERS_CONFIGURED`
   = `true` only once `production-db` really has required reviewers; never before.
4. **Railway.** Turn on "Wait for CI" for the API service.
5. **First run: plan only.** Run the workflow by hand with apply off. Read the list (it may hold files
   from several PRs), check that the summary's "Connection" line shows the pooler host on port 5432,
   and that the database check reads the Management API's answer. The check may warn about tables made
   outside migrations (the stray `public.test`, LAUNCH_CHECKLIST); deal with those before the first
   apply so its warnings mean something.

### What the plan job can reach (the trade-off, and how to close it)

The plan job has no reviewers, and as set up above its environment holds the same
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` as the apply. The token can run any SQL through the
Management API. So the approval (reviewers, or the typed confirm and `MIGRATION_APPROVERS`) gates
`supabase db push`, not everything the workflow does with production credentials: whoever can merge
to `main` (or start a manual run on it) controls the workflow file, and with it the plan job.

What the repository does about it:

- In the plan job every step that holds a secret runs before any of our own code
  (`scripts/migrations/plan.mjs`), so an edit to that script can't plant a `$GITHUB_ENV` or
  `$GITHUB_PATH` entry that a secret-holding step would pick up.
- `scripts/migrations/problems.sql` runs against production (plan and apply) only when its sha256
  matches `PROBLEMS_SQL_SHA256` in `migrations.yml`. Changing the SQL that runs before approval means
  changing the workflow file too, and `npm test` (`migrations-workflow.test.ts`) fails until both
  agree. When you change the check, update the hash in the same PR and say so in its description.
- The CLI calls are the pinned CLI reading repository files as data: `db push --dry-run` reads the
  migration files and runs none of them.

What it can't do: stop a merged edit to `migrations.yml` itself from using the plan's secrets. Close
that outside the repository:

1. **A read-only credential for the plan.** Give `production-db-plan` its own secrets instead of the
   apply's: ideally a database role with `SELECT` on `supabase_migrations.schema_migrations` and the
   catalogs, logging in through the session pooler, and a workflow change to use it with `--db-url`
   for the plan's dry run and check (the unit test's ban on `--db-url` moves to the apply job then).
   Until that exists, the plan's credentials are as powerful as the apply's.
2. **Review by an approver.** A `CODEOWNERS` entry naming the `MIGRATION_APPROVERS` for
   `.github/workflows/**`, `scripts/migrations/**` and `supabase/migrations/**`, with branch protection
   on `main` requiring code-owner review, so nothing that runs with production credentials merges
   without one of them.

**GitHub plan.** The repository is private. Required reviewers on a private repository's environment
need GitHub Enterprise; Team has environments, environment secrets and branch rules but no reviewers.
On Team, leave `MIGRATIONS_REVIEWERS_CONFIGURED` unset and use manual mode. On Free, environment
protection isn't available for a private repository: use repository secrets and manual mode, where the
typed confirm and `MIGRATION_APPROVERS` are the approval. Confirm which applies with the first
plan-only run.

---

# History: how the earlier sets were applied by hand

The sections below are how each set was applied before the workflow existed. They stay as the by-hand
route for when the workflow can't run (no secrets, GitHub down): `supabase link` + `supabase db push`
from a laptop, or each file pasted whole into the SQL editor (which records no version, so the next
`db push` would try to run it again; prefer the CLI).

## Demo v10 sync

These steps brought the Supabase project `kerstlpuvpmstiavxblv` up to the schema the v10 backend and
app expect. They were applied by hand on 2026-10-06 (LAUNCH_CHECKLIST.md).

**Run them as soon as the PRs merge.** Railway and Vercel deploy `main` on merge, and until these
migrations are applied, routes that read the new columns fail. That includes existing screens: meetings
(`meeting_attendees`), AxIS chats (`ai_messages.trace`), Files (`folders.system_key`), invitations
(new `invitations` columns) and Financial aid (the FAFSA columns change).

Every file below was applied, in order, on a local Postgres with Supabase's auth/storage stubs and
then exercised through PostgREST and GoTrue with counselor, firm-colleague, student and outsider
accounts.

---

### 1. Take a backup

Supabase dashboard > Project `kerstlpuvpmstiavxblv` > Database > Backups. Confirm a recent backup
exists, or download one. Step 2's file `20261005030002` deletes data on purpose (see "Data that is
deleted" below), so a backup is the only way back.

### 2. Check where the database is today

In the SQL editor:

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 3;
```

The newest version should be `20260923000005`. If you have been pasting migrations into the SQL
editor by hand, this table may be empty or behind; in that case check that
`public.student_red_flags` (the view from `20260923000005`) exists and continue.

### 3. Apply the 24 new migrations, in this order

Option A, Supabase CLI (records each version, recommended):

```bash
cd meridies-backend
supabase link --project-ref kerstlpuvpmstiavxblv
supabase db push        # shows the 24 pending files; confirm
```

Option B, SQL editor: open each file below from `supabase/migrations/`, paste it whole and run it,
one at a time, in this order. Stop at the first error and send it over.

| # | File | What it does |
|---|---|---|
| 1 | `20261005010001_overview_work_items_and_pins.sql` | My Work Queue items, pinned students per consultant |
| 2 | `20261005010002_overview_invitation_intake_and_referrals.sql` | New student fields on `invitations`, `accept_invitation()` re-created, `referrals` |
| 3 | `20261005010003_overview_outcomes_and_alumni.sql` | Admission outcomes, alumni records, cycles, `close_admission_cycle()` |
| 4 | `20261005010004_overview_ai_module_mass_invite.sql` | Allows the `mass-invite` AI audit label |
| 5 | `20261005020001_student_application_college_list.sql` | College list board columns, SCEA, statuses renamed (data migrated), supplement prompt catalog, recommendations |
| 6 | `20261005020002_student_application_sheets.sql` | UC fields on activities and honors; blank rows allowed |
| 7 | `20261005020003_student_application_essays.sql` | Essays linked to schools, prompts, documents and Google Docs; word count computed by the database (existing rows recounted) |
| 8 | `20261005020004_student_application_coherence_and_activities.sql` | Coherence reports, Activities Build program fields |
| 9 | `20261005030001_student_page_profile_and_polygon.sql` | Student personal details, hidden polygon axes, 10-axis cap |
| 10 | `20261005030002_financial_aid_fafsa_and_scholarship_matching.sql` | FAFSA narrowed to status and due date (v8 rule), family financials, scholarship matching, 6 scholarships seeded |
| 11 | `20261005030003_student_communication.sql` | Composer preferences, `student_messages` |
| 12 | `20261005030004_student_private_note.sql` | The counselor's private notes box on the student page (counselor-only) |
| 13 | `20261005040001_college_profile_v10.sql` | College profile facts, admitted profile, Common Data Set editions, programs |
| 14 | `20261005040002_college_webinar_tips.sql` | Supplemental advice from webinars (starts empty) |
| 15 | `20261005040003_events_hub.sql` | Events Hub listings and saves (starts empty); allows the `college-research` AI label |
| 16 | `20261005040004_seed_college_v10.sql` | Catalog seed for the profiled schools and the Build College Lists schools (generated, idempotent) |
| 17 | `20261005050001_contact_pipeline.sql` | Contact Pipeline stages and contacts |
| 18 | `20261005050002_pipeline_payments.sql` | Payment Tracker packages, invoices, payments (cents; balances derived) |
| 19 | `20261005050003_management.sql` | Consultant tasks with subtasks, consultant summaries, staff email blasts |
| 20 | `20261005050004_email_templates.sql` | Per-consultant email templates; allows the `email-template` AI label |
| 21 | `20261005060001_calendar_event_types_and_practice_events.sql` | Calendar event types, type assignments, practice events |
| 22 | `20261005060002_meeting_attendees.sql` | Meetings with several students (existing meetings backfilled) |
| 23 | `20261005060003_practice_folders.sql` | "Practice templates" and "Policy & research" folders (backfilled per counselor) |
| 24 | `20261005060004_axis_message_trace.sql` | AxIS chats keep their reasoning steps and sources |

Every new table ships with RLS enabled and its policies in the same file.

#### Data that is deleted

`20261005030002` applies the v5 privacy rule that the v8 brief kept: the FAFSA shows its status and
due date only. It:

- drops `student_aid_profiles.fafsa_submitted_at` and `student_aid_profiles.efc_estimate`;
- deletes every `student_aid_checklist` row whose item is `fafsa`;
- maps old FAFSA statuses onto three (`verified` becomes `submitted`, `corrections-needed` becomes
  `in-progress`, `not-applicable` becomes `not-started`).

#### Data that is changed in place

- `20261005020001`: `student_colleges.status` `considering` becomes `not-started` and `applying`
  becomes `in-progress`. If a student had the same catalog college on their list twice, the newer row
  is kept but unlinked from the catalog (it stays on the list under its typed name), so the new
  unique index can be created without deleting anything.
- `20261005020003`: every existing essay's word count is recomputed from its text.
- `20261005030001`: existing students keep their current polygon axes; only students with no axes get
  the new default five.

### 4. Check it worked

```sql
select version from supabase_migrations.schema_migrations
 where version like '20261005%' order by version;            -- 24 rows (CLI path only)

select count(*) from pg_tables
 where schemaname = 'public' and rowsecurity = false;        -- expect 0
```

On Option B the first query returns nothing, because the SQL editor doesn't record versions. Run the
read-only check instead; it looks for every table the 24 files create and for the FAFSA column change:

```bash
node --env-file=.env scripts/verify-v10.mjs      # ends with "All checks passed."
```

Then Supabase dashboard > Advisors > Security: there should be no new "RLS disabled" or
"policy missing" warnings.

### 5. Settings outside the database

1. **Google consent screen.** Google Cloud Console > APIs & Services > OAuth consent screen > Scopes:
   add `https://www.googleapis.com/auth/drive.file`. Counselors who already connected Google need to
   disconnect and connect again once. Until they do, "Add essay" on the Application page explains
   the missing permission and files the prompts as plain records.
2. **Railway cron for scheduled messages.** Add a second cron next to the accountability sweep,
   every 5 to 15 minutes:

   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
     "https://<api-host>/communication/internal/dispatch"
   ```

   Without it, "Schedule send" and messages held for quiet hours stay scheduled and never go out.
   It needs `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`, which the sweep already uses.
3. **No new environment variables** and no new storage buckets.

### 6. If something fails

A failure leaves the earlier files applied and stops there. Send the file name and the error text.
Files 4, 15 and 20 rebuild the `ai_runs` module check by reading the current list back and adding
their label, so running any of them a second time is harmless.

---

## Student view (SV Demo v2): five more migrations

Apply these after the 24 above, in this order (today: the Apply migrations workflow; by hand,
`supabase db push`, or paste each file whole into the SQL editor). None deletes data. They were applied after every earlier file on a local
Postgres with Supabase's auth/storage stubs and exercised as a counselor, their student and a second
student.

| # | File | What it does |
|---|---|---|
| 25 | `20261010000001_student_view_preferences.sql` | `student_preferences` (banner preset or uploaded image, theme, the student's own text/email reminder channels); creates the private **`student-banners`** Storage bucket (5 MB, png/jpeg/webp) and its `storage.objects` policies |
| 26 | `20261010000002_student_view_polygon_read_only.sql` | Strength profile read-only for the student: axis insert/update/delete and history insert become counselor-only (`private.counselor_can_edit_student`) |
| 27 | `20261010000003_student_view_tasks.sql` | `deliverables.source` (`counselor` / `student`) and `created_by`; students may add, edit and delete only their own tasks, and only record progress on assigned ones (policies + two column-guard triggers); stage inserts/deletes and task document links become counselor-only |
| 28 | `20261010000004_student_view_files_scope.sql` | Restrictive policies: a student's documents and links must be about themselves and sit unfiled or in their own student folder; students create no folders |
| 29 | `20261010000005_profile_updates.sql` | Profile Update (AxIS): `profile_update_threads`, `profile_update_messages`, `profile_updates`; allows the `profile-update` AI audit label (additive) |

Data changed in place: `20261010000003` adds `deliverables.source` with default `counselor` (every
existing task was assigned by a counselor) and copies `assigned_by` into the new `created_by`.

Checks:

```sql
select id, public from storage.buckets where id = 'student-banners';      -- 1 row, public = false
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;  -- expect 0
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'ai_runs_module_check';                                   -- includes profile-update
```

Note: `20261005*`'s "no new storage buckets" no longer holds; `student-banners` is the one this set adds,
from SQL, so nothing needs creating in the dashboard. No new environment variables.

The app changes with it: `polygon` writes, `DELETE /tasks/:id/documents/:documentId` and the legacy
`/polygon/axes` writes are counselor-only in code too, so a student client that used them gets 403.

---

## AI context and research: two more migrations

Apply these after every earlier file, in this order. Both are additive and idempotent. Apply each
**before deploying the code that needs it**. (This section once said to avoid `supabase db push`
because the project's version history didn't match the files; that was reconciled on 2026-10-12, X12,
and the Apply migrations workflow is now the route.)

| # | File | What it does |
|---|---|---|
| 1 | `20261016000001_context_documents.sql` | Adds the document kinds the AI allowlist needs, `documents.ai_access` and `documents.ferpa_waived`, and hides restricted documents from students; apply before deploying the context-layer code, which selects the new columns |
| 2 | `20261016000002_research.sql` | Adds `deliverables.visible_to_student` (hidden counselor tasks, with restrictive RLS on the tables that point at a task), and the tables `research_runs`, `recommendations` and `research_blocked_domains`; apply before deploying the research code, and after file 1 |

With the research code deployed before file 2, every query that names `visible_to_student` fails
(creating a counselor task, every `PATCH /tasks/:id`, raising a flag, the escalation sweep, the
parent-alert draft, due-tomorrow reminders, the calendar feed, stall detection, the composer's
overdue check) as well as the research routes; the list is not exhaustive. The previous code ignores
the new column and tables, so applying the files first is always safe.

Check:

```sql
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;  -- expect 0
select to_regclass('public.research_runs'), to_regclass('public.recommendations');   -- both non-null
```

---

## AxIS: files in a chat (one more migration)

Apply after every earlier file (the Apply migrations workflow, or `supabase db push`). It
adds a table and a private bucket and deletes nothing. Either order is safe:
until it is applied, attaching a file in AxIS says files aren't switched on yet,
and messages go out without files as before.

| # | File | What it does |
|---|---|---|
| 1 | `20261020000001_axis_attachments.sql` | `ai_attachments` (owner-only RLS, the approval gate) and the private **`axis-attachments`** Storage bucket (10 MB; PDF, PNG, JPEG, WebP, GIF, plain text, Markdown, CSV) with its `storage.objects` policies, each counselor writing only under their own id |

Check:

```sql
select to_regclass('public.ai_attachments');                                          -- non-null
select id, public from storage.buckets where id = 'axis-attachments';                  -- 1 row, public = false
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;   -- expect 0
```

---

# Not yet applied: everything after `20261022000001`

These twenty-eight files are merged ahead of production's database on purpose: the code was written to
run without them, so they can go in when the team is ready. Until then the Apply migrations workflow's
plan lists all of them on every merge that touches `supabase/migrations/**`; leave the apply job
unapproved (manual mode: don't run it with apply on). None of them is in `REQUIRED_SCHEMA`, so
`/health` stays green and Railway keeps deploying.

What works without them: every existing screen and route, unchanged (the persona suites from before
these files pass against a database that has none of them). Each new feature answers that it isn't
switched on yet: the questionnaire save stores the answers and copies nothing (`fromQuestionnaire: []`),
step-2 import routes `503 { code: "imports_unavailable" }` and `GET /imports` `{ available: false }`,
caseload transfer `503 { code: "caseload_transfer_unavailable" }` (removing a firm member keeps today's
behaviour), meetings `invites: { status: "unavailable" }`, colleges `photo: null`, and the extended
Scorecard figures read null (the monthly load writes every older figure).

Apply in this order, after taking a backup (the workflow, or `supabase db push` from a laptop). Each
set's own section below says what it does and how to check it.

| # | File | Set |
|---|---|---|
| 1 | `20261023010001_intake_import_targets.sql` | Questionnaire sync |
| 2 | `20261023010002_intake_profile_sync.sql` | Questionnaire sync |
| 3 | `20261023010003_intake_held_import_default.sql` | Questionnaire sync |
| 4 | `20261023010004_intake_profile_backfill.sql` | Questionnaire sync (runs the backfill) |
| 5 | `20261023020001_imports_step2_schema.sql` | Import pipeline step 2 |
| 6 | `20261023020002_imports_step2_functions.sql` | Import pipeline step 2 |
| 7 | `20261023020003_imports_step2_review.sql` | Import pipeline step 2 |
| 8 | `20261023030001_caseload_transfer.sql` | Caseload transfer |
| 9 | `20261023030002_caseload_transfer_functions.sql` | Caseload transfer |
| 10 | `20261023030003_remove_firm_member_caseload.sql` | Caseload transfer |
| 11 | `20261023070001_college_photos.sql` | Campus photos |
| 12 | `20261023080001_college_stats_scorecard_more.sql` | College Scorecard figures |
| 13 | `20261023090001_meeting_calendar_invites.sql` | Emailed meeting invites |
| 14 | `20261024000011_meeting_calendar_owner_guard.sql` | Security: meeting owner and calendar pointer guard |
| 15 | `20261024000012_meeting_calendar_forged_rows.sql` | Security: meeting owner and calendar pointer guard |
| 16 | `20261024000021_firm_membership_writes.sql` | Security: RLS and ownership |
| 17 | `20261024000022_student_files_ownership.sql` | Security: RLS and ownership |
| 18 | `20261024000023_invitation_accept_state.sql` | Security: RLS and ownership |
| 19 | `20261024000024_student_message_recipients.sql` | Security: RLS and ownership |
| 20 | `20261024000025_profile_archive_counselor_only.sql` | Security: RLS and ownership |
| 21 | `20261024000041_document_storage_paths.sql` | Security: submission review and reminders |
| 22 | `20261024000042_counselor_recorded_phone.sql` | Security: submission review and reminders |
| 23 | `20261024000043_submit_intake_once.sql` | Security: submission review and reminders |
| 24 | `20261024000051_chat_counselor_only.sql` | Security: AxIS chats are the counselor's |
| 25 | `20261024000061_import_invite_review_per_counselor.sql` | Security: import invitation review (after file 7) |
| 26 | `20261024000071_college_photo_review.sql` | Security: campus photos wait for review (after file 11) |
| 27 | `20261024000081_profile_size_limit.sql` | Security: caseload files and profile size |
| 28 | `20261024000082_caseload_transfer_keeps_other_files.sql` | Security: caseload files and profile size (after file 9) |

(Twenty-eight files: the first thirteen are six feature sets, the other fifteen are seven sets of security
fixes. `20261022000001_visit_offerings.sql`, the file just before them, is not part of this list.)

Files 21-23, the security fixes for submission review and student reminders, depend on none of the
others: `20261024000041_document_storage_paths.sql` (a documents row
names only the documents bucket and a path the bucket's insert policy could have taken, and never
moves; client roles only), `20261024000042_counselor_recorded_phone.sql`
(`profiles.phone_recorded_by_counselor`, trigger-written; reminder texts go only to it, so until it
is applied no reminder text is sent) and `20261024000043_submit_intake_once.sql` (a repeated New
student Submit moves and returns nothing). The code already enforces each in the API; check after
applying with `test/integration/submission-hardening.test.mjs` and `student-reminders.test.mjs`
(their database checks run only once the files are in).

Order between the files matters in these places: step 2's staging (file 6) and review (file 7) call
`private.intake_owns_current` from file 3; the caseload transfer (file 9) reads step 2's
`import_items.invite_state` / `invite_claimed_at` (file 5); file 15 clears rows the guard in file 14
would have refused (run it again if it went in first); file 25 replaces `request_import_commit` from
file 7, file 26 extends the campus photos of file 11, and file 28 replaces `transfer_caseload` from
file 9 (each with the same signature and grants, built on the round-one body). Applying the files in
the order above satisfies all of them. Apart from those two replacements (`request_import_commit`,
files 7 and 25; `transfer_caseload`, files 9 and 28), no function, policy or trigger is defined in two
of these files; the shared CHECK constraints (`ai_runs_module_check`, the `ingest_runs` and
`job_heartbeats` labels) are rewritten additively, each file reading the current list back.

After all twenty-eight:

```sql
select count(*) from public.import_fields;                                            -- 25
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;   -- expect 0
```

and `node --test test/integration/approval-db.test.mjs` against a staging copy finds the approval gate
on every new table.

---

## RLS and ownership: `20261024000021`-`25`

Closes table-level paths a signed-in user could take straight through PostgREST (AGENTS.md:
"Only `accept_invitation()` marks an invitation accepted", the composer, "Firm teams", "Documents
and AI context", "A student can't archive or restore themselves"). Each file is independent of the
others and of the sets above, and safe for the build that is serving: the API never made any of the
writes these files refuse. Nothing is deleted; rows planted before them stay, and each file's header
has a read-only audit query. They change grants, policies, triggers and one function body
(`private.deliverables_sync_intake_request`, now also requiring the task's student to be the one who
accepted the invitation).

Check:

```sql
select count(*) from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'firm_members' and grantee = 'authenticated'
   and privilege_type in ('INSERT','UPDATE','DELETE');                                 -- 0
select count(*) from pg_trigger where tgname in ('invitations_guard_client', 'deliverables_guard_intake_link',
  'student_messages_guard_client', 'profiles_guard_self_archive');                     -- 4
```

and `node --test test/integration/ownership-rls.test.mjs` against a staging copy.

---

## Questionnaire sync: `20261023010001`-`04`

The onboarding questionnaire's answers (`profiles.profile.intakeAnswers`) fill the real fields, fill
only what is empty, through the import pipeline's compare-and-set (AGENTS.md, "The questionnaire
fills the record"). Additive: no import function changes signature or behaviour for its callers.
Either order with the code is safe: before the files, a save stores the answers as it always did,
the info card's `fromQuestionnaire` is `[]`, sheet rows carry no `fromQuestionnaire`, and the held
queue has no `currentSource`.

| # | File | What it does |
|---|---|---|
| 1 | `20261023010001_intake_import_targets.sql` | Adds `import_fields` rows `profiles.high_school` / `hometown` / `grad_year`, `student_academics.gpa_band` and `awards *` (25 in all; the `target_table` CHECK widened); re-creates `import_value_ok_raw` (type `grad_year`, `row:award`, activity keys `timing` / `continuing` / `uc_description`), `import_current_value`, `import_set_field`, `import_row_snapshot` and `import_delete_row` (awards branch only) as supersets; a 4-argument `import_insert_row(target, student, row, source)` with the 3-argument form kept as a wrapper stamping `'import'` |
| 2 | `20261023010002_intake_profile_sync.sql` | `intake_fills` (what the questionnaire last wrote, as hashes; RLS, the approval gate, no client writes), the sync (`private.sync_intake_answers` and its helpers), the AFTER trigger `profiles_fill_from_questionnaire` on `profiles.profile`, and `public.intake_filled_fields(p_student)` for the counselor's marks |
| 3 | `20261023010003_intake_held_import_default.sql` | `private.intake_owns_current`; re-creates `import_held_queue()` and `request_held_apply(uuid, jsonb)` so a field the questionnaire filled (unchanged) defaults to accept and reports `currentSource: 'intake'` |
| 4 | `20261023010004_intake_profile_backfill.sql` | `private.backfill_intake_answers(p_only uuid default null)`, then runs it once for every student with answers on file (archived students skipped; one `audit_log` row, counts only). Re-running it changes nothing |

Check:

```sql
select count(*) from public.import_fields;                                             -- 25
select to_regclass('public.intake_fills');                                             -- non-null
select tgname from pg_trigger where tgname = 'profiles_fill_from_questionnaire';       -- 1 row
select to_regprocedure('public.intake_filled_fields(uuid)') is not null;               -- true
select action, metadata from public.audit_log
 where action like 'intake.backfill%' order by created_at desc limit 1;                -- the backfill's counts
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;   -- expect 0
```

---

## Import pipeline step 2 (CSV/XLSX path): `20261023020001`-`03`

Apply after every earlier file, in this order, the same way (paste each file whole into the SQL
editor, or the Management API; rehearse on a staging copy first). All three are additive: they add
columns and functions, re-create one trigger function as a superset, and delete nothing. Applying
them before the code is safe (nothing calls the new functions, and the old roster flow keeps
working). The code is safe before them too: every step-2 route answers
`503 { code: "imports_unavailable" }`, `GET /imports` answers `{ available: false }`, and Ready to
apply, commit, undo and the status poll keep working. None of it is in `REQUIRED_SCHEMA`.

| # | File | What it does |
|---|---|---|
| 1 | `20261023020001_imports_step2_schema.sql` | `roster_imports.plan`, `stats`, `staged_at`, `invites_held_reason`, `invites_approved_at`; `import_files.row_count`; `import_items.flags` and `invite_claimed_at` (and `invite_state` gains `sending`); `import_changes.alternatives`, `source_column`, `flags`. Re-creates `private.roster_imports_guard_client()`: every new column is client-proof, and a row `start_import` created is the API's alone (no client update or delete). Adds `import-mapping` and `import-cleanup` to `ai_runs_module_check`, additively |
| 2 | `20261023020002_imports_step2_functions.sql` | The import worker's functions (register a file, the plan, templates, AI spend, the roster for matching, staging) and the helpers they share. EXECUTE to `import_worker` and `service_role` only |
| 3 | `20261023020003_imports_step2_review.sql` | What the browser may call (`start_import`, review decisions, discard, templates, the invitation claim), the review reads, retention for the sweep, and `imports_step2_ready()` last. Replaces `request_import_commit(uuid)` with `request_import_commit(uuid, integer default null)` (the invitation count); calls with only `p_import` keep working |

Check:

```sql
select to_regprocedure('public.imports_step2_ready()') is not null;                  -- true
select to_regprocedure('public.stage_import(uuid,uuid,jsonb)') is not null;          -- true
select plan, stats from public.roster_imports limit 0;                                -- no error
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;   -- expect 0
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'ai_runs_module_check';                                              -- includes import-mapping
```

Settings outside the database (Railway): `IMPORTS_ROLLOUT` (default `pilot`) and `IMPORTS_PILOT`
(firm ids or solo counselor ids) decide who sees the Import page; `IMPORTS_AI=off` is the kill switch
for the AI column mapping. `IMPORT_DATABASE_URL` and the `/internal/imports/sweep` cron must already
be in place (step 1). Leave `IMPORT_HOLD_EXPIRY_ENABLED` unset until the app's Ready to apply page is
live in production, then run the grace update below first, so nothing held since step 1 expires
unseen:

```sql
update public.import_items
   set held_until = greatest(held_until, now() + interval '14 days'), hold_warned_at = null
 where match_status = 'awaiting_counselor';
```

Once a counselor's saved imports would send more than 50 invitations in all (and Meridies has
approved none of their imports yet), the import saves its data but holds the invitations; an email
goes to `ACCESS_REVIEW_EMAIL`. Approve by hand, which releases this import and every later one of
that counselor:
`update public.roster_imports set invites_approved_at = now() where id = '<import id>';`
The API applies this rule itself; `20261024000061` (below) makes the database apply it too.

---

## Caseload transfer: `20261023030001`-`03`

Spec: `docs/superpowers/specs/2026-10-15-caseload-transfer-design.md`. Apply in
this order, after every earlier file. Nothing is deleted. Either order with the
code is safe: before the files, the transfer, preview, history and policy
routes answer `503 { code: "caseload_transfer_unavailable" }`, the student
page's `transferredFrom` reads null, and removing a firm member falls back to
the 1-argument `remove_firm_member` (today's behaviour). None of it is in
`REQUIRED_SCHEMA`.

| # | File | What it does |
|---|---|---|
| 1 | `20261023030001_caseload_transfer.sql` | `caseload_transfers` and `caseload_transfer_students` (RLS, the approval gate, no client writes); `practice_settings.caseload_transfer_mode` (`one_person` / `per_student`, default `per_student`) and `caseload_default_receiver`, with a trigger keeping the receiver an approved member of the firm; the closed-cycle lock guard on `admission_outcomes` lets a SECURITY DEFINER caller change only a locked row's owner |
| 2 | `20261023030002_caseload_transfer_functions.sql` | `caseload_transfer_preview(p_from)` and `transfer_caseload(...)` (SECURITY DEFINER, firm owner/admin only), and two private helpers |
| 3 | `20261023030003_remove_firm_member_caseload.sql` | Drops the 1-argument `remove_firm_member` and creates `remove_firm_member(p_profile, p_release_students default false)`, which refuses a member who still has students (archived included) until they are transferred or an owner/admin releases them; `firm_consultants()` gains `archived_count` (drop and recreate, same grants) |

**Behaviour change from file 3 alone:** once it is applied, removing a firm
member who still has students is refused (409 `caseload_not_transferred`),
including through AxIS's `firm.remove_member`, until Management's transfer has
moved them or an owner/admin removes them with "Let them take their students"
(`?releaseStudents=true`).

Check:

```sql
select to_regclass('public.caseload_transfers'), to_regclass('public.caseload_transfer_students');  -- both non-null
select count(*) from public.caseload_transfers;                                                       -- 0 on a fresh apply
select oid::regprocedure from pg_proc where proname = 'remove_firm_member';                           -- one row: remove_firm_member(uuid,boolean)
select column_name from information_schema.columns
 where table_name = 'practice_settings' and column_name like 'caseload_%';                            -- 2 rows
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;                  -- expect 0
```

---

## Campus photos: `20261023070001`, `20261024000071`

Apply after every earlier file. It adds a table and the project's first
**public** bucket, and deletes nothing. Either order is safe: until it is
applied, every college response carries `photo: null` (the app falls back to
its 43 static photos), and `POST /internal/ingest/college-photos` answers 503
naming this file.

| # | File | What it does |
|---|---|---|
| 1 | `20261023070001_college_photos.sql` | `college_photos` (one freely licensed Commons photo per college with its credit, license, deed and file page; any signed-in user reads, only service_role writes; the approval gate) and the public **`college-photos`** Storage bucket (3 MB, JPEG only, no `storage.objects` policy: only the loader writes). Adds `college-photos` to the `ingest_runs` and `job_heartbeats` labels by reading the current CHECKs back, and a `job_heartbeats` row (31 days) |
| 2 | `20261024000071_college_photo_review.sql` | `college_photo_candidates`, the review queue: a new or changed photo (or a changed credit for one already shown) the loader held until Wikidata and Commons have been quiet about it for a week, with why and when a run first and last saw it (service_role only, no policies, the approval gate). Adds the nullable `ingest_runs.counts` (each run's counts by outcome). Either order: without it new photos still pass on their timestamps, replacements are held, and the run's row is finished without counts |

Check:

```sql
select to_regclass('public.college_photos');                                          -- non-null
select id, public from storage.buckets where id = 'college-photos';                    -- 1 row, public = true
select count(*) from job_heartbeats where job = 'college-photos';                      -- 1
select to_regclass('public.college_photo_candidates');                                -- non-null
select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;   -- expect 0
```

Then load the photos once by hand (`npx tsx --env-file=.env scripts/ingest/college-photos.ts`,
after a `--dry-run` to look the list over), or `/internal/status` reads the new job overdue
until the first monthly run.

---

## College Scorecard: more figures on college_stats: `20261023080001`

Apply after every earlier file, the same way. It adds columns to `college_stats`
and deletes nothing; no new table, so no new policies (the table keeps its
select policy, its approval gate and service-role-only writes). Either order is
safe: before it, the profile serves the new figures as null, and the Scorecard
load writes every older figure exactly as before (the run ends `succeeded`,
the missing columns logged as a warning, the heartbeat clean), so nothing
alerts while the file is held back.

| # | File | What it does |
|---|---|---|
| 1 | `20261023080001_college_stats_scorecard_more.sql` | Adds the completion cohort and rates (`completion_basis`, `grad_rate_on_time`, `grad_rate_150`, `completion_by_race`), `retention_rate`, `part_time_share`, `student_faculty_ratio`, `grad_students`, `demographics`, `room_board_on_campus`, `books_supplies`, `median_earnings_6yr`, `median_debt_monthly`, `median_debt_noncompleters` and `carnegie_basic` |

Then run the Scorecard load once (`POST /internal/ingest/scorecard` with the
cron secret, or `npx tsx --env-file=.env scripts/ingest/scorecard.ts`), or the
columns stay empty until the monthly cron.

Check:

```sql
select count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'college_stats'
   and column_name in ('completion_basis', 'grad_rate_150', 'demographics', 'carnegie_basic');  -- expect 4
-- after the load:
select count(*) filter (where completion_basis is not null), count(*) from college_stats;
select status, errors from ingest_runs where source = 'scorecard' order by started_at desc limit 1;  -- succeeded, []
```

---

## Meetings, emailed calendar invites: `20261023090001`

Apply after every earlier file (`supabase db push`, or paste it into the SQL
editor). It adds columns, a CHECK, a trigger and an index, and deletes
nothing. Either order is safe: until it is applied, meetings work as before,
`sendInvites` is answered `invites: { status: "unavailable" }`, and no invite
email is sent.

| # | File | What it does |
|---|---|---|
| 1 | `20261023090001_meeting_calendar_invites.sql` | `meetings.send_invites` (default false) with the CHECK `meetings_invites_need_end` (invites need an end time), `meetings.ics_sequence` written only by the trigger `meetings_ics_sequence` (raised on every change a calendar shows), and `message_deliveries.meeting_id` (on delete set null) with its index |

Check:

```sql
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'meetings' and column_name in ('send_invites', 'ics_sequence');  -- 2 rows
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'message_deliveries' and column_name = 'meeting_id';            -- 1 row
select tgname from pg_trigger where tgrelid = 'public.meetings'::regclass and tgname = 'meetings_ics_sequence';  -- 1 row
```

Invites reach families only once `INVITE_FROM_EMAIL` is on a verified Resend
domain (`LAUNCH_CHECKLIST.md`).

## Meetings: the owner and the calendar pointer: `20261024000011`, `20261024000012`

A security fix. A meeting's `calendar_provider` / `calendar_event_id` name an
event on the calendar of `meetings.counselor_id`, and the API acts on it with
that counselor's stored tokens; before this file any approved counselor could
write a meeting naming another counselor as its owner, and read-only
collaborators could write meetings. It depends only on files already in
production, so it can be applied on its own, ahead of the rest of this list.
Either order with the code is safe (the code already calls a provider only for
the caller's own meeting, and emails invites or spends a counselor's invite
throttle only for a meeting whose student is on that counselor's caseload). The
first file adds a trigger and replaces policies; the second clears the
calendar pointer on rows already in the table whose owner has no hold on the
student (forged before the guard). Neither deletes anything. Apply them
together, 11 then 12; if 12 went in first, run it again after 11 (it is
idempotent).

| # | File | What it does |
|---|---|---|
| 1 | `20261024000011_meeting_calendar_owner_guard.sql` | Trigger `meetings_owner_guard` (a user session books only as itself, never changes `counselor_id`, and changes the calendar pointer only on its own meeting; `transfer_caseload` and the service role pass), `meetings_write` replaced by insert/update/delete policies on `private.counselor_can_edit_student`, and `meeting_attendees_write` narrowed to students the caller can edit |
| 2 | `20261024000012_meeting_calendar_forged_rows.sql` | Clears `calendar_provider` / `calendar_event_id` on every meeting whose `counselor_id` is neither the student's counselor nor a collaborator on the student (any access; approval not asked), and raises a notice with the count. `counselor_id` and the provider's own event are left as they are |

Before applying, list what the second file will clear (read-only):

```sql
select m.id, m.counselor_id, m.student_id, s.counselor_id as students_counselor, m.calendar_provider, m.created_at
  from public.meetings m join public.profiles s on s.id = m.student_id
 where (m.calendar_provider is not null or m.calendar_event_id is not null)
   and s.counselor_id is distinct from m.counselor_id
   and not exists (select 1 from public.student_collaborators c
                    where c.student_id = m.student_id and c.counselor_id = m.counselor_id);
```

A row there whose owner never worked with the student was forged; tell that
counselor, since the event it named is on their calendar. A row left by a
collaborator since removed is harmless either way. After applying, the same
query returns no rows.

Check:

```sql
select tgname from pg_trigger where tgrelid = 'public.meetings'::regclass and tgname = 'meetings_owner_guard';  -- 1 row
select policyname from pg_policies where schemaname = 'public' and tablename = 'meetings' order by 1;
-- approval_gate, meetings_delete, meetings_insert, meetings_select, meetings_select_attendee, meetings_update
```

and `node --test test/integration/meeting-calendar-owner.test.mjs` against a staging copy.

## Security: AxIS chats are the counselor's: `20261024000051`

Restrictive INSERT policies: only an approved counselor creates an `ai_conversations`,
`ai_messages` or `ai_attachments` row or uploads into the `axis-attachments` bucket. Reads,
renames and deletes keep their owner policies. Either order is safe: the API already answers
403 to a student on every `/chat` route but deleting their own chat (AGENTS.md, "The essay
restriction"). Not in `REQUIRED_SCHEMA`.

Check:

```sql
select polname from pg_policy where polname in
  ('ai_conversations_insert_counselor', 'ai_messages_insert_counselor', 'ai_attachments_insert_counselor', 'axis_attachments_insert_counselor');  -- 4 rows
```

---

## Import invitation review per counselor: `20261024000061`

Apply after `20261023020003` (it replaces that file's `request_import_commit(uuid, integer)` with
the same signature and body, except the hold). Either order with the code is safe: the API holds
invitations by the same rule after each commit request and before every send, writing
`invites_held_reason` through the service role, and the previous code reads that column as before.
Not in `REQUIRED_SCHEMA`.

| # | File | What it does |
|---|---|---|
| 1 | `20261024000061_import_invite_review_per_counselor.sql` | `request_import_commit` holds an import's invitations when none of the counselor's imports is approved yet and the invitations their saved imports have sent or still hold, plus this import's, pass 50 (it held only a first import over 50, which a split list or a one-row import saved first skipped) |

Check:

```sql
select prosrc like '%v_prior + v_invites > 50%' from pg_proc
 where oid = to_regprocedure('public.request_import_commit(uuid,integer)');   -- true
```

---

## Profile size bound: `20261024000081`

A `BEFORE INSERT OR UPDATE OF profile` trigger on `public.profiles`
(`private.profiles_profile_size`) refuses a `profile` over 400,000 characters of jsonb text that is
larger than the stored one (errcode 23514, "Profile is too large"). The API already bounds the merged
value at 200,000 characters of JSON (`lib/profileSize.ts`) on `PATCH /auth/me` and
`PATCH /students/:id`; this adds the same rule for a direct PostgREST write. A trigger, not a CHECK,
so a row already over the bound still takes every other update (accept_invitation, a transfer, a name
change) and can shrink. Either order with the code; not in `REQUIRED_SCHEMA`.

Check, before applying, how many profiles are already over (they keep working, but can't grow):

```sql
select count(*) from public.profiles where length(profile::text) > 400000;
select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_profile_size';  -- one row
```

## Caseload transfer, files: `20261024000082`

Replaces `public.transfer_caseload` (file 9 above) with the same signature, grants and body except
the step that moves documents and links: a file moves only when it is about a moved student (to that
student's receiver) or has no student and is filed in the moved folder tree (with the tree). A file
about anyone else filed in that tree stays with its owner and is unfiled; the answer counts these as
`attention.keptFiles`. Apply after `20261023030002` (filename order does it). Either order with the
code: the API reads `keptFiles` as 0 when the function doesn't send it. Not in `REQUIRED_SCHEMA`.

```sql
select prosrc like '%keptFiles%' from pg_proc where proname = 'transfer_caseload';  -- true
```
