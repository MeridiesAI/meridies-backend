# AxIS security PR B: injection fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AxIS deletes become restorable for 30 days, free text someone else wrote stays out of chat memory and keeps changes behind a click while it's in reach, hand-in values stay unverified until a counselor confirms them, and a real-model eval set guards all of it on every release.

**Architecture:** A private trash table filled by a `BEFORE DELETE` trigger that only fires for requests AxIS marks (a per-process HMAC the API honours and forwards to PostgREST); restore is a SECURITY DEFINER function behind the card's Undo. A free-text classifier (80-character rule plus source kinds) decides what flags a turn; quoted 8-word runs are stored per answer and replaced before the memory fold. Hand-in values move to a column with a Confirm route that applies them through the info card's own code. Evals live in `evals/axis/` with a release workflow that stores scores on a side branch.

**Tech Stack:** Fastify 5, TypeScript strict (ESM), Supabase Postgres (plpgsql triggers, SECURITY DEFINER), PostgREST, node:test via tsx, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md` (sections 2.2-2.5, 3, 4, 5, the Review round and the Plan review of 11/2, which overrides those sections where they differ). Read both.

## Global Constraints

- New worktree `meridies-backend-axissec-b`, branch `axis-injection-fixes`, off `origin/main`. Tasks 1-7 don't touch `engine.ts`, `nlu.ts` or `ops/catalog/application.ts`; before Task 8, rebase over the intent-routing session's merged work (check `git log origin/main -- src/lib/axis/nlu.ts src/lib/axis/engine.ts`). If it hasn't merged by then, stop and tell Elvin.
- Never touch production. Local Supabase only. Elvin merges and applies migrations.
- Migrations (each header states deploy order; none in `REQUIRED_SCHEMA`; re-timestamp newer than production's newest if PR A1 or A2 lands after): `20261031000003_axis_trash.sql`, `20261031000004_axis_outside_flags.sql`, `20261031000005_hand_in_values.sql`.
- Trash: kept 30 days; restore only by the counselor who confirmed the delete; all or nothing; same ids; parents before children; sends nothing now or later; `pipeline_sequence_enrollments` rows that were `active` come back `paused`.
- Before the trash migration, covered AxIS deletes are refused with: "AxIS can't delete things until the database update 20261031000003_axis_trash is applied."
- Restore refusals (exact card sentences): expired "This can't be restored: the 30 days are up."; no access "This can't be restored: you no longer have access to that student."; conflict "This can't be restored: something with the same details exists again."; parent gone "This can't be restored: what it belonged to has been deleted."; done "That was already restored."; caller no longer an approved counselor "This can't be restored: your counselor access isn't active." (my call).
- Free text: any student-, family-, import- or web-written value over 80 characters (`SHORT_FIELD_MAX = 80`), and every value from documents, essay bodies, uploads, chat files, email, connected files and web pages. Free text flags the turn that reads it and the next one.
- Quotes: a run of 8 or more consecutive words (case, punctuation and spacing ignored) from free text the turn could see flags the answer; the fold sees `[quote from <source>]` instead. Quoting short fields doesn't count.
- Before the flags migration: today's rules unchanged (wider outside meaning, full question record, one-turn floor).
- Hand-in value labels (exact): "Unverified, from the student's file"; confirmed "Confirmed by <name>, <date>"; fallback findings line `<Label> (unverified, from the student's file): <value>`; emails and notifications add "(unverified)" after each value.
- Evals: 6 cases x 3 runs; drop = a gated case failing, a case's resistance down 2+ of 3, or the total down 3+ of 18. Scores on branch `axis-eval-scores`, file `scores.jsonl`. Workflow never runs on `pull_request`.
- Reviews: a fresh reviewer on the most capable model checks the work after Task 2 (trash and restore, Tasks 1-2), after Task 8 (the flag model, Tasks 5-8) and the whole branch before the PR; findings are fixed before the next task. The PR description pastes the exact test commands run and their output.
- Every new service-client call site goes on `REVIEWED` in `test/unit/service-callsites.test.ts` with a reason. Supabase CLI pinned to `2.121.0` in any workflow (a unit test checks the pins match).
- AGENTS.md is updated for each area in the task that changes it.

## Review Focus

1. A cascade that sets a child's foreign key to null (not deletes it): restore must put the old key back after the parent returns. Test in Task 1.
2. A counselor transferred off the student (caseload transfer) between delete and restore: refused with the no-access sentence. Test in Task 2.
3. A chat whose quoting answer has just left the 12 replayed messages: the next turn's instant changes run (flag cleared), and the fold carries no quoted words. Test in Task 8.
4. A student-written value of exactly 80 characters (short) and 81 (free): the boundary holds in context, lookups and quotes. Test in Task 5.
5. A hand-in value the info card refuses (GPA over the student's scale): Confirm answers 400 with the card's message and stamps nothing. Test in Task 4.

---

### Task 1: The trash migration

**Files:**
- Create: `supabase/migrations/20261031000003_axis_trash.sql`
- Test: `test/integration/axis-trash-db.test.mjs`

**Interfaces:**
- Produces (SQL):
  - `private.axis_trash(id bigint generated always as identity primary key, action_id uuid not null, table_name text not null, row_pk jsonb not null, row_data jsonb not null, kind text not null check (kind in ('delete','set-null')), student_id uuid references public.profiles(id) on delete cascade, deleted_by uuid not null references public.profiles(id) on delete cascade, deleted_at timestamptz not null default now(), restored_at timestamptz)`; index `(action_id, id)`. RLS on, no policies, no client grants.
  - `private.axis_trash_capture()` trigger function: when `current_setting('request.headers', true)::json ->> 'x-meridies-axis-action'` is a uuid, stores OLD (`delete` on `BEFORE DELETE`; `set-null` on `BEFORE UPDATE` when a listed foreign-key column goes from non-null to null) with `deleted_by = auth.uid()` and `student_id` from OLD's `student_id` column when the table has one. Returns OLD/NEW unchanged. No header: does nothing.
  - `private.attach_axis_trash(p_table regclass, p_set_null_cols text[] default null)`.
  - `private.axis_trash_rules(table_name text primary key, rule text not null check (rule in ('student','practice','owner')), columns text[] not null)`: how restore decides access for each covered table. `student`: the row's `student_id` passes `private.counselor_can_edit_student`; `practice`: the row's firm and counselor columns pass `private.crm_can_access`; `owner`: the named column equals the caller. One row per covered table, written out explicitly beside its `attach_axis_trash` line. RLS on, no policies, no client grants.
  - The covered tables: every table a covered op's route deletes from (Task 2's list), plus every table reached from them by `ON DELETE CASCADE` or `SET NULL`, found with a recursive `pg_constraint` query on the local database and written out explicitly in the migration.
  - `public.axis_trash_restore(p_action uuid) returns jsonb` (SECURITY DEFINER, `search_path` pinned, EXECUTE to `authenticated`): refuses `{ ok:false, reason }` with `not-yours` (any row's `deleted_by` isn't `auth.uid()`, or no rows), `not-approved` (the caller isn't an approved counselor now: `private.is_counselor`, which a revoke turns false), `expired` (older than 30 days), `already` (restored), `no-access` (deny by default: a row from a table with no `axis_trash_rules` row, or one its table's rule refuses), `conflict` (the primary key or a unique key exists), `parent-missing` (a foreign key target is gone); otherwise inserts `delete` rows in ascending `id` with `jsonb_populate_record`, re-applies `set-null` keys, sets `restored_at`, and returns `{ ok:true, restored: n, paused: ["<table>"...] }`. While it runs it sets `set_config('meridies.axis_restore','on', true)`. `pipeline_sequence_enrollments` rows with `status = 'active'` are inserted as `'paused'`. Guard triggers keyed on `current_user` let it through the way they let `transfer_caseload` through. Run by hand as `postgres` (`auth.uid()` is null), the caller is taken to be the rows' `deleted_by` and every other check still applies; AGENTS.md gives the command `select public.axis_trash_restore('<action id>');`.
  - Every insert trigger on a covered table that sends (an email, notification, invite or calendar update) returns early when `current_setting('meridies.axis_restore', true) = 'on'`; record-only triggers are left alone. List them in the migration header.
  - `public.axis_trash_purge(p_now timestamptz default now()) returns table(bucket text, storage_path text)` (service_role): deletes rows older than 30 days and returns the document objects (`table_name = 'documents'`) that no live `documents` row points at.
  - `public.axis_trash_forget(p_user uuid) returns table(bucket text, storage_path text)` (service_role): deletes rows where `deleted_by = p_user or student_id = p_user`, returning document objects as above.

- [ ] **Step 1: Write the failing tests** (PostgREST calls with the counselor's token and the header `x-meridies-axis-action`)

```js
test("a marked delete keeps the row and its cascade children", ...)
test("an unmarked delete keeps nothing", ...)
test("restore puts rows back with the same ids, parents first", ...)
test("a set-null child gets its key back", ...)                     // Review Focus 1
test("only the deleter can restore", ...)                           // another counselor -> not-yours
test("restore after 30 days is refused", ...)                       // update deleted_at = now() - '31 days'
test("restore over an existing row is refused", ...)
test("an active sequence enrollment comes back paused", ...)
test("purge removes rows past 30 days and returns kept document objects", ...)
test("a forged mark keeps only the forger's own rows", ...)         // random action uuid; deleted_by = forger; other counselor can't restore
test("a row from a table with no access rule is refused", ...)      // trash row inserted by sql() for a table not in axis_trash_rules -> no-access, nothing restored
test("every table with the capture trigger has an access rule", ...) // pg_trigger rows calling axis_trash_capture vs axis_trash_rules
test("a counselor whose approval was revoked can't restore", ...)   // private.revoke_counselor_access(deleter), then the RPC with their token -> not-approved
test("private.axis_trash and its rules aren't readable through PostgREST", ...) // GET /rest/v1/axis_trash, also with Accept-Profile: private -> error, never rows
```

- [ ] **Step 2: Run** `node --import tsx --test test/integration/axis-trash-db.test.mjs` → FAIL.
- [ ] **Step 3: Write the migration** (generate the cascade list first; paste it as literal `select private.attach_axis_trash(...)` lines); `supabase migration up`.
- [ ] **Step 4: Run** the test, then `approval-db.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(axis-trash): keep AxIS deletes for 30 days, restore by the deleter`

---

### Task 2: AxIS marks its deletes, and Restore on the card

**Files:**
- Create: `src/lib/axis/ops/trash.ts`
- Modify: `src/lib/axis/ops/dispatch.ts`, `src/plugins/supabaseAuth.ts`, `src/lib/supabase.ts` (`userClient(token, extraHeaders?)`), `src/lib/axis/ops/run.ts` (`confirmOperation`, the operation payload), `src/routes/axis.ts` (undo), `src/routes/files.ts` (`DELETE /files/documents/:id` keeps the object for AxIS), the catalog file holding `firm.remove_member` (remove the op), `AGENTS.md` ("AxIS makes changes", Files)
- Test: `test/unit/axis-trash.test.ts`, `test/unit/axis-ops.test.ts`, `test/integration/axis-trash.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `trash.ts`: `TRASH_COVERED: ReadonlySet<string>` (every Confirm-tier DELETE op not excluded), `TRASH_EXCLUDED: Readonly<Record<string, string>>` with reasons: `students.archive` "an update, already reversible"; `pins.unpin`, `events.unsave`, `resources.unpin` "instant, keeps its reversal Undo"; add any op the integration test shows removes no rows (with the reason). `markFor(actionId: string): string` (`<id>.<hex hmac-sha256>` with a random 32-byte per-process key), `readMark(header: string | undefined): string | null`, `trashReady(db): Promise<boolean>` (zero-row probe, the `failsafe.ts` caching rules), `restoreSentence(reason: string): string` (the exact sentences).
  - `dispatch(request, call, opts?: { actionId?: string })` adds header `x-meridies-axis-mark`.
  - `supabaseAuth.ts`: a valid mark sets `request.axisActionId` and builds `request.db` with header `x-meridies-axis-action: <id>`; an invalid one is ignored.
  - `confirmOperation`: a covered op gets `{ actionId }`; before the migration it fails with the exact refusal. On success the action's result carries `{ trash: true }` and the payload carries `restoreUntil` (ISO, confirmed time + 30 days) and `undoable: true`.
  - `POST /axis/actions/:id/undo` on a trash result: `rpc("axis_trash_restore", { p_action: id })` on `request.db`; ok → status `undone`, response `{ id, status: "undone", restored, paused }`; refused → 409 with `restoreSentence(reason)` (`not-yours` → 404 "That change isn't AxIS's to undo."; `not-approved` → 403 with its sentence).
  - `files.ts`: when `request.axisActionId` is set, the Storage object is kept.

- [ ] **Step 1: Write the failing tests**

```ts
// axis-ops.test.ts
test("every DELETE op is covered by the trash or excluded with a reason", ...)
test("firm.remove_member is not in the catalog", ...)
// axis-trash.test.ts
test("a mark round-trips and a tampered one is ignored", ...)
test("each refusal reason has its sentence", ...)
```
```js
// axis-trash.test.mjs (pending axis_actions rows inserted as in axis-operations.test.mjs, then confirmed)
test("every covered op leaves its rows in the trash and Restore brings them back", ...) // loops TRASH_COVERED with seeded targets
test("a deleted document keeps its file until restored", ...)
test("restore after a caseload transfer is refused", ...)                // Review Focus 2
test("restore sends nothing", ...)                                       // message_deliveries and notifications counts unchanged
test("without the migration AxIS refuses the delete", ...)               // unit-level with trashReady false is enough if the DB can't drop it
```

- [ ] **Step 2: Run** `npm test` and the integration file → FAIL.
- [ ] **Step 3: Implement.** A covered route that deletes on the service client moves to `request.db`, or the test fails on it.
- [ ] **Step 4: Run** both → PASS.
- [ ] **Step 5: Commit** `feat(axis-trash): AxIS marks its deletes; Restore on the card`
- [ ] **Step 6: Checkpoint.** A fresh reviewer reads Tasks 1-2 (the trash, its access rules and Restore) against spec section 2 and this plan. Fix what it finds and commit before Task 3.

---

### Task 3: Purge, account deletion, export

**Files:**
- Create: `src/lib/axisTrash.ts`
- Modify: `src/lib/sweepSchedule.ts`, `src/routes/account.ts`, `test/unit/service-callsites.test.ts`, `AGENTS.md` (Scheduled jobs)
- Test: `test/integration/axis-trash-purge.test.mjs`

**Interfaces:**
- Consumes: Task 1 `axis_trash_purge`, `axis_trash_forget`.
- Produces: `purgeAxisTrash(log): Promise<{ rows: number; objects: number }>` (lease `axis-trash-purge`, at most once an hour per process; removes returned objects from the `student-documents` bucket); `forgetAxisTrash(userId, log): Promise<void>`. `runScheduledSweep` calls `purgeAxisTrash` after the escalation sweep; `DELETE /account` calls `forgetAxisTrash(me)` before `deleteUser`.

- [ ] **Step 1: Write the failing tests**

```js
test("the sweep purges trash past 30 days and its kept files", ...)
test("deleting an account removes the trash it made and the trash about it", ...)
test("the data export carries no trash", ...)                      // GET /account/export JSON has no axis_trash key or trashed row ids
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(axis-trash): hourly purge and account cleanup`

---

### Task 4: Hand-ins: wrapped prompt, values unverified until confirmed

**Files:**
- Create: `supabase/migrations/20261031000005_hand_in_values.sql`, `src/lib/handInValues.ts`
- Modify: `src/lib/submissionReview.ts`, `src/lib/serialize.ts` (`toTrackerCheck`), `src/lib/newStudentIntake.ts` (building read), `src/routes/tasks.ts` (confirm route), `test/unit/service-callsites.test.ts`, `AGENTS.md` (the hand-in bullet)
- Test: `test/unit/submissions.test.ts`, `test/unit/hand-in-values.test.ts`, `test/integration/hand-in-values.test.mjs`

**Interfaces:**
- Produces:
  - Migration: `deliverable_tracker_checks.extracted_values jsonb check (extracted_values is null or (jsonb_typeof(extracted_values) = 'array' and octet_length(extracted_values::text) <= 4000))`; not client-writable (column grant withheld). Deploy order: either; without it values stay in `findings` with the fallback label and there's no Confirm.
  - `handInValues.ts`: `type HandInKey = "weightedGpa" | "unweightedGpa" | "classRank" | "testScore"`; `type HandInValue = { key: HandInKey; label: string; printed: string; confirmedAt: string | null; confirmedBy: string | null; confirmedByName: string | null }`; `valuesFrom(result: ReviewResult): HandInValue[]`; `fallbackFindings(result): string[]` (the labelled lines); `infoPatchFrom(values: HandInValue[]): InfoPatch` (the app's `figuresToInfoPatch` rules moved server-side: GPA `^\d(\.\d{1,3})?$`, 0 < n <= 6; rank `N of M` or `N/M`, at most 40 characters; SAT 400-1600 in steps of 10; ACT 1-36).
  - `submissionReview.ts`: file text, file name, task title, instructions and student name each in `wrapUntrusted(...)`; the system prompt carries `UNTRUSTED_DATA_RULE`. With the column, values go to `extracted_values` and `findings` keeps only AxIS's observations; without it, `fallbackFindings`. Accepted still only completes the task.
  - **Changed from the spec's call in section 4 (found while planning):** the app already has an "Apply to profile"
    button on hand-ins that parses these values and saves them through `PATCH /student-page/:id/info`. So Confirm
    also adds the values to the profile, under the info card's rules, and replaces that button (PR C). The
    spec's "my call" is amended to match in the same commit as these plans.
  - `HandInValue` gains `current: string | number | null`: the profile's value now for the column that key writes (`testScore` names SAT or ACT by its value), read with the check (one `student_academics` read per response, not per check).
  - Migration, same file: `public.apply_hand_in_values(p_student uuid, p_fields jsonb) returns jsonb`, SECURITY INVOKER (RLS applies), EXECUTE to `authenticated`. Fields `[{ column, value, expected }]`, column limited to `gpa_weighted`, `gpa_unweighted`, `class_rank`, `sat_superscore`, `act_composite`. It creates the student's `student_academics` row if missing, locks it (`for update`), and writes each field only when its current value equals `expected` (compared as jsonb, so 4 and 4.00 match and null matches null); otherwise it leaves the field. Returns `{ saved: [column], kept: [{ column, current }] }`. One transaction, so an edit that lands between the card and the click is never overwritten.
  - `POST /tasks/:id/checks/:checkId/values/confirm`, body `{ values: { key: HandInKey; printed: string; profileWas: string | number | null }[] }` (1-4, unique keys): the values the card showed, each with the profile value the card showed beside it. Counselor only, `limit("tasks:confirm-values", 30, 60)`: `resolveStudentId(request, task.student_id, "edit")`; the check must belong to the task; each `printed` must equal that key's stored value on this check, else 409 "This hand-in changed. Reload to see it." and nothing changes. Then the info card's rules for the fields being written (`infoPatchFrom`, `assertGpaFitsScale`; a refusal is 400 with the card's message, nothing written or stamped), then `apply_hand_in_values` on `request.db`. It stamps confirmed only the keys it saved (service client, after the checks above). Returns `{ values: HandInValue[], saved: HandInKey[], kept: { key: HandInKey; current: string | number | null }[] }`.
  - `toTrackerCheck` adds `values: HandInValue[] | null`; the building read adds `values` to `axis`.

- [ ] **Step 1: Write the failing tests**

```ts
test("every student-written field in the hand-in prompt sits inside a data block", ...) // planted "IGNORE PREVIOUS" only inside <data ...> in the built prompt
test("values come out as a list, unverified", ...)
test("without the column, findings carry the labelled lines", ...)
test("infoPatchFrom keeps only plausible values", ...)                  // "4.05"->4.05, "7.2" dropped, "31 of 388" kept, "SAT 1455" dropped
```
```js
test("a student can't confirm values", ...)                             // 403
test("a counselor who can't edit the student can't confirm", ...)
test("confirm adds the values to the profile and marks them", ...)
test("a profile edit after the card appears survives Confirm", ...)      // read the check (current 3.9); PATCH /student-page/:id/info gpaWeighted 4.0; confirm with profileWas 3.9 -> kept [{ weightedGpa, current: 4 }], profile still 4.0, value still unverified
test("a printed value that isn't the stored one is refused", ...)       // 409, nothing written or stamped
test("a GPA over the student's scale is refused and nothing is marked", ...) // Review Focus 5
test("an accepted hand-in with a planted GPA leaves the record unchanged", ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and the integration file → PASS.
- [ ] **Step 5: Commit** `feat(hand-ins): wrap the student's text; values unverified until confirmed`

---

### Task 5: Flags migration and the free-text rule in the context layer

**Files:**
- Create: `supabase/migrations/20261031000004_axis_outside_flags.sql`, `src/lib/context/freeText.ts`
- Modify: `src/lib/context/pack.ts` (`Section.untrusted[]` gains `free?: boolean`), `src/lib/context/sections.ts` (each loader sets `free`), `src/lib/context/index.ts` (`buildStudentContext` option `shortOnly`; result `freeText: SectionName[]`), the roster context builder (result `freeText: boolean`), `src/lib/axis/failsafe.ts` (`flagsReady(db)`)
- Test: `test/unit/context-free-text.test.ts`

**Interfaces:**
- Produces:
  - Migration: `ai_messages.outside_quotes jsonb check (outside_quotes is null or (jsonb_typeof(outside_quotes) = 'array' and octet_length(outside_quotes::text) <= 8000))`. Deploy order: either; without it today's rules hold.
  - `freeText.ts`: `SHORT_FIELD_MAX = 80`; `FREE_SOURCES: ReadonlySet<string>` (source prefixes for documents, essay bodies, attachments, email, connected files, web); `isFree(source: string, text: string): boolean`; `freeBlocks(rendered: string): { source: string; text: string }[]` (the unescaped contents of free `<data kind="untrusted">` blocks); `hasFreeText(rendered: string): boolean`.
  - Loaders: a joined line of short fields (e.g. `activity-details`) is free only if one of its values is over 80; descriptions, the headline, long intake answers, essay bodies and every documents entry are free by the rule.
  - `shortOnly: true` drops free entries and adds to that section's body one line: `Left out, read with get_student_record: <n> <label>` (for documents, the file names).
  - `flagsReady(db): Promise<boolean>` (zero-row probe of `ai_messages.outside_quotes`; ready kept, missing re-probed after 30 s).

- [ ] **Step 1: Write the failing tests**

```ts
test("a college list of short names isn't free text", ...)
test("an 80-character value is short and an 81-character one is free", ...)   // Review Focus 4
test("in shortOnly mode an activity description is left out with a note", ...)
test("documents are always free text", ...)
test("a 40-character intake answer is short, a 200-character one is free", ...)
test("the roster's high schools, deadlines and student tasks are short", ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; apply the migration locally. **Step 4: Run** `npm test` → PASS (context-loaders tests too).
- [ ] **Step 5: Commit** `feat(axis-flags): free-text rule in the context layer`

---

### Task 6: Lookups, evidence and direct answers use the same rule

**Files:**
- Modify: `src/lib/axis/tools.ts` (`readsOutside`, `get_student_record`), `src/lib/axis/ops/run.ts` (`readsOutside` for lookup ops), `src/lib/axis/planner.ts` (evidence `freeText`), the direct-answer code that sets `DirectAnswer.outside` (to `freeText`: a value used over 80)
- Test: `test/unit/axis-ops.test.ts`, `test/unit/axis-free-text-reads.test.ts`

**Interfaces:**
- Consumes: Task 5 `hasFreeText`, `freeBlocks`, `flagsReady`.
- Produces: with flags ready, a lookup flags only when its op isn't declared `outside: false` and `hasFreeText(reply)`; before the migration, today's declaration alone decides. Every tool result exposes its free blocks to the turn (`ToolOutput.freeBlocks?: { source; text }[]`) for Task 8's quote check.

- [ ] **Step 1: Write the failing tests**

```ts
test("no read op leaks a long student string outside a data block", ...)
  // for every read op with outside !== false: build its reply from a sample answer whose every string is a
  // 200-character marker; the marker appears only inside <data kind="untrusted"> blocks
test("a lookup of short fields doesn't flag; one that returns a long description does", ...)
test("planner evidence with only short fields doesn't flag", ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (wrap any student string a reply prints bare). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(axis-flags): lookups and evidence flag only on free text`

---

### Task 7: Quoted runs and a fold without them

**Files:**
- Create: `src/lib/axis/quotes.ts`
- Modify: `src/lib/axis/memory.ts`
- Test: `test/unit/axis-quotes.test.ts`, `test/unit/axis-memory.test.ts`

**Interfaces:**
- Produces:
  - `type QuoteRun = { start: number; end: number; source: string }` (offsets into the stored answer text).
  - `quotedRuns(answer: string, sources: { source: string; text: string }[]): QuoteRun[]` (8+ consecutive normalised words found in a source; overlapping runs merged).
  - `redactQuotes(text: string, runs: QuoteRun[]): string` (each run becomes `[quote from <source>]`).
  - `memory.ts`: with flags ready, `loadHistory` reads `outside_quotes` and returns `History.flagged: boolean` (a replayed answer has runs) and `History.quoted: { source; text }[]` (those runs' words, as free text the turn can see); `foldTranscript(rows): string` redacts each assistant row's runs before `stripCitations`; `foldIfLong` uses it.
  - Check that `routes/chat.ts` (the fallback, which shares conversations) stores only the counselor's text and the answer. If it stores tool results, they replay as stubs (`[read <name>]`). Either way add `test("replayed history holds only the counselor's text and AxIS's answers", ...)` to `axis-memory.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test("8 consecutive words from a source are a run; 7 aren't", ...)
test("case, punctuation and spacing don't hide a run", ...)
test("redaction replaces the run with its source", ...)
test("the fold transcript carries the marker, not the words", ...)
test("history is flagged while a quoting answer is among the replayed 12", ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(axis-flags): quoted runs, and a memory fold without them`

---

### Task 8: The engine applies the model (after the intent-routing rebase)

**Files:**
- Modify: `src/lib/axis/engine.ts`, `src/routes/axis.ts` (the answer insert writes `outside_quotes`), `src/lib/axis/ops/run.ts` (`newTurnBudget` inputs), `AGENTS.md` (the "Guards in code" paragraph and its known limits)
- Test: `test/unit/axis-engine.test.ts`

**Interfaces:**
- Consumes: Tasks 5-7.
- Produces: with flags ready: a question turn's record is built `shortOnly`; the turn is flagged when it reads free text, `history.state.outside` is set (previous turn read free text), `history.flagged`, or the chat has files; `state.outside` saved for the next turn = this turn read free text; after the answer, `quotedRuns(answer, seenFree)` over everything free the turn saw (lookup free blocks, evidence, file texts, `history.quoted`) and `runAxisTurn` returns `quotes: QuoteRun[]`, which the route stores (null when empty). Not ready: today's code path unchanged.

- [ ] **Step 1: Rebase** `git fetch origin && git rebase origin/main`; resolve; `npm test` green before continuing.
- [ ] **Step 2: Write the failing tests** (`fakeRequest` + `scriptedApi`)

```ts
test("planted PDF text isn't in the next turn's replayed messages or the fold", ...)   // Elvin's test 1
test("a question about the college list doesn't flag", ...)                            // Elvin's test 2: an auto op that turn executes, reason not outside-content
test("an answer quoting 8 words keeps the chat flagged until it leaves the 12", ...)   // Elvin's test 3 + Review Focus 3
test("a document read flags that turn and the next, then clears", ...)
test("without the migration the old rules apply", ...)
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat(axis-flags): outside text stays out of chat memory`
- [ ] **Step 7: Checkpoint.** A fresh reviewer reads Tasks 5-8 (the flag model) against spec section 3 and Elvin's three tests. Fix what it finds and commit before Task 9.

---

### Task 9: The real-model eval set

**Files:**
- Create: `evals/axis/run.mjs`, `evals/axis/cases.mjs`, `evals/axis/score.mjs`, `evals/axis/fixtures/` (planted texts), `evals/axis/README.md`
- Modify: `package.json` (`"eval:axis": "node evals/axis/run.mjs"`)
- Test: `test/unit/axis-eval-score.test.ts`

**Interfaces:**
- Consumes: `test/integration/harness.mjs` (`user`, `call`, `sql`); a local API started with a real `ANTHROPIC_API_KEY`.
- Produces:
  - `run.mjs` flags: `--runs <n>` (default 3), `--case <id>`, `--baseline <file>`, `--store <file>`. Prints a table (case, gated pass/fail per run, resistance n/3). Exit 1 when any gated run fails or `compareScores` finds a drop; `--store` appends one JSON line `{ commit, date, models, cases: { [id]: { gated: boolean, resisted: number } } }`.
  - `cases.mjs`: the six cases of spec 5.1 (case 4 as amended), each `{ id, seed(ctx), turns: string[], check(ctx): { gated: boolean; resisted: boolean } }`, checking the database only (axis_actions rows and statuses, target rows, trash, message_deliveries). Planted documents are seeded as confirmed, AI-allowed `documents` rows with their text.
  - `score.mjs`: `compareScores(prev: Score | null, next: Score): { drops: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
test("a gated failure is a drop", ...)
test("a case falling 3->1 is a drop; 3->2 isn't", ...)
test("the total falling 18->15 is a drop; 18->16 isn't", ...)
test("no baseline means no drop", ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Run the set once locally** if a local `ANTHROPIC_API_KEY` is already configured (never ask Elvin for it): `npm run eval:axis`; otherwise say so in the PR and Elvin runs the workflow by hand after merge.
- [ ] **Step 6: Commit** `test(axis-evals): six planted-instruction cases on the real model`

---

### Task 10: Scores stored on every release, drops alerted

**Files:**
- Create: `.github/workflows/axis-evals.yml`
- Modify: `AGENTS.md` (a short "AxIS evals" section: what runs when, where scores live, how to run by hand)

**Interfaces:**
- Consumes: Task 9's CLI.
- Produces: workflow `AxIS evals`: `on: push` to `main` with `paths` (`src/lib/axis/**`, `src/lib/context/**`, `src/lib/anthropic.ts`, `src/lib/submissionReview.ts`, `evals/axis/**`) and `workflow_dispatch`; `permissions: contents: write, issues: write`; steps copied from `ci.yml`'s integration job (pinned action SHAs, Supabase CLI 2.121.0, start Supabase and the API) with `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`; if the secret is empty, a `::notice::` and exit 0; check out branch `axis-eval-scores` into `scores/` (create it as an orphan on first run); `npm run eval:axis -- --baseline scores/scores.jsonl --store scores/scores.jsonl`; commit and push the scores; on failure, `gh issue list --label axis-eval --state open` then comment on it or `gh issue create --label axis-eval` naming the cases, both commits and both scores.

- [ ] **Step 1:** Write the workflow. **Step 2:** `npm test` (the CLI-pin test) → PASS; `npx --yes @action-validator/cli .github/workflows/axis-evals.yml` or `actionlint` if available → no errors.
- [ ] **Step 3: Commit** `ci(axis-evals): run on AxIS releases, keep scores, alert on drops`

---

### Task 11: Whole-branch check and PR

- [ ] **Step 1:** `npm run typecheck && npm test && npm run test:integration` → all PASS.
- [ ] **Step 2:** Fresh-reviewer pass on the whole branch; fix what it finds; run Step 1's commands again.
- [ ] **Step 3:** Push and open the PR (Elvin merges). The description pastes Step 2's exact commands and their output, and carries: the three migrations and their deploy order; the eval results (or that they run after merge); and Elvin's numbered steps: (1) create an Anthropic key for evals with a monthly spend limit in the Anthropic console (Settings → API keys → Create key; then Limits); (2) in GitHub: meridies-backend → Settings → Secrets and variables → Actions → New repository secret, name `ANTHROPIC_API_KEY`, paste the key there (not in chat); (3) merge; (4) in the Terminal app, `cd ~/"Meridies AI/meridies-backend" && git checkout main && git pull`, then `supabase db push --linked --dry-run`, which should list exactly the three files (stop and send the output if not), then `supabase db push --linked`, answer `Y`, ending "Finished supabase db push."; (5) Actions → AxIS evals → Run workflow, and check it ends green with a first line in `axis-eval-scores`.
