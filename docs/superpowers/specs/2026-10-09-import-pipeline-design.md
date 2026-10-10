# Import pipeline — design

Status: v2, draft for review · 2026-10-09 · Owner: Elvin
Supersedes the 2026-10-07 import brief (roster CSV → invitations).
First customer: **independent counselors** working with families. Schools
(and the student data privacy agreements they require) come later (§10).

## 1. Goal

A counselor uploads a spreadsheet of student data (CSV or XLSX). The pipeline
matches it to **their own** students, shows the proposed changes as a diff, and
commits the approved ones in one transaction that can be undone for 30 days.
Students who aren't on the counselor's roster are invited; their data is held
and, after they accept, the counselor approves it before it attaches.

It also fixes today's bug: `POST /roster/imports` stages GPA, SAT/ACT, grad
year, high school and intended major in `roster_import_rows`, and
`accept_invitation()` never reads them, so the data is lost.

### Releases

| Release | Contents |
|---|---|
| **v1.0** | Lost-data bug fix (held-data queue); CSV + XLSX import with mapping, templates, review, commit, undo. Google Sheets = "File → Download → CSV" and upload. |
| **v1.1** | PDF extraction (transcripts, score reports), behind a feature flag, with a pilot group of counselors (§5.11). |
| Later | Direct Google Sheets import; school customers (§10); contacts import; spreadsheet export. |

### Success criteria (v1.0)

- A counselor's caseload export (up to 5,000 rows) updates existing profiles
  with one review pass and one commit, and no value a student entered is
  overwritten without the counselor choosing to.
- A monthly re-import from the same system needs review only for values that
  changed or that someone edited since the last import (§5.6).
- Undo within 30 days reverts everything the import wrote that nobody has
  edited since, and reports the rest.
- No path delivers one student's data to a different account (§5.6, §5.8).

### Non-goals (v1.0)

- PDFs (v1.1), direct Google Sheets (later).
- Selling to schools / signing school DPAs (§10).
- Bulk import of Contact Pipeline contacts (separate design).
- Exporting data as spreadsheets (if added, escape cells starting `= + - @`).
- End-to-end encryption, which is incompatible with server-side AI parsing (§6.1).

## 2. Decisions

| Topic | Decision |
|---|---|
| Inputs | v1.0: CSV, XLSX. v1.1: PDF. Later: Google Sheets direct. |
| Targets | `student_academics`, `student_personal_details` (single-row); `test_scores`, `courses`, `activities` (multi-row) |
| Matching scope | **Only the counselor's own students.** Anyone else is "new"; the invitation flow handles collisions. Prevents learning who has an account by uploading emails. |
| Matching rules | Email match **and** a fuzzy name match → matched. Email match with a different name → **the counselor must confirm** (shown as "email matches Jane Doe, file says John Doe"); never applied without that confirmation. Several rows with the same email **and** the same name are one student with several rows (normal for score and course exports). The same email with **different** names is a shared parent email → suggested. Name matching follows §4.4. No email match → name + birthday + school, or name + grad year + school: suggested. **Suggestions are confirmed by the counselor** (bulk confirm for high confidence). |
| No match | Has email → invitation; data held until the invitation expires (14 days, the existing `invitations.expires_at`). No email → skipped with reason. |
| Held data | Never auto-applied on acceptance. Counselor queue ("Jane accepted — apply her imported data?") with a loud warning when the accepting account's name differs from the imported name. Expires 30 days after acceptance; warning email 7 days before. |
| Conflicts | Empty fields fill. Differing values default by provenance (§5.6); grouped by pattern; sorted by risk, which includes match confidence. |
| Access | The uploader, plus the firm's owners/admins, who can always see, undo and apply held data for their firm's imports (§6.4). A solo counselor's imports are theirs alone. |
| Storage | New private bucket `imports`, separate from `student-documents`. |
| Staging model | Change list (`import_changes`, "approach A"). Typed-table guarantees through `import_fields` + validation trigger. |
| Commit/undo | Background jobs, one real transaction each on a direct Postgres connection; the client polls. No chunking. |
| GPA | Stored as given with its scale and weighted flag; **never converted**. Column widened to hold 100-point scales. |
| Undo window | 30 days, then values are compacted; a hash of each written value is kept for provenance (§5.10). |

### Approaches considered

- **A, change list (chosen).** One row per proposed edit: target, field, old →
  new. Review reads it, commit applies it, undo reverses it. One set of tables
  for every target and for PDFs; new targets need no new tables; access lives in
  one place. Values are jsonb, so type safety comes from `import_fields`.
- **B, typed staging table per target.** Postgres types catch bad values at
  staging, but 4–5 mirror tables must track the real ones, with diff/commit/undo
  written per table and RLS in 5+ places. A→B later is a multi-day migration;
  instead we take B's main benefit by typing `import_changes` through
  `import_fields.value_type` (§4.2).
- **C, snapshot/restore.** Simplest, but undo also erases edits made after the
  commit. Rejected.

## 3. Storage

Today almost every upload goes to the private `student-documents` bucket at
`<studentId|folderId|unfiled>/<timestamp>-<file>`; `public.documents`
(`bucket`, `storage_path`, unique) links rows to objects, and Storage policies
defer to `documents` RLS. Categories (activities, transcripts…) are database
data (`folders`, `documents.kind`), not path segments: Storage can't rename
paths and policies check only the first segment. This stays.

Import files go to a new bucket because one file holds many students (it must
not inherit per-student access) and it has its own retention.

- Bucket `imports`: `public = false`, `file_size_limit` 25 MB,
  `allowed_mime_types` = text/csv, text/plain, xlsx (application/pdf added in
  v1.1). The declared type is only a first filter: the backend checks the
  file's magic bytes on registration (§5.1).
- Path `<counselor_id>/<import_id>/<file_id>-<safe name>`.
- Insert policy: first segment = `auth.uid()`, second segment is an import that
  exists, belongs to `auth.uid()` and has `status = 'draft'`.
- Select policy: `private.can_view_import(import_id, auth.uid())`.
- No update or delete policy for `authenticated`; the backend deletes.

## 4. Schema

All changes are one additive migration. `roster_imports` is extended, not
renamed. `roster_import_rows` stays for history; new imports don't write to it.

```
counselor ─< roster_imports >─ import_templates
                 │
                 ├─< import_files ── storage: imports/<uid>/<import>/<file>
                 │
                 └─< import_items ──> profiles (matched) | invitations (new)
                          │
                          └─< import_changes >── import_fields (allowlist + types)
```

### 4.1 Tables

**`roster_imports`** (extended)
- `source` widened: `csv | xlsx | google-sheet | pdf | mixed | manual` (old
  values kept valid). This is the file format.
- Add `source_system`: `naviance | scoir | cialfo | hubspot | collegeplannerpro
  | counselmore | gradbetter | other | unknown`, detected from header presets
  or chosen by the counselor. This is where the data came from, and it drives
  provenance (§5.6).
- `status`: `draft | profiling | mapping | staging | review | committing |
  committed | undoing | undone | failed | expired`.
- Add `firm_id` (stamped at creation, null for solo counselors), `template_id`, `committed_at`, `undone_at`, `expires_at` (draft expiry),
  `undo_until` (committed_at + 30 days), `compacted_at`, `ai_spend_cents`,
  `job_error jsonb` (validation report from a failed commit).

**`import_files`**: `id, import_id, counselor_id, storage_path, filename,
mime_type, detected_type, size_bytes, sha256, kind (sheet | pdf), status
(registered | profiled | failed | excluded), error, profile jsonb, deleted_at`.
`profile` holds sheet names, header row, column stats and masked samples; it is
wiped on commit.

**`import_templates`**: `id, counselor_id, name, source_system, fingerprint,
parse_plan jsonb, use_count, last_used_at`; unique `(counselor_id,
fingerprint)`. Fingerprint = hash of normalized headers per sheet. Sheets only.

**`import_items`**: one per student unit (a sheet row; in v1.1, one student
found in a PDF). `id, import_id, file_id, locator jsonb, match_status
(matched_email | suggested | confirmed | new_invite | awaiting_counselor |
applied | skipped | expired | failed), match_confidence (high | medium | low),
match_reasons text[] ('email', 'name', 'shared_email', 'name_mismatch', …),
student_id, invitation_id, match_key jsonb, candidates jsonb, skip_reason,
held_until, invite_state (unsent | sent | failed), error`. `student_id`
references `profiles` **on delete cascade**: a deleted student takes their
items and changes with them.

**`import_fields`**: the single source of truth for what an import may write.
`target_table, field, value_type, sensitivity (1–3), primary key (target_table,
field)`. Each multi-row target has a `'*'` row used by `insert_row`.
`value_type` examples: `gpa`, `gpa_scale`, `sat_total`, `sat_section`,
`act_composite`, `date`, `email`, `enum:<name>`, `text:<max>`, `text[]`,
`row:test_score`, `row:course`, `row:activity`.

**`import_changes`**: `id, import_id, item_id, target_table, field, op
(set_field | insert_row), target_row_id, old_value jsonb, new_value jsonb,
new_value_hash text, old_source (empty | student | counselor | intake |
import), risk numeric, pattern_key, decision (auto | accept | keep_old |
reject), state (staged | applied | skipped_stale | skipped_invalid | undone |
undo_skipped | failed), source_ref text ('Sheet1!D12'), ai_cleaned boolean,
error`. Foreign key `(target_table, field)` → `import_fields`.
`new_value_hash` = sha256 of the canonical JSON of `new_value`, kept forever.

**`student_academics`** (changed): `gpa_unweighted` and `gpa_weighted` widen
from `numeric(4,3) ≤ 10` to `numeric(6,3)`, with a check tied to `gpa_scale`
(≤ 10 unless the scale is `100`, then ≤ 110 to allow weighted bonuses). Existing
values are untouched. **Step 1 includes a GPA audit**: every place that sorts,
filters, charts, compares or sends GPA to the AI must read `gpa_scale` and show
the scale beside the value. Known readers today: backend `lib/collegeIntel.ts`,
`lib/collegesV10.ts`, `lib/outcomes.ts`, `lib/serialize.ts`, `lib/studentAid.ts`,
`lib/studentPage.ts`, `lib/classRank.ts`, `routes/applicationAi.ts`,
`routes/collegesV10.ts`, `routes/outcomes.ts`, `routes/overviewSummaries.ts`,
`routes/pipeline.ts`, `routes/records.ts`, `routes/roster.ts`,
`routes/students.ts`, and SQL in `20260828000003`, `20260918000001`,
`20261005010003`; app `StudentProfileSelf.tsx`, `AxisPanel.tsx`,
`AlumniCard.tsx`, `overview/status.ts`, `ContactProfileModal.tsx`,
`StudentInfoCard.tsx`, `lib/profileDisplay.ts`, `lib/api.ts`. Fit, odds and
class rank compare against 4-point bands, so they treat a non-4/5 scale as
"unknown" rather than guessing.

### 4.2 Type safety on the change list

A `BEFORE INSERT OR UPDATE` trigger on `import_changes` validates `new_value`
against `import_fields.value_type` (ranges match the target table's CHECK
constraints). The backend loads `import_fields` at startup for its own
validation, so there is no second field list in code. This is the "B benefit"
path: tighten types here as the field list settles, with no table migration.

### 4.3 Deduplication

**Within the file:** rows with the same email and a matching name (§4.4)
are one student: they merge into one item, and a long-format file (one row per
test or per course) produces many changes on that item. Where single-row values
disagree, the change is flagged `conflict_in_file` and the counselor picks.
Rows sharing one email with names that don't match (siblings using a parent
address) are never merged and never auto-matched.

**Against existing data**, at staging an `insert_row` is dropped (or shown as
"already present") when the student already has:
- Test scores: the same `(kind, exam, taken_on)`; when `taken_on` is null on
  either side, the same `(kind, exam, score)`. Superscores and "best" values go
  to `student_academics.sat_superscore` / `act_composite`, not `test_scores`.
- Courses: the same `(lower(name), school_year)`; when `school_year` is missing,
  a same-name course is shown as a suggestion, never dropped or added silently.
  Grades are stored as given (letter, percentage, pass/fail), never converted.
- Activities: the same normalized name, suggested only; the counselor confirms.

These keys are final for v1.0 and are built in step 1. `courses` has no term
column; a term in the file is kept in `school_year` as given (e.g. "2025-26
Fall") and ignored for matching.

### 4.4 Name matching rule

Names are normalized before comparing: lowercase, accents removed (José →
jose), punctuation and extra spaces removed, "Last, First" split.
- **Last name** matches if the normalized names are equal, or one is a part of
  the other's hyphenated or two-part surname (García-López ↔ López).
- **First name** matches if equal, or equivalent in a fixed nickname table
  (Robert ↔ Bob/Rob/Bobby, Elizabeth ↔ Liz/Beth, …, kept in code with tests),
  or equal to the student's preferred name where we have one.
- A match needs **both**. Initials alone never match, so twins with the same
  last name and initial stay apart.
- Anything else is a name mismatch: suggested, and for an email match, the
  counselor must confirm.

## 5. Flow

Status in parentheses. Every step is idempotent per file or per item.

### 5.1 Start and upload (`draft`)
`POST /imports` creates the import. The browser uploads files directly to the
bucket, then `POST /imports/:id/files` registers each: the backend checks the
object exists, its size and **magic bytes** (CSV/text vs XLSX zip; PDF in v1.1),
and computes sha256. Limits per import: 20 files and **5,000 rows in total**
across them (the size the load test covers). Before the first upload the
counselor ticks "I have permission from the student's family to upload this
information"; the import stores who ticked it and when, and the terms say the
same. Existing
limits stay: `roster:import` 20 per hour **per user**, and the `invites` quota
of 100 per day per user. Counselor accounts younger than 14 days get half the
invite quota, and a counselor's first import that would send more than 50
invitations waits for Meridies staff approval. Owner: Elvin until a support
role exists; target response within one business day; the counselor sees
"Waiting for a quick check from Meridies (usually within a day)".

### 5.2 Profile (`profiling`)
In a worker thread with a memory cap, a timeout and an uncompressed-size limit
(§7.3). Per sheet: tabs, header row, row count, per-column stats (min, max,
distinct count, % empty, and for date-like columns whether any first component
is > 12 and whether values look like Excel serial numbers, with the workbook's
1900/1904 date system), masked samples (§7.2), and the fingerprint. A matching
template skips §5.3.

**Wide or pivot sheets**, where student names appear as column headers, are
detected (headers that look like personal names, or far more columns than
rows). Headers are masked before anything goes to the model, and if the layout
can't be mapped the file is refused with "This sheet has one column per
student; export it with one row per student."

### 5.3 Parse plan (`mapping`)
Model input: masked headers, column stats, masked samples. Forced tool output:
layout (one row per student | one row per student per test | …), student key
columns, column → `import_fields` field or `ignore`, `source_system` guess, and
transforms limited to **parsing** (date format, number format, splitting a
"Last, First" name). There is **no value conversion**: GPA is stored with its
scale and weighted flag as given. Code rejects unknown columns or fields and
forces sensitive columns to `ignore` (§7.4). The counselor sees the mapping
table, can override any row and the detected source system, confirms, and may
save it as a template.

Models and audit: mapping and cleanup run on `FAST_MODEL` (Haiku) through
`runStructured()`. New `ai_runs` modules `import-mapping` and `import-cleanup`
(`import-extract` in v1.1), added to `ai_runs_module_check` additively and to
the `AiModule` union. AI spend is capped at **200 cents per import** (a
setting), tracked in `roster_imports.ai_spend_cents`.

### 5.4 Apply plan (`staging`)
Deterministic code turns each row into an `import_item` and each value into an
`import_change`, validated against `import_fields`. A non-empty value that fails
validation is flagged for cleaning, not dropped. If ≥ 20% of cells fail on a
file mapped by a saved template, staging stops: "This file looks different
from your saved template. Remap?"

### 5.5 Clean messy cells
Only flagged cells go to the model, **batched by column** (up to 100 cells per
call), as field name + raw values, with no identifying columns. Output must pass the same validation; otherwise the cell is
an error the counselor fixes by hand.

### 5.6 Match and review (`review`)
Matching runs only against students where `can_edit_student(student,
counselor)`. Rules are in §2, deduplication in §4.3.

For each change: read the current value into `old_value`; drop it if equal;
otherwise set `old_source` and the default decision:

| Old value | Default |
|---|---|
| Empty | `auto` (fills), except on a `medium`/`low` confidence match, where it is `accept` and shown for review |
| Equal (by `new_value_hash`) to what an earlier import from the **same `source_system` or the same template** wrote, and unedited since | `accept` |
| Anything else (student, counselor, intake, or pre-import history) | `keep_old` |

Provenance is derived from earlier applied `import_changes` for the same
student and field, comparing the hash of the current value with
`new_value_hash`. This still works after compaction (§5.10), so monthly
re-imports keep working past 30 days. Values written before this system have no
history and default to `keep_old` (the safe direction).

**Risk** = field sensitivity (`import_fields.sensitivity`: GPA/scores 3,
personal details 2, contact 1) × old-value source (student 3, counselor 2,
import 1, empty 1) × change size (numeric: |Δ| / field range; date: changed or
not; text: normalized edit distance; a fill counts as 1) × match confidence
(high 1, medium 2, low 3). Review is sorted by risk, highest first.

**Grouping**: changes sharing `pattern_key` (target field + source column) are
offered as one decision: "GPA differs for 31 students (Sheet1 col D): accept
all / keep all / review each." Suggested matches with `high` confidence can be
confirmed in bulk.

The review screen shows counts (matched, suggested, to invite, skipped,
conflicts), per-student diffs, and requires an explicit "Send N invitations"
confirmation when the import will invite anyone.

### 5.7 Commit (`committing` → `committed`)
`POST /imports/:id/commit` checks ownership and status, sets `committing`, and
enqueues a commit job. The client polls `GET /imports/:id`. The job runs on a
**direct Postgres connection** (`IMPORT_DATABASE_URL`, as `import_worker`
through the Supabase session pooler, §6.2), not PostgREST, so no HTTP timeout applies. It calls
`commit_import(p_import, p_actor)` inside one transaction with `SET LOCAL
statement_timeout = '300s'`:
1. Lock the import (`FOR UPDATE`); require `committing` and the job's claim.
2. Re-check `can_edit_student(student, p_actor)` per item; skip items whose
   student was deleted or reassigned, with a reason.
3. Validation pass over all accepted changes; on any violation, roll back,
   store the full report (every `source_ref` + message) in `job_error`, and set
   status back to `review`. Nothing is applied.
4. Apply each change as **one compare-and-set statement**:
   `UPDATE … SET col = new WHERE student_id = … AND col IS NOT DISTINCT FROM
   old_value`. Zero rows updated → `skipped_stale`. Inserts check for
   duplicates under the same transaction.
5. Write the audit row (counts, students affected) **inside** the transaction.
6. Set `committed`, `committed_at`, `undo_until`.

An unexpected error rolls back everything and returns the import to `review`
with "Couldn't save. Nothing was changed." There is no chunking: the
5,000-row load test (§9) must pass within the timeout, and if it doesn't, the
row limit is lowered rather than splitting the transaction.

Then queued, retried jobs: send invitations (Resend idempotency key
`import-invite/<item_id>`; `invite_state` per item is the primary duplicate
guard), wipe `import_files.profile`, delete raw files.

### 5.8 Held data
While the invitation is pending, held data lives until the invitation expires
(14 days) and is then wiped. On `accept_invitation()`, an item with that
`invitation_id` moves to `awaiting_counselor`, and nothing attaches. The
counselor's "Ready to apply" queue shows the diff against whatever the student
has entered since (intake included), with a **loud mismatch warning** when the
accepting account's name doesn't fuzzy-match the imported name; applying a
mismatched item requires typing the student's name to confirm. Applying runs
`apply_held_item(p_item, p_actor)` as a job with the same rules as commit.
`accept_invitation()` also routes pending `roster_import_rows` from the old
flow into the same queue. Held data expires 30 days after acceptance, with a
warning **email** (and an in-app notice) 7 days before.

### 5.9 Undo (`undoing` → `undone`)
`POST /imports/:id/undo` enqueues a job, which calls `undo_import(p_import,
p_actor)` on the direct connection in one transaction: lock; require
`committed` and `now() < undo_until`; then:
- `set_field`: restore `old_value` with a compare-and-set on `new_value`; zero
  rows → `undo_skipped`.
- `insert_row`: delete the row only if unchanged since insert; else
  `undo_skipped`.
- Held data that was applied from "Ready to apply" is reverted by the same
  rules, because its changes belong to this import.
- Revoke still-pending invitations it created; drop their held data.
- Audit row inside the transaction.
Report: "Reverted 412 changes; 9 kept because they were edited since."

### 5.10 Retention jobs
- Drafts never committed: files and import deleted after 7 days (`expired`).
- Storage sweep by path prefix, which catches objects never registered in
  `import_files` (24 h grace).
- After `undo_until`: compact `import_changes` by dropping `old_value` and
  `new_value` and **keeping `new_value_hash`**, field and target. The audit
  summary keeps who, when and counts; student ids are dropped from it.
- The fingerprint is **personal data**: for fields with few possible values
  (GPA, SAT) it can be reversed by trying every value. We describe it honestly
  ("we keep a fingerprint so we can tell whether a value has changed since an
  import"), list it in the privacy policy, and delete it with the student's
  account (cascade).

### 5.11 PDFs (v1.1, behind a flag)
Designed now so the schema doesn't change later; shipped only after v1.0 and
only to pilot counselors (§11).
- 50 PDFs per import, 30 pages per PDF (over the limit → the file is rejected
  by name with the reason; never partially processed).
- Each PDF is extracted by the model into `import_fields` fields with page
  references. The output is a list of students with page ranges: more than one
  → one item per student; unclear boundaries → the file is rejected with a
  message.
- The extraction schema contains **no** SSN, IEP/504 or accommodation notes,
  disciplinary notes, or free/reduced-lunch status (§7.4).
- The review screen renders the cited page (pdf.js, from a signed URL, before
  commit) beside the extracted values, so hidden or white-on-white text that
  differs from the visible page is caught by the counselor. Region highlighting
  is a later improvement.
- Unavailable when the practice has `autoParseDocuments` off.
- Background work follows the existing job pattern: no `pg_cron`; a Railway
  cron calls `POST /internal/imports/sweep` (`CRON_SECRET`), which takes the
  `import-sweep` lease, claims each unit with a conditional status update,
  writes `job_heartbeats`, and caps AI calls per counselor per run.
- Model: Haiku first; `DEEP_MODEL` only if pilot files show Haiku isn't
  accurate enough (documented in AGENTS.md if so).
- Gate: written confirmation of which Anthropic endpoints our zero data
  retention covers, including PDF input.
- Its own AI cap, per PDF and per import, set from current model pricing before
  1.1 ships; the $2 spreadsheet cap doesn't apply. A cap reached mid-batch
  pauses the remaining PDFs; it never half-processes one.

## 6. Security

### 6.1 Encryption: what is and isn't true
TLS in transit; Supabase AES-256 at rest for database and storage; OAuth tokens
encrypted by the app (`lib/tokenCrypto.ts`). There is **no** end-to-end
encryption: the server and the model must read files to parse them. Public
wording: "Encrypted in transit and at rest; access limited to the counselor who
ran the import."

Column-level encryption (Vault/pgcrypto) is rejected for these tables: the app
reads them from the browser under RLS, email matching and sort/search would
break, Vault is for secrets, and pgsodium is deprecated. If a single field ever
needs it, encrypt that field in the app as `tokenCrypto` does.

### 6.2 Database functions and jobs
`commit_import`, `undo_import`, `apply_held_item`:
- `SECURITY DEFINER`, `set search_path = ''` with qualified names.
- `EXECUTE` granted to a dedicated `import_worker` role used only by the
  backend's direct connection (and to `service_role`); never to
  `authenticated`. The route authenticates, checks ownership on `request.db`
  (RLS-bound) first, then enqueues the job with `p_actor` = the JWT's user. The
  function asserts `private.can_manage_import(p_import, p_actor)` again.
- Routes: `requireRole("counselor")`, a `limit(...)` preHandler, Zod `.strict()`
  bodies; logic in `src/lib/imports/`, thin handlers in `src/routes/imports.ts`.
- **No dynamic SQL.** Each of the five targets has hand-written statements
  selected by `CASE target_table`; fields are applied by explicit column lists.
  The `import_fields` FK means an unknown `(target_table, field)` cannot be
  stored.
- Status transitions are enforced under `FOR UPDATE`; anything else → "already
  in progress". A job claims its import with a conditional status update, so a
  double click or two tabs produce one job.
- New env var `IMPORT_DATABASE_URL` (Railway, set by the team;
  `.env.example` updated). The backend's first direct Postgres use; the `pg`
  package is added. **It never uses the `postgres` login.** It connects as
  `import_worker`, a role created `NOLOGIN` by the migration with only
  `EXECUTE` on the three functions and the grants they need on the import
  tables; the team turns on its login and sets the password by hand, outside
  git. Anyone pasting the superuser string is refused at startup (the backend
  checks `current_user = 'import_worker'`).
- Connection: Supabase's **session pooler** (IPv4, holds a session for the
  whole transaction), never the transaction pooler, which can't hold locks
  across statements. The direct host is IPv6-only on our plan unless the IPv4
  add-on is bought, so step 1 starts by confirming Railway reaches the session
  pooler.

### 6.3 Browser privileges
`authenticated` may: create an import via the API, upload to its own draft path,
and **select** its own `roster_imports`, `import_files`, `import_items`,
`import_changes`, `import_templates`. No insert/update/delete policies on items
or changes. Everything else goes through the backend.

### 6.4 Access functions
Every policy (tables and bucket) calls `private.can_view_import(import_id,
uid)`; commit, undo and applying held data go through
`private.can_manage_import(import_id, uid)`. Both return true for:
- the uploader, while they are still a member of the practice; or
- an owner/admin of the firm the import belongs to (always, not only after the
  uploader leaves). `roster_imports.firm_id` is stamped at creation so the
  answer doesn't change when the uploader leaves.

Changing who else may see imports later is a change to these two functions
only. What happens to a departing counselor's students and imports is decided
by the firm (caseload transfer spec, §14).

### 6.5 Invitations as an abuse channel
Invitation emails use fixed templates; the student and counselor names are
inserted as escaped plain text, with no links or formatting from imported data.
Limits per §5.1 (quota, new-account halving, staff approval for a first import
over 50 invitations). Bounces and complaints (already received in
`routes/webhooks.ts`) are tracked per import: after ≥ 20 sends in an import, a
bounce rate ≥ 10% or any complaint pauses that counselor's import invitations.
Thresholds are settings.

## 7. Data sent to the AI, and parsing safety

### 7.1 What leaves our infrastructure
| Step | Sent to the model |
|---|---|
| Parse plan | Masked headers, column stats, masked samples; no real cell values |
| Cleanup | Individual flagged cells with field name; no identifying columns |
| PDF extraction (v1.1) | The whole PDF (disclosed to counselors) |

Before launch: confirm in writing which Anthropic API endpoints our zero data
retention covers. Zero data retention isn't automatic.

### 7.2 Masking
Samples are replaced by shape tokens: `<email>`, `<date>`, `<phone>`,
`<number 400–1600>`, `<text, 2 words, capitalized>`. Column stats (min, max,
distinct, % empty, date hints) let the model tell SAT from ACT from GPA, and
MM/DD from DD/MM, without values. Headers that look like personal names are
masked too (§5.2).

### 7.3 Parsing hardening
- Parse in a `worker_threads` worker with `resourceLimits` (heap cap) and a
  wall-clock timeout; kill on breach.
- Enforce an uncompressed-size cap on XLSX (zip bomb) and disable external
  entities / entity expansion in XML parsing.
- Library: `exceljs` (or SheetJS's own CDN build), **not** npm `xlsx`, which is
  stuck at 0.18.5 with known prototype-pollution and ReDoS issues.
- File type from magic bytes, not the declared MIME type.

### 7.4 Sensitive values
| Pattern | Action |
|---|---|
| `###-##-####` | Always blocked: the value is never staged, and a matching column is forced to `ignore` |
| Bare 9 digits, header suggests SSN (`ssn`, `social`, …) | Blocked |
| Bare 9 digits otherwise (often district student IDs) | Flagged for the counselor; never blocked or silently redacted |

Imports only ever write fields in `import_fields`; anything else is ignored.
The categories below are extra protection for values that slip into allowed
columns (free text, mislabelled columns, PDFs).

**Never stored and never sent onward** (forced `ignore` by header, blocked by
value pattern where one exists, absent from the v1.1 extraction schema):

| Category | Examples |
|---|---|
| Government ID numbers | SSN, driver's license, passport, state ID, immigration (A-)numbers |
| Financial | Bank, account and card numbers; family income; tax figures |
| Health and disability | Diagnoses, medications, IEP/504 plans, accommodations |
| Discipline and legal | Suspensions, discipline notes, criminal records |
| Economic status | Free/reduced lunch, income-based fee waivers |
| Beliefs and identity | Religion, sexual orientation, race/ethnicity (no field exists; adding one later is a deliberate decision) |
| Login secrets | Passwords, security answers |

**Allowed but higher risk** (always shown for review when they would change a
value; never auto-overwritten): `import_fields.sensitivity` 3 = GPA, test
scores, class rank; 2 = birthday, home address, phone, gender, citizenship
status, first-generation status. Everything else is 1. Applied to sheet cells, messy cells and (v1.1) PDF
text. For PDFs, redaction protects our database, not the model call; the
disclosure says so.

### 7.5 Imported text in later prompts
Imported rows keep `source = 'import'` (activities and test scores already have
the column). Every AI module treats imported text as data, never instructions.
Add this rule to AGENTS.md.

### 7.6 Retention promise
Raw files: ≤ 7 days. Sample cells: until commit. Change values: 30 days, then
a fingerprint of each imported value (personal data, deleted with the student's
account, §5.10) and a counts-only summary. Held data: until the invitation expires (14
days) or 30 days after acceptance. Backups: per the Supabase plan (point-in-time
recovery).

## 8. Failure handling

| Failure | Behavior | Counselor sees |
|---|---|---|
| Upload never registered | Storage sweep deletes after 24 h | — |
| Declared type doesn't match the file's bytes | File `failed` | "grades.xlsx isn't a spreadsheet" |
| File unreadable / too big / zip bomb / worker timeout | File `failed`; others continue; "Continue without <file>" | "grades.xlsx couldn't be read (too large when unpacked)" |
| Wide sheet with names as headers | File refused | "This sheet has one column per student; export it with one row per student" |
| Parse plan timeout or invalid output | 2 retries with backoff, then manual mapping | "Couldn't suggest a mapping. Map columns manually" |
| AI spend cap reached | Remaining AI steps skipped; manual mapping/cleanup | "AI help limit reached for this import. Finish manually" |
| Cleanup output invalid | Cell → error | Cell highlighted for manual fix |
| AI provider outage | Queue; after 30 min with no progress → paused | "Paused: AI processing is unavailable; will resume automatically" |
| Template no longer fits (≥ 20% invalid) | Staging stops | "This file looks different from your saved template. Remap?" |
| Conflicting rows for one student in the file | `conflict_in_file` | Pick which row wins |
| Value changed since review | Compare-and-set misses → `skipped_stale`; rest commit | "3 values changed since you reviewed; kept the newer ones" |
| Student deleted / reassigned | Item skipped with reason | Listed in the commit report |
| Validation violations at commit | Rolled back; report in `job_error`; back to `review` | Full list with source refs |
| Unexpected DB error at commit | Rolled back; back to `review` | "Couldn't save. Nothing was changed. Retry" |
| Double commit / undo during commit | Job claim + lock + status check | "Already in progress" |
| Invitation send fails | Retry job sends only `unsent`/`failed` items | "2 invitations failed · Retry" |
| Undo partly blocked | `undo_skipped`; rest reverts | "Reverted 412; 9 kept because edited since" |
| Backend crash mid-job | Transaction rolls back; job lease expires and the job reruns | Progress resumes |
| Accepting account's name differs | Item held with mismatch flag | Warning; type the name to apply |
| Held data near expiry / expired | Email + in-app warning at 7 days; wipe; audit | "4 students' held data expires in 7 days" |
| Uploader left the firm | Firm admins keep full access; the firm's offboarding choice decides who takes over (caseload transfer spec, §14) | Import listed under its students' new counselor |

## 9. Testing

Fits the existing setup: `node:test` unit tests (`test/unit`), persona
integration tests (`test/integration`) against local `supabase start`. New dev
dependency: `fast-check`.

| Suite | Proves | Where |
|---|---|---|
| Field list & validation | Every `value_type`; FK rejects unknown target/field; `'*'` rows; GPA scale check | unit + SQL |
| Parse plan guardrails | No invented columns/fields; sensitive → ignore; masking, header masking and stats; no value conversion | unit, model mocked |
| Sensitive values | §7.4 table; 9-digit student IDs flagged, not blocked | unit |
| Dates | MM/DD vs DD/MM via stats; Excel serials; 1900 and 1904 systems | unit |
| Matching | Own students only; email + name; shared parent email → suggested; in-file duplicates; fallbacks only suggest | unit |
| Provenance | Monthly re-import from the same system defaults to accept, before **and after** compaction; different system → keep_old | integration |
| Undo properties | Random import → edit → import → undo sequences never corrupt data | integration, fast-check |
| Compare-and-set | A student edit committed between review and commit is never overwritten | integration |
| Real files | Anonymized exports, first-customer tools first: CollegePlannerPro, CounselMore, GradBetter, homemade counselor spreadsheets; then HubSpot and school-side Naviance, SCOIR, Cialfo | integration, `test/fixtures/imports/` |
| Malicious files | Zip bomb, XML expansion, mismatched magic bytes, formula cells, names-as-headers, SSN in free text | integration |
| RLS & storage | Two counselors in a firm, a firm admin, a solo counselor and a student × every table + bucket; admins see firm imports, other counselors don't; definer functions not callable by `authenticated` | integration (persona) |
| Concurrency | Double commit; commit during undo; acceptance during undo; held apply vs expiry | integration |
| Load | Commit and undo at the import maximum (5,000 rows in total × all fields) as `import_worker` through the session pooler, within the timeout | integration, tagged pre-release |
| Held data | Pending invite expiry wipes; acceptance → queue only; name-mismatch warning; email at 7 days; wipe at 30 | integration |

## 10. Privacy and legal

Not legal advice; a lawyer reviews this section before any school sale.

**v1.0 (independent counselors):** the counselor is collecting data from
families they work with. Needed before launch:
- Privacy policy and in-product disclosure naming our subprocessors
  (Anthropic, Supabase, Railway, Resend), what each receives, the retention
  promise (§7.6), and that PDFs (v1.1) are sent to the AI provider whole.
- A deletion path: account deletion removes import data (cascade, §4.1), and
  the counts-only audit summary keeps no student ids.
- Breach-notification commitment in the terms.
- The upload permission checkbox (§5.1) and a matching line in the terms: the
  counselor confirms they have the family's permission.
- A lawyer checks whether state student-privacy laws apply to the
  family/independent-counselor launch too, not only to school deals.

**Schools (later, gated on legal work):** a school sharing student records
needs a legal basis, usually our signature on a student data privacy agreement
under FERPA's school-official exception (the SDPC national template is
common). State laws add requirements, e.g. New York Education Law 2-d
(parents' bill of rights, subprocessor disclosure) and California SOPIPA. These
agreements ask for subprocessors, breach-notification terms and deletion
timelines. School customers are out of scope until this is done.

## 11. Rollout

- Feature flag per practice; v1.0 to all counselors once metrics are healthy on
  a pilot of 5–10 counselors. v1.1 (PDFs) has its own flag and pilot.
- Kill switch for the AI path (falls back to manual mapping and cleanup).
- Migration rehearsal on a Supabase branch (a copy of production's schema)
  before PR1 lands; production rollout follows the per-file apply-and-verify
  procedure, never `db push`.
- `RosterImportPanel` stays behind the flag until v1.0 is fully rolled out,
  then is removed in the app PR that follows. `POST /roster/imports` is
  retired a release later.

## 12. Metrics (from day one)

- **Correction rate**: % of imported fields edited by a person within 7 days
  (primary quality signal).
- Undo rate.
- Funnel drop-off at upload, mapping, review and commit; time to first
  successful import.
- Auto-match rate; suggested-match confirmation time; % of cells needing
  cleanup; conflicts per student; stale skips.
- Held-data expiries (before and after acceptance).
- `ai_spend_cents` per import.
- Bounce and complaint rates on import invitations.

## 13. Prerequisites and launch blockers

- **Five real anonymized export files this week, before code beyond PR1**,
  mostly from what our first customers use: CollegePlannerPro, CounselMore,
  GradBetter and homemade counselor spreadsheets. The mapping design rests on
  them and they will change it.
- Supabase Pro with point-in-time recovery, and the Resend paid plan: needed
  now regardless of this feature (the team is handling both).
- Anthropic zero data retention confirmed in writing, with the endpoints it
  covers.
- `IMPORT_DATABASE_URL` on Railway, logging in as `import_worker` (§6.2).
- Privacy policy and subprocessor disclosure (§10).

## 14. Planned follow-ups

- v1.1: PDFs (§5.11).
- Direct Google Sheets import (`lib/suiteApi.ts`, `accessTokenFor`).
- Shared starter templates (column names only, no data) for common tools, so a
  counselor's first import from a known tool needs no AI or mapping work.
- Caseload transfer when a counselor leaves (separate spec): firm setting for
  "transfer everything to one person" vs "an admin assigns each student",
  optional temporary delegation; imports, held data and templates follow the
  students.
- Tighten `import_fields.value_type` as the field list settles.
- `field_sources` provenance column if hash-based provenance proves too coarse.
- PDF region highlighting in review.
- School customers (§10), Contact Pipeline contacts import, spreadsheet export
  with formula escaping.

## 15. Delivery

Separate PRs in this order, each green on CI before the next:
1. **Bug fix and foundation:** migration (bucket, tables, `import_fields`,
   GPA widening, policies, access functions) + `commit_import` /
   `undo_import` / `apply_held_item` + the job runner on the direct connection
   + the held-data queue routes + the `import_worker` role and connection check
   + the GPA audit (§4.1). Includes SQL, RLS, concurrency, provenance and load
   tests.
2. **CSV/XLSX path:** upload, profiling worker, parse plan, staging, cleanup,
   matching, review/commit/undo routes + unit tests against the real files.
3. **App (`meridies-app`):** Import screen behind the flag, review, history
   with Undo, "Ready to apply" queue; `lib/api.ts` wrappers.
4. **v1.1 PDFs**, behind their own flag.

## Appendix A. Built to change

Rule: access, retention, the field list, storage and AI calls each live in
exactly one place.

| Future change | Effort | Where |
|---|---|---|
| Change who can see imports (e.g. all firm counselors) | Easy, one migration | `private.can_view_import()` / `can_manage_import()` |
| Change raw-file retention (7 days → 24 h) | Trivial | One setting read by the sweep |
| Add/remove importable fields or sensitive columns | Easy | `import_fields` rows |
| Encrypt raw files before storage | Medium | One `importStore` module (upload/download/delete) |
| Encrypt `import_changes` values | Medium | One changes writer/reader, `tokenCrypto` pattern |
| Move processing to Edge Functions / another provider | Medium | Behind `extract` / `planParse` / `cleanCells` interfaces |
| New target (e.g. awards) | Easy | `import_fields` rows + one apply branch; no new table |
| True end-to-end encryption | Hard, any approach | Product change: the server could no longer parse files |
| Switch staging model A → B | Hard (several days to a week) | New tables, history migration, rewritten commit/undo/review; avoided by §4.2 |

## Appendix B. Security proposals considered and adapted

| Proposal | Outcome |
|---|---|
| HTTPS/TLS in transit | Already true |
| AES-256 at rest (Supabase) | Already true |
| Process files in memory in Supabase Edge Functions | Adopted the guarantee, not the runtime: in memory on the Railway backend in a worker thread. AI calls, quotas, `ai_runs` and the Anthropic key already live there; a second runtime would split them. |
| Send extracted text to Claude over HTTPS | Already true (`lib/anthropic.ts`); PDFs are sent natively, so no PDF library |
| "Anthropic deletes logs within 28 days" | Not stated as a number; confirm our account's zero data retention terms in writing |
| Column-level encryption with Vault / pgcrypto | Rejected (§6.1); sensitive data is kept out instead (§7.4) |
| Store raw files in `student-documents` under category folders | Rejected; separate `imports` bucket (§3) |
| Commit in chunks if the load test fails | Rejected: breaks all-or-nothing; commit is a job on a direct connection instead (§5.7) |

## Appendix C. The three staging approaches, plainly

Think of a teacher copying grades from a pile of papers into the class
gradebook, who wants to check before saving and be able to undo.

- **A, sticky notes (chosen).** Each change is a note: "Maya's GPA 3.5 → 3.8".
  Check the notes, apply the kept ones, undo by reading them backwards, and
  skip any note whose value someone has changed since. One board for every kind
  of data. The notes accept anything, so code and a database trigger check
  every value.
- **B, a practice gradebook per subject.** Boxes only accept the right kind of
  value, so mistakes are caught early, but there are 4–5 extra books to keep in
  sync and every step is built once per book.
- **C, a photo of the page.** Undo puts the photo back, which also erases
  anything changed after it was taken. Rejected.

Start with A; once the field list settles, add B's early checking to A's notes
through `import_fields.value_type` (§4.2).

## Appendix D. Review history

- 2026-10-09: design built section by section with Elvin (inputs, targets,
  matching, conflicts, access, staging model A).
- External security review, round 1: held data delivered to whoever accepts
  the invite → counselor queue; dynamic SQL → per-target fixed SQL +
  `import_fields` FK; PDFs bypass the sensitive list → SSN value patterns;
  "minimal data" claim → masked samples; parsing attack surface → worker,
  caps, no npm `xlsx`; storage write rule + object sweep; invitation spam
  limits; retention, stored prompt injection, formula injection; review-load
  grouping, provenance defaults, risk sort; duplicate check when email
  doesn't match; batch PDFs; overlapping review; held-data conflicts; metrics.
- Round 2: `'*'` rows and `value_type` on `import_fields`; provenance blind
  spot accepted; refined SSN rules; column stats with masking; risk formula;
  birthday-less fallback; reject PDFs over the page cap by name; minimum sends
  before the bounce pause.
- Round 3: audit inside the transaction, side effects as retried jobs;
  validation pass before applying; statement timeout; `FOR UPDATE` status
  lock; deleted/reassigned students, "continue without file", template drift;
  paused-state and pre-expiry messages; Resend idempotency key; test suites.
- Round 4 (v2): compaction kept provenance → `new_value_hash` and
  `source_system`; chunked commit and PostgREST timeouts → jobs on a direct
  connection, compare-and-set updates, no chunking; matching scoped to the
  counselor's students, name check on email matches, shared emails and in-file
  duplicates, mismatch warning, confidence in risk; GPA never converted and
  column widened; test-score, course and date edge cases; names in headers;
  SSN rule no longer blocks student IDs; IEP/504, discipline and lunch status
  excluded; magic bytes; invitation abuse limits; deletion and offboarding
  (firm admins take over orphaned imports); privacy/legal section; scope cut
  to CSV/XLSX for v1.0 with PDFs in v1.1; first customer named (independent
  counselors); rollout, correction-rate metric, AI cost cap, staging
  rehearsal.
- Round 5 (Elvin + reviewer): email match with a name mismatch needs counselor
  confirmation; firm admins always see firm imports (`firm_id` on imports);
  caseload transfer split into its own spec; same email + same name = one
  student with many rows; name-matching rule (§4.4); fingerprint treated as
  personal data and deleted with the account; GPA read audit in step 1;
  `import_worker` role through the session pooler; 5,000 rows per import in
  total; dedupe keys final; cleanup batched by column; undo covers applied held
  data; separate PDF cap; staff-approval owner and response target; family
  permission checkbox; first-customer tools first in real-file tests;
  sensitive-data categories; lawyer checks state laws for the family launch;
  starter templates as a follow-up.
