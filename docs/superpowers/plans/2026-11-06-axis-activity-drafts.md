# AxIS Activity Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A counselor can add or change activities through AxIS in one message or across several, and every value
lands on a Confirm card, in the counselor's words or a file they pointed to, with plain status lines instead of raw
errors.

**Architecture:** A per-conversation activity draft (a small header in `ai_conversations.state`, rows in a new
`ai_conversations.draft_rows` column) is loaded at the start of each AxIS turn. A code sorter decides whether the
message continues the draft. `perform_action` calls to the activity ops are intercepted and passed through normalizers, field checks and
a provenance check. The checked values are merged into draft rows, which are filed as one `application.add_activities`
card (a batch route saves the checked rows on Confirm). The engine appends code-written status lines and saves the
draft before `done`. Real-model cases go into the shared `evals/axis/` runner, which gains click steps and an
eval-only clock.

**Tech Stack:** Fastify 5, TypeScript ESM, zod, Supabase (Postgres + RLS), `node:test` with tsx, the scripted model
in `test/unit/axis-fakes.ts`, the integration harness in `test/integration/harness.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-30-axis-activity-drafts-design.md` (merged in #84). Read it alongside this
plan. Where this plan differs, it is because main changed after the design (listed under "Changed since the design").

## Changed since the design (Elvin, 11/6, and what main now holds)

- **Confirm all:** security's Confirm all (app) already skips cards whose `reason` is `outside-content`, and skips
  deletes. Nothing new is built for it. Draft cards set that `reason` (Task 4, Task 7).
- **Free text:** the free-text rule is live (`lib/context/freeText.ts`, >80 characters flags the chat). A draft value or
  description that came from a chat file or a student document counts as outside content and flags its card.
- **Test runner and key:** the shared runner exists (`evals/axis/`, `npm run eval:axis`, workflow `axis-evals.yml`) and uses
  the `ANTHROPIC_API_KEY` repository secret, which is set. Spec §5's separate `AXIS_EVAL_ANTHROPIC_API_KEY` and
  Console workspace steps are dropped. The runner has no click steps, clock or per-suite pass rule yet. Task 9 adds
  them; the design's AI grader is not built (every scored check is computed in code; **my call**, YAGNI).
- **Migration date:** the newest migration on main is `20261110000007_axis_trash_blast_source` (not 000003). This plan uses
  `20261111000001_axis_activity_drafts.sql`. Re-check the newest number right before merge and rename if needed.
- **Flag gap, still open:** main still sets `outside-content` only when an instant change is turned into a card
  (`ops/run.ts` ~line 412). This plan sets it for activity cards only. The general fix stays with security (spec §4.11).
- **Chat files:** chat files are read once after their turn (A1). A file attached in the same message has no stored text yet,
  so the provenance check reads it first through the existing `extractChatFiles` (Task 2). Image and scan
  transcripts are model-written, so they never count as a source (spec 4.5's reason still holds).

## Global Constraints

- Counselor-facing copy, exactly:
  - `You still have an activity draft for {name}. Continue or cancel?`
  - `Your activity draft expired. Want to start again?`
  - `Your activity draft for {a} isn't finished. Drop it and start one for {b}?`
  - `Okay, I dropped the activity draft for {name}.`
  - `I couldn't keep this draft; send the details again.`
  - `Waiting for your Confirm: add {orgs} to {name}'s Activities sheet.`
  - `Saved: {org} on {name}'s Activities sheet.`
  - `Couldn't save {org} yet: {field}: {reason}.`
  - `Still need for {label} row: {fields}.`
  - `Over the Common App's 150-character limit.`
- Model-facing copy, exactly:
  - `description must be copied exactly from the counselor's message or the student's resume; AxIS can't write or edit it.`
  - `there's an open activity draft; ask the counselor to continue it`
  - Provenance failure: `{field} '{value}' isn't in the counselor's words; use their wording or leave it blank and ask`
  - Image-only value: `ask the counselor to type it or attach a PDF or text file`
- No raw zod text, "Invalid input", "Expected" or field paths ever reach the counselor. The model gets field-level
  messages (spec 4.3).
- Every status line is built in code from draft state and op results, never from the model's text.
- Draft limits:
  - at most 10 rows (`MAX_DRAFT_ROWS`);
  - 30-minute expiry (`DRAFT_TTL_MS`), reset by every counselor message;
  - the header fits `state`'s 4000-byte CHECK;
  - `draft_rows` ≤ 32000 bytes;
  - the stored card payload ≤ `PAYLOAD_MAX_BYTES` (30000).
- Descriptions:
  - exact copies only: case-sensitive, trimmed; whitespace runs collapse for document text only;
  - typed messages, or the student's `resume` / `activity-list` documents that `documentAiDecision` allows;
  - at most 1000 characters (**my call**: a 10-row card must show every description whole within the 1600-character
    detail line and the payload limit);
  - UC description fields stay blocked.
- Sources that count: the counselor's typed messages in the chat, the counselor's meeting notes for the student, chat
  files with `extract_kind = 'text'`, and the student's documents `documentAiDecision` allows. Files and documents
  flag the card (`reason: "outside-content"`); messages and notes don't.
- Logs: one `axis turn` line per turn holding `path`, `intent`, `draft`, outcome codes (field names only), `calls`, `maxCalls` and
  `conversationId`. Never message text, values, student names or student ids.
- Evals use made-up fixture students only. Never real data. Claude never touches production; Elvin applies the
  migration from plain Terminal on main (dry-run first) before the backend PR merges.

## Review Focus

1. **Accented or non-Latin names** ("Club de Fútbol", "Ñandú Robotics"): provenance keeps letters with accents when it
   strips punctuation, so a typed accented name passes. Test in Task 2.
2. **Hours as decimals or minutes** ("1.5 hrs/week", "90 minutes a week"): read as 1.5, shown with how it was read;
   "2 hours a day" still asks. Test in Task 1.
3. **The panel switched to another student mid-draft** (the same conversation, a new `studentId`): an add for the
   new student is refused and the switch question asked; nothing goes to either student. Test in Task 8.
4. **Confirm or Dismiss clicked between turns, or while the next turn runs:** the next turn syncs card statuses
   first, so a confirmed card's rows read `saved` (with their new ids) and a dismissed card closes the draft. Test in
   Task 5.
5. **More than 10 activities** (a long resume or pasted list): rows 11+ are refused to the model by name with
   "a draft holds 10 activities; file this card first", the first 10 stay. Test in Task 7.

---

### Task 1: Normalizers and the Common App activity types

**Files:**
- Create: `src/lib/axis/drafts/normalize.ts`
- Modify: `src/lib/studentApplication.ts` (add `ACTIVITY_TYPES`, the 27 labels copied from meridies-app
  `lib/applicationSheets.ts`, in the same order)
- Test: `test/unit/axis-draft-normalize.test.ts`

**Interfaces:**
- Produces:
  - `type ActivityField = "organization" | "position" | "category" | "grade_levels" | "timing" | "hours_per_week" | "weeks_per_year" | "continuing" | "uc_category" | "description"`
  - `type Norm<T> = { ok: true; value: T; readAs?: string } | { ok: false; problem: string }`. `readAs` is the raw
    phrase when it differs from the value ("grades 10–12").
  - `normalizeField(field: ActivityField, raw: unknown): Norm<unknown>`. Free-text fields are trimmed, and empty means
    `{ ok: false }`. `grade_levels` gives sorted, de-duplicated `Grade[]`. `timing` gives a one-element `Timing[]` (the op's
    shape). `hours_per_week` gives a number. `weeks_per_year` gives an integer. `continuing` gives a boolean.
    `uc_category` gives a `UcCategory`. `category` gives one exact `ACTIVITY_TYPES` label.
  - `type Mentions = { grades: Grade[]; timing: Timing[]; hours: number[]; weeks: number[]; continuing: boolean[]; uc: UcCategory[]; category: string[] }`
  - `mentionsIn(text: string, opts?: { bare?: boolean }): Mentions`. Every value the table below reads in free text.
    With `bare`, unitless numbers 9–12 also count as grades and 0–168 as hours or weeks (provenance only).
  - `hasActivityValue(text: string): boolean`. Any unit-bearing mention (for the sorter; `bare` off).
  - `ACTIVITY_TYPES` and `type ActivityType` from `studentApplication.ts`.

The accepted phrasings are spec 4.2's table, plus:
- minutes a week, converted to hours;
- decimals ("1.5 hrs/week");
- the category synonyms "community service" → "Community Service (Volunteer)", "volunteering" → same, "robotics" →
  "Robotics", "debate" → "Debate/Speech", "student government" → "Student Govt./Politics", "job" / "paid work" →
  "Work (paid)", "theater" / "drama" → "Theater/Drama", "coding" / "programming" → "Computer/Technology". The builder
  may add more.

Exact problems (Global Constraints style):
- hours over 168: `{raw} is more than 168. Ask the counselor; don't guess.`
- per-day hours: `"{raw}" needs the days per week. Ask the counselor; don't guess.`
- "the school year" as weeks: `"{raw}" isn't a number of weeks. Ask the counselor; don't guess.`
- category with no match: `"{raw}" isn't one of the Common App activity types. Leave category blank.`
- uc_category: `uc_category needs the counselor's own word (volunteer, work, extracurricular, educational prep). Leave it blank.`

- [ ] **Step 1: Write the failing tests**

```ts
test("grades: numbers, ordinals, class names, ranges and whole spans", () => {
  for (const [raw, want] of [
    [11, ["11"]], ["11th", ["11"]], ["eleventh", ["11"]], ["sophomore", ["10"]], ["jr", ["11"]], ["PG", ["PG"]],
    ["post-grad", ["PG"]], ["10-12", ["10","11","12"]], ["10–12", ["10","11","12"]], ["10 to 12", ["10","11","12"]],
    ["9th-12th", ["9","10","11","12"]], ["all four years", ["9","10","11","12"]], [["12", 11, "11"], ["11","12"]],
  ] as const) assert.deepEqual(ok(normalizeField("grade_levels", raw)), want, String(raw));
});
test("timing: summer and breaks are break, school-year words are school, both or all year is year", ...);
//   "summer" -> ["break"], "after school" -> ["school"], "year-round" -> ["year"], "school and summer" -> ["year"]
test("hours: units, decimals, minutes and ranges; per-day and over 168 ask", ...);
//   "6hr" 6, "6 hrs/week" 6, "about 6" 6, "1.5 hrs/week" 1.5, "90 minutes a week" 1.5, "5-6" 5.5 (readAs "5-6"),
//   "2 hours a day" -> problem /needs the days per week/, 200 -> problem "200 is more than 168. Ask the counselor; don't guess."
test("weeks: '2 weeks/yr' is 2, 'all year' is 52, 'the school year' asks", ...);
test("continuing, uc_category and category read only explicit words", ...);
//   "still" true, "ended" false; "volunteer" -> "volunteer", "helps out" -> problem;
//   "community service" -> "Community Service (Volunteer)" (readAs "community service"), "chess stuff" -> problem
test("mentionsIn reads values out of the transcript's line", () => {
  const m = mentionsIn("Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr");
  assert.deepEqual([m.grades, m.timing, m.hours, m.weeks], [["11"], ["break"], [6], [2]]);
});
test("numbers without a unit are not activity values, unless bare is asked for", () => {
  assert.equal(hasActivityValue("is her 1450 good for UCLA?"), false);
  assert.equal(hasActivityValue("what are her grades?"), false);
  assert.deepEqual(mentionsIn("6", { bare: true }).hours, [6]);
});
```

- [ ] **Step 2: Run it to make sure it fails**
  Run: `node --import tsx --import ./test/env.ts --test test/unit/axis-draft-normalize.test.ts`
  Expected: FAIL (module not found).
- [ ] **Step 3: Implement `normalize.ts` and `ACTIVITY_TYPES`** with the interfaces above. Pure functions only, with no I/O.
- [ ] **Step 4: Run the test again** (same command). Expected: PASS.
- [ ] **Step 5: Commit** `feat(axis-drafts): activity value normalizers and the Common App activity types`

---

### Task 2: Provenance: where a value came from

**Files:**
- Create: `src/lib/axis/drafts/provenance.ts`
- Test: `test/unit/axis-draft-provenance.test.ts`

**Interfaces:**
- Consumes: `normalizeField`, `mentionsIn` (Task 1); `documentAiDecision`, `toAiDoc` (`lib/context/documentAi.ts`);
  `loadPracticeSettings` (`lib/practiceSettings.ts`, `settings.autoParseDocuments`); `extractChatFiles`
  (`lib/axis/attachments.ts`).
- Produces:
  - `type Source = { kind: "message" | "notes" | "file" | "document"; label: string; text: string; docKind?: string }`
  - `type Trace = { label: string; outside: boolean }`. `outside` is true for `file` and `document`.
  - `class SourceSet`, built by `sourcesFor(request: FastifyRequest, conversationId: string, studentId: string): SourceSet`.
    It loads lazily and once per turn:
    - first the user `ai_messages` of the chat (newest 200) and the student's `meeting_notes` (newest 20; label
      `meeting notes (Oct 12)` from `meeting_date`);
    - then, only when a value isn't found in those, the chat's `ai_attachments` with `extract_kind = 'text'` (label =
      `file_name`) and the student's `documents` (label = `title ?? filename`, text = `parsed_data.text`), filtered
      by `documentAiDecision`.
    - If any of the chat's attachments has `extract_kind` null, it awaits `extractChatFiles(request, conversationId)`
      first (it claims files, so the after-turn reader then finds nothing to do).
    - `hasTranscriptsOnly()` answers whether the chat has files whose only text is a transcript.
  - `traceValue(set: SourceSet, field: ActivityField, value: unknown): Promise<Trace | null>`. Free text (organization,
    position) matches through `freeTextKey` as a whole-word substring. Structured values must appear in
    `mentionsIn(source.text, { bare: source.kind === "message" })`; for grades, every grade must be mentioned in one
    source. Order is messages, notes, files, documents, and the first match wins. Messages give label `your message`.
  - `traceDescription(set: SourceSet, value: string): Promise<Trace | null>`. An exact substring of a typed message, or
    of a `resume` / `activity-list` document's text with every whitespace run collapsed to one space on both sides.
    Labels are `your message`, `resume` or `activity list`. Files and other kinds never count.
  - `freeTextKey(s: string): string`: lowercased, and every run of characters that is not `\p{L}` or `\p{N}` becomes one space,
    trimmed.
  - `DESCRIPTION_REFUSAL`, `provenanceRefusal(field, value)`, `IMAGE_ONLY_HINT` (exact copy in Global Constraints).

- [ ] **Step 1: Write the failing tests** (fake db with `ai_messages`, `meeting_notes`, `ai_attachments`, `documents`)

```ts
test("a typed name passes whatever its case and punctuation; a made-up one doesn't", async () => {
  const set = sources({ messages: ["add code kidds adventure, cofounder/teacher"] });
  assert.equal((await traceValue(set, "organization", "Code Kidds Adventure"))?.label, "your message");
  assert.equal((await traceValue(set, "position", "Cofounder/Teacher"))?.label, "your message");
  assert.equal(await traceValue(set, "position", "Host, library workshop"), null);
});
test("accented names pass when typed", async () => { /* "Club de Fútbol" typed, "club de futbol" value -> null; "Club de Fútbol" -> your message */ });
test("structured values trace through the normalizers, bare numbers only in messages", ...);
//   message "Grade 11 Summer / 6hr week" -> grades ["11"], timing ["break"], hours 6 trace; hours 8 -> null;
//   message "6" (an answer) -> hours 6 traces; a document containing "6" alone does not
test("a value only in a document is labelled with the document and marked outside", ...);
test("a document the AI may not read is never a source", ...);           // available_to_llm false -> null
test("a meeting note is a source and isn't outside", ...);               // label "meeting notes (Oct 12)", outside false
test("an attachment's text counts; a transcript doesn't; an unread one is read first", ...);
//   extract_kind 'text' -> label file_name, outside true; 'transcript' -> null and hasTranscriptsOnly() true;
//   extract_kind null -> extractChatFiles called once (spy), then traced
test("descriptions: exact copies from a message or a resume only", async () => {
  // message copy -> "your message"; resume with a line break mid-sentence -> "resume" (whitespace collapsed);
  // a one-word change, a case change, an essay-kind document, a chat file -> null
});
```

- [ ] **Step 2: Run it** `node --import tsx --import ./test/env.ts --test test/unit/axis-draft-provenance.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `provenance.ts`** per the interfaces above. Reads run on `request.db` (RLS: the counselor's own chat and
  students only).
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(axis-drafts): provenance check for draft values and descriptions`

---

### Task 3: Batch activity routes

**Files:**
- Modify: `src/routes/application.ts` (two routes, registered beside the activities collection)
- Test: `test/integration/axis-activity-batch.test.mjs`

**Interfaces:**
- Produces:
  - `POST /application/activities/batch`, body `{ studentId: uuid, rows: activityBody[] (1–10) }`.
    - `resolveStudentId(..., "edit")`.
    - Each row runs in order through the same `capRows("activities")` check and insert the collection uses, so a row
      past the 30-row cap fails alone.
    - Answers 200 `{ results: ({ ok: true; id: string } | { ok: false; message: string })[] }` in request order.
  - `DELETE /application/activities?studentId=<uuid>&ids=<uuid>,<uuid>` (≤10 ids). It deletes only rows of that student
    and answers 200 `{ deleted: number }`.

- [ ] **Step 1: Write the failing integration tests**

```js
test("a batch saves each row and answers per row, in order", ...);            // 2 rows -> 2 ok ids, both on GET /application/sheets
test("a row past the 30-row cap fails alone; the rest still save", ...);      // 29 rows seeded, batch of 2 -> [ok, {ok:false, message:/at most 30 rows/}]
test("a batch for a student the counselor can't edit is refused whole", ...); // 403/404, nothing written
test("the batch delete removes only that student's rows", ...);               // another student's id in ids stays
test("a description is saved as sent", ...);
```

- [ ] **Step 2: Run them** with the local stack and API as AGENTS.md describes:
  `node --import tsx --test test/integration/axis-activity-batch.test.mjs`. Expected: FAIL (404s).
- [ ] **Step 3: Implement both routes.**
- [ ] **Step 4: Run them again.** Expected: PASS. Then `npm test` (the ops test "every operation's request reaches a
  registered route" still passes).
- [ ] **Step 5: Commit** `feat(application): batch add and batch delete for the Activities sheet`

---

### Task 4: Activity ops become cards; the batch op; Confirm with chosen rows

**Files:**
- Modify: `src/lib/axis/ops/types.ts` (three optional hooks), `src/lib/axis/ops/run.ts`,
  `src/lib/axis/ops/catalog/application.ts`, `src/lib/axis/ops/trash.ts`, `src/routes/axis.ts`
- Modify: `test/unit/axis-op-samples.ts` (samples for the two new ops), `AGENTS.md` (AxIS rules: the description
  exception and its sources)
- Test: `test/unit/axis-ops.test.ts` (new tests appended)

**Interfaces:**
- Produces:
  - `OpDef` gains three optional hooks:
    - `rows?: (input) => CardRow[]`: a card's row view, stored as `payload.rows` and passed to the app.
    - `select?: (input, keys: string[]) => input`: the rows Confirm keeps.
    - `confirmRows?: (input, body) => RowOutcome[]`.
    - The types: `type CardRow = { key: string; label: string; fields: Record<string, string | number | boolean | string[] | null>; sources: Record<string, string>; readAs: Record<string, string>; missing: string[]; description: { chars: number; source: string; overLimit: boolean } | null }`
      and `type RowOutcome = { key: string; ok: boolean; id?: string; message?: string }`.
  - `OperationPayload` and `StoredPayload` gain `rows?: CardRow[]`. `publicAction` passes `payload.rows` through.
  - `runWrite(ctx, name, raw, opts?: { outside?: boolean; onFiled?: (id: string) => void })`. When the write is a card
    and `reason` is still null, `opts.outside` sets `reason = "outside-content"`. It also sets the stored
    `outside` mark (the recall rule). `onFiled` gets the new card's id.
  - `confirmOperation(request, row, opts?: { keep?: string[] })`. It applies `def.select` when `keep` is given and the op has one,
    and re-validates the input. With `def.confirmRows`, it answers `rows`: all rows failed means `{ status: "failed", result: {
    ok: false, message: <first row's message>, rows } }`, otherwise `confirmed` with `rows`.
  - `POST /axis/actions/:id/confirm` accepts `rows?: string[]` (each `/^r([1-9]|10)$/`, 1–10) and answers
    `result.rows` when present. `rows` is ignored for ops without `select`.
  - Catalog changes:
    - `application.add_activity` and `application.update_activity` become `risk: "confirm"`. They gain
      `description?` (≤2000 at the route; the draft layer allows 1000) and `draft_row?` (`/^r([1-9]|10)$/`).
      `request()` never sends `draft_row`.
    - `update_activity`'s undo restores `description`.
    - Header comment and titles: descriptions are exact copies only (spec 4.4).
  - New op `application.add_activities` (confirm, `takesStudent`):
    - input `{ student_id, rows: [{ key, ...activity fields, description?, sources?: Record<string,string ≤80>, read_as?: Record<string,string ≤120> }] (1–10) }`;
    - `request()` posts the rows' fields (no `key`, `sources`, `read_as`) to `/application/activities/batch`;
    - `describe` is `Add activity "X" to {name}'s Activities sheet` for one row, otherwise `Add N activities to …`;
    - `details` gives one line per row from `activityRowLine(row)`;
    - `rows`, `select` and `confirmRows` map `results[i]` to `rows[i].key`;
    - `undo` is `application.delete_activities` with the saved ids.
  - `activityRowLine(row): string` (exported). Fields joined with ` · `, converted values as `timing break (from
    'summer')`, then `not given: …`, `sources: your message, Resume.pdf`, and the description whole in quotes with
    `(resume)` and the 150-character note. Example:
    `Code Club · Cofounder/Teacher · grades 11 · timing break (from 'summer') · 6 h/wk · 2 wk/yr · not given: category · sources: your message`.
  - New op `application.delete_activities` (confirm, DELETE, `{ student_id, activity_ids ≤10 }`), added to
    `TRASH_COVERED` (the `activities` table already has its trash rule).
  - `export { activityFields }` from `catalog/application.ts` (now with `description`).

- [ ] **Step 1: Write the failing tests**

```ts
test("adding or changing an activity always waits for Confirm", () => {
  for (const n of ["application.add_activity", "application.update_activity", "application.add_activities"]) assert.equal(riskOf(getOp(n)!, sampleInput(n)), "confirm");
});
test("a card filed with outside set says outside-content and is recalled by operation only", async () => {
  const out = await runWrite(ctx, "application.add_activities", input, { outside: true, onFiled: (id) => (filed = id) });
  assert.equal(inserted[0]!.payload.reason, "outside-content");
  assert.equal(inserted[0]!.payload.outside, true);
  assert.ok(filed);
});
test("without outside, a card in a clean turn has no reason", ...);
test("the batch card shows every row on one line each, the description whole, and a row view for the app", ...);
//   10 rows with 1000-char descriptions -> details.length 10, no line ends in "…", payload fits, payload.rows[i].key == "r{i+1}"
test("Confirm keeps only the chosen rows, and without a choice keeps all", async () => {
  // keep ["r1","r3"] of 3 -> the injected POST body has 2 rows; no keep -> 3
});
test("Confirm answers per row; a refused row doesn't stop the others; all refused is a failure", ...);
//   route answers [ok id1, {ok:false, message:"A sheet holds at most 30 rows"}] -> confirmed, rows[1].message set,
//   undo = delete_activities [id1]; both refused -> failed with the first message
test("Undo of a batch card deletes exactly the rows it saved", ...);
test("the batch op never sends draft_row, key, sources or read_as to the route", ...);
```

- [ ] **Step 2: Run** `node --import tsx --import ./test/env.ts --test test/unit/axis-ops.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the hooks, `runWrite` and `confirmOperation` options, the confirm route's `rows`, the catalog
  changes and the two new ops.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS, including the existing ops, trash and prose-guard suites. Update an
  existing test only where it asserted `add_activity` was instant, and say so in the commit.
- [ ] **Step 5: Add one integration test** to `test/integration/axis-operations.test.mjs`. It files an `add_activities`
  card, Confirms it with `{ rows: ["r2"] }`, and checks that only r2 is on the sheet and the answer carries r2's id. Run
  it. Expected: PASS.
- [ ] **Step 6: Commit** `feat(axis): activity changes wait for Confirm; one card for several activities`
- [ ] **Step 7: Checkpoint.** A fresh reviewer reads Tasks 3–4 against spec 4.4, 4.6 and 4.11 and the security code
  they touch (`run.ts`, the confirm route, `TRASH_COVERED`). Fix what it finds before Task 5.

---

### Task 5: Draft state, the clock, and the migration

**Files:**
- Create: `supabase/migrations/20261111000001_axis_activity_drafts.sql`
- Create: `src/lib/axis/clock.ts`, `src/lib/axis/drafts/state.ts`
- Modify: `src/lib/axis/nlu.ts` (`DialogueState.draft?: DraftHeader`), `src/lib/axis/memory.ts` (`stateSchema` gets
  `draft: draftHeaderSchema.optional()`)
- Test: `test/unit/axis-draft-state.test.ts`

**Interfaces:**
- Produces:
  - Migration:
    - `alter table public.ai_conversations add column if not exists draft_rows jsonb`;
    - CHECK `draft_rows is null or (jsonb_typeof = 'array' and jsonb_array_length ≤ 10 and octet_length ≤ 32000)`;
    - a header comment in the style of `20261108000004` (deploy order: the migration first, not in REQUIRED_SCHEMA,
      and the column takes the table's grants).
  - `clock.ts`:
    - `axisNow(): Date` returns real time plus an offset that is always 0 unless eval clock mode is on;
    - `advanceClock(ms: number): void` throws unless `evalClockOn()`;
    - `evalClockOn(): boolean`;
    - `evalClockRefusal(e: { AXIS_EVAL_CLOCK?: string; NODE_ENV?: string; SUPABASE_URL?: string }): string | null`.
      It refuses when the flag is on and `NODE_ENV=production`, or when the Supabase URL's host isn't `localhost`,
      `127.0.0.1` or `host.docker.internal`. That covers the production project, which is never named in code. It
      follows `translateFakeRefusal`'s shape.
  - `state.ts`:
    - Types:
      - `DraftHeader = { kind: "activity"; student_id: string; student_name: string; opened_at: string; updated_at: string; asked_at?: string; expired_at?: string; switch_to?: { student_id: string; name: string } }`
      - `DraftRow = { key: string; op: "add" | "update"; activity_id?: string; fields: Partial<Record<ActivityField, unknown>>; sources: Partial<Record<ActivityField, { label: string; outside: boolean }>>; read_as: Partial<Record<ActivityField, string>>; status: "collecting" | "card" | "saved" | "dismissed" | "skipped" | "failed"; card_id?: string; message?: string }`
      - `DraftNote = { kind: "filed" | "replaced" | "saved" | "rejected" | "missing" | "failed" | "refused-student" | "refused-unrelated" | "cancelled" | "opened" | "expired"; key?: string; field?: string; reason?: string }`
      - `Draft = { ready: boolean; header: DraftHeader | null; rows: DraftRow[]; notes: DraftNote[]; switchAccepted?: boolean }`
        (`switchAccepted` lasts one turn, never saved)
    - `anyOutside(row: DraftRow): boolean`: some value's source is `outside`.
    - Constants and the schema: `DRAFT_TTL_MS = 30 * 60 * 1000`, `MAX_DRAFT_ROWS = 10`, `draftHeaderSchema`.
    - `draftsReady(db)`: a `select draft_rows limit 0` probe cached like `flagsReady`.
    - `loadDraft(request, conversationId, header: DraftHeader | undefined): Promise<Draft>`. It reads `draft_rows` only
      when there is a header. Rows that fail their schema are dropped.
    - `saveDraft(request, conversationId, state: DialogueState, draft: Draft): Promise<boolean>`. One update of
      `{ state: { ...state, draft: header ?? undefined }, draft_rows: rows.length ? rows : null }`.
      - Before the column exists, it writes `state` without the draft and answers `false` when a row is still
        `collecting`.
      - Any error also answers `false`; it never throws.
    - `syncCards(request, draft): Promise<void>`:
      - reads `axis_actions` (status, result) for the rows' `card_id`s;
      - a confirmed card makes its rows `saved` (with `activity_id` from `result.rows`), `failed` (with the route's
        message) or `skipped` (not in `result.rows`);
      - a dismissed card makes its rows `dismissed`; a failed card makes them `failed`;
      - adds `saved` and `failed` notes.
    - `isOpen(draft): boolean`: a row is `collecting` or `card`.
    - `isStale(draft, now): boolean`: `now - updated_at > DRAFT_TTL_MS`.
    - `closeIfDone(draft): void`: no open row means header null and rows [].
    - `dismissCards(ctx: Pick<OpContext, "request" | "onOperation">, draft, ids: string[], message: string): Promise<void>`.
      It sets status `dismissed`, `result: { ok: false, message }`, `decided_at`, `.eq("status","pending")`, and
      emits each card's stored payload with status `dismissed` and that message.

- [ ] **Step 1: Write the failing tests**

```ts
test("the draft header survives the state schema and the rows their own column", ...);
test("a confirmed card saves its rows with their new ids; a dismissed one closes the draft", ...);   // Review Focus 4
test("a card confirmed with r1 only: r1 saved, r2 skipped", ...);
test("a row the route refused is failed with the route's reason", ...);
test("saving before the column exists keeps the state and reports the lost draft", ...);
test("a failed save answers false and never throws", ...);
test("dismissing cards touches only pending ones and tells the app", ...);
test("clock mode: off without the flag; refuses production, a remote project, any non-local host; on with a local stack", () => {
  assert.equal(evalClockRefusal({}), null);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "production", SUPABASE_URL: "http://127.0.0.1:54321" })!, /refusing to start/);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "https://abcdefghij.supabase.co" })!, /refusing to start/);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "https://staging.example.com" })!, /refusing to start/);
  assert.equal(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "http://127.0.0.1:54321" }), null);
  assert.throws(() => advanceClock(60_000)); // flag off in tests
});
```

- [ ] **Step 2: Run** `node --import tsx --import ./test/env.ts --test test/unit/axis-draft-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, `clock.ts`, `state.ts`, and the `nlu.ts` / `memory.ts` type and schema changes.
- [ ] **Step 4: Run it, then `npm test`.** Expected: PASS. Apply the migration to the local stack (`supabase migration up`)
  and check `\d ai_conversations` shows `draft_rows` with its CHECK.
- [ ] **Step 5: Commit** `feat(axis-drafts): draft state, its column, and an eval-only clock`

---

### Task 6: The sorter, and essay patterns for descriptions

**Files:**
- Create: `src/lib/axis/drafts/sorter.ts`
- Modify: `src/lib/axis/lexicon.ts` (essay pattern)
- Test: `test/unit/axis-draft-sorter.test.ts`, `test/unit/axis-nlu.test.ts` (essay cases appended)

**Interfaces:**
- Consumes: `hasActivityValue` (Task 1), `Draft` (Task 5), `Understanding` (nlu.ts).
- Produces:
  - `type Verdict = "cancel" | "continue" | "draft" | "unrelated"`
  - Whole-message matches, normalized and ignoring trailing punctuation, word lists from spec 4.1 (the builder may
    add phrasings in the table):
    - `isCancel(text)`: cancel, never mind, forget it, stop, drop it, don't add it/that/them, scrap it, optionally
      followed by "it", "that", "the draft", "please";
    - `isYes(text)`: yes, yeah, yep, sure, ok, okay, go ahead, start again, do it;
    - `isContinue(text)`: continue, keep going, go on, resume, back to the draft.
  - `isFileNow(text)`: contains add it, add them, that's all, that's it, that's everything, file it, save it.
  - `isCorrection(text)`: starts with actually, no, wait, make it, change, sorry, I meant.
  - `sortMessage(text, u: Pick<Understanding, "intent" | "scores">, draft: Draft): Verdict`:
    - cancel, then continue;
    - `draft` when a yes, a value (`hasActivityValue`), a draft organization or position (by `freeTextKey`, ≥3
      characters), a correction cue, `u.intent === "action"`, or a top score ≤ 1.5 (nothing scored above the
      fallback) holds;
    - otherwise `unrelated`;
    - `u.intent === "essay"` is always `unrelated`.
  - Lexicon: essay weight 8 for write, draft, rewrite, redo, compose, come up with, generate, polish, improve, reword or rephrase,
    followed within 5 words by description, descriptions or blurb. A change verb ("add the description from her
    resume") stays an action.

- [ ] **Step 1: Write the failing table test**, at least 30 rows, each `[message, verdict]` with a draft holding
  "Code Club" / "Cofounder":

```ts
const TABLE: [string, Verdict][] = [
  ["cancel", "cancel"], ["never mind", "cancel"], ["forget it", "cancel"], ["cancel her Tuesday meeting", "draft"],
  ["continue", "continue"], ["keep going", "continue"], ["yes", "draft"], ["i gave it", "draft"],
  ["Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr", "draft"], ["6 hrs a week", "draft"],
  ["she's a junior", "draft"], ["actually 8 hours", "draft"], ["make it 3 weeks", "draft"], ["code club ran at City Library", "draft"],
  ["City Library, please add it now", "draft"], ["add Debate Club for Jordan Park, 5 hrs a week", "draft"],
  ["what's her GPA?", "unrelated"], ["Is her SAT 1450 good for UCLA?", "unrelated"], ["what are her grades?", "unrelated"],
  ["when is her Common App due?", "unrelated"], ["write a description for it", "unrelated"], ["who is behind this week?", "unrelated"],
  // ...the builder fills to 30+ and tunes the rule here, never elsewhere
];
```

Add to `axis-nlu.test.ts`: "write a description for it" and "rewrite the activity description" score `essay`; "add
the description from her resume" scores `action`.

- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement** `sorter.ts` and the lexicon pattern.
- [ ] **Step 4: Run both, then `npm test`.** Expected: PASS (no existing nlu case changes intent).
- [ ] **Step 5: Commit** `feat(axis-drafts): sort each message into the draft or not; essay route for descriptions`

---

### Task 7: The draft write path, card filing, and the lines

**Files:**
- Create: `src/lib/axis/drafts/write.ts`, `src/lib/axis/drafts/lines.ts`
- Test: `test/unit/axis-draft-write.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4 and 5 (`normalizeField`, `traceValue`, `traceDescription`, `runWrite` with `opts`,
  `activityFields`, `Draft`, `dismissCards`, `MAX_DRAFT_ROWS`), `resolveStudentId`.
- Produces:
  - `ACTIVITY_OPS: ReadonlySet<string>` holds the three activity op names.
  - `type DraftTurn = { draft: Draft; verdict: Verdict | "none"; now: Date; sources: (studentId: string) => SourceSet; studentName: (id: string) => string; fileNow: boolean }`
  - `draftWrite(ctx: OpContext, turn: DraftTurn, name: string, raw: unknown): Promise<OpOutput>`, in order:
    1. `verdict === "unrelated"` gives `notRun("there's an open activity draft; ask the counselor to continue it")` and
       a `refused-unrelated` note.
    2. Resolve `student_id` (default: the chat's student) with edit access. If a draft is open for another student,
       refuse with `Not done: there's an open activity draft for {a}; don't add anything for another student. The
       counselor will be asked.` It sets `header.switch_to`, adds a `refused-student` note, and merges nothing.
    3. With no draft, open one pinned to that student (an `opened` note).
    4. For `add_activities` from the model, each row is handled as an add.
    5. Pick the row:
       - `draft_row` if given;
       - for an update, the row with the same `activity_id`;
       - for an add, the row whose organization matches by `freeTextKey`, or the only open add row when the call
         names no organization;
       - else a new row (`r{n}`). An 11th row refuses that row by name with `a draft holds 10 activities; file this
         card first`.
    6. Each field given: `normalizeField`, then the `activityFields[field]` schema (description: ≤1000, or
       `DESCRIPTION_REFUSAL` via `traceDescription`), then `traceValue`. A failure is a `rejected` note with the field
       and its plain reason (`IMAGE_ONLY_HINT` appended when `hasTranscriptsOnly()`), and the field isn't merged. A pass
       merges value, source and `read_as`.
    7. A merge into a row whose card is pending sets that row back to `collecting` (the card is replaced in
       `fileIfReady`).
    8. An update row with at least one field is filed at once as its own `application.update_activity` card through
       `runWrite(ctx, …, { outside: ctx.turn.tainted || anyOutside(row), onFiled })`.
    9. `fileIfReady(ctx, turn, turn.fileNow)`.
    10. Answer the model in plain lines: `Kept in draft row r1: organization, position.`, one `Not kept: {field}: {reason}` per
        rejection, `Still missing: … Ask the counselor once, in one message, for just these.` or `Filed as one card (rows r1, r2).`,
        and always `Don't say whether anything was saved, tried or needs Confirm; status lines written by the server follow your answer.`
  - `fileIfReady(ctx: OpContext, turn: DraftTurn, force: boolean): Promise<void>`. It acts when every open add row has
    an organization, and either none is missing position, grades, timing, hours or weeks, or `force` is true, or
    `header.asked_at` was set before this turn. Then:
    - dismiss any pending add card of the draft with `Replaced by an updated card.` (a `replaced` note);
    - file one `application.add_activities` card with every open add row through `runWrite(ctx, …, { outside:
      ctx.turn.tainted || rows.some(anyOutside), onFiled })`;
    - set those rows to `card` with `card_id` (a `filed` note);
    - a refused filing (payload too large, prose) is a `failed` note with its reason, and the rows stay `collecting`.
  - `lines.ts`:
    - `LINES`: the fixed copy from Global Constraints, as functions of names.
    - `draftBlock(draft: Draft): string`. Goes in the user turn and is wrapped with `wrapUntrusted("draft", …)`. It
      holds:
      - the student's name, and each row's key, op, values with their sources, missing fields and status;
      - descriptions as `description: 312 characters, from resume`, never their text;
      - the line "Call perform_action application.add_activity (update_activity for a saved row) with draft_row
        whenever the counselor gives or corrects a value, even partial. Use the counselor's own words; never fill a
        field they didn't give. Don't say whether anything was saved, tried or needs Confirm, and don't describe
        earlier attempts.";
      - when `switchAccepted`, a line that the counselor agreed to start a draft for {b} from their message before
        this one.
    - `statusLines(draft: Draft): string[]`, from the notes and row state:
      - Waiting: one line naming every row on the pending card;
      - Saved: per `saved` note;
      - Couldn't save: per rejection, using the row's organization or else `the new activity`;
      - Still need: per open row with missing fields and no card;
      - plus the switch question, and `saveFailed` when told.
    - `continueReply(draft: Draft): string`: the status lines, then `Send what's missing, or say "add it" to file it
      with blanks.`
    - `outcomeCodes(draft: Draft): string[]`: `filed`, `replaced`, `saved`, `rejected:hours_per_week`,
      `refused:other-student`, `refused:unrelated`. Field names only.

- [ ] **Step 1: Write the failing tests** (`runWrite` real, over the ops test's fake request; sources from a stub)

```ts
test("a partial add opens a draft, keeps what passes, and asks once for the rest", ...);
//   org+position typed -> row r1 collecting, notes [opened], model text has "Still missing: grade_levels, timing, hours_per_week, weeks_per_year"
test("the transcript's detail line completes the row and files one card", ...);
//   grade 11 (number), "summer", "6hr week", "2 week/yr" -> card filed, reason null, row r1 status card
test("a value the counselor never wrote is refused by name and the rest is kept", ...);          // "Host, library workshop"
test("200 hours a week is refused in plain words; no raw zod reaches the model or the lines", ...);
test("after asking once, the next draft turn files with blanks", ...);
test("a correction while the card waits replaces it, with every row", ...);                     // old dismissed "Replaced by an updated card.", new card pending
test("two activities in one go make one card with two rows", ...);
test("an eleventh activity is refused by name; the first ten stay", ...);                         // Review Focus 5
test("an update of a saved row is its own card, checking only the changed fields", ...);
test("an add for another student while a draft is open files nothing and merges nothing", ...);
test("in an unrelated turn activity ops are refused", ...);
test("a resume-sourced value or description flags the card outside-content, even read three messages earlier", ...);
//   source from a document traced in an earlier turn's row; this turn clean (tainted false) -> reason "outside-content"
test("a typed or meeting-note value doesn't flag the card", ...);
test("a description: exact copy saved and shown whole; an edited one refused with the fixed sentence", ...);
test("status lines are code-written and use the fixed copy", ...);                               // snapshot each LINES entry once
test("the draft block lists descriptions by length and source, never their text", ...);
```

- [ ] **Step 2: Run** `node --import tsx --import ./test/env.ts --test test/unit/axis-draft-write.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `write.ts` and `lines.ts`.
- [ ] **Step 4: Run it, then `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(axis-drafts): draft writes, one card per draft, code-written status lines`

---

### Task 8: The engine runs the draft

**Files:**
- Modify: `src/lib/axis/engine.ts`, `src/lib/axis/tools.ts` (`ToolContext.draft?: DraftTurn`; `perform_action`
  hands `ACTIVITY_OPS` to `draftWrite`), `src/lib/axis/profiles.ts` ("Making changes" lines)
- Test: `test/unit/axis-draft-engine.test.ts` (with `scriptedApi` tool calls; extend `test/unit/axis-fakes.ts` with
  `insert` and the tables below)

**Interfaces:**
- Consumes: Tasks 5–7, `axisNow` (Task 5).
- Produces (inside `axisTurn`):
  1. `now = axisNow()` feeds `understand` and `nextState`. After `loadHistory`, `loadDraft`, `syncCards`, then the
     verdict:
     - **Switch pending:** a yes cancels the old draft (cards dismissed with `Dropped with the activity draft.`) and
       opens an empty draft for `switch_to` with `switchAccepted`, verdict `draft`. Anything else clears `switch_to`
       and goes on.
     - **Expired header:** a yes within `DRAFT_TTL_MS` of `expired_at` reopens the draft (fields kept), verdict
       `draft`. Anything else clears the draft, verdict `none`.
     - **Open and stale:** with a `collecting` row, set `expired_at = now`, prefix the expiry line, verdict `none`.
       With only cards, close it and leave the cards valid, with no line.
     - **Open:** `sortMessage`. **No draft:** `none`.
     - Then `updated_at = now` on any surviving draft.
  2. **cancel:** `dismissCards`, clear the draft, and reply `LINES.cancelled(name)` on the direct path (frame
     `activity-draft`), with no model call. **continue:** `fileIfReady(force false)`, then reply `continueReply`, with
     no model call.
  3. **Essay intent:** the essay route as today, plus the reminder when a draft is open.
  4. **draft:** skip step 3 (direct), `tasks = null`, mode `action` (Clerk). The planner gets the understanding with
     `colleges` and `ambiguousColleges` emptied unless an attribute in `COLLEGE_ATTRIBUTES` is present (spec 4.8).
     `draftBlock` goes in `userParts` just before `content`. If a row's value came from a file or document,
     `markShort(toolCtx.turn)`.
  5. **unrelated:** runs as today, and its final text gets `LINES.reminder(name)`. **none:** runs as today. An activity
     op opens a draft through `draftWrite`.
  6. After `runLoop`, for `draft` turns: `fileIfReady(force = asked_at set before this turn || isFileNow(content))`. If
     open rows still miss fields with no card, set `asked_at = now`.
  7. On every path:
     - `closeIfDone`;
     - compute the final `state` (`draft: header`) and `saveDraft` **before returning** (so before `done`);
     - render `statusLines` (with `saveFailed` when the save answered false) and append them as one `delta`
       (`\n\n` + lines), before the citation and quote checks run on the final text.
  8. One log line per turn: `request.log.info({ axis: { path, intent, draft, outcomes, calls, maxCalls, conversationId, ms } }, "axis turn")`.
     - `draft` is one of `none`, `opened`, `continued`, `unrelated`, `expired`, `closed:saved`, `closed:cancelled` or `closed:timeout`.
     - This replaces today's direct-only line.
  9. `AXIS_SYSTEM` "Making changes":
     - replace the "fix the input once …" line with: when an action's error says how to fix it, fix it and call again
       in the same turn; never ask the counselor's permission to retry;
     - add: for activities, call the action right away with what the counselor gave, even partial, rather than
       asking first.

- [ ] **Step 1: Write the failing tests**

```ts
test("a detail-only reply mid-draft skips the direct answer and runs as the Clerk with the draft block", ...);
//   route event path "agent", mode "action"; scripted call 1's last user message contains "Activity draft for"
test("an unrelated question mid-draft is answered as usual, then the reminder; the draft is unchanged", ...);
test("an essay request mid-draft stays on the essay route and leaves the draft and card alone", ...);
test("cancel drops the draft and its pending card with no model call", ...);
test("continue shows what's missing with no model call", ...);
test("after 30 minutes the reply starts with the expiry line; yes on the next message restores the fields", ...);
test("after 30 minutes with only a card left: no line, the card still confirmable", ...);
test("the panel switched to another student: the add is refused, the switch question asked, nothing filed", ...); // Review Focus 3
test("yes to the switch drops the old draft and opens one for the new student", ...);
test("the draft is saved before the turn returns, and a failed save says so", ...);
test("the draft survives nextState and the state schema across turns", ...);
test("status lines follow the model's text and come from code", ...);
test("a college matched by a fragment isn't fetched while drafting", ...);                       // "City Library" with a "City" college in the index
test("every path logs one axis turn line with no text, values, names or student ids", ...);       // scan the logged object
// Plus spec 4.10's 18 conversations replayed with scripted model turns, one test each (`drafts-NN` ids), asserting
// the cards, draft state and lines up to the card; the Confirm step itself is Task 4's.
```

- [ ] **Step 2: Run** `node --import tsx --import ./test/env.ts --test test/unit/axis-draft-engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the engine, tools and profile changes.
- [ ] **Step 4: Run it, then `npm test`.** Expected: PASS, with `test/unit/axis-engine.test.ts` unchanged.
- [ ] **Step 5: Commit** `feat(axis): the engine runs activity drafts`
- [ ] **Step 6: Checkpoint.** A fresh reviewer reads Tasks 5–8 against spec 4.1, 4.3, 4.7, 4.8, 4.9 and 4.11 and the
  Review Focus. Fix what it finds before Task 9.

---

### Task 9: Eval cases on the shared runner

**Files:**
- Create: `evals/axis/cases-drafts.mjs`, `evals/axis/fixtures/resume-activities.txt` (made-up student),
  `src/routes/axisEval.ts`
- Modify: `evals/axis/run.mjs`, `evals/axis/score.mjs`, `evals/axis/README.md`, `src/index.ts` (boot refusal),
  `src/app.ts` (register `axisEval` only when `evalClockOn()`), `src/env.ts` (`AXIS_EVAL_CLOCK: blankIsUnset(z.enum(["on"]).optional())`),
  `.github/workflows/axis-evals.yml` (API env `AXIS_EVAL_CLOCK: "on"`, `timeout-minutes: 90`)
- Test: `test/unit/axis-eval-score.test.ts`, `test/unit/axis-evals-workflow.test.ts`, `test/unit/axis-eval-clock.test.ts`

**Interfaces:**
- Produces:
  - `POST /axis/eval/clock { minutes: number (1–1440) }`, behind `Authorization: Bearer $CRON_SECRET` (the
    constant-time check `routes/internal.ts` uses). It calls `advanceClock` and answers `{ now }`. It isn't
    registered unless `AXIS_EVAL_CLOCK=on`.
  - `index.ts`: `evalClockRefusal({ AXIS_EVAL_CLOCK, NODE_ENV: process.env.NODE_ENV, SUPABASE_URL })` exits 1 with
    the message, like the research and translate guards.
  - The runner (backward compatible; the security cases are untouched):
    - A case may have `steps` instead of `turns`. A step is `{ say: string }`, `{ confirm: "last", rows?: string[] }`,
      `{ dismiss: "last" }`, `{ undo: "last" }` or `{ advanceClock: minutes }`.
    - `"last"` is the newest pending (or, for undo, confirmed) card in the chat.
    - Each `say` reply is parsed into text (the `delta` events) and kept on `ctx.replies`.
    - A case may set `rule: "2of3"`: run once, and on a failure run twice more. It passes with 2 of 3, and any
      failure makes it `flaky`.
    - `check` may return `{ gated, resisted: null, flaky?, scored?: Record<string, number> }`.
  - `score.mjs`: `compareScores` skips cases whose `resisted` is null. The score line stores `flaky` and `scored` per
    case.
  - `cases-drafts.mjs`: the 18 cases of spec 4.10, ids `drafts-01-one-message` … `drafts-18-switch-student`.
    - Fixtures are "Avery Lee" (Student A) and "Jordan Park" (Student B), made up.
    - Every case is `rule: "2of3"`.
    - Every case's hard checks are code-only:
      - the Activities rows per student, field by field, as an exact set;
      - the `axis_actions` op, status and reason;
      - the draft state from `ai_conversations`;
      - fixed lines the replies must include;
      - and in every case, replies never contain `Invalid input`, `Expected`, `ZodError` or a zod path.
    - Scored values are `questionsAsked` (sentences ending in `?`, the fixed lines excluded) and
      `counselorMessages` (says until the card is filed). Case targets are from spec 4.10 (cases 1, 2 and 15
      especially).
    - Case 13 is: say "Add Code Club for Avery, cofounder", then `advanceClock 31`, then say "what's her GPA?" (the
      reply starts with the expiry line), then say "yes" (the draft holds Code Club / cofounder, `collecting`).
    - Case 16 seeds the resume fixture as a confirmed `resume` document. Its card's `reason` is `outside-content` and
      its descriptions are exact copies.
    - Case 18 checks that Avery's sheet is unchanged and her card is dismissed, and that Jordan's draft holds Debate Club.
  - `run.mjs` loads `CASES` from both files.

- [ ] **Step 1: Write the failing unit tests**

```ts
test("a case with resisted null is never a resistance drop; a gated failure still is", ...);
test("2 of 3 passes and is marked flaky; 1 of 3 fails", ...);                 // a pure helper in run.mjs, exported for the test
test("the clock route exists only in clock mode and needs the cron secret", ...);
test("the workflow starts the API in clock mode and allows 90 minutes", ...); // added to axis-evals-workflow.test.ts
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the route, the boot guard, the env and workflow changes, the runner and score changes, and
  the 18 cases and fixture. Update `README.md` (the two suites, their pass rules, the clock, the cost: about $5 for a full
  run on Haiku 5.5).
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Run the drafts suite once locally**, only if a local `ANTHROPIC_API_KEY` is already configured
  (never ask Elvin for it). Use the API started with `AXIS_EVAL_CLOCK=on`:
  `npm run eval:axis -- --case drafts-01-one-message --runs 1`, then the whole suite. Fix product code for hard-check
  failures. If case 2 fails because the model asks for details without calling the op, add spec 4.1's opener:
  action intent plus "activity/activities" plus a student in context opens an empty draft, with a test in Task 8's
  file. Without a key, say so in the PR; Elvin runs the workflow by hand.
- [ ] **Step 6: Commit** `test(axis-evals): activity draft cases, click steps and an eval-only clock`

---

## After the last task

- [ ] Whole-branch review by a fresh reviewer against the spec, this plan's "Changed since the design" and Review
  Focus. Fix what it finds.
- [ ] `npm test` and `npm run typecheck` pass. Run the integration suite locally and paste the commands and output
  into the PR.
- [ ] Re-check the newest migration on `origin/main`. Rename `20261111000001` if anything newer landed.
- [ ] Open the backend PR. Its description includes Elvin's steps:
  1. In plain Terminal, on `main` of meridies-backend, after `git pull`, run `supabase db push --dry-run`.
  2. You should see only `20261111000001_axis_activity_drafts.sql` listed.
  3. Run `supabase db push`, and answer `Y`.
  4. Merge the PR.
  5. Optionally run **Actions → AxIS evals → Run workflow** on main and check that the drafts suite is green.
- [ ] Not in this plan: the app PR (bcha). It covers checkbox rows sending `rows` on Confirm, the Save & edit button
  (it confirms, then opens the sheet with `result.rows[].id` highlighted), live `dismissed` card updates with their
  `message`, and per-value source labels from `payload.rows`. Its contract is Task 4's interfaces. It gets its own
  short plan once this merges.
