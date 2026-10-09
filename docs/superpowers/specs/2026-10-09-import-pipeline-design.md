# Import pipeline — design

Status: draft for review · 2026-10-09 · Owner: Elvin
Supersedes the 2026-10-07 import brief (roster CSV → invitations).

## 1. Goal

A counselor uploads student data — CSV, XLSX, Google Sheets, or PDFs such as
transcripts and score reports. The pipeline matches it to their existing
students, shows the proposed changes as a diff, and commits the approved ones in
one transaction that can be undone for 30 days. Students who don't exist yet are
invited; their data is held and, after they accept, the counselor approves it
before it attaches.

It also fixes today's bug: `POST /roster/imports` stages GPA, SAT/ACT, grad
year, high school and intended major in `roster_import_rows`, and
`accept_invitation()` never reads them, so the data is lost.

### Success criteria

- A 500-student school export updates existing profiles with one review pass
  and one commit, and no value a student entered is overwritten without the
  counselor choosing to.
- A transcript PDF lands as courses, test scores and academics on the right
  student, with every value traceable to a page.
- Undo within 30 days reverts everything the import wrote that nobody has
  edited since, and reports the rest.
- No path delivers one student's data to a different account.

### Non-goals (v1)

- Bulk import of Contact Pipeline contacts (separate design).
- Firm-wide visibility of imports (supported by the access design, §6.4; not enabled).
- Exporting data as spreadsheets (if added, escape cells starting `= + - @`).
- End-to-end encryption — incompatible with server-side AI parsing (§7.1).

## 2. Decisions

| Topic | Decision |
|---|---|
| Inputs | CSV, XLSX, Google Sheets, PDF — all in v1 |
| Targets | `student_academics`, `student_personal_details` (single-row); `test_scores`, `courses`, `activities` (multi-row) |
| Matching | Lowercased email → match. Otherwise name + birthday + school, or name + grad year + school when no birthday: **suggested only**, counselor confirms. Runs even when an email is present but unmatched, before any invitation. |
| No match | Has email → invitation; data held. No email → skipped with reason. |
| Held data | Never auto-applied on acceptance. Goes to a counselor queue ("Jane accepted — apply her imported data?") using the same diff UI. Expires after 30 days, with a warning 7 days before. |
| Conflicts | Empty fields fill. Differing values default by provenance (§5.6); grouped by pattern; sorted by risk. |
| Access | Uploader only. One function decides (§6.4). |
| Storage | New private bucket `imports`, separate from `student-documents`. |
| Staging model | Change list (`import_changes`, "approach A"). Typed-table guarantees added through `import_fields` + validation trigger. |
| Undo window | 30 days, then values are compacted to a permanent audit summary. |

### Approaches considered

- **A — change list (chosen).** One row per proposed edit: target, field, old →
  new. Review reads it, commit applies it, undo reverses it. One set of tables
  for every target and for PDFs; new targets need no new tables; access lives in
  one place. Values are jsonb, so type safety comes from `import_fields`.
- **B — typed staging table per target.** Postgres types catch bad values at
  staging, but 4–5 mirror tables must track the real ones, with diff/commit/undo
  written per table and RLS in 5+ places. A→B later is a multi-day migration;
  instead we take B's main benefit by typing `import_changes` through
  `import_fields.value_type` (§4.2).
- **C — snapshot/restore.** Simplest, but undo also erases edits made after the
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
  `allowed_mime_types` = text/csv, text/plain, xlsx, application/pdf.
- Path `<counselor_id>/<import_id>/<file_id>-<safe name>`.
- Insert policy: first segment = `auth.uid()`, second segment is an import that
  exists, belongs to `auth.uid()` and has `status = 'draft'`.
- Select policy: `private.can_view_import(import_id, auth.uid())`.
- No update or delete policy for `authenticated`; the backend deletes.
- Google Sheets: the backend exports via the existing Google connection
  (`lib/suiteApi.ts`, `accessTokenFor`) and writes the file into the bucket, so
  every later step reads from storage regardless of source.

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
  values kept valid).
- `status`: `draft | profiling | mapping | staging | review | committing |
  committed | undoing | undone | failed | expired`.
- Add `template_id`, `committed_at`, `undone_at`, `expires_at` (draft expiry),
  `undo_until` (committed_at + 30 days), `compacted_at`, `ai_spend_cents`.

**`import_files`** — `id, import_id, counselor_id, storage_path, filename,
mime_type, size_bytes, sha256, kind (sheet | pdf), status (registered | profiled
| failed | excluded), error, profile jsonb, deleted_at`. `profile` holds sheet
names, header row, column stats and masked samples; wiped on commit.

**`import_templates`** — `id, counselor_id, name, fingerprint, parse_plan jsonb,
use_count, last_used_at`; unique `(counselor_id, fingerprint)`. Fingerprint =
hash of normalized headers per sheet. Sheets only; PDFs always use the AI.

**`import_items`** — one per student unit (a sheet row, or one student found in
a PDF). `id, import_id, file_id, locator jsonb (sheet+row | pdf page range),
match_status (matched_email | suggested | confirmed | new_invite |
awaiting_counselor | applied | skipped | expired | failed), student_id,
invitation_id, match_key jsonb, candidates jsonb, skip_reason, held_until,
invite_state (unsent | sent | failed), error`.

**`import_fields`** — the single source of truth for what an import may write.
`target_table, field, value_type, sensitivity (1–3), primary key (target_table,
field)`. Each multi-row target has a `'*'` row used by `insert_row`.
`value_type` examples: `gpa`, `sat_total`, `sat_section`, `act_composite`,
`date`, `email`, `enum:<name>`, `text:<max>`, `text[]`, `row:test_score`,
`row:course`, `row:activity`.

**`import_changes`** — `id, import_id, item_id, target_table, field, op
(set_field | insert_row), target_row_id, old_value jsonb, new_value jsonb,
old_source (empty | student | counselor | intake | import), risk numeric,
pattern_key, decision (auto | accept | keep_old | reject), state (staged |
applied | skipped_stale | skipped_invalid | undone | undo_skipped | failed),
source_ref text ('Sheet1!D12', 'transcript.pdf p.2'), ai_cleaned boolean,
error`. Foreign key `(target_table, field)` → `import_fields`.

### 4.2 Type safety on the change list

A `BEFORE INSERT OR UPDATE` trigger on `import_changes` validates `new_value`
against `import_fields.value_type` (ranges match the target table's CHECK
constraints). The backend loads `import_fields` at startup for its own
validation, so there is no second field list in code. This is the "B benefit"
path: tighten types here as the field list settles, with no table migration.

### 4.3 Multi-row deduplication

At staging an `insert_row` is dropped (or shown as "already present") when the
student already has: a test score with the same `(kind, exam, taken_on)`; a
course with the same `(lower(name), school_year)`; an activity with the same
normalized name (suggested only — the counselor confirms).

## 5. Flow

Status in parentheses. Every step is idempotent per file or per item.

### 5.1 Start and upload (`draft`)
`POST /imports` creates the import. The browser uploads files directly to the
bucket, then `POST /imports/:id/files` registers each (backend checks the object
exists, size, MIME, computes sha256). Limits per import: 20 files, 5,000 rows
per sheet, 50 PDFs, 30 pages per PDF (over the limit → the file is rejected by
name with the reason; never partially processed). Existing limits stay:
`roster:import` 20/hour and the `invites` quota of 100/day.

### 5.2 Profile (`profiling`)
In a worker thread with a memory cap, a timeout and an uncompressed-size limit
(§7.3). Sheets: tabs, header row, row count, per-column stats (min, max,
distinct count, % empty), masked samples (§7.2), fingerprint. PDFs: page count,
text layer present. A matching template skips §5.3.

### 5.3 Parse plan (`mapping`, sheets only)
Model input: headers, column stats, masked samples. Forced tool output: layout
(one row per student | one row per student per test | …), student key columns,
column → `import_fields` field or `ignore`, transforms (date format, GPA
scale). Code rejects unknown columns or fields and forces sensitive columns to
`ignore`. The counselor sees the mapping table, can override any row, confirms,
and may save it as a template.

Models and audit: mapping and cleanup run on `FAST_MODEL` (Haiku) through
`runStructured()`; PDF extraction starts on Haiku and moves to `DEEP_MODEL`
only if the real-files suite shows Haiku isn't accurate enough (documented in
AGENTS.md if so). New `ai_runs` modules `import-mapping`, `import-cleanup`,
`import-extract`, added to `ai_runs_module_check` additively and to the
`AiModule` union.

**PDFs** skip mapping. Each PDF is extracted by the model into `import_fields`
fields with page references. The output is a list of students with page
ranges: more than one → one item per student; unclear boundaries → the file is
rejected with a message. PDF import is unavailable when the practice has
`autoParseDocuments` off (`lib/practiceSettings.ts`); the screen says why.

Background work (PDF extraction, invitation sends, retention) follows the
existing job pattern: no `pg_cron`; a Railway cron calls
`POST /internal/imports/sweep` (`CRON_SECRET`), which takes the
`import-sweep` lease, claims each unit with a conditional status update (as
`/communication/internal/dispatch` does), writes `job_heartbeats`, and caps AI
calls per counselor per run. Finished items are reviewable while others run.

### 5.4 Apply plan (`staging`)
Deterministic code turns each row into an `import_item` and each value into an
`import_change`, validated against `import_fields`. A non-empty value that fails
validation is flagged for cleaning, not dropped. If ≥ 20% of cells fail on a
file mapped by a saved template, staging stops: "This file looks different
from your saved template — remap?"

### 5.5 Clean messy cells
Only flagged cells go to the model, batched, as field name + raw value, with no
identifying columns. Output must pass the same validation; otherwise the cell is
an error the counselor fixes by hand.

### 5.6 Match and review (`review`)
Matching per §2. For each change: read the current value into `old_value`; drop
it if equal; otherwise set `old_source` and the default decision:

| Old value | Default |
|---|---|
| Empty | `auto` (fills) |
| Written by an earlier import of the same source kind, unedited since | `accept` |
| Anything else (student, counselor, intake, or pre-import history) | `keep_old` |

Provenance is derived from earlier applied `import_changes` for the same
student and field. Values written before this system have no history and
default to `keep_old` (the safe direction). If review load is high, the
follow-up is a trigger-maintained `field_sources jsonb` on each single-row table.

**Risk** = field sensitivity (`import_fields.sensitivity`: GPA/scores 3,
personal details 2, contact 1) × old-value source (student 3, counselor 2,
import 1, empty 0) × change size (numeric: |Δ| / field range; date: changed or
not; text: normalized edit distance). Review is sorted by risk, highest first.

**Grouping**: changes sharing `pattern_key` (target field + source column) are
offered as one decision: "GPA differs for 31 students (Sheet1 col D): accept
all / keep all / review each."

The review screen shows counts (matched, suggested, to invite, skipped,
conflicts), per-student diffs, and requires an explicit "Send N invitations"
confirmation when the import will invite anyone.

### 5.7 Commit (`committing` → `committed`)
The backend calls `commit_import(p_import, p_actor)` (§6.2):
1. Lock the import (`FOR UPDATE`); require `review`; set `committing`.
2. Re-check `can_edit_student(student, p_actor)` per item; skip items whose
   student was deleted or reassigned, with a reason.
3. Validation pass over all accepted changes; on any violation raise **once**
   with every `source_ref` + message; nothing is applied.
4. For each change, compare the current value to `old_value`; if different →
   `skipped_stale`. Otherwise apply.
5. Write the audit row (counts, students affected) **inside** the transaction.
6. Set `committed`, `committed_at`, `undo_until`.

Then queued, retried jobs: send invitations (Resend idempotency key
`import-invite/<item_id>`; `invite_state` per item is the primary duplicate
guard), wipe `import_files.profile`, delete raw files.

### 5.8 Held data
On `accept_invitation()`, an item with that `invitation_id` moves to
`awaiting_counselor` — nothing attaches. The counselor's "Ready to apply"
queue shows the diff against whatever the student has entered since (intake
included) and applies via `apply_held_item(p_item, p_actor)` with the same
rules as commit. `accept_invitation()` also routes pending `roster_import_rows`
from the old flow into the same queue. Held data expires 30 days after
acceptance (or with the invitation), with a warning at 7 days remaining.

### 5.9 Undo (`undoing` → `undone`)
`undo_import(p_import, p_actor)`: lock; require `committed` and
`now() < undo_until`; then in one transaction:
- `set_field`: restore `old_value` only where the current value equals
  `new_value`; else `undo_skipped`.
- `insert_row`: delete the row only if unchanged since insert; else
  `undo_skipped`.
- Revoke still-pending invitations it created; drop their held data.
- Audit row inside the transaction.
Report: "Reverted 412 changes; 9 kept because they were edited since."

### 5.10 Retention jobs
- Drafts never committed: files and import deleted after 7 days (`expired`).
- Storage sweep by path prefix — catches objects never registered in
  `import_files` (24 h grace).
- After `undo_until`: compact `import_changes` (drop `old_value`/`new_value`),
  keep the permanent audit summary (who, when, counts, students affected).

## 6. Security

### 6.1 Encryption — what is and isn't true
TLS in transit; Supabase AES-256 at rest for database and storage; OAuth tokens
encrypted by the app (`lib/tokenCrypto.ts`). There is **no** end-to-end
encryption: the server and the model must read files to parse them. Public
wording: "Encrypted in transit and at rest; access limited to the counselor who
ran the import."

Column-level encryption (Vault/pgcrypto) is rejected for these tables: the app
reads them from the browser under RLS, email matching and sort/search would
break, Vault is for secrets, and pgsodium is deprecated. If a single field ever
needs it, encrypt that field in the app as `tokenCrypto` does.

### 6.2 Database functions
`commit_import`, `undo_import`, `apply_held_item`:
- `SECURITY DEFINER`, `set search_path = ''` with qualified names.
- `EXECUTE` granted to `service_role` only. The route authenticates, checks
  ownership on `request.db` (RLS-bound) first, then calls the function through
  `serviceClient()` with `p_actor` = the JWT's user. The function asserts
  `p_actor` owns the import again — never trusting a client-supplied id
  (AGENTS.md, "The two Supabase clients").
- Routes: `requireRole("counselor")`, a `limit(...)` preHandler, Zod `.strict()`
  bodies; logic in `src/lib/imports/`, thin handlers in `src/routes/imports.ts`.
- **No dynamic SQL.** Each of the five targets has hand-written statements
  selected by `CASE target_table`; fields are applied by explicit column lists.
  `import_fields` FK means unknown `(target_table, field)` cannot be stored.
- Status transitions enforced under `FOR UPDATE`; anything else → "already in
  progress".
- Timeout: called as `service_role`, which has no role-level
  `statement_timeout` by default — verified by the 5,000-row load test (§9). A
  `SET statement_timeout` on the function does not extend the running call. If
  the load test fails, commit/undo run in chunks of ≤ 1,000 changes under the
  same lock, with progress stored.

### 6.3 Browser privileges
`authenticated` may: create an import via the API, upload to its own draft path,
and **select** its own `roster_imports`, `import_files`, `import_items`,
`import_changes`, `import_templates`. No insert/update/delete policies on items
or changes. Everything else goes through the backend.

### 6.4 One access function
Every policy (tables and bucket) calls `private.can_view_import(import_id,
uid)` (today: uploader only). Commit/undo authority goes through
`private.can_manage_import`. Widening to firm admins later is a one-function
migration.

## 7. Data sent to the AI, and parsing safety

### 7.1 What leaves our infrastructure
| Step | Sent to the model |
|---|---|
| Parse plan | Headers, column stats, masked samples — no real cell values |
| Cleanup | Individual flagged cells with field name; no identifying columns |
| PDF extraction | The whole PDF (disclosed to counselors) |

Before launch: confirm Anthropic API retention terms for our account and put
zero data retention in place.

### 7.2 Masking
Samples are replaced by shape tokens: `<email>`, `<date>`, `<phone>`,
`<number 400–1600>`, `<text, 2 words, capitalized>`. Column stats (min, max,
distinct, % empty) let the model tell SAT from ACT from GPA without values.

### 7.3 Parsing hardening
- Parse in a `worker_threads` worker with `resourceLimits` (heap cap) and a
  wall-clock timeout; kill on breach.
- Enforce an uncompressed-size cap on XLSX (zip bomb) and disable external
  entities / entity expansion in XML parsing.
- Library: `exceljs` (or SheetJS's own CDN build) — **not** npm `xlsx`, which is
  stuck at 0.18.5 with known prototype-pollution and ReDoS issues.
- Limits per §5.1; per-import AI spend cap.

### 7.4 Sensitive values
| Pattern | Action |
|---|---|
| `###-##-####` | Always blocked (value never staged; a matching sheet column is forced to `ignore`) |
| Bare 9 digits | Blocked if the header suggests SSN or ≥ 50% of the column matches |
| Otherwise suspicious | Flagged for the counselor; never silently redacted |

Applied to sheet cells, messy cells and text extracted from PDFs. SSN is not in
the extraction schema. Redaction protects our database, not the model call —
PDFs have already been sent; the disclosure says so. Financial-account-like
columns are on the forced-ignore list.

### 7.5 Imported text in later prompts
Imported rows keep `source = 'import'` (activities, test scores already have the
column). Every AI module treats imported text as data, never instructions. Add
this rule to AGENTS.md.

### 7.6 Invitations
Explicit "Send N invitations" confirmation; existing daily quota; bounces and
complaints (already received in `routes/webhooks.ts`) tracked per import. After
≥ 20 sends in an import, a bounce rate ≥ 10% or any complaint pauses that
counselor's import invitations. Thresholds are settings.

### 7.7 Retention promise
Raw files: ≤ 7 days. Sample cells: until commit. Change values: 30 days, then a
permanent summary. Held data: 30 days. Backups: per the Supabase plan.

## 8. Failure handling

| Failure | Behavior | Counselor sees |
|---|---|---|
| Upload never registered | Storage sweep deletes after 24 h | — |
| File unreadable / too big / zip bomb / worker timeout | File `failed`; others continue; "Continue without <file>" | "grades.xlsx couldn't be read (too large when unpacked)" |
| Parse plan timeout or invalid output | 2 retries with backoff, then manual mapping | "Couldn't suggest a mapping — map columns manually" |
| Cleanup output invalid | Cell → error | Cell highlighted for manual fix |
| PDF extraction fails | Item `failed`; retry per item | "smith_transcript.pdf failed · Retry" |
| AI cap, concurrency or provider outage | Queue; after 30 min with no progress → paused | "Paused — AI processing is unavailable; will resume automatically" |
| Template no longer fits (≥ 20% invalid) | Staging stops | "This file looks different from your saved template — remap?" |
| Value changed since review | `skipped_stale`; rest commit | "3 values changed since you reviewed — kept the newer ones" |
| Student deleted / reassigned | Item skipped with reason | Listed in the commit report |
| Validation violations at commit | One error listing all; nothing applied; stays `review` | Full list with source refs |
| Unexpected DB error at commit | Transaction rolls back; stays `review` | "Couldn't save — nothing was changed. Retry" |
| Double commit / undo during commit | Rejected by lock + status check | "Already in progress" |
| Invitation send fails | Retry job sends only `unsent`/`failed` items | "2 invitations failed · Retry" |
| Undo partly blocked | `undo_skipped`; rest reverts | "Reverted 412; 9 kept because edited since" |
| Backend crash mid-job | Lease expires; resume from item state | Progress resumes |
| Held data near expiry / expired | Warning at 7 days; wipe at 30; audit | "4 students' held data expires in 7 days" |

## 9. Testing

Fits the existing setup: `node:test` unit tests (`test/unit`), persona
integration tests (`test/integration`) against local `supabase start`. New dev
dependency: `fast-check`.

| Suite | Proves | Where |
|---|---|---|
| Field list & validation | Every `value_type`; FK rejects unknown target/field; `'*'` rows | unit + SQL |
| Parse plan guardrails | No invented columns/fields; sensitive → ignore; masking and stats | unit, model mocked |
| Sensitive values | §7.4 table, incl. student IDs and phones not redacted | unit |
| Matching | Email match; fallbacks only suggest; batch PDFs split | unit |
| Undo properties | Random import → edit → import → undo sequences never corrupt data | integration, fast-check |
| Real files | Anonymized exports: Naviance, SCOIR, Cialfo, HubSpot, CollegePlannerPro, CounselMore, GradBetter; 3–5 transcript PDFs | integration, `test/fixtures/imports/` |
| Malicious files | Zip bomb, XML expansion, formula cells, prompt-injection PDF, SSN in free text | integration |
| RLS & storage | Two counselors + a student × every table + bucket; definer functions not callable by `authenticated` | integration (persona) |
| Concurrency | Double commit; commit during undo; acceptance during undo; held apply vs expiry | integration |
| Load | Commit and undo at 5,000 rows × all fields as `service_role` | integration, tagged pre-release |
| Held data | Acceptance → queue only; warning at 7 days; wipe at 30 | integration |

## 10. Metrics (from day one)

Auto-match rate · % of cells needing cleanup · review time per import ·
conflicts per student · stale skips · **undo rate** (primary quality signal).

## 11. Prerequisites and launch blockers

- Anonymized real export files and 3–5 transcript PDFs from the team (before
  building the real-files suite).
- Supabase Pro (backups) — production has none today.
- Anthropic zero data retention confirmed.
- Resend paid plan (free tier is 100 emails/day).
- Migrations tested locally only (`supabase start`); production rollout follows
  the per-file apply-and-verify procedure, never `db push`.

## 12. Planned follow-ups (not v1)

- Tighten `import_fields.value_type` as the field list settles.
- `field_sources` provenance column if review load is high.
- Firm-admin visibility via `can_view_import`.
- Contact Pipeline contacts import.
- Spreadsheet export with formula escaping.

## 13. Delivery

One spec, delivered as separate PRs in this order, each green on CI before the next:
1. Migration (bucket, tables, `import_fields`, policies, `can_view_import`) +
   `commit_import` / `undo_import` / `apply_held_item` + SQL, RLS, concurrency
   and load tests. Fixes the lost-data bug via the held-data queue.
2. Sheets path: upload, profiling worker, parse plan, staging, cleanup,
   matching, review/commit/undo routes + unit tests.
3. PDF path: extraction, batch splitting, the sweep job.
4. App (`meridies-app`): Import screen replacing `RosterImportPanel`, review,
   history with Undo, "Ready to apply" queue; `lib/api.ts` wrappers.

## Appendix A. Built to change

Rule: access, retention, the field list, storage and AI calls each live in
exactly one place.

| Future change | Effort | Where |
|---|---|---|
| Firm admins can see imports | Easy, one migration | `private.can_view_import()` |
| Admins can commit/undo others' imports | Easy–medium | `private.can_manage_import()` + route role check |
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
| "Anthropic deletes logs within 28 days" | Not stated as a number; verify our account's terms and set up zero data retention before launch |
| Column-level encryption with Vault / pgcrypto | Rejected (§6.1); sensitive data is kept out instead (§7.4) |
| Store raw files in `student-documents` under category folders | Rejected; separate `imports` bucket (§3) |

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
  validation pass before applying; statement timeout (fixed via service_role,
  not a function `SET`); `FOR UPDATE` status lock; deleted/reassigned
  students, "continue without file", template drift; paused-state and
  pre-expiry messages; Resend idempotency key; test suites.
