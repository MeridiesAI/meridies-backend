# Database migration instructions: Demo v10 sync

These steps bring the Supabase project `kerstlpuvpmstiavxblv` up to the schema the v10 backend and app
expect. They were not applied automatically: the project is not reachable from the session that wrote
this change.

**Run them as soon as the PRs merge.** Railway and Vercel deploy `main` on merge, and until these
migrations are applied, routes that read the new columns fail. That includes existing screens: meetings
(`meeting_attendees`), AxIS chats (`ai_messages.trace`), Files (`folders.system_key`), invitations
(new `invitations` columns) and Financial aid (the FAFSA columns change).

Every file below was applied, in order, on a local Postgres with Supabase's auth/storage stubs and
then exercised through PostgREST and GoTrue with counselor, firm-colleague, student and outsider
accounts.

---

## 1. Take a backup

Supabase dashboard > Project `kerstlpuvpmstiavxblv` > Database > Backups. Confirm a recent backup
exists, or download one. Step 2's file `20261005030002` deletes data on purpose (see "Data that is
deleted" below), so a backup is the only way back.

## 2. Check where the database is today

In the SQL editor:

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 3;
```

The newest version should be `20260923000005`. If you have been pasting migrations into the SQL
editor by hand, this table may be empty or behind; in that case check that
`public.student_red_flags` (the view from `20260923000005`) exists and continue.

## 3. Apply the 24 new migrations, in this order

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

### Data that is deleted

`20261005030002` applies the v5 privacy rule that the v8 brief kept: the FAFSA shows its status and
due date only. It:

- drops `student_aid_profiles.fafsa_submitted_at` and `student_aid_profiles.efc_estimate`;
- deletes every `student_aid_checklist` row whose item is `fafsa`;
- maps old FAFSA statuses onto three (`verified` becomes `submitted`, `corrections-needed` becomes
  `in-progress`, `not-applicable` becomes `not-started`).

### Data that is changed in place

- `20261005020001`: `student_colleges.status` `considering` becomes `not-started` and `applying`
  becomes `in-progress`. If a student had the same catalog college on their list twice, the newer row
  is kept but unlinked from the catalog (it stays on the list under its typed name), so the new
  unique index can be created without deleting anything.
- `20261005020003`: every existing essay's word count is recomputed from its text.
- `20261005030001`: existing students keep their current polygon axes; only students with no axes get
  the new default five.

## 4. Check it worked

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

## 5. Settings outside the database

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

## 6. If something fails

A failure leaves the earlier files applied and stops there. Send the file name and the error text.
Files 4, 15 and 20 rebuild the `ai_runs` module check by reading the current list back and adding
their label, so running any of them a second time is harmless.

---

# Student view (SV Demo v2): five more migrations

Apply these after the 24 above, in this order, the same way (`supabase db push`, or paste each file
whole into the SQL editor). None deletes data. They were applied after every earlier file on a local
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

# AI context and research: two more migrations

Apply these after every earlier file, in this order, the same way (paste each file whole into the SQL
editor, or the Management API; not `supabase db push`, see the launch checklist). Both are additive and
idempotent. Apply each **before deploying the code that needs it**.

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

# AxIS: files in a chat (one more migration)

Apply after every earlier file (`supabase db push` once the history repair in
the context repo's MASTER_TODO X12 is done, or paste it into the SQL editor). It
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

# Import pipeline step 2 (CSV/XLSX path): three more migrations

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

A counselor's first import that would send more than 50 invitations saves its data but holds the
invitations; an email goes to `ACCESS_REVIEW_EMAIL`. Approve by hand:
`update public.roster_imports set invites_approved_at = now() where id = '<import id>';`
