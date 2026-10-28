# Google Connector (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google connects with picked files only (`drive.file` + Picker), Calendar is asked for only when turned on, picked files arrive unconfirmed and out of AI with a server-side type guess, one batch confirm unlocks them, and confirmed files get their text extracted (PDFs in a capped worker thread, queued two at a time).

**Architecture:** Two PRs in `meridies-backend`. **PR 0** is the migration alone (`documents.kind_confirmed`, `kind_guess`, `extraction_requested_at`), merged and applied to production first. **PR 1** is the code: OAuth scope rules in `lib/oauth.ts`, the `drive.file` switch in `lib/suiteApi.ts` / `lib/supplementDocs.ts`, a pure type guesser (`lib/documentGuess.ts`), a PDF text extractor in worker threads (`lib/pdfText*.ts`), a durable in-process extraction queue (`lib/documentExtraction.ts`), the confirm and status routes in `routes/files.ts`, `picker-config` and import changes in `routes/integrations.ts`, and one AI-readability rule for every document reader (`lib/context/documentAi.ts`).

**Tech Stack:** Fastify 5, TypeScript strict / ESM, Zod, Supabase Postgres (RLS, plpgsql), `unpdf` 1.8.1 (PDF.js 6.1.200), Node `worker_threads`, `node:test` unit tests, `.mjs` persona integration tests.

**Spec:** `docs/superpowers/specs/2026-10-14-google-connector-design.md` (rev 5, approved 10/15, PR #55), plus Elvin's addition of 10/15: **extractions beyond the two running at once wait in a queue, and the UI shows progress ("Reading 3 of 10…") instead of timing out.** The app half is `docs/superpowers/plans/2026-10-15-google-connector-app.md`. The spec wins on any disagreement except the three deviations listed at the end of Global Constraints; if anything else disagrees, stop and ask.

## Global Constraints

- Repo `meridies-backend`. **Open PRs only; never merge; never touch production yourself; never `supabase db push`.** Elvin merges backend PRs.
- **PR 0** branch `feat/documents-kind-confirmation` from `origin/main`: the migration `supabase/migrations/20261024000001_documents_kind_confirmation.sql` and its integration test, nothing else. It merges first; `.github/workflows/migrations.yml` plans and (after approval) applies it; production is verified before PR 1 merges (Task 13).
- **PR 1** branch `feat/google-connector` from `origin/main` after PR 0 merged (develop on top of the PR 0 branch until then and rebase).
- Google scopes: Connect = exactly `openid`, `email`, `https://www.googleapis.com/auth/drive.file`; `?add=calendar` adds exactly `https://www.googleapis.com/auth/calendar.events`. Allowed back from Google: those plus `https://www.googleapis.com/auth/userinfo.email`. `drive.readonly` and `gmail.send` are removed. Microsoft scopes unchanged in this plan.
- Error codes (on `HttpError.code`): `google_disconnected`, `google_reconnect`, `google_other_account`, `drive_not_granted`, `calendar_not_enabled`, `picked_file_unavailable`; Microsoft equivalents `microsoft_disconnected`, `microsoft_reconnect`.
- `GOOGLE_PICKER_MAX_FILES` default 10, allowed 1–50. New env: `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`, `GOOGLE_PICKER_MAX_FILES`.
- PDF extraction: `unpdf` pinned **exactly `1.8.1`** (bundled PDF.js **6.1.200**, must be ≥ 4.2.67, CVE-2024-4367); every `getDocument` call passes `isEvalSupported: false` and `enableScripting: false`; runs in a `worker_threads` Worker with `resourceLimits` `maxOldGenerationSizeMb: 256`, `maxYoungGenerationSizeMb: 32`; **10 s enforced by `worker.terminate()`**; 25 MB input (refused before the worker), 50 pages, 200,000 characters; **at most 2 extractions at once, the rest wait in a FIFO queue** (type-guess extraction at import jumps the queue and gives up after 5 s waiting).
- Type guess: never calls a model; text for the guess is the first 3 pages / 20,000 characters, used only inside `guessKind`, never stored or logged; `kind_guess` stores `{ kind, basis, matched, textFound, keepOut }`; financial and iep-504 guesses carry `keepOut: true`; a guess whose `basis` isn't `text` (or `textFound: false`) shows "Please check" in the app.
- **No backfill.** Extraction runs only for confirmations made after this ships (`extraction_requested_at` is set only by them). The migration touches no rows. The opt-in backfill script is documented in AGENTS.md as later work, not built.
- `confirm-types`: 1–50 items, strict, per-item results, a refused item never stops the others.
- **Elvin's additions (10/15, after plan approval):**
  - One shared constant `SENSITIVE_DOCUMENT_KINDS` (financial, iep-504, counselor-only, recommendation-letter, award-letter) used by the context layer (`documentAiDecision`), the tracker and submission review (`documentReadableForTask` / `refusalFor`); a test proves all three refuse each sensitive kind.
  - "No text" (a scan) stays distinct from "failed" in the API (`empty` vs `failed`) and in the app ("This PDF is a scan" vs "Couldn't read this file" + Try again). `POST /files/documents/extraction-retry` re-queues failed ones.
  - **Queue lease:** a claim sets `extraction_lease_until = now() + 2 minutes` and increments `extraction_attempts`; recovery (every minute) returns an expired lease to the queue, and after **3 attempts** marks the item `failed` (`parse_error = 'gave-up'`). Every item reaches a final state, so the app's polling always ends.
  - Until the Railway variables are set, `picker-config` answers 503 `picker_not_configured`, and `/integrations/providers` reports `pickerReady: false` so the app hides the Drive button or says "Google Drive isn't set up yet."
  - Removing the unused app component `StudentFiles` is later cleanup, not this work.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- TypeScript strict, no `any`, `.js` import suffixes, Zod `.strict()` bodies, thin routes, every `err` logged through `serializeErr`.
- **Deviations from the spec text, decided in this plan (tell Elvin in the PR):**
  1. The tracker and submission review apply `documentReadableForTask` (unconfirmed, keep-out, waived letter, practice setting, `ai_access = 'excluded'`, and the sensitive kinds financial / iep-504 / counselor-only / recommendation-letter / award-letter are out; everything else in), not the context layer's full `documentAiDecision`. The full rule would stop the tracker reading essays and every existing confirmed `other` file (out by kind default), a regression. Unconfirmed files are still refused on every path, which is what the spec's success criterion 4 asks.
  2. Text after confirming is read from Meridies' stored copy for every type (PDF incl. Docs/Slides stored as PDF, .docx/.txt/.md, .xlsx via the vetted `parseSpreadsheet`), not from Drive's export. Same result, no Google call, and it still works after a disconnect.
  3. "Scanned PDF" is `parse_status = 'skipped'` with `parse_error = 'no-text'` (the column's CHECK has no `empty`); the status route reports it as `empty`.

### Running things locally (every task)

```bash
cd "/Users/elvinojuan/Meridies AI/meridies-backend-gconn-impl"   # the worktree for the branch
npm ci
supabase start
supabase db reset
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)=' | tr -d '"' \
  | sed -e 's/^API_URL=/export SUPABASE_URL=/' -e 's/^ANON_KEY=/export SUPABASE_ANON_KEY=/' \
        -e 's/^SERVICE_ROLE_KEY=/export SUPABASE_SERVICE_ROLE_KEY=/' -e 's/^DB_URL=/export DB_URL=/')"
psql "$DB_URL" -qc "alter role import_worker login password 'local-import-worker-pw'"
export IMPORT_DATABASE_URL="postgresql://import_worker:local-import-worker-pw@127.0.0.1:54322/postgres"
PORT=4100 NODE_ENV=development CRON_SECRET=ci-cron-secret-0123456789abcdef0123456789 RESEARCH_FAKE=fixture \
  RESEND_WEBHOOK_SECRET=whsec_dGVzdC1yZXNlbmQtc2VjcmV0LWZvci1sb2NhbC10ZXN0cw== PUBLIC_API_URL=http://127.0.0.1:4100 \
  TWILIO_AUTH_TOKEN=local-twilio-test-token-123 npx tsx src/index.ts > /tmp/gconn-api.log 2>&1 &
npm test                                  # unit
API_URL=http://127.0.0.1:4100 CRON_SECRET=ci-cron-secret-0123456789abcdef0123456789 node test/integration/<file>.test.mjs
npm run typecheck && npm run build
```

The persona harness is `test/integration/harness.mjs` (`user`, `call`, `rest`, `sql`, `check`); `studentOf` is in `test/integration/imports-helpers.mjs`. Google itself can't be reached from tests: everything that talks to Google is either a pure function under unit test or checked by hand in `scripts/smoke/google-picker.md` (Task 12).

## Review Focus

1. **The server restarts (deploy, crash) while confirmed files are queued or mid-extraction.** A counselor expects the progress to finish, not to hang at "Reading 3 of 10…" forever. → Task 8: recovery re-queues `pending` rows with `extraction_requested_at`, returns expired 2-minute leases to the queue, and marks an item failed after 3 attempts; tests `a crashed in-progress item is retried after its lease expires`, `after 3 attempts the item is marked failed`.
2. **The counselor ticks "Keep out of AI" (or changes the type) while that file's extraction is still queued.** They expect no text to be stored for it. → Task 8: the write is conditional on `available_to_llm = true and kind_confirmed = true`; test `a file kept out after it was queued gets no text`.
3. **A 300-page scanned PDF of 24 MB.** The counselor expects it to be accepted, to read as "no readable text", and the API to stay responsive. → Task 6 (page cap, worker) and Task 8: test `a PDF with no text layer ends skipped/no-text, reported as empty`.
4. **A firm counselor batch-confirms a list in which one file belongs to a student they can no longer edit** (the student was transferred). They expect the others to be confirmed and that one refused with a reason. → Task 10: test `a refused item doesn't stop the rest`.
5. **A non-English or oddly named file ("Relevé de notes – 2026.pdf", "IMG_2041.HEIC", a 0-byte file).** The counselor expects an unknown guess with "Please check", never an error that fails the import. → Task 7: test rows for accents, image names and empty text; Task 9: an image import stores a filename-only guess.

---

# PR 0 — Migration (`feat/documents-kind-confirmation`)

### Task 1: `documents` kind confirmation columns

**Files:**
- Create: `supabase/migrations/20261024000001_documents_kind_confirmation.sql`
- Create: `test/integration/documents-kind-confirmation.test.mjs`
- Modify: `.github/workflows/ci.yml` only if integration tests are listed one by one there (check: `grep -n "test:integration\|\.test\.mjs" .github/workflows/ci.yml`; `npm run test:integration` runs the whole folder, so normally nothing to do)

**Interfaces:**
- Produces (columns, for PR 1): `documents.kind_confirmed boolean not null default true`, `documents.kind_guess jsonb null` (object or null), `documents.extraction_requested_at timestamptz null`, `documents.extraction_attempts smallint not null default 0` (check 0–10), `documents.extraction_lease_until timestamptz null`; partial indexes `documents_unconfirmed_idx (student_id) where kind_confirmed = false`, `documents_extraction_requested_idx (extraction_requested_at) where extraction_requested_at is not null`; `private.documents_guard_student_restricted()` refuses a student's write of any of the five.

- [ ] **Step 1: Write the failing integration test**

```js
// test/integration/documents-kind-confirmation.test.mjs
// PR 0: documents.kind_confirmed / kind_guess / extraction_requested_at (20261024000001).
import { check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("kind-confirm");
const s = await studentOf(c, "kind-confirm-student");

const cols = await sql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by column_name)
  from information_schema.columns where table_schema = 'public' and table_name = 'documents'
  and column_name in ('kind_confirmed', 'kind_guess', 'extraction_requested_at', 'extraction_attempts', 'extraction_lease_until')`);
check("kind_confirmed is boolean, not null, default true", cols.includes("kind_confirmed:boolean:NO:true"), cols);
check("extraction_attempts is smallint, not null, default 0", cols.includes("extraction_attempts:smallint:NO:0"), cols);
check("extraction_lease_until is a nullable timestamp", cols.includes("extraction_lease_until:timestamp with time zone:YES:"), cols);
check("kind_guess is nullable jsonb", cols.includes("kind_guess:jsonb:YES:"), cols);
check("extraction_requested_at is a nullable timestamp", cols.includes("extraction_requested_at:timestamp with time zone:YES:"), cols);

const id = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind)
  values ('${s.id}', '${c.id}', 'x/kc-${Date.now()}', 'old.pdf', 'other') returning id) select id from d`);
check("an existing-style insert counts as confirmed", (await sql(`select kind_confirmed::text from public.documents where id = '${id}'`)) === "true");

let refused = false;
try { await sql(`update public.documents set kind_guess = '"text"'::jsonb where id = '${id}'`); } catch { refused = true; }
check("kind_guess must be an object", refused);

await sql(`update public.documents set kind_confirmed = false, kind_guess = '{"kind":"transcript","basis":"filename","matched":"transcript","textFound":false,"keepOut":false}' where id = '${id}'`);
check("the counselor side can mark a file unconfirmed with a guess",
  (await sql(`select kind_confirmed::text || ':' || (kind_guess->>'kind') from public.documents where id = '${id}'`)) === "false:transcript");

const idx = await sql(`select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename = 'documents'
  and indexname in ('documents_unconfirmed_idx', 'documents_extraction_requested_idx')`);
check("both partial indexes exist", idx === "documents_extraction_requested_idx,documents_unconfirmed_idx", idx);

// A student can't set any of the three, on insert or update.
const insert = await rest(s.token, "POST", "/rest/v1/documents", {
  student_id: s.id, owner_id: s.id, storage_path: `${s.id}/kc-${Date.now()}.pdf`, filename: "mine.pdf", kind: "other", kind_confirmed: false,
}, { Prefer: "return=representation" });
check("a student can't insert an unconfirmed document", insert.status >= 400, `status ${insert.status}`);
const own = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind)
  values ('${s.id}', '${s.id}', '${s.id}/kc-own-${Date.now()}.pdf', 'own.pdf', 'other') returning id) select id from d`);
const patch = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { extraction_requested_at: new Date().toISOString() });
check("a student can't request an extraction", patch.status >= 400, `status ${patch.status}`);
const patch2 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { kind_guess: { kind: "transcript" } });
check("a student can't write a guess", patch2.status >= 400, `status ${patch2.status}`);
const patch4 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { extraction_attempts: 0, extraction_lease_until: null });
check("a student can't touch the queue lease", patch4.status >= 400, `status ${patch4.status}`);
let badAttempts = false;
try { await sql(`update public.documents set extraction_attempts = 11 where id = '${id}'`); } catch { badAttempts = true; }
check("attempts are bounded", badAttempts);
const patch3 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { title: "renamed" });
check("a student can still rename their own file", patch3.status < 300, `status ${patch3.status}`);
```

- [ ] **Step 2: Run it to verify it fails**

Run (local stack up, API running, see "Running things locally"): `API_URL=http://127.0.0.1:4100 node test/integration/documents-kind-confirmation.test.mjs`
Expected: FAIL at "kind_confirmed is boolean…" (columns don't exist).

- [ ] **Step 3: Write the migration**

```sql
-- documents_kind_confirmation: a document's type can be unconfirmed (Drive picks) with the server's guess, and a confirmation can ask for its text. Additive; no rows change.
--
-- kind_confirmed: false only for a Google import that named no kind (lib/documentGuess.ts guessed one).
--   Every existing row counts as confirmed (default true), so nothing that works today changes.
-- kind_guess: { kind, basis, matched, textFound, keepOut }; never document text.
-- extraction_requested_at: set by a confirmation; the in-process queue (lib/documentExtraction.ts)
--   reads text from the stored copy and clears it. Old rows stay null: there is no backfill.
-- extraction_attempts / extraction_lease_until: a claim holds a 2-minute lease; recovery returns an
--   expired lease to the queue and gives up after 3 attempts (parse_status 'failed').

alter table public.documents
  add column if not exists kind_confirmed boolean not null default true,
  add column if not exists kind_guess jsonb,
  add column if not exists extraction_requested_at timestamptz,
  add column if not exists extraction_attempts smallint not null default 0,
  add column if not exists extraction_lease_until timestamptz;

alter table public.documents drop constraint if exists documents_extraction_attempts_range;
alter table public.documents add constraint documents_extraction_attempts_range
  check (extraction_attempts between 0 and 10);

alter table public.documents drop constraint if exists documents_kind_guess_object;
alter table public.documents add constraint documents_kind_guess_object
  check (kind_guess is null or jsonb_typeof(kind_guess) = 'object');

create index if not exists documents_unconfirmed_idx
  on public.documents (student_id) where kind_confirmed = false;
create index if not exists documents_extraction_requested_idx
  on public.documents (extraction_requested_at) where extraction_requested_at is not null;

-- The student guard (20261016000001) gains the five columns: they are the counselor side's.
create or replace function private.documents_guard_student_restricted()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  if coalesce(private.user_role(v_uid), '') <> 'student' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.ai_access is distinct from 'default' or new.ferpa_waived is distinct from false then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
    if new.kind_confirmed is distinct from true or new.kind_guess is not null or new.extraction_requested_at is not null
       or new.extraction_attempts is distinct from 0 or new.extraction_lease_until is not null then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
  else
    if new.ai_access is distinct from old.ai_access or new.ferpa_waived is distinct from old.ferpa_waived then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
    if new.kind_confirmed is distinct from old.kind_confirmed
       or new.kind_guess is distinct from old.kind_guess
       or new.extraction_requested_at is distinct from old.extraction_requested_at
       or new.extraction_attempts is distinct from old.extraction_attempts
       or new.extraction_lease_until is distinct from old.extraction_lease_until then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
  end if;

  if new.kind in ('recommendation-letter', 'iep-504', 'counselor-only')
     and new.owner_id is distinct from v_uid
     and (tg_op = 'INSERT' or new.kind is distinct from old.kind) then
    raise exception 'Only your counselor can file a document under that kind' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.documents_guard_student_restricted() from public, anon, authenticated;
```

(The trigger `documents_guard_student_restricted` already points at this function; `create or replace` keeps it.)

- [ ] **Step 4: Apply locally and run the test**

Run: `supabase migration up --local && API_URL=http://127.0.0.1:4100 node test/integration/documents-kind-confirmation.test.mjs`
Expected: every line `ok`. Then `supabase db reset` (replays all migrations) and run the existing `node test/integration/context-documents.test.mjs` to confirm the guard still behaves for the old cases. Expected: all `ok`.

- [ ] **Step 5: Commit and open PR 0**

```bash
git add supabase/migrations/20261024000001_documents_kind_confirmation.sql test/integration/documents-kind-confirmation.test.mjs
git commit -m "Migration: documents.kind_confirmed, kind_guess, extraction queue columns

Additive and safe for the code that is live: every existing row counts as
confirmed, nothing reads the new columns yet. The student guard refuses a
student's write of any of the three.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/documents-kind-confirmation
gh pr create --repo MeridiesAI/meridies-backend --base main \
  --title "Migration: document type confirmation columns (Google connector, step 0)" \
  --body "Step 0 of the Google connector (spec PR #55, §9.0): the migration alone, so it is on production before the code PR merges.

- \`documents.kind_confirmed\` (default true: every existing row is confirmed), \`kind_guess\` (jsonb object), \`extraction_requested_at\`, \`extraction_attempts\` (0–10), \`extraction_lease_until\`; two partial indexes; the student guard refuses a student's write of any of them.
- **Safe before and after the code:** nothing live reads these columns. No rows change.
- After merge: the Apply migrations workflow plans it; an approver applies it. Then verify (plan Task 13) before PR 1 merges.

Tests: \`test/integration/documents-kind-confirmation.test.mjs\`; \`context-documents.test.mjs\` still passes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

# PR 1 — Code (`feat/google-connector`)

### Task 2: One readability rule, and unconfirmed files are "not categorized" everywhere

**Files:**
- Modify: `src/lib/context/documentAi.ts`
- Modify: `src/lib/context/ai-allowlist.ts` (documents gains `kind_confirmed`)
- Modify: `src/lib/context/sections.ts:280-337` (documents loader selects and passes `kind_confirmed`)
- Modify: `src/lib/axis/guard.ts` (`DocRow` and its select gain `kind_confirmed`)
- Modify: `src/lib/schemaCheck.ts` (`REQUIRED_SCHEMA.documents = ["kind_confirmed"]`)
- Test: `test/unit/document-ai.test.ts` (new); `test/unit/schema-check.test.ts` and `test/unit/context-loaders.test.ts` (update fixtures that build document rows)

**Interfaces:**
- Produces:
  - `type AiDoc = { kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean; kind_confirmed: boolean }`
  - `documentAiDecision(doc: AiDoc, practiceReadsDocuments: boolean): { allowed: boolean; reason: DocumentAiReason }` (first rule: `!kind_confirmed` → `not-categorized`)
  - `toAiDoc(row: Record<string, unknown>): AiDoc` (missing `kind_confirmed` reads as `true`; missing `available_to_llm` as `true`, matching today's `!== false`)
  - `SENSITIVE_DOCUMENT_KINDS = ["financial", "iep-504", "counselor-only", "recommendation-letter", "award-letter"] as const`
  - `documentReadableForTask(doc: AiDoc, practiceReadsDocuments: boolean): { allowed: boolean; reason: DocumentAiReason }`

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/document-ai.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { documentAiDecision, documentReadableForTask, toAiDoc, type AiDoc } from "../../src/lib/context/documentAi.js";

const doc = (over: Partial<AiDoc> = {}): AiDoc => ({
  kind: "transcript", available_to_llm: true, ai_access: "default", ferpa_waived: false, kind_confirmed: true, ...over,
});

test("an unconfirmed file is not categorized, before every other rule", () => {
  assert.deepEqual(documentAiDecision(doc({ kind_confirmed: false }), true), { allowed: false, reason: "not-categorized" });
  assert.deepEqual(documentAiDecision(doc({ kind_confirmed: false, available_to_llm: false }), true), { allowed: false, reason: "not-categorized" });
  assert.deepEqual(documentAiDecision(doc({ kind_confirmed: false, ai_access: "allowed" }), true), { allowed: false, reason: "not-categorized" });
});

test("confirmed files keep the context layer's existing order", () => {
  assert.equal(documentAiDecision(doc(), true).allowed, true);
  assert.deepEqual(documentAiDecision(doc({ available_to_llm: false }), true), { allowed: false, reason: "keep-out" });
  assert.deepEqual(documentAiDecision(doc({ kind: "other" }), true), { allowed: false, reason: "not-categorized" });
  assert.deepEqual(documentAiDecision(doc({ kind: "essay" }), true), { allowed: false, reason: "kind-excluded" });
});

test("rows from the database: a missing kind_confirmed is confirmed, a false one is not", () => {
  assert.equal(toAiDoc({ kind: "other", available_to_llm: true }).kind_confirmed, true);
  assert.equal(toAiDoc({ kind: "other", kind_confirmed: false }).kind_confirmed, false);
  assert.equal(toAiDoc({ kind: "other" }).available_to_llm, true);
  assert.equal(toAiDoc({ kind: "other", available_to_llm: false }).available_to_llm, false);
});

test("the task rule reads essays and confirmed other files, and refuses unconfirmed and sensitive ones", () => {
  assert.equal(documentReadableForTask(doc({ kind: "essay" }), true).allowed, true);
  assert.equal(documentReadableForTask(doc({ kind: "other" }), true).allowed, true);
  assert.deepEqual(documentReadableForTask(doc({ kind: "other", kind_confirmed: false }), true), { allowed: false, reason: "not-categorized" });
  for (const kind of ["financial", "iep-504", "counselor-only", "recommendation-letter", "award-letter"]) {
    assert.equal(documentReadableForTask(doc({ kind }), true).allowed, false, kind);
  }
  assert.equal(documentReadableForTask(doc({ kind: "financial", ai_access: "allowed" }), true).allowed, true);
  assert.deepEqual(documentReadableForTask(doc({ available_to_llm: false }), true), { allowed: false, reason: "keep-out" });
  assert.deepEqual(documentReadableForTask(doc(), false), { allowed: false, reason: "practice-setting" });
  assert.deepEqual(documentReadableForTask(doc({ ai_access: "excluded" }), true), { allowed: false, reason: "excluded" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="unconfirmed|task rule|rows from"` (or `node --import tsx --import ./test/env.ts --test test/unit/document-ai.test.ts`)
Expected: FAIL, `toAiDoc` / `documentReadableForTask` not exported.

- [ ] **Step 3: Implement**

Replace the top of `src/lib/context/documentAi.ts` (keep `isRestrictedDocument` below it unchanged):

```ts
/** The per-document AI decision (spec §3.1–§3.2). Order is fixed and tested. */
export const AI_DEFAULT_DOCUMENT_KINDS = ["transcript", "resume", "test-report", "activity-list"] as const;

/** Kinds that stay out of a task's prompts unless the counselor allowed the file by hand. */
export const SENSITIVE_DOCUMENT_KINDS = ["financial", "iep-504", "counselor-only", "recommendation-letter", "award-letter"] as const;

export type DocumentAiReason = "keep-out" | "waived" | "excluded" | "not-categorized" | "kind-excluded" | "practice-setting" | null;

export type AiDoc = { kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean; kind_confirmed: boolean };

/** A documents row as a decision input. Absent switches read as today's defaults. */
export function toAiDoc(row: Record<string, unknown>): AiDoc {
  return {
    kind: typeof row.kind === "string" ? row.kind : "other",
    available_to_llm: row.available_to_llm !== false,
    ai_access: typeof row.ai_access === "string" && row.ai_access ? row.ai_access : "default",
    ferpa_waived: row.ferpa_waived === true,
    kind_confirmed: row.kind_confirmed !== false,
  };
}

/** What the context layer (and AxIS retrieval) may read. */
export function documentAiDecision(doc: AiDoc, practiceReadsDocuments: boolean): { allowed: boolean; reason: DocumentAiReason } {
  // A Drive pick nobody has confirmed: out, and reported as "not categorized" so the counselor is asked.
  if (!doc.kind_confirmed) return { allowed: false, reason: "not-categorized" };
  if (!doc.available_to_llm) return { allowed: false, reason: "keep-out" };
  if (doc.kind === "recommendation-letter" && doc.ferpa_waived) return { allowed: false, reason: "waived" };
  if (!practiceReadsDocuments) return { allowed: false, reason: "practice-setting" };
  if (doc.ai_access === "excluded") return { allowed: false, reason: "excluded" };
  if (doc.ai_access === "allowed") return { allowed: true, reason: null };
  // The same sensitive list the tracker and submission review use (one constant, three readers).
  if ((SENSITIVE_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: false, reason: "kind-excluded" };
  if ((AI_DEFAULT_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: true, reason: null };
  if (doc.kind === "other") return { allowed: false, reason: "not-categorized" };
  return { allowed: false, reason: "kind-excluded" };
}

/**
 * What the task tracker and submission review may read: the file the task is
 * about. Same protections as the context layer (unconfirmed, keep-out, waived
 * letters, the practice switch, per-file exclusion), but the kind defaults are
 * replaced by a short list of sensitive kinds, because these features read the
 * student's work for the task (an essay, a draft filed as "other").
 */
export function documentReadableForTask(doc: AiDoc, practiceReadsDocuments: boolean): { allowed: boolean; reason: DocumentAiReason } {
  if (!doc.kind_confirmed) return { allowed: false, reason: "not-categorized" };
  if (!doc.available_to_llm) return { allowed: false, reason: "keep-out" };
  if (doc.kind === "recommendation-letter" && doc.ferpa_waived) return { allowed: false, reason: "waived" };
  if (!practiceReadsDocuments) return { allowed: false, reason: "practice-setting" };
  if (doc.ai_access === "excluded") return { allowed: false, reason: "excluded" };
  if (doc.ai_access === "allowed") return { allowed: true, reason: null };
  if ((SENSITIVE_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: false, reason: "kind-excluded" };
  return { allowed: true, reason: null };
}
```

In `src/lib/context/ai-allowlist.ts` change the documents line to:

```ts
  documents: ["id", "filename", "title", "kind", "available_to_llm", "ai_access", "ferpa_waived", "kind_confirmed", "parsed_data"],
```

In `src/lib/context/sections.ts` documents loader: select `kind_confirmed` too, and build the decision input with `toAiDoc(d)` in both places:

```ts
  const rows = await many(db.from("documents")
    .select(columns("documents", ["id", "filename", "title", "kind", "available_to_llm", "ai_access", "ferpa_waived", "kind_confirmed"]))
    .eq("student_id", studentId).order("created_at"));
  if (rows.length === 0) return empty("documents");
  const allowed = rows.filter((d) => documentAiDecision(toAiDoc(d), opts.practiceReadsDocuments).allowed);
```

and in the loop `const decision = documentAiDecision(toAiDoc(d), opts.practiceReadsDocuments);`. Update the import to `import { documentAiDecision, toAiDoc } from "./documentAi.js";`. The existing `uncategorized` counter now also counts unconfirmed files, so the omitted entry `{ section: "documents", reason: "not-categorized", count }` is the "N files aren't categorized" line; no new shape.

In `src/lib/axis/guard.ts`: add `kind_confirmed: boolean;` to `DocRow`, select `"id, student_id, kind, available_to_llm, ai_access, ferpa_waived, kind_confirmed"`, and call `documentAiDecision(toAiDoc(doc), practiceReadsDocuments)` (import `toAiDoc`).

In `src/lib/schemaCheck.ts` add to `REQUIRED_SCHEMA`:

```ts
  // 20261024000001: the context layer's documents loader selects it on every AxIS read.
  documents: ["kind_confirmed"],
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: `document-ai.test.ts` passes. Fix any existing fixture in `test/unit/context-loaders.test.ts`, `context-consumers.test.ts`, `axis-*.test.ts` or `schema-check.test.ts` that builds a document row or asserts the `REQUIRED_SCHEMA` keys (add `kind_confirmed: true` to rows; add the `documents` entry to the expected schema list). Expected: all green. Then `npm run typecheck`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/context src/lib/axis/guard.ts src/lib/schemaCheck.ts test/unit
git commit -m "One document readability rule: unconfirmed files are not categorized everywhere

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Tracker and submission review use the task rule; disconnected Google never yields "no activity"

**Files:**
- Modify: `src/lib/liveDocuments.ts`
- Modify: `src/routes/tasks.ts:975-1050` (tracker) and `:1201-1205` (`liveProblems`)
- Modify: `src/lib/submissionReview.ts:271-276` (`decide`)
- Modify: `src/lib/serialize.ts:270-285` (task document DTO gains `externalProvider`; also select `external_provider` wherever the task's documents embed is built: `grep -n "document:documents(" src/routes/tasks.ts`)
- Test: `test/unit/live-documents.test.ts` (new), `test/unit/submissions.test.ts` (extend), `test/unit/sensitive-kinds.test.ts` (new)

**Interfaces:**
- Consumes: `documentReadableForTask`, `toAiDoc` (Task 2).
- Produces:
  - `LiveFileCheck` gains `errorCode: string | null` (the `HttpError.code`, else `"not_found"` for 404, else `"unavailable"`).
  - `liveStatusOf(checks: LiveFileCheck[]): { status: "ok" | "disconnected" | "reconnect"; files: number }`
  - `holdsNoActivity(checks: LiveFileCheck[]): boolean` (true when any check's `errorCode` ends in `_disconnected` or `_reconnect`)
  - Tracker 409 `{ code: "google_disconnected" }` instead of saving a `no-activity` verdict when `holdsNoActivity`; every 201 body gains `liveStatus`.
  - Task document DTO field `externalProvider: "google" | "microsoft" | null`.

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/live-documents.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { holdsNoActivity, liveStatusOf, type LiveFileCheck } from "../../src/lib/liveDocuments.js";

const check = (errorCode: string | null): LiveFileCheck => ({
  documentId: crypto.randomUUID(), name: "Essay draft", provider: "google",
  modifiedAt: null, editedBy: null, counts: false, error: errorCode ? "x" : null, errorCode,
});

test("a disconnected or broken grant holds a no-activity verdict; other failures don't", () => {
  assert.equal(holdsNoActivity([check("google_disconnected")]), true);
  assert.equal(holdsNoActivity([check(null), check("google_reconnect")]), true);
  assert.equal(holdsNoActivity([check("not_found")]), false);
  assert.equal(holdsNoActivity([check("unavailable"), check(null)]), false);
  assert.equal(holdsNoActivity([]), false);
});

test("liveStatus names the worst state and counts the files it affects", () => {
  assert.deepEqual(liveStatusOf([check(null)]), { status: "ok", files: 0 });
  assert.deepEqual(liveStatusOf([check("google_disconnected"), check("google_disconnected"), check(null)]), { status: "disconnected", files: 2 });
  assert.deepEqual(liveStatusOf([check("google_reconnect")]), { status: "reconnect", files: 1 });
  assert.deepEqual(liveStatusOf([check("google_reconnect"), check("google_disconnected")]), { status: "disconnected", files: 2 });
});
```

Add to `test/unit/submissions.test.ts` (it already imports from `submissionReview.js`; export the pure part first, see Step 3):

```ts
import { refusalFor } from "../../src/lib/submissionReview.js";

test("submission review refuses an unconfirmed file with a reason the student's counselor can act on", () => {
  assert.equal(refusalFor({ kind: "other", kind_confirmed: false }, true), "Choose a type for this file first, so AxIS knows what it is.");
  assert.equal(refusalFor({ kind: "other", available_to_llm: false }, true), "This file is kept out of AI, so AxIS didn't read it.");
  assert.equal(refusalFor({ kind: "essay" }, true), null);
  assert.equal(refusalFor({ kind: "financial" }, true), "This kind of file stays out of AI, so AxIS didn't read it.");
  assert.equal(refusalFor({ kind: "essay" }, false), "Automatic document reading is off for this practice.");
});
```

And the shared-constant test (Elvin, 10/15: all three readers refuse each sensitive kind):

```ts
// test/unit/sensitive-kinds.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { documentAiDecision, documentReadableForTask, SENSITIVE_DOCUMENT_KINDS, toAiDoc } from "../../src/lib/context/documentAi.js";
import { refusalFor } from "../../src/lib/submissionReview.js";

test("the sensitive list is the five agreed kinds", () => {
  assert.deepEqual([...SENSITIVE_DOCUMENT_KINDS].sort(), ["award-letter", "counselor-only", "financial", "iep-504", "recommendation-letter"]);
});

test("the context layer, the tracker and submission review all refuse every sensitive kind", () => {
  for (const kind of SENSITIVE_DOCUMENT_KINDS) {
    const row = { kind, available_to_llm: true, ai_access: "default", ferpa_waived: false, kind_confirmed: true };
    assert.equal(documentAiDecision(toAiDoc(row), true).allowed, false, `context layer: ${kind}`);
    assert.equal(documentReadableForTask(toAiDoc(row), true).allowed, false, `tracker: ${kind}`);
    assert.notEqual(refusalFor(row, true), null, `submission review: ${kind}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/live-documents.test.ts test/unit/submissions.test.ts test/unit/sensitive-kinds.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`src/lib/liveDocuments.ts`: add `errorCode: string | null;` to `LiveFileCheck`; in the success return add `errorCode: null`; in the catch:

```ts
      } catch (err) {
        const message =
          err instanceof HttpError ? err.message : "Couldn't reach the provider for this file.";
        const errorCode =
          err instanceof HttpError
            ? err.code ?? (err.statusCode === 404 ? "not_found" : "unavailable")
            : "unavailable";
        return { ...base, modifiedAt: null, editedBy: null, counts: false, error: message, errorCode };
      }
```

Only export Doc text on edit for a confirmed file the AI may keep text for: change `if (doc.available_to_llm !== false) {` to `if (doc.available_to_llm !== false && doc.kind_confirmed !== false) {`. Add at the end of the file:

```ts
const isGrantProblem = (code: string | null) => !!code && (code.endsWith("_disconnected") || code.endsWith("_reconnect"));

/** A task whose linked files can't be checked because the grant is gone must not read as "no activity". */
export function holdsNoActivity(checks: LiveFileCheck[]): boolean {
  return checks.some((c) => isGrantProblem(c.errorCode));
}

export function liveStatusOf(checks: LiveFileCheck[]): { status: "ok" | "disconnected" | "reconnect"; files: number } {
  const affected = checks.filter((c) => isGrantProblem(c.errorCode));
  if (affected.length === 0) return { status: "ok", files: 0 };
  const disconnected = affected.some((c) => c.errorCode!.endsWith("_disconnected"));
  return { status: disconnected ? "disconnected" : "reconnect", files: affected.length };
}
```

`src/routes/tasks.ts` tracker:
- the document embed gains `kind, ai_access, ferpa_waived, kind_confirmed`:
  `"role, document:documents(id, owner_id, filename, title, description, parsed_data, parse_status, available_to_llm, kind, ai_access, ferpa_waived, kind_confirmed, updated_at, external_provider, external_file_id, external_drive_id, external_modified_at)"`
- after `const settings = await settingsFor(...)` add `const { settings: practice } = await loadPracticeSettings(request);` (import from `../lib/practiceSettings.js`).
- replace the `readable` line:

```ts
      // The task rule (unconfirmed, keep-out, waived, practice switch, sensitive kinds): lib/context/documentAi.ts.
      const readable = attachedDocs.filter(
        (row) => row.doc && documentReadableForTask(toAiDoc(row.doc), practice.autoParseDocuments).allowed
      );
      const status = liveStatusOf(live.checks);
```

- inside `if (stale && !hasWork) {`, before `saveCheck`:

```ts
        if (holdsNoActivity(live.checks)) {
          const held = live.checks.filter((c) => c.errorCode && /_(disconnected|reconnect)$/.test(c.errorCode));
          const label = held[0]!.provider === "google" ? "Google" : "Microsoft";
          throw new HttpError(
            409,
            `${label} is disconnected, so Meridies can't see edits to ${quoteNames(held)}. Reconnect ${label} to check this task.`,
            `${held[0]!.provider}_disconnected`
          );
        }
```

- every `return reply.code(201).send(saved);` in the tracker becomes `return reply.code(201).send({ ...saved, liveStatus: status });` (three places: no-activity, live-edit on-track, and the model verdict further down; `grep -n "reply.code(201).send(saved)" src/routes/tasks.ts` lists them).
- imports: `documentReadableForTask, toAiDoc` from `../lib/context/documentAi.js`; `holdsNoActivity, liveStatusOf` from `../lib/liveDocuments.js`; `HttpError` from `../lib/errors.js` if not already imported.

`src/lib/submissionReview.ts`: add an exported pure function and use it in `decide`:

```ts
/** Why AxIS won't read this file for a hand-in, or null when it may. */
export function refusalFor(row: Record<string, unknown>, practiceReadsDocuments: boolean): string | null {
  const verdict = documentReadableForTask(toAiDoc(row), practiceReadsDocuments);
  if (verdict.allowed) return null;
  switch (verdict.reason) {
    case "not-categorized": return "Choose a type for this file first, so AxIS knows what it is.";
    case "keep-out": return "This file is kept out of AI, so AxIS didn't read it.";
    case "practice-setting": return "Automatic document reading is off for this practice.";
    default: return "This kind of file stays out of AI, so AxIS didn't read it.";
  }
}
```

and replace the first two checks in `decide`:

```ts
  const refusal = refusalFor(doc, await documentReadingAllowed(svc, studentId));
  if (refusal) return { status: "skipped", reason: refusal };
```

Make sure the row `decide` receives carries `kind, ai_access, ferpa_waived, kind_confirmed` (find its select: `grep -n "from(\"documents\")" src/lib/submissionReview.ts` and add the columns).

`src/lib/serialize.ts` task document DTO: add after `ferpaWaived`:

```ts
    /** Drive / OneDrive file this came from; the app shows "Google disconnected" against it. */
    externalProvider: doc ? (nstr(doc.external_provider) as "google" | "microsoft" | null) : null,
```

and add `external_provider` to the documents embed that feeds it (`grep -n "document:documents(id, filename" src/routes/tasks.ts`).

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: green. Then the persona suite for submissions: `node test/integration/submissions.test.mjs` (API running). Expected: all `ok` (existing hand-ins are confirmed `other` files, still read).

- [ ] **Step 5: Commit**

```bash
git add src/lib/liveDocuments.ts src/routes/tasks.ts src/lib/submissionReview.ts src/lib/serialize.ts test/unit
git commit -m "Tracker and submission review: the task rule, liveStatus, no verdict while disconnected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Google consent in two steps, the scope allowlist and the same-account rule

**Files:**
- Modify: `src/lib/oauth.ts`
- Modify: `src/routes/integrations.ts:122-167` (`/providers` gains `calendarEnabled`, `driveGranted`; `/authorize` reads `?add=`)
- Test: `test/unit/google-oauth.test.ts` (new)

**Interfaces:**
- Produces (from `lib/oauth.ts`):
  - `GOOGLE_SCOPE = { driveFile: "https://www.googleapis.com/auth/drive.file", calendarEvents: "https://www.googleapis.com/auth/calendar.events" } as const`
  - `type GoogleAddOn = "calendar"`
  - `googleScopesFor(add: GoogleAddOn | null): string[]`
  - `disallowedGoogleScopes(granted: string[]): string[]`
  - `accountMismatch(existingAccountId: string | null, newSub: string | null): boolean`
  - `googleAuthorizeParams(input: { add: GoogleAddOn | null; loginHint: string | null }): Record<string, string>` (scope string + `access_type`, `prompt`, `include_granted_scopes`, optional `login_hint`)
  - `beginAuthorization(userId, provider, opts?: { add?: GoogleAddOn | null })`
  - `completeAuthorization` throws `HttpError(409, …, "google_reconnect")` / `HttpError(409, …, "google_other_account")`
  - `connectedAccountEmail(ownerId: string, provider: SuiteProvider): Promise<string | null>`
  - `readTokenRow` "isn't connected" → code `${provider}_disconnected`; `markGrantBroken` paths → code `${provider}_reconnect`
  - `requireScope(token, provider, scope, what, code?: string)`

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/google-oauth.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountMismatch, disallowedGoogleScopes, googleAuthorizeParams, googleScopesFor, GOOGLE_SCOPE,
} from "../../src/lib/oauth.js";

test("Connect asks for exactly openid, email and drive.file; Calendar adds exactly calendar.events", () => {
  assert.deepEqual(googleScopesFor(null), ["openid", "email", GOOGLE_SCOPE.driveFile]);
  assert.deepEqual(googleScopesFor("calendar"), ["openid", "email", GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.calendarEvents]);
  for (const s of [...googleScopesFor(null), ...googleScopesFor("calendar")]) {
    assert.ok(!/drive\.readonly|gmail/.test(s), s);
  }
});

test("a client string can never become a scope", () => {
  // The add-on is a closed union; anything else is refused before this point by zod (Task 4 route).
  assert.throws(() => googleScopesFor("gmail" as never));
});

test("the authorize parameters carry incremental consent and the login hint", () => {
  const p = googleAuthorizeParams({ add: "calendar", loginHint: "counselor@example.com" });
  assert.equal(p.scope, `openid email ${GOOGLE_SCOPE.driveFile} ${GOOGLE_SCOPE.calendarEvents}`);
  assert.equal(p.include_granted_scopes, "true");
  assert.equal(p.access_type, "offline");
  assert.equal(p.prompt, "consent");
  assert.equal(p.login_hint, "counselor@example.com");
  assert.equal("login_hint" in googleAuthorizeParams({ add: null, loginHint: null }), false);
});

test("anything Google returns outside the allowlist is flagged", () => {
  assert.deepEqual(disallowedGoogleScopes(["openid", "https://www.googleapis.com/auth/userinfo.email", GOOGLE_SCOPE.driveFile]), []);
  assert.deepEqual(disallowedGoogleScopes(["openid", GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.calendarEvents, "email"]), []);
  assert.deepEqual(
    disallowedGoogleScopes(["openid", GOOGLE_SCOPE.driveFile, "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.send"]),
    ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.send"]
  );
});

test("a different Google account than the connected one is a mismatch; a first connection is not", () => {
  assert.equal(accountMismatch(null, "111"), false);
  assert.equal(accountMismatch("111", "111"), false);
  assert.equal(accountMismatch("111", "222"), true);
  assert.equal(accountMismatch("111", null), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/google-oauth.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement in `src/lib/oauth.ts`**

Replace the header comment's first paragraph and `GOOGLE_SCOPES`:

```ts
/**
 * Google asks in two steps (spec §4.1): Connect is identity plus drive.file (only files the
 * counselor picks in Google Picker, or files this app created); Calendar is added only when the
 * counselor turns it on. Nothing the client sends becomes a scope string.
 */
export const GOOGLE_SCOPE = {
  driveFile: "https://www.googleapis.com/auth/drive.file",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
} as const;

const GOOGLE_CONNECT_SCOPES = ["openid", "email", GOOGLE_SCOPE.driveFile];
const GOOGLE_ADD_ONS = { calendar: [GOOGLE_SCOPE.calendarEvents] } as const;
export type GoogleAddOn = keyof typeof GOOGLE_ADD_ONS;

/** What Google may hand back. Anything else (an old drive.readonly folded back in) is refused. */
const GOOGLE_ALLOWED_BACK = new Set<string>([
  "openid", "email", "https://www.googleapis.com/auth/userinfo.email", GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.calendarEvents,
]);

export function googleScopesFor(add: GoogleAddOn | null): string[] {
  if (add === null) return [...GOOGLE_CONNECT_SCOPES];
  const extra = GOOGLE_ADD_ONS[add];
  if (!extra) throw new Error(`Unknown Google add-on: ${String(add)}`);
  return [...GOOGLE_CONNECT_SCOPES, ...extra];
}

export function disallowedGoogleScopes(granted: string[]): string[] {
  return granted.filter((s) => !GOOGLE_ALLOWED_BACK.has(s));
}

export function accountMismatch(existingAccountId: string | null, newSub: string | null): boolean {
  if (!existingAccountId) return false;
  return newSub !== existingAccountId;
}

export function googleAuthorizeParams(input: { add: GoogleAddOn | null; loginHint: string | null }): Record<string, string> {
  return {
    scope: googleScopesFor(input.add).join(" "),
    // offline + consent: the only way Google reliably issues a refresh token.
    access_type: "offline",
    prompt: "consent",
    // The Calendar consent adds to the first grant instead of replacing it.
    include_granted_scopes: "true",
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  };
}
```

In `providerConfig` for Google: `scopes: googleScopesFor(null)` and `extraAuthorizeParams: {}` (the Google params now come from `googleAuthorizeParams`). Change `beginAuthorization`:

```ts
export async function beginAuthorization(
  userId: string,
  provider: SuiteProvider,
  opts: { add?: GoogleAddOn | null } = {}
): Promise<string> {
  const { config, db } = configured(provider);
  // … state, verifier, cleanup, insert: unchanged …

  const base = {
    client_id: config.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    state,
    code_challenge: sha256B64Url(verifier),
    code_challenge_method: "S256",
  };
  const params =
    provider === "google"
      ? new URLSearchParams({
          ...base,
          ...googleAuthorizeParams({ add: opts.add ?? null, loginHint: await connectedAccountEmail(userId, "google") }),
        })
      : new URLSearchParams({ ...base, scope: config.scopes.join(" "), ...config.extraAuthorizeParams });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/** The connected account's email, for login_hint and messages. Null when not connected. */
export async function connectedAccountEmail(ownerId: string, provider: SuiteProvider): Promise<string | null> {
  const db = serviceClient();
  if (!db) return null;
  const { data } = await db
    .from("integration_tokens")
    .select("account_email")
    .eq("owner_id", ownerId)
    .eq("provider", provider)
    .maybeSingle();
  return (data?.account_email as string | null) ?? null;
}
```

In `completeAuthorization`, after `accountId` / `accountEmail` are known and before the upsert, for Google:

```ts
  if (provider === "google") {
    const extra = disallowedGoogleScopes(granted);
    const { data: existing } = await db
      .from("integration_tokens")
      .select("account_id, account_email")
      .eq("owner_id", ownerId)
      .eq("provider", "google")
      .maybeSingle();
    const existingId = (existing?.account_id as string | null) ?? null;
    if (extra.length > 0 || accountMismatch(existingId, accountId)) {
      // Leave nothing behind at Google for a grant we won't keep.
      await postForm("https://oauth2.googleapis.com/revoke", { token: token.access_token }).catch(() => undefined);
      if (extra.length > 0) {
        log.warn({ provider, extra: extra.length }, "google returned scopes outside the allowlist");
        await revokeAndForget(ownerId, "google", log);
        await db.from("integrations").delete().eq("owner_id", ownerId).eq("provider", "google");
        throw new HttpError(409, "Your Google connection had permissions Meridies no longer uses. Connect Google again.", "google_reconnect");
      }
      const connected = (existing?.account_email as string | null) ?? "the connected account";
      throw new HttpError(
        409,
        `You signed in as ${accountEmail ?? "another account"}. Use ${connected}, or disconnect Google and connect the other account.`,
        "google_other_account"
      );
    }
  }
```

Codes on the existing errors:
- `readTokenRow`: `throw new HttpError(409, \`${label} isn't connected. Connect it under App Integrations first.\`, \`${provider}_disconnected\`);`
- `refreshGrant` no refresh token: `throw new HttpError(409, message, \`${provider}_reconnect\`);`
- `refreshGrant` revoked: `throw revoked ? new HttpError(409, message, \`${provider}_reconnect\`) : unavailable(message);`
- `requireScope` gains `code?: string`:

```ts
export function requireScope(token: LiveToken, provider: SuiteProvider, scope: string, what: string, code?: string) {
  if (!hasScope(token, scope)) {
    throw new HttpError(
      409,
      code === "calendar_not_enabled"
        ? "Turn on Google Calendar to add Meet links."
        : `Your ${providerLabel(provider)} connection doesn't allow ${what}. Reconnect and leave that permission ticked.`,
      code
    );
  }
}
```

Update the header comment ("One consent per provider covers files, mail and calendar…") to the two-step wording.

In `src/routes/integrations.ts`:
- `/providers`: select `provider, account_email, created_at, scopes`, and add to each item:

```ts
        calendarEnabled: account ? account.scopes.some((s) => /calendar\.events$|calendars\.readwrite$/i.test(s)) : false,
        driveGranted: account ? account.scopes.some((s) => /drive\.file$|files\.read/i.test(s)) : false,
        // Until the Railway variables are set the app hides the Drive button (Elvin, 10/15).
        pickerReady:
          provider === "google" &&
          reason === null &&
          pickerConfigProblem({ clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_PICKER_API_KEY, projectNumber: env.GOOGLE_PROJECT_NUMBER }) === null,
```

(`pickerConfigProblem` and the two env settings arrive in Task 11; in this task add `pickerReady: false` as a literal with a `// Task 11` comment, and Task 11 replaces it with the expression above.)

  (store `scopes: (r.scopes as string[] | null) ?? []` in the `accounts` map).
- `/authorize`:

```ts
      const { provider } = suiteParam.parse(request.params);
      const { add } = z.object({ add: z.enum(["calendar"]).optional() }).strict().parse(request.query ?? {});
      if (add && provider !== "google") throw badRequest("Only Google has add-ons");
      return { url: await beginAuthorization(request.auth.userId, provider, { add: add ?? null }) };
```

- update the file's header comment: one consent no longer lights up Gmail; Google is picked files only, Calendar on request.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: green. Integration: `node test/integration/hardening.test.mjs` and any test that asserts the providers shape (`grep -rln "/integrations/providers" test/integration`). Expected: `ok` (new fields are additive).

- [ ] **Step 5: Commit**

```bash
git add src/lib/oauth.ts src/routes/integrations.ts test/unit/google-oauth.test.ts
git commit -m "Google consent in two steps, scope allowlist, same-account rule, error codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: `drive.file` everywhere Google files are read, and stable error codes

**Files:**
- Modify: `src/lib/suiteApi.ts`
- Modify: `src/lib/supplementDocs.ts`
- Modify: `src/routes/application.ts:874-945` (`POST /application/essays/sync`)
- Test: `test/unit/suite-api.test.ts` (new)

**Interfaces:**
- Consumes: `GOOGLE_SCOPE`, `requireScope(..., code)` (Task 4).
- Produces:
  - `googleFileFailureCode(status: number): string | null` (`404 → "not_found"`, else null) — used by `providerFailure` to set `HttpError.code`.
  - `exportDocTextResult(ownerId, fileId, log): Promise<{ ok: true; text: string } | { ok: false; reason: "not-picked" | "failed" }>`; `exportDocText` stays as a wrapper returning `string | null`.
  - `POST /application/essays/sync` response gains `notPicked: string[]` (essay ids).
  - Calendar calls throw code `calendar_not_enabled` without `calendar.events`; Google file calls throw `drive_not_granted` without `drive.file`.

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/suite-api.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { requireScope, GOOGLE_SCOPE, type LiveToken } from "../../src/lib/oauth.js";
import { googleFileFailureCode, GOOGLE_FILE_SCOPE, GOOGLE_CALENDAR_SCOPE } from "../../src/lib/suiteApi.js";

const token = (scopes: string[]): LiveToken => ({ accessToken: "t", accountId: "1", accountEmail: "c@example.com", scopes });

test("Google file calls use drive.file, never drive.readonly", () => {
  assert.equal(GOOGLE_FILE_SCOPE, GOOGLE_SCOPE.driveFile);
  assert.equal(GOOGLE_CALENDAR_SCOPE, GOOGLE_SCOPE.calendarEvents);
});

test("a grant without calendar.events answers calendar_not_enabled; without drive.file, drive_not_granted", () => {
  assert.throws(
    () => requireScope(token(["openid", GOOGLE_SCOPE.driveFile]), "google", GOOGLE_CALENDAR_SCOPE, "writing to Calendar", "calendar_not_enabled"),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "calendar_not_enabled" && e.message === "Turn on Google Calendar to add Meet links."
  );
  assert.throws(
    () => requireScope(token(["openid"]), "google", GOOGLE_FILE_SCOPE, "reading the files you picked", "drive_not_granted"),
    (e: unknown) => e instanceof HttpError && e.code === "drive_not_granted"
  );
  assert.doesNotThrow(() => requireScope(token([GOOGLE_SCOPE.driveFile]), "google", GOOGLE_FILE_SCOPE, "x", "drive_not_granted"));
});

test("a Drive 404 carries not_found so callers can map it", () => {
  assert.equal(googleFileFailureCode(404), "not_found");
  assert.equal(googleFileFailureCode(403), null);
  assert.equal(googleFileFailureCode(500), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/suite-api.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`src/lib/suiteApi.ts`:

```ts
import { accessTokenFor, GOOGLE_SCOPE, providerLabel, requireScope, type LiveToken, type SuiteProvider } from "./oauth.js";

/** drive.file: only files the counselor picked in Google Picker, or files this app created. */
export const GOOGLE_FILE_SCOPE = GOOGLE_SCOPE.driveFile;
export const GOOGLE_CALENDAR_SCOPE = GOOGLE_SCOPE.calendarEvents;
const GOOGLE_FILES = { name: GOOGLE_FILE_SCOPE, what: "reading the files you picked", code: "drive_not_granted" };
const GOOGLE_CALENDAR = { name: GOOGLE_CALENDAR_SCOPE, what: "writing to Calendar", code: "calendar_not_enabled" };
```

- delete `GOOGLE_DRIVE_SCOPE`; every `{ name: GOOGLE_DRIVE_SCOPE, what: "reading Drive" }` becomes `GOOGLE_FILES`; every `{ name: GOOGLE_CALENDAR_SCOPE, what: "writing to Calendar" }` becomes `GOOGLE_CALENDAR`.
- `call(...)`'s `scope` parameter type becomes `{ name: string; what: string; code?: string }` and it calls `requireScope(token, provider, scope.name, scope.what, scope.code)`.
- `providerFailure`: for a 404 return `new HttpError(404, \`${label} couldn't find that ${what}, or it isn't shared with you.\`, googleFileFailureCode(404) ?? undefined)` and add:

```ts
export function googleFileFailureCode(status: number): string | null {
  return status === 404 ? "not_found" : null;
}
```

- `listRemoteFiles` (Google) is unchanged apart from the scope: under `drive.file`, Drive's `files.list` returns only files the app can reach (earlier picks and supplement Docs), which is the app's "Recently added from Drive". Update its doc comment to say so.

`src/lib/supplementDocs.ts`: delete `GOOGLE_DRIVE_READ_SCOPE`; `exportDocText` reads with `{ name: GOOGLE_DRIVE_FILE_SCOPE, what: "reading Docs you picked" }`. Add the result-returning variant and keep the old name as a wrapper:

```ts
/** A picked or app-created Doc's plain text; `not-picked` when Google says the app can't see it. */
export async function exportDocTextResult(
  ownerId: string,
  fileId: string,
  log: Log
): Promise<{ ok: true; text: string } | { ok: false; reason: "not-picked" | "failed" }> {
  if (!GOOGLE_ID.test(fileId)) return { ok: false, reason: "failed" };
  const res = await googleCall(
    ownerId,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`,
    {},
    { name: GOOGLE_DRIVE_FILE_SCOPE, what: "reading Docs you picked" }
  );
  if (res.status === 404) return { ok: false, reason: "not-picked" };
  if (!res.ok) {
    log.warn({ status: res.status }, "google doc export failed");
    return { ok: false, reason: "failed" };
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_EXPORT_BYTES) return { ok: false, reason: "failed" };
  const text = await res.text();
  return text.length > MAX_EXPORT_BYTES ? { ok: false, reason: "failed" } : { ok: true, text: normalizeText(text) };
}

export async function exportDocText(ownerId: string, fileId: string, log: Log): Promise<string | null> {
  const r = await exportDocTextResult(ownerId, fileId, log);
  return r.ok ? r.text : null;
}
```

Update the file header: "Reading answers back uses drive.file: the Doc was created by this app, or picked by the counselor."

`src/routes/application.ts` essay sync: add `const notPicked: string[] = [];` next to `failed`; in the linked-essay job use the result variant:

```ts
          const r = await exportDocTextResult(me, fileId, request.log).catch(() => ({ ok: false as const, reason: "failed" as const }));
          if (!r.ok) {
            if (r.reason === "not-picked") notPicked.push(String(e.id));
            else failed.push(String(e.id));
            return;
          }
          const text = r.text;
```

and return `{ updated, failed: failed.length, notPicked, essays: … }`. Import `exportDocTextResult` alongside `exportDocText`. Update the route's doc comment: a linked Doc is read only when the counselor picked it; an unpicked one is reported in `notPicked` so the app can offer "Pick this Doc to keep it in sync".

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/suiteApi.ts src/lib/supplementDocs.ts src/routes/application.ts test/unit/suite-api.test.ts
git commit -m "drive.file for every Google file read; calendar_not_enabled, drive_not_granted, essay notPicked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: PDF text extraction in capped worker threads, queued two at a time

**Files:**
- Modify: `package.json` / `package-lock.json` (`"unpdf": "1.8.1"`, exact)
- Create: `src/lib/pdfText.options.ts`, `src/lib/pdfText.extract.ts`, `src/lib/pdfText.worker.ts`, `src/lib/pdfText.ts`
- Create: `test/fixtures/pdf/build.ts`, `test/fixtures/pdf/loop.worker.mjs`, `test/fixtures/pdf/hog.worker.mjs`
- Test: `test/unit/pdf-text.test.ts`

**Interfaces:**
- Produces:
  - `PDFJS_OPTIONS = { isEvalSupported: false, enableScripting: false, disableFontFace: true, useSystemFonts: false } as const`
  - `PDF_LIMITS = { maxBytes: 25 * 1024 * 1024, maxPages: 50, maxChars: 200_000, timeoutMs: 10_000, maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, concurrency: 2 } as const`
  - `extractInThisThread(bytes: Uint8Array, maxPages: number, maxChars: number): Promise<{ text: string; pages: number }>`
  - `type PdfTextResult = { ok: true; text: string; pages: number } | { ok: false; reason: "too-large" | "timeout" | "memory" | "unreadable" | "busy" }`
  - `extractPdfText(bytes: Uint8Array, opts?: { maxPages?: number; priority?: "high" | "normal"; waitMs?: number; timeoutMs?: number; workerUrl?: URL }): Promise<PdfTextResult>`
  - `pdfQueueStats(): { running: number; waiting: number }`
  - `bundledPdfjsVersion(): Promise<string>`

- [ ] **Step 1: Pin the dependency**

```bash
npm install --save-exact unpdf@1.8.1
node -e "const p=require('./package.json'); if (p.dependencies.unpdf !== '1.8.1') { console.error(p.dependencies.unpdf); process.exit(1) }"
grep -o 'apiVersion:`[0-9.]*`' node_modules/unpdf/dist/pdfjs.mjs | head -1
```

Expected: `apiVersion:\`6.1.200\``. Check the API the plan uses exists: `grep -n "getResolvedPDFJS" node_modules/unpdf/dist/index.d.mts`. Expected: one export line. If either check fails, stop and ask.

- [ ] **Step 2: Write the PDF builder fixture**

```ts
// test/fixtures/pdf/build.ts
/** Minimal, valid PDFs built in memory for the extractor's tests. Object 1 is the catalog. */
export function buildPdf(objects: string[]): Buffer {
  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** One text line per page, Helvetica. `extraCatalog` is spliced into the catalog dict. */
export function textPdf(pages: string[], opts: { extraCatalog?: string; extraObjects?: string[]; fontDict?: string } = {}): Buffer {
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then per page: page obj + content obj, then extras.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R ${opts.extraCatalog ?? ""} >>`,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`,
    opts.fontDict ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((line, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${esc(line)}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  return buildPdf([...objects, ...(opts.extraObjects ?? [])]);
}

/** A PDF whose open action is JavaScript that would set a global if it ever ran. */
export function javascriptPdf(): Buffer {
  const jsId = 6; // after catalog, pages, font, one page, one content
  return textPdf(["Has a script"], {
    extraCatalog: `/OpenAction ${jsId} 0 R /Names << /JavaScript << /Names [(m) ${jsId} 0 R] >> >>`,
    extraObjects: ["<< /S /JavaScript /JS (globalThis.__meridiesMarker = 1;) >>"],
  });
}

/** CVE-2024-4367's shape: script smuggled into a font's FontMatrix. */
export function fontMatrixPdf(): Buffer {
  return textPdf(["Crafted font"], {
    fontDict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontMatrix [1 0 0 1 0 (0\\); globalThis.__meridiesMarker = 1; //)] >>",
  });
}
```

```js
// test/fixtures/pdf/loop.worker.mjs: never answers; the pool must terminate it.
for (;;) {}
```

```js
// test/fixtures/pdf/hog.worker.mjs: allocates until the worker's memory cap kills it.
const keep = [];
for (;;) keep.push(new Array(1_000_000).fill(Math.random()));
```

- [ ] **Step 3: Write the failing unit test**

```ts
// test/unit/pdf-text.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PDFJS_OPTIONS } from "../../src/lib/pdfText.options.js";
import { extractInThisThread } from "../../src/lib/pdfText.extract.js";
import { bundledPdfjsVersion, extractPdfText, pdfQueueStats, PDF_LIMITS } from "../../src/lib/pdfText.js";
import { fontMatrixPdf, javascriptPdf, textPdf } from "../fixtures/pdf/build.js";

const atLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

test("unpdf is pinned exactly and bundles PDF.js at or past the CVE-2024-4367 fix", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.unpdf, "1.8.1");
  const v = await bundledPdfjsVersion();
  assert.ok(atLeast(v, "4.2.67"), `bundled PDF.js ${v}`);
});

test("every load passes isEvalSupported false and scripting off", () => {
  assert.equal(PDFJS_OPTIONS.isEvalSupported, false);
  assert.equal(PDFJS_OPTIONS.enableScripting, false);
});

test("text comes out of a normal PDF, in a worker", async () => {
  const r = await extractPdfText(textPdf(["Official Transcript", "Cumulative GPA 3.9"]));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.text, /Official Transcript/);
    assert.equal(r.pages, 2);
  }
});

test("embedded JavaScript never runs: an OpenAction script and a crafted FontMatrix", async () => {
  delete (globalThis as Record<string, unknown>).__meridiesMarker;
  await extractInThisThread(javascriptPdf(), 50, 200_000).catch(() => undefined);
  await extractInThisThread(fontMatrixPdf(), 50, 200_000).catch(() => undefined);
  assert.equal((globalThis as Record<string, unknown>).__meridiesMarker, undefined);
});

test("only the first 50 pages are read and the text stops at 200,000 characters", async () => {
  const many = await extractPdfText(textPdf(Array.from({ length: 60 }, (_, i) => `Page ${i + 1}`)));
  assert.ok(many.ok && many.pages === 50 && !many.text.includes("Page 51"));
  const long = await extractPdfText(textPdf(Array.from({ length: 50 }, () => "x".repeat(5_000))));
  assert.ok(long.ok && long.text.length === PDF_LIMITS.maxChars);
});

test("a file over 25 MB is refused before any worker starts", async () => {
  const r = await extractPdfText(new Uint8Array(PDF_LIMITS.maxBytes + 1));
  assert.deepEqual(r, { ok: false, reason: "too-large" });
  assert.deepEqual(pdfQueueStats(), { running: 0, waiting: 0 });
});

test("a worker that never answers is terminated at the time limit, and the next extraction works", async () => {
  const started = Date.now();
  const r = await extractPdfText(textPdf(["x"]), { timeoutMs: 400, workerUrl: new URL("../fixtures/pdf/loop.worker.mjs", import.meta.url) });
  assert.deepEqual(r, { ok: false, reason: "timeout" });
  assert.ok(Date.now() - started < 3_000);
  assert.equal(pdfQueueStats().running, 0);
  assert.equal((await extractPdfText(textPdf(["after"]))).ok, true);
});

test("a worker over its memory cap fails cleanly", async () => {
  const r = await extractPdfText(textPdf(["x"]), { workerUrl: new URL("../fixtures/pdf/hog.worker.mjs", import.meta.url) });
  assert.deepEqual(r, { ok: false, reason: "memory" });
  assert.equal((await extractPdfText(textPdf(["after"]))).ok, true);
});

test("at most two run at once; the rest wait in order, and high priority jumps the queue", async () => {
  const loop = new URL("../fixtures/pdf/loop.worker.mjs", import.meta.url);
  const slow = [1, 2].map(() => extractPdfText(textPdf(["x"]), { timeoutMs: 600, workerUrl: loop }));
  const normal = extractPdfText(textPdf(["normal"]));
  const high = extractPdfText(textPdf(["high"]), { priority: "high" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pdfQueueStats(), { running: 2, waiting: 2 });
  const order: string[] = [];
  await Promise.all([high.then(() => order.push("high")), normal.then(() => order.push("normal")), ...slow]);
  assert.deepEqual(order.slice(0, 1), ["high"]);
});

test("a high-priority job that can't start within its wait gives up as busy", async () => {
  const loop = new URL("../fixtures/pdf/loop.worker.mjs", import.meta.url);
  const slow = [1, 2].map(() => extractPdfText(textPdf(["x"]), { timeoutMs: 800, workerUrl: loop }));
  const r = await extractPdfText(textPdf(["guess"]), { priority: "high", waitMs: 100 });
  assert.deepEqual(r, { ok: false, reason: "busy" });
  await Promise.all(slow);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/pdf-text.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 5: Implement**

```ts
// src/lib/pdfText.options.ts
/**
 * Options for every PDF.js load (lib/pdfText.extract.ts). isEvalSupported false is the
 * CVE-2024-4367 guard (this build has no eval path at all; the flag keeps it that way if a
 * later version brings one back). Scripting stays off, as PDF.js defaults.
 */
export const PDFJS_OPTIONS = {
  isEvalSupported: false,
  enableScripting: false,
  disableFontFace: true,
  useSystemFonts: false,
} as const;
```

```ts
// src/lib/pdfText.extract.ts
import { getResolvedPDFJS } from "unpdf";
import { PDFJS_OPTIONS } from "./pdfText.options.js";

/** Text of the first `maxPages` pages, cut at `maxChars`. Runs in whatever thread calls it: the pool calls it inside a worker. */
export async function extractInThisThread(bytes: Uint8Array, maxPages: number, maxChars: number): Promise<{ text: string; pages: number }> {
  const { getDocument } = await getResolvedPDFJS();
  const pdf = await getDocument({ data: bytes, ...PDFJS_OPTIONS }).promise;
  try {
    const pages = Math.min(pdf.numPages, maxPages);
    let text = "";
    for (let i = 1; i <= pages && text.length < maxChars; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
      page.cleanup();
    }
    return { text: text.slice(0, maxChars), pages };
  } finally {
    await pdf.destroy();
  }
}
```

```ts
// src/lib/pdfText.worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { extractInThisThread } from "./pdfText.extract.js";

const { bytes, maxPages, maxChars } = workerData as { bytes: Uint8Array; maxPages: number; maxChars: number };
extractInThisThread(bytes, maxPages, maxChars)
  .then((r) => parentPort?.postMessage({ ok: true, text: r.text, pages: r.pages }))
  .catch(() => parentPort?.postMessage({ ok: false, reason: "unreadable" }));
```

```ts
// src/lib/pdfText.ts
/**
 * PDF text extraction for the type guess and for AxIS (spec §4.3.2). PDFs are hostile input:
 * each one is read in its own worker thread with a memory cap, terminated at the time limit,
 * at most two at once; the rest wait in a FIFO queue (high priority first: the type guess at
 * import, which gives up after `waitMs` rather than hold an import). Nothing is logged but codes.
 */
import { Worker } from "node:worker_threads";
import { getResolvedPDFJS } from "unpdf";

export const PDF_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 50,
  maxChars: 200_000,
  timeoutMs: 10_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  concurrency: 2,
} as const;

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: "too-large" | "timeout" | "memory" | "unreadable" | "busy" };

type Job = {
  bytes: Uint8Array;
  maxPages: number;
  timeoutMs: number;
  workerUrl: URL;
  priority: "high" | "normal";
  resolve: (r: PdfTextResult) => void;
  giveUp: NodeJS.Timeout | null;
};

// Under tsx (dev, tests) the worker is the .ts file and inherits tsx through execArgv.
const here = import.meta.url;
const DEFAULT_WORKER = new URL(here.endsWith(".ts") ? "./pdfText.worker.ts" : "./pdfText.worker.js", here);

const waiting: Job[] = [];
let running = 0;

export function pdfQueueStats(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}

export async function bundledPdfjsVersion(): Promise<string> {
  const pdfjs = (await getResolvedPDFJS()) as { version?: string };
  return String(pdfjs.version ?? "0.0.0");
}

export function extractPdfText(
  bytes: Uint8Array,
  opts: { maxPages?: number; priority?: "high" | "normal"; waitMs?: number; timeoutMs?: number; workerUrl?: URL } = {}
): Promise<PdfTextResult> {
  if (bytes.byteLength > PDF_LIMITS.maxBytes) return Promise.resolve({ ok: false, reason: "too-large" });
  return new Promise((resolve) => {
    const job: Job = {
      bytes,
      maxPages: Math.min(opts.maxPages ?? PDF_LIMITS.maxPages, PDF_LIMITS.maxPages),
      timeoutMs: opts.timeoutMs ?? PDF_LIMITS.timeoutMs,
      workerUrl: opts.workerUrl ?? DEFAULT_WORKER,
      priority: opts.priority ?? "normal",
      resolve,
      giveUp: null,
    };
    if (opts.waitMs !== undefined) {
      job.giveUp = setTimeout(() => {
        const i = waiting.indexOf(job);
        if (i >= 0) {
          waiting.splice(i, 1);
          resolve({ ok: false, reason: "busy" });
        }
      }, opts.waitMs);
    }
    if (job.priority === "high") {
      const firstNormal = waiting.findIndex((j) => j.priority === "normal");
      waiting.splice(firstNormal < 0 ? waiting.length : firstNormal, 0, job);
    } else {
      waiting.push(job);
    }
    pump();
  });
}

function pump(): void {
  while (running < PDF_LIMITS.concurrency && waiting.length > 0) {
    const job = waiting.shift()!;
    if (job.giveUp) clearTimeout(job.giveUp);
    running++;
    run(job).then((r) => {
      running--;
      job.resolve(r);
      pump();
    });
  }
}

function run(job: Job): Promise<PdfTextResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: PdfTextResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const worker = new Worker(job.workerUrl, {
      workerData: { bytes: job.bytes, maxPages: job.maxPages, maxChars: PDF_LIMITS.maxChars },
      resourceLimits: {
        maxOldGenerationSizeMb: PDF_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: PDF_LIMITS.maxYoungGenerationSizeMb,
      },
      execArgv: process.execArgv,
    });
    // The limit is enforced by killing the thread, not by abandoning a promise.
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), job.timeoutMs);
    worker.on("message", (m: { ok: boolean; text?: string; pages?: number }) =>
      finish(m.ok ? { ok: true, text: String(m.text ?? ""), pages: Number(m.pages ?? 0) } : { ok: false, reason: "unreadable" })
    );
    worker.on("error", (err: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "unreadable" })
    );
    worker.on("exit", () => finish({ ok: false, reason: "unreadable" }));
  });
}
```

Make sure `tsc` emits `pdfText.worker.js` next to `pdfText.js` in `dist/lib/` (it does: it is a normal source file). Add to `tsconfig.json` nothing; confirm after `npm run build` with `ls dist/lib/pdfText.worker.js`.

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --import ./test/env.ts --test test/unit/pdf-text.test.ts && npm test && npm run build && ls dist/lib/pdfText.worker.js && node -e "import('./dist/lib/pdfText.js').then(async m=>{const r=await m.extractPdfText(new Uint8Array(10));console.log(r)})"`
Expected: tests pass; the last command prints `{ ok: false, reason: 'unreadable' }` (proves the compiled worker path loads under plain node).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/pdfText*.ts test/fixtures/pdf test/unit/pdf-text.test.ts
git commit -m "PDF text extraction: unpdf 1.8.1 in capped worker threads, two at a time, queued

Bundled PDF.js 6.1.200 (past CVE-2024-4367), isEvalSupported false, 256 MB
worker heap, terminated at 10 s, 25 MB / 50 pages / 200,000 characters.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The type guess, without AI

**Files:**
- Create: `src/lib/documentGuess.ts`
- Test: `test/unit/document-guess.test.ts`

**Interfaces:**
- Produces:
  - `type GuessKind = "transcript" | "test-report" | "financial" | "iep-504" | "award-letter" | "recommendation-letter" | "resume" | "activity-list"`
  - `type KindGuess = { kind: GuessKind | null; basis: "text" | "filename" | "type" | null; matched: string | null; textFound: boolean; keepOut: boolean }`
  - `guessKind(input: { filename: string; mimeType: string | null; text: string | null }): KindGuess`
  - `GUESS_TEXT_LIMIT = 20_000`, `GUESS_PAGES = 3`

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/document-guess.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guessKind } from "../../src/lib/documentGuess.js";

const g = (filename: string, text: string | null = null, mimeType: string | null = "application/pdf") => guessKind({ filename, mimeType, text });

test("the guesser never imports anything that can call a model", () => {
  const src = readFileSync(new URL("../../src/lib/documentGuess.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports.filter((p) => /anthropic|axis|research|@anthropic-ai/.test(p!)), []);
  assert.ok(imports.every((p) => p!.startsWith("./") || p!.startsWith("node:")), imports.join(","));
});

test("text patterns are the strongest signal", () => {
  assert.deepEqual(g("scan.pdf", "OFFICIAL TRANSCRIPT ... Cumulative GPA 3.91"), { kind: "transcript", basis: "text", matched: "Official Transcript", textFound: true, keepOut: false });
  assert.equal(g("doc.pdf", "Your SAT Score Report from College Board").kind, "test-report");
  assert.equal(g("doc.pdf", "Department of the Treasury Form 1040 U.S. Individual Income Tax Return").kind, "financial");
  assert.equal(g("doc.pdf", "Individualized Education Program annual review").kind, "iep-504");
  assert.equal(g("doc.pdf", "Letter of Recommendation for Jordan").kind, "recommendation-letter");
  assert.equal(g("doc.pdf", "Financial Aid Award for the 2027-28 year").kind, "award-letter");
});

test("sensitive wins every conflict, and comes pre-filled as kept out", () => {
  const r = g("transcript.pdf", "Official Transcript. Cumulative GPA 3.8. FAFSA submitted.");
  assert.equal(r.kind, "financial");
  assert.equal(r.keepOut, true);
  assert.equal(g("essay.pdf", "My IEP taught me to ask for help.").kind, "iep-504");
  assert.equal(g("iep.pdf", null).keepOut, true);
});

test("the kind with more distinct matches wins; a tie is unknown", () => {
  assert.equal(g("x.pdf", "Official Transcript. Cumulative GPA 3.9. SAT total score 1450").kind, "transcript");
  assert.equal(g("x.pdf", "Resume. Activities List").kind, null);
});

test("filename keywords when there is no text, flagged as not read from the text", () => {
  assert.deepEqual(g("Jordan_Transcript_2026.pdf", ""), { kind: "transcript", basis: "filename", matched: "transcript", textFound: false, keepOut: false });
  assert.equal(g("ACT-scores.pdf").kind, "test-report");
  assert.equal(g("2025 taxes 1040.pdf").kind, "financial");
  assert.equal(g("rec letter - Ms Park.docx").kind, "recommendation-letter");
  assert.equal(g("CV.pdf").kind, "resume");
});

test("the Google file type is the weakest signal", () => {
  assert.deepEqual(g("Senior year list", null, "application/vnd.google-apps.spreadsheet"), { kind: "activity-list", basis: "type", matched: "spreadsheet named like a list", textFound: false, keepOut: false });
  assert.equal(g("Budget", null, "application/vnd.google-apps.spreadsheet").kind, null);
});

test("false friends and odd names stay unknown without throwing", () => {
  for (const name of ["Contract.pdf", "Pact essay.docx", "IMG_2041.HEIC", "Relevé de notes – 2026.pdf", "", "actual-draft.pdf", "$1,099 receipt.pdf"]) {
    const r = g(name, null);
    assert.equal(r.kind, null, name);
    assert.equal(r.basis, null, name);
  }
  assert.equal(g("x.pdf", "   ").textFound, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/document-guess.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/lib/documentGuess.ts
/**
 * What a picked file probably is (spec §4.3.1). Pure, no model, no I/O: filename, Google file
 * type and a few printed phrases. The text it reads is used here and dropped; `matched` is one
 * of our own labels below, never document text. A sensitive signal anywhere wins, so a doubtful
 * file errs toward being kept out of AI.
 */

export type GuessKind =
  | "transcript" | "test-report" | "financial" | "iep-504"
  | "award-letter" | "recommendation-letter" | "resume" | "activity-list";

export type KindGuess = {
  kind: GuessKind | null;
  basis: "text" | "filename" | "type" | null;
  matched: string | null;
  textFound: boolean;
  keepOut: boolean;
};

export const GUESS_TEXT_LIMIT = 20_000;
export const GUESS_PAGES = 3;

const SENSITIVE: readonly GuessKind[] = ["financial", "iep-504"];

type Rule = { kind: GuessKind; label: string; re: RegExp };

// Order matters only for picking the label shown; kinds are counted by distinct labels.
const TEXT_RULES: Rule[] = [
  { kind: "financial", label: "Form 1040", re: /\bform\s+1040\b/i },
  { kind: "financial", label: "W-2", re: /\bW-2\b/ },
  { kind: "financial", label: "1099", re: /\b(?:form\s+1099|1099-[a-z]{1,4})\b/i },
  { kind: "financial", label: "Student Aid Report", re: /\bstudent\s+aid\s+report\b/i },
  { kind: "financial", label: "FAFSA", re: /\bFAFSA\b/ },
  { kind: "financial", label: "CSS Profile", re: /\bCSS\s+profile\b/i },
  { kind: "financial", label: "tax return", re: /\btax\s+return\b/i },
  { kind: "iep-504", label: "Individualized Education Program", re: /\bindividuali[sz]ed\s+education\s+(?:program|plan)\b/i },
  { kind: "iep-504", label: "504 Plan", re: /\b504\s+plan\b/i },
  { kind: "iep-504", label: "Section 504", re: /\bsection\s+504\b/i },
  { kind: "iep-504", label: "IEP", re: /\bIEP\b/ },
  { kind: "transcript", label: "Official Transcript", re: /\bofficial\s+transcript\b/i },
  { kind: "transcript", label: "Unofficial Transcript", re: /\bunofficial\s+transcript\b/i },
  { kind: "transcript", label: "Academic Transcript", re: /\bacademic\s+transcript\b/i },
  { kind: "transcript", label: "Cumulative GPA", re: /\bcumulative\s+gpa\b/i },
  { kind: "test-report", label: "Score Report", re: /\bscore\s+report\b/i },
  { kind: "test-report", label: "College Board", re: /\bcollege\s+board\b/i },
  { kind: "test-report", label: "SAT score", re: /\bSAT\b[^.\n]{0,40}\bscores?\b/ },
  { kind: "test-report", label: "ACT score", re: /\bACT\b[^.\n]{0,40}\bscores?\b/ },
  { kind: "test-report", label: "AP Scores", re: /\bAP\s+scores\b/i },
  { kind: "award-letter", label: "Financial Aid Award", re: /\bfinancial\s+aid\s+award\b/i },
  { kind: "award-letter", label: "Award Letter", re: /\baward\s+letter\b/i },
  { kind: "award-letter", label: "Offer of Financial Aid", re: /\boffer\s+of\s+financial\s+aid\b/i },
  { kind: "recommendation-letter", label: "Letter of Recommendation", re: /\bletter\s+of\s+recommendation\b/i },
  { kind: "recommendation-letter", label: "Recommendation for", re: /\brecommendation\s+for\b/i },
  { kind: "resume", label: "Resume", re: /\br[eé]sum[eé]\b/i },
  { kind: "resume", label: "Curriculum Vitae", re: /\bcurriculum\s+vitae\b/i },
  { kind: "activity-list", label: "Activities List", re: /\bactivities\s+list\b/i },
  { kind: "activity-list", label: "Extracurricular Activities", re: /\bextracurricular\s+activities\b/i },
];

const FILENAME_WORDS: Record<string, GuessKind> = {
  transcript: "transcript", transcripts: "transcript",
  "1040": "financial", w2: "financial", "1099": "financial", fafsa: "financial", taxes: "financial", tax: "financial",
  iep: "iep-504", "504": "iep-504",
  score: "test-report", scores: "test-report", sat: "test-report", act: "test-report",
  resume: "resume", cv: "resume",
  recommendation: "recommendation-letter",
  award: "award-letter",
  activities: "activity-list",
};

const SHEETS = new Set([
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const none = (textFound: boolean): KindGuess => ({ kind: null, basis: null, matched: null, textFound, keepOut: false });

function words(filename: string): string[] {
  return filename
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Pick among matches: sensitive first; else the kind with strictly the most distinct labels. */
function pick(matches: { kind: GuessKind; label: string }[]): { kind: GuessKind; label: string } | null {
  if (matches.length === 0) return null;
  const sensitive = matches.find((m) => SENSITIVE.includes(m.kind));
  if (sensitive) return sensitive;
  const counts = new Map<GuessKind, number>();
  for (const m of matches) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) return null;
  return matches.find((m) => m.kind === ranked[0]![0])!;
}

export function guessKind(input: { filename: string; mimeType: string | null; text: string | null }): KindGuess {
  const text = (input.text ?? "").slice(0, GUESS_TEXT_LIMIT);
  const textFound = text.trim().length >= 20;

  const fromText = textFound ? TEXT_RULES.filter((r) => r.re.test(text)).map((r) => ({ kind: r.kind, label: r.label })) : [];
  const ws = words(input.filename);
  const fromName = ws.flatMap((w) => (FILENAME_WORDS[w] ? [{ kind: FILENAME_WORDS[w]!, label: w }] : []));
  if (ws.includes("rec") && ws.includes("letter")) fromName.push({ kind: "recommendation-letter", label: "rec letter" });

  // A sensitive signal anywhere wins, text or filename.
  const sensitive = [...fromText, ...fromName].find((m) => SENSITIVE.includes(m.kind));
  if (sensitive) {
    const basis = fromText.includes(sensitive) ? "text" : "filename";
    return { kind: sensitive.kind, basis, matched: sensitive.label, textFound, keepOut: true };
  }
  const t = pick(fromText);
  if (t) return { kind: t.kind, basis: "text", matched: t.label, textFound, keepOut: false };
  if (fromText.length > 0) return none(textFound); // a tie in the text is unknown, not a filename guess
  const f = pick(fromName);
  if (f) return { kind: f.kind, basis: "filename", matched: f.label, textFound, keepOut: false };
  if (input.mimeType && SHEETS.has(input.mimeType) && ws.includes("list")) {
    return { kind: "activity-list", basis: "type", matched: "spreadsheet named like a list", textFound, keepOut: false };
  }
  return none(textFound);
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --import ./test/env.ts --test test/unit/document-guess.test.ts && npm test`
Expected: green. If a table row fails, fix the rule, not the test, unless the test contradicts the spec (then stop and ask).

- [ ] **Step 5: Commit**

```bash
git add src/lib/documentGuess.ts test/unit/document-guess.test.ts
git commit -m "Type guess without AI: printed phrases, filename, Google file type; sensitive wins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: The extraction queue (durable, two at a time, survives restarts)

**Files:**
- Create: `src/lib/documentExtraction.ts`
- Modify: `src/app.ts` (start the recovery next to `startSweepInterval(app)`)
- Modify: `test/unit/service-callsites.test.ts` (`REVIEWED` gains `"lib/documentExtraction.ts"` with a comment)
- Test: `test/unit/document-extraction.test.ts`; integration `test/integration/document-extraction.test.mjs`

**Interfaces:**
- Consumes: `extractPdfText` (Task 6), `readDocumentText` (`lib/documentText.ts`), `parseSpreadsheet` (`lib/imports/sheet.ts`), `isCounselorApproved` (`lib/access.ts`), `serviceClient`.
- Produces:
  - `extractorFor(mimeType: string | null, filename: string): "pdf" | "text" | "sheet" | "none"`
  - `type ExtractionState = "queued" | "reading" | "done" | "empty" | "failed" | "kept-out" | "unconfirmed" | "none"`
  - `extractionState(row: { kind_confirmed?: unknown; available_to_llm?: unknown; parse_status?: unknown; parse_error?: unknown; extraction_requested_at?: unknown }): ExtractionState`
  - `requestExtraction(ids: string[], log: Log): void` (in-process, FIFO, concurrency 2; ids already marked in the DB by the caller)
  - `runExtraction(id: string, log: Log): Promise<"done" | "empty" | "failed" | "skipped">`
  - `recoverExtractions(log: Log): Promise<number>`
  - `startExtractionRecovery(app: FastifyInstance): void` (onReady + every minute)
  - `LEASE_MS = 120_000`, `MAX_ATTEMPTS = 3` (exported for tests)
  - `leaseVerdict(row: { extraction_attempts: number }): "retry" | "give-up"` (pure: attempts ≥ 3 → give up)

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/document-extraction.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractionState, extractorFor, LEASE_MS, leaseVerdict, MAX_ATTEMPTS } from "../../src/lib/documentExtraction.js";

test("each stored type has one extractor; images and unknowns have none", () => {
  assert.equal(extractorFor("application/pdf", "a.pdf"), "pdf");
  assert.equal(extractorFor(null, "Doc export.PDF"), "pdf");
  assert.equal(extractorFor("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), "text");
  assert.equal(extractorFor("text/plain", "notes.txt"), "text");
  assert.equal(extractorFor(null, "notes.md"), "text");
  assert.equal(extractorFor("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "list.xlsx"), "sheet");
  assert.equal(extractorFor("image/jpeg", "scan.jpg"), "none");
  assert.equal(extractorFor(null, "file.heic"), "none");
});

test("the state the app polls, from the row", () => {
  const at = new Date().toISOString();
  assert.equal(extractionState({ kind_confirmed: false }), "unconfirmed");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: false }), "kept-out");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "pending", extraction_requested_at: at }), "queued");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "parsing", extraction_requested_at: at }), "reading");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "parsed" }), "done");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "skipped", parse_error: "no-text" }), "empty");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "failed" }), "failed");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "pending" }), "none");
  assert.equal(extractionState({ kind_confirmed: true, available_to_llm: true, parse_status: "failed", parse_error: "gave-up" }), "failed");
});

test("an expired lease is retried until the third attempt, then given up", () => {
  assert.equal(leaseVerdict({ extraction_attempts: 1 }), "retry");
  assert.equal(leaseVerdict({ extraction_attempts: 2 }), "retry");
  assert.equal(leaseVerdict({ extraction_attempts: 3 }), "give-up");
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(LEASE_MS, 120_000);
});
```

- [ ] **Step 2: Write the failing integration test**

```js
// test/integration/document-extraction.test.mjs
// Extraction after confirming: stored copy -> parsed_data, two at a time, restart recovery, keep-out mid-queue.
import { call, check, rest, sql } from "./harness.mjs";
import { user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";
import { textPdf } from "../fixtures/pdf/build.ts";

const c = await user("extract");
const s = await studentOf(c, "extract-student");

async function upload(name, bytes, type) {
  const path = `${s.id}/ex-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  const up = await rest(c.token, "POST", `/storage/v1/object/student-documents/${path}`, bytes, { "Content-Type": type });
  if (up.status !== 200) throw new Error(`upload ${up.status}`);
  return sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, mime_type, kind, kind_confirmed, available_to_llm, source)
    values ('${s.id}', '${c.id}', '${path}', '${name}', '${type}', 'other', false, false, 'integration') returning id) select id from d`);
}
const state = async (ids) => (await call(c.token, "GET", `/files/documents/extraction-status?ids=${ids.join(",")}`)).body;
async function until(ids, done, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await state(ids);
    if (done(st)) return st;
    if (Date.now() > end) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const pdf = await upload("t.pdf", textPdf(["Official Transcript", "Cumulative GPA 3.9"]), "application/pdf");
const txt = await upload("n.txt", new TextEncoder().encode("Notes from our meeting about the essay"), "text/plain");
const scan = await upload("scan.pdf", textPdf([""]), "application/pdf");
const keep = await upload("k.pdf", textPdf(["Private"]), "application/pdf");

const confirm = await call(c.token, "POST", "/files/documents/confirm-types", { items: [
  { documentId: pdf, kind: "transcript", keepOut: false },
  { documentId: txt, kind: "other", keepOut: false },
  { documentId: scan, kind: "transcript", keepOut: false },
  { documentId: keep, kind: "transcript", keepOut: false },
] });
check("confirm answers per item", confirm.status === 200 && confirm.body.results.every((r) => r.status === "confirmed"), JSON.stringify(confirm.body));

// Review Focus 2: kept out while queued -> no text.
await call(c.token, "PATCH", `/files/documents/${keep}`, { availableToLlm: false });

const final = await until([pdf, txt, scan, keep], (st) => st.every((r) => !["queued", "reading"].includes(r.state)));
const by = Object.fromEntries(final.map((r) => [r.documentId, r.state]));
check("the PDF's text was extracted", by[pdf] === "done", JSON.stringify(final));
check("the text file's text was extracted", by[txt] === "done");
check("a PDF with no text layer ends empty", by[scan] === "empty");
check("a file kept out after it was queued gets no text", by[keep] === "kept-out"
  && (await sql(`select coalesce(parsed_data->>'text', '') from public.documents where id = '${keep}'`)) === "");
check("the PDF's text is stored", (await sql(`select parsed_data->>'text' from public.documents where id = '${pdf}'`)).includes("Official Transcript"));
check("the request marker is cleared", (await sql(`select count(*) from public.documents where id in ('${pdf}','${txt}','${scan}') and extraction_requested_at is not null`)) === "0");

// Review Focus 1: a crashed in-progress item (expired lease) is retried; after 3 attempts it is failed.
const recover = () => fetch(`${process.env.API_URL ?? "http://127.0.0.1:4100"}/internal/documents/extraction-recover`, {
  method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? "ci-cron-secret-0123456789abcdef0123456789"}` },
});
const anon = await call(c.token, "POST", "/internal/documents/extraction-recover", undefined);
check("recovery is a CRON_SECRET route", anon.status === 401 || anon.status === 403 || anon.status === 503, `status ${anon.status}`);

const orphan = await upload("o.pdf", textPdf(["Score Report"]), "application/pdf");
await sql(`update public.documents set kind = 'test-report', kind_confirmed = true, available_to_llm = true, parse_status = 'parsing',
  extraction_requested_at = now() - interval '10 minutes', extraction_attempts = 1, extraction_lease_until = now() - interval '1 minute' where id = '${orphan}'`);
const res = await recover();
check("recovery runs with the cron secret", res.status === 202, `status ${res.status}`);
const after = await until([orphan], (st) => st[0]?.state === "done");
check("a crashed in-progress item is retried after its lease expires", after[0]?.state === "done", JSON.stringify(after));
check("the retry counted as an attempt", (await sql(`select extraction_attempts::text from public.documents where id = '${orphan}'`)) === "2");

const doomed = await upload("d.pdf", textPdf(["x"]), "application/pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'parsing',
  extraction_requested_at = now() - interval '10 minutes', extraction_attempts = 3, extraction_lease_until = now() - interval '1 minute' where id = '${doomed}'`);
await recover();
const gaveUp = await until([doomed], (st) => st[0]?.state === "failed", 5_000);
check("after 3 attempts the item is marked failed", gaveUp[0]?.state === "failed"
  && (await sql(`select parse_error from public.documents where id = '${doomed}'`)) === "gave-up", JSON.stringify(gaveUp));

const held = await upload("h.pdf", textPdf(["Official Transcript"]), "application/pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'parsing',
  extraction_requested_at = now(), extraction_attempts = 1, extraction_lease_until = now() + interval '2 minutes' where id = '${held}'`);
await recover();
check("a live lease is left alone", (await sql(`select parse_status from public.documents where id = '${held}'`)) === "parsing");

// No backfill: an old pending PDF with no request marker is never touched.
const old = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, mime_type, kind)
  values ('${s.id}', '${c.id}', 'x/old-${Date.now()}.pdf', 'old.pdf', 'application/pdf', 'transcript') returning id) select id from d`);
await recover();
check("no backfill: an old document without a request stays as it was",
  (await sql(`select parse_status from public.documents where id = '${old}'`)) === "pending");
```

(The integration test imports a `.ts` fixture: run it with `node --import tsx test/integration/document-extraction.test.mjs`, and add `--import tsx` to the `test:integration` script in `package.json` so CI does too: `"test:integration": "node --import tsx --test test/integration/*.test.mjs"`.)

- [ ] **Step 3: Run both to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/document-extraction.test.ts` → FAIL (module missing). The integration test fails at confirm (route missing; it lands in Task 10). Write Task 8 and Task 10 code before expecting it to pass; run it at the end of Task 10.

- [ ] **Step 4: Implement `src/lib/documentExtraction.ts`**

```ts
/**
 * Text for AI after a counselor confirms a file's type (spec §4.3; Elvin 10/15: queued, two at
 * a time, progress shown). The queue is in-process; the database is the durable part: a
 * confirmation sets `extraction_requested_at` and leaves `parse_status = 'pending'`, a worker
 * claims a row by moving it to `parsing` under a 2-minute lease (and counts an attempt), and the
 * result clears the marker. Recovery (on boot and every minute) returns an expired lease to the
 * queue, and after 3 attempts marks the row failed, so every item reaches a final state and the
 * app's polling always ends. Rows without the
 * marker (everything that existed before) are never touched: there is no backfill.
 *
 * Runs on the service client, outside the request: every row is re-checked when it runs
 * (still confirmed, still allowed for AI, its counselor still approved), and the text write is
 * conditional on the same, so a file kept out while it waited never gets text.
 */
import type { FastifyInstance } from "fastify";
import { isCounselorApproved } from "./access.js";
import { readDocumentText } from "./documentText.js";
import { parseSpreadsheet } from "./imports/sheet.js";
import { extractPdfText, PDF_LIMITS } from "./pdfText.js";
import { serializeErr } from "./requestLog.js";
import { serviceClient } from "./supabase.js";

type Log = { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
type Row = Record<string, unknown>;

const CONCURRENCY = 2;
export const LEASE_MS = 120_000;
export const MAX_ATTEMPTS = 3;
const RECOVERY_EVERY_MS = 60_000;
const RECOVERY_WINDOW_HOURS = 24;

/** What recovery does with an expired lease. */
export function leaseVerdict(row: { extraction_attempts: number }): "retry" | "give-up" {
  return row.extraction_attempts >= MAX_ATTEMPTS ? "give-up" : "retry";
}

export type ExtractionState = "queued" | "reading" | "done" | "empty" | "failed" | "kept-out" | "unconfirmed" | "none";

export function extractorFor(mimeType: string | null, filename: string): "pdf" | "text" | "sheet" | "none" {
  const m = (mimeType ?? "").toLowerCase();
  const n = filename.toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.includes("spreadsheetml") || n.endsWith(".xlsx")) return "sheet";
  if (m.includes("wordprocessingml") || m === "text/plain" || /\.(docx|txt|md)$/.test(n)) return "text";
  return "none";
}

export function extractionState(row: Row): ExtractionState {
  if (row.kind_confirmed === false) return "unconfirmed";
  if (row.available_to_llm === false) return "kept-out";
  const requested = row.extraction_requested_at != null;
  switch (row.parse_status) {
    case "pending": return requested ? "queued" : "none";
    case "parsing": return "reading";
    case "parsed": return "done";
    case "skipped": return row.parse_error === "no-text" ? "empty" : "none";
    case "failed": return "failed";
    default: return "none";
  }
}

const waiting: string[] = [];
const inQueue = new Set<string>();
let running = 0;

export function requestExtraction(ids: string[], log: Log): void {
  for (const id of ids) {
    if (inQueue.has(id)) continue;
    inQueue.add(id);
    waiting.push(id);
  }
  pump(log);
}

function pump(log: Log): void {
  while (running < CONCURRENCY && waiting.length > 0) {
    const id = waiting.shift()!;
    running++;
    runExtraction(id, log)
      .catch((err) => log.error({ err: serializeErr(err) }, "document extraction failed"))
      .finally(() => {
        running--;
        inQueue.delete(id);
        pump(log);
      });
  }
}

async function textOf(kind: "pdf" | "text" | "sheet", bytes: Uint8Array, filename: string, mimeType: string | null): Promise<{ text: string | null; from: string }> {
  if (kind === "pdf") {
    const r = await extractPdfText(bytes);
    return { text: r.ok ? r.text : null, from: "pdf" };
  }
  if (kind === "text") return { text: readDocumentText(Buffer.from(bytes), filename, mimeType), from: "text" };
  const parsed = await parseSpreadsheet(bytes, filename, 2_000);
  if (!parsed.ok) return { text: null, from: "sheet" };
  const lines = parsed.sheets.flatMap((s) => [s.headers.join(", "), ...s.rows.map((r) => r.join(", "))]);
  return { text: lines.join("\n").slice(0, PDF_LIMITS.maxChars), from: "sheet" };
}

export async function runExtraction(id: string, log: Log): Promise<"done" | "empty" | "failed" | "skipped"> {
  const db = serviceClient();
  if (!db) return "skipped";

  // Claim: only a confirmed, AI-allowed row that a confirmation asked for, once, under a lease.
  // The attempt count is compare-and-set, so two replicas can't both claim the same attempt.
  const { data: current } = await db
    .from("documents")
    .select("extraction_attempts")
    .eq("id", id)
    .eq("parse_status", "pending")
    .not("extraction_requested_at", "is", null)
    .maybeSingle();
  if (!current) return "skipped";
  const attempts = Number(current.extraction_attempts ?? 0);
  if (attempts >= MAX_ATTEMPTS) {
    await db.from("documents").update({ parse_status: "failed", parse_error: "gave-up", extraction_requested_at: null, extraction_lease_until: null }).eq("id", id);
    return "failed";
  }
  const { data: claimed } = await db
    .from("documents")
    .update({ parse_status: "parsing", extraction_attempts: attempts + 1, extraction_lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq("id", id)
    .eq("parse_status", "pending")
    .eq("extraction_attempts", attempts)
    .eq("kind_confirmed", true)
    .eq("available_to_llm", true)
    .not("extraction_requested_at", "is", null)
    .select("id, owner_id, bucket, storage_path, filename, mime_type")
    .maybeSingle();
  if (!claimed) return "skipped";
  const row = claimed as Row;

  const release = async (fields: Row) => {
    await db.from("documents").update({ ...fields, extraction_requested_at: null, extraction_lease_until: null }).eq("id", id);
  };

  if (!(await isCounselorApproved(db, String(row.owner_id)).catch(() => false))) {
    await release({ parse_status: "pending" });
    return "skipped";
  }

  const kind = extractorFor((row.mime_type as string | null) ?? null, String(row.filename ?? ""));
  if (kind === "none") {
    await release({ parse_status: "skipped", parse_error: "no-text" });
    return "empty";
  }

  const file = await db.storage.from(String(row.bucket)).download(String(row.storage_path));
  if (file.error || !file.data) {
    await release({ parse_status: "failed", parse_error: "unreadable" });
    return "failed";
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const { text, from } = await textOf(kind, bytes, String(row.filename ?? ""), (row.mime_type as string | null) ?? null);

  const outcome = text === null ? "failed" : text.trim() ? "done" : "empty";
  const fields: Row =
    outcome === "done"
      ? { parse_status: "parsed", parse_error: null, parsed_data: { text: text!.trim(), extractedFrom: from, extractedAt: new Date().toISOString() } }
      : outcome === "empty"
        ? { parse_status: "skipped", parse_error: "no-text" }
        : { parse_status: "failed", parse_error: "unreadable" };

  // Write only if the file is still confirmed and still allowed for AI.
  const { data: written } = await db
    .from("documents")
    .update({ ...fields, extraction_requested_at: null, extraction_lease_until: null })
    .eq("id", id)
    .eq("parse_status", "parsing")
    .eq("kind_confirmed", true)
    .eq("available_to_llm", true)
    .select("id")
    .maybeSingle();
  if (!written) {
    // Kept out (or retyped) while it waited: no text, and the queue lets go of it.
    await db.from("documents").update({ parse_status: "pending", extraction_requested_at: null, extraction_lease_until: null }).eq("id", id).eq("parse_status", "parsing");
    return "skipped";
  }
  return outcome;
}

export async function recoverExtractions(log: Log): Promise<number> {
  const db = serviceClient();
  if (!db) return 0;
  const since = new Date(Date.now() - RECOVERY_WINDOW_HOURS * 3_600_000).toISOString();
  const now = new Date().toISOString();
  // Expired leases belonged to a process that crashed or hung: retry, or give up after 3 attempts.
  const { data: expired } = await db
    .from("documents")
    .select("id, extraction_attempts")
    .eq("parse_status", "parsing")
    .not("extraction_requested_at", "is", null)
    .lt("extraction_lease_until", now)
    .limit(200);
  for (const r of expired ?? []) {
    const verdict = leaseVerdict({ extraction_attempts: Number(r.extraction_attempts ?? 0) });
    const fields = verdict === "give-up"
      ? { parse_status: "failed", parse_error: "gave-up", extraction_requested_at: null, extraction_lease_until: null }
      : { parse_status: "pending", extraction_lease_until: null };
    await db.from("documents").update(fields).eq("id", String(r.id)).eq("parse_status", "parsing").lt("extraction_lease_until", now);
  }
  const { data, error } = await db
    .from("documents")
    .select("id")
    .eq("parse_status", "pending")
    .gte("extraction_requested_at", since)
    .order("extraction_requested_at")
    .limit(100);
  if (error) {
    log.warn({ err: serializeErr(error) }, "extraction recovery read failed");
    return 0;
  }
  const ids = (data ?? []).map((r) => String(r.id));
  requestExtraction(ids, log);
  return ids.length;
}

export function startExtractionRecovery(app: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  const tick = () => void recoverExtractions(app.log).catch((err) => app.log.error({ err: serializeErr(err) }, "extraction recovery failed"));
  app.addHook("onReady", async () => {
    tick();
    timer = setInterval(tick, RECOVERY_EVERY_MS);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
}
```

Check `isCounselorApproved`'s signature first (`grep -n "export async function isCounselorApproved" -A3 src/lib/access.ts`) and match the argument order. In `src/app.ts`, after `startSweepInterval(app);` add `startExtractionRecovery(app);` and the import.

Add the CRON_SECRET route in `src/routes/internal.ts`, following the existing sweep route in that file (same bearer check helper, 503 without the secret):

```ts
  /** Re-queue confirmed documents whose extraction was asked for and never finished; expire leases (also runs on boot and every minute). */
  app.post("/documents/extraction-recover", { preHandler: requireCronSecret }, async (request, reply) => {
    const queued = await recoverExtractions(request.log);
    return reply.code(202).send({ queued });
  });
```

(Use the file's own name for the bearer-check preHandler; `grep -n "preHandler" src/routes/internal.ts | head -3` shows it. Confirm the prefix: `grep -n "internalRoutes" src/app.ts` should show `/internal`.)

`test/unit/service-callsites.test.ts`: add `"lib/documentExtraction.ts"` to `REVIEWED`, with the comment line `// lib/documentExtraction.ts: after a counselor's confirmation inside their request, and on recovery; re-checks isCounselorApproved per row and writes only that row's text.`

- [ ] **Step 5: Run unit tests**

Run: `npm test && npm run typecheck`
Expected: green (`service-callsites` included).

- [ ] **Step 6: Commit**

```bash
git add src/lib/documentExtraction.ts src/app.ts src/routes/internal.ts test/unit/document-extraction.test.ts test/unit/service-callsites.test.ts test/integration/document-extraction.test.mjs package.json
git commit -m "Extraction queue: stored copy to text, two at a time, durable marker, restart recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Google import arrives unconfirmed with a guess

**Files:**
- Modify: `src/routes/integrations.ts:220-318` (import route)
- Modify: `src/lib/serialize.ts:367-390` (`toDocument` gains `kindConfirmed`, `kindGuess`)
- Test: `test/unit/import-defaults.test.ts` (new)

**Interfaces:**
- Consumes: `guessKind`, `GUESS_PAGES`, `GUESS_TEXT_LIMIT` (Task 7), `extractPdfText` (Task 6), `readDocumentText`, `requestExtraction` (Task 8), `connectedAccountEmail` (Task 4).
- Produces:
  - `importFields(input: { kind: string | undefined; availableToLlm: boolean | undefined; guess: KindGuess }): { kind: string; kind_confirmed: boolean; available_to_llm: boolean; kind_guess: KindGuess | null; requestExtraction: boolean }` (exported from `src/lib/documentGuess.ts`, pure)
  - `guessText(bytes: Uint8Array, mimeType: string, filename: string): Promise<string | null>` (in `src/lib/documentExtraction.ts`)
  - Import response: `toDocument` with `kindConfirmed: boolean`, `kindGuess: KindGuess | null`.
  - Google 404 on the picked file → `HttpError(409, "Meridies can't open that file. It may have been picked with a different Google account, or it's no longer available. Pick it again with {email}.", "picked_file_unavailable")`.

- [ ] **Step 1: Write the failing unit test**

```ts
// test/unit/import-defaults.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { importFields, type KindGuess } from "../../src/lib/documentGuess.js";

const guess: KindGuess = { kind: "transcript", basis: "filename", matched: "transcript", textFound: false, keepOut: false };

test("no kind: unconfirmed, kept out, guess stored, no extraction yet", () => {
  assert.deepEqual(importFields({ kind: undefined, availableToLlm: undefined, guess }), {
    kind: "other", kind_confirmed: false, available_to_llm: false, kind_guess: guess, requestExtraction: false,
  });
  // The client can't open an unconfirmed file to AI.
  assert.equal(importFields({ kind: undefined, availableToLlm: true, guess }).available_to_llm, false);
});

test("a named kind (Essays) is confirmed at once and its text is extracted unless kept out", () => {
  assert.deepEqual(importFields({ kind: "essay", availableToLlm: undefined, guess }), {
    kind: "essay", kind_confirmed: true, available_to_llm: true, kind_guess: null, requestExtraction: true,
  });
  assert.equal(importFields({ kind: "essay", availableToLlm: false, guess }).requestExtraction, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/import-defaults.test.ts`
Expected: FAIL (`importFields` missing).

- [ ] **Step 3: Implement**

Append to `src/lib/documentGuess.ts`:

```ts
/** The documents columns an import writes (spec §4.3): no kind means unconfirmed and kept out. */
export function importFields(input: { kind: string | undefined; availableToLlm: boolean | undefined; guess: KindGuess }) {
  if (input.kind === undefined) {
    return { kind: "other", kind_confirmed: false, available_to_llm: false, kind_guess: input.guess, requestExtraction: false };
  }
  const available = input.availableToLlm ?? true;
  return { kind: input.kind, kind_confirmed: true, available_to_llm: available, kind_guess: null, requestExtraction: available };
}
```

Append to `src/lib/documentExtraction.ts`:

```ts
/** Text for the type guess only: first pages of a PDF (jumps the queue, gives up after 5 s), or a text file. Never stored. */
export async function guessText(bytes: Uint8Array, mimeType: string, filename: string): Promise<string | null> {
  const kind = extractorFor(mimeType, filename);
  if (kind === "pdf") {
    const r = await extractPdfText(bytes, { maxPages: GUESS_PAGES, priority: "high", waitMs: 5_000 });
    return r.ok ? r.text.slice(0, GUESS_TEXT_LIMIT) : null;
  }
  if (kind === "text") return readDocumentText(Buffer.from(bytes), filename, mimeType)?.slice(0, GUESS_TEXT_LIMIT) ?? null;
  return null;
}
```

(import `GUESS_PAGES, GUESS_TEXT_LIMIT` from `./documentGuess.js`.)

In the import route (`src/routes/integrations.ts`):

```ts
      let file;
      try {
        file = await getRemoteFile(request.auth.userId, provider, b.fileId, b.driveId ?? null, request.log);
      } catch (err) {
        if (provider === "google" && err instanceof HttpError && err.code === "not_found") {
          const email = (await connectedAccountEmail(request.auth.userId, "google")) ?? "your connected Google account";
          throw new HttpError(
            409,
            `Meridies can't open that file. It may have been picked with a different Google account, or it's no longer available. Pick it again with ${email}.`,
            "picked_file_unavailable"
          );
        }
        throw err;
      }
      const download = await downloadRemoteFile(request.auth.userId, provider, file, request.log);
      // The guess reads a little text in memory and drops it; nothing from it is stored but the label.
      const guess = b.kind === undefined
        ? guessKind({ filename: file.name, mimeType: file.mimeType, text: await guessText(new Uint8Array(download.bytes), download.mimeType, download.filename) })
        : guessKind({ filename: file.name, mimeType: file.mimeType, text: null });
      const fields = importFields({ kind: b.kind, availableToLlm: b.availableToLlm, guess });
```

Delete the `availableToLlm` / `exportGoogleDocText` lines. In the insert replace `kind`, `available_to_llm`, `parse_status`, `parsed_data` with:

```ts
          kind: fields.kind,
          kind_confirmed: fields.kind_confirmed,
          kind_guess: fields.kind_guess,
          available_to_llm: fields.available_to_llm,
          parse_status: "pending",
          parsed_data: {},
          extraction_requested_at: fields.requestExtraction ? new Date().toISOString() : null,
```

After the `progress_events` insert and before the reply:

```ts
      if (fields.requestExtraction) requestExtraction([String(data.id)], request.log);
```

Imports: `guessKind, importFields` from `../lib/documentGuess.js`; `guessText, requestExtraction` from `../lib/documentExtraction.js`; `connectedAccountEmail` from `../lib/oauth.js`. Remove the unused `exportGoogleDocText` import. Update the route's doc comment (no more Doc text at import; unconfirmed + guess when no kind).

`toDocument` in `src/lib/serialize.ts`, after `ferpaWaived`:

```ts
  /** False for a Drive pick nobody has confirmed yet: out of AI until a type is confirmed. */
  kindConfirmed: r.kind_confirmed !== false,
  /** The server's guess for an unconfirmed file (lib/documentGuess.ts); never document text. */
  kindGuess: (r.kind_guess && typeof r.kind_guess === "object" ? r.kind_guess : null) as
    | { kind: string | null; basis: "text" | "filename" | "type" | null; matched: string | null; textFound: boolean; keepOut: boolean }
    | null,
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documentGuess.ts src/lib/documentExtraction.ts src/routes/integrations.ts src/lib/serialize.ts test/unit/import-defaults.test.ts
git commit -m "Google import: unconfirmed and kept out with a server guess; picked_file_unavailable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Confirm the whole list; extraction status for the progress line

**Files:**
- Modify: `src/routes/files.ts` (new `POST /documents/confirm-types`, new `GET /documents/extraction-status`; `PATCH /documents/:id` confirms and requests extraction when `kind` is set)
- Test: `test/integration/confirm-types.test.mjs` (new); run `test/integration/document-extraction.test.mjs` from Task 8

**Interfaces:**
- Consumes: `requestExtraction`, `extractionState` (Task 8), `toAiDoc`/`documentAiDecision` indirectly via the context layer.
- Produces:
  - `POST /files/documents/confirm-types` body `{ items: { documentId: uuid; kind: DocumentKind; keepOut: boolean }[] }` (1–50, strict) → `200 { results: { documentId; status: "confirmed" | "refused"; reason: string | null; document: DocumentDto | null }[] }`
  - `GET /files/documents/extraction-status?ids=<uuid,…≤50>` → `200 { documentId; state: ExtractionState }[]` (RLS-bound; ids the caller can't see are omitted)
  - `POST /files/documents/extraction-retry` body `{ ids: uuid[] }` (1–50) → `200 { retried: string[] }` (only confirmed, AI-allowed, `failed` rows; resets attempts)

- [ ] **Step 1: Write the failing integration test**

```js
// test/integration/confirm-types.test.mjs
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("confirm");
const other = await user("confirm-other");
const s = await studentOf(c, "confirm-student");
const s2 = await studentOf(other, "confirm-other-student");

const unconfirmed = (studentId, owner, name) => sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind, kind_confirmed, available_to_llm, source, kind_guess)
  values ('${studentId}', '${owner}', 'x/${name}-${Date.now()}-${Math.random()}', '${name}', 'other', false, false, 'integration',
  '{"kind":"transcript","basis":"filename","matched":"transcript","textFound":false,"keepOut":false}') returning id) select id from d`);

const ten = [];
for (let i = 0; i < 10; i++) ten.push(await unconfirmed(s.id, c.id, `f${i}.pdf`));

// A skipped file is still excluded, and reported as one "not categorized" entry.
const ctx = await call(c.token, "GET", `/students/${s.id}/ai-context`);
const omitted = ctx.body?.omitted ?? ctx.body?.contextUsed?.omitted ?? [];
const nc = omitted.find((o) => o.section === "documents" && o.reason === "not-categorized");
check("unconfirmed files are one 'not categorized' entry with a count", nc?.count === 10, JSON.stringify(omitted));

const res = await call(c.token, "POST", "/files/documents/confirm-types", {
  items: ten.map((documentId, i) => ({ documentId, kind: i === 0 ? "financial" : "transcript", keepOut: i === 0 })),
});
check("confirm-all applies every row", res.status === 200 && res.body.results.length === 10 && res.body.results.every((r) => r.status === "confirmed"), JSON.stringify(res.body));
const rows = await sql(`select string_agg(kind || ':' || kind_confirmed::text || ':' || available_to_llm::text, ',' order by filename) from public.documents where id in (${ten.map((t) => `'${t}'`).join(",")})`);
check("each row has its kind, confirmed, and AI access from keepOut", rows.split(",")[0] === "financial:true:false" && rows.split(",").slice(1).every((r) => r === "transcript:true:true"), rows);

// Review Focus 4: one item the caller can't edit doesn't stop the rest.
const mine = await unconfirmed(s.id, c.id, "mine.pdf");
const theirs = await unconfirmed(s2.id, other.id, "theirs.pdf");
const mixed = await call(c.token, "POST", "/files/documents/confirm-types", {
  items: [{ documentId: theirs, kind: "transcript", keepOut: false }, { documentId: mine, kind: "resume", keepOut: false }],
});
const st = Object.fromEntries((mixed.body?.results ?? []).map((r) => [r.documentId, r.status]));
check("a refused item doesn't stop the rest", st[theirs] === "refused" && st[mine] === "confirmed", JSON.stringify(mixed.body));
check("the refused row is untouched", (await sql(`select kind_confirmed::text from public.documents where id = '${theirs}'`)) === "false");

const tooMany = await call(c.token, "POST", "/files/documents/confirm-types", { items: Array.from({ length: 51 }, () => ({ documentId: mine, kind: "resume", keepOut: false })) });
check("over 50 items is refused", tooMany.status === 400, `status ${tooMany.status}`);
const badKind = await call(c.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: mine, kind: "tax-return", keepOut: false }] });
check("an unknown kind is refused", badKind.status === 400, `status ${badKind.status}`);
const student = await call(s.token, "POST", "/files/documents/confirm-types", { items: [{ documentId: mine, kind: "resume", keepOut: false }] });
check("a student can't confirm types", student.status === 403, `status ${student.status}`);

// "Couldn't read this file, try again": a failed file is re-queued; a scan (no text) is not a failure.
const failedDoc = await unconfirmed(s.id, c.id, "broken.pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'failed', parse_error = 'gave-up', extraction_attempts = 3 where id = '${failedDoc}'`);
const scanDoc = await unconfirmed(s.id, c.id, "scan.pdf");
await sql(`update public.documents set kind = 'transcript', kind_confirmed = true, available_to_llm = true, parse_status = 'skipped', parse_error = 'no-text' where id = '${scanDoc}'`);
const before = await call(c.token, "GET", `/files/documents/extraction-status?ids=${failedDoc},${scanDoc}`);
const states = Object.fromEntries(before.body.map((r) => [r.documentId, r.state]));
check("a scan and a failure are distinct states", states[failedDoc] === "failed" && states[scanDoc] === "empty", JSON.stringify(before.body));
const retry = await call(c.token, "POST", "/files/documents/extraction-retry", { ids: [failedDoc, scanDoc] });
check("retry re-queues only the failed file", retry.status === 200 && JSON.stringify(retry.body.retried) === JSON.stringify([failedDoc]), JSON.stringify(retry.body));
check("retry resets the attempts", (await sql(`select extraction_attempts::text from public.documents where id = '${failedDoc}'`)) === "0");

const status = await call(c.token, "GET", `/files/documents/extraction-status?ids=${[mine, theirs].join(",")}`);
check("status omits files the caller can't see", status.status === 200 && status.body.length === 1 && status.body[0].documentId === mine, JSON.stringify(status.body));
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx test/integration/confirm-types.test.mjs` (API running)
Expected: FAIL at "confirm-all applies every row" (404 route).

- [ ] **Step 3: Implement in `src/routes/files.ts`**

Near the other documents routes (import `requestExtraction, extractionState` from `../lib/documentExtraction.js`; reuse `documentBody.shape.kind` for the kind enum):

```ts
  const confirmBody = z
    .object({
      items: z
        .array(z.object({ documentId: z.string().uuid(), kind: documentBody.shape.kind.unwrap(), keepOut: z.boolean() }).strict())
        .min(1)
        .max(50),
    })
    .strict();

  /**
   * "Looks right": confirm a whole list of types at once (spec §4.4). Each item is checked and
   * written on its own, so one the caller can't edit is refused without stopping the rest.
   * Confirmed files the AI may read are queued for text extraction (two at a time).
   */
  app.post(
    "/documents/confirm-types",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("documents:confirm", 60, 60)] },
    async (request) => {
      const b = confirmBody.parse(request.body);
      const results: { documentId: string; status: "confirmed" | "refused"; reason: string | null; document: ReturnType<typeof toDocument> | null }[] = [];
      const queue: string[] = [];
      for (const item of b.items) {
        try {
          const { data: existing } = await request.db.from("documents").select("id, student_id").eq("id", item.documentId).maybeSingle();
          if (!existing?.student_id) throw notFound("That document isn't on file");
          await resolveStudentId(request, String(existing.student_id), "edit");
          const available = !item.keepOut;
          const { data, error } = await request.db
            .from("documents")
            .update({
              kind: item.kind,
              kind_confirmed: true,
              available_to_llm: available,
              parse_status: "pending",
              extraction_requested_at: available ? new Date().toISOString() : null,
              extraction_attempts: 0,
              extraction_lease_until: null,
            })
            .eq("id", item.documentId)
            .select("*")
            .maybeSingle();
          if (error || !data) throw error ? fromPostgrest(error) : notFound();
          if (available) queue.push(item.documentId);
          results.push({ documentId: item.documentId, status: "confirmed", reason: null, document: toDocument(data as Row) });
        } catch (err) {
          results.push({ documentId: item.documentId, status: "refused", reason: publicMessage(err, "Couldn't confirm that file."), document: null });
        }
      }
      requestExtraction(queue, request.log);
      return { results };
    }
  );

  /** "Couldn't read this file, try again": re-queue confirmed, AI-allowed files whose extraction failed. */
  app.post(
    "/documents/extraction-retry",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("documents:extraction-retry", 30, 60)] },
    async (request) => {
      const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict().parse(request.body);
      const { data, error } = await request.db
        .from("documents")
        .update({ parse_status: "pending", parse_error: null, extraction_requested_at: new Date().toISOString(), extraction_attempts: 0, extraction_lease_until: null })
        .in("id", ids)
        .eq("parse_status", "failed")
        .eq("kind_confirmed", true)
        .eq("available_to_llm", true)
        .select("id");
      if (error) throw fromPostgrest(error);
      const retried = (data ?? []).map((r) => String(r.id));
      requestExtraction(retried, request.log);
      return { retried };
    }
  );

  /** Where each file's text extraction is, for the app's "Reading 3 of 10…". RLS decides which ids come back. */
  app.get(
    "/documents/extraction-status",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("documents:extraction-status", 240, 60)] },
    async (request) => {
      const { ids } = z.object({ ids: z.string().max(2_000) }).strict().parse(request.query);
      const list = ids.split(",").map((s) => s.trim()).filter(Boolean);
      const parsed = z.array(z.string().uuid()).min(1).max(50).parse(list);
      const { data, error } = await request.db
        .from("documents")
        .select("id, kind_confirmed, available_to_llm, parse_status, parse_error, extraction_requested_at")
        .in("id", parsed);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => ({ documentId: String(r.id), state: extractionState(r as Row) }));
    }
  );
```

(If `documentBody.shape.kind` is already `.optional()`, `.unwrap()` gives the enum; if it isn't optional, drop `.unwrap()`. Check with `grep -n "const documentBody" -A20 src/routes/files.ts`.)

`PATCH /documents/:id`: after building `update`, when `b.kind !== undefined` also confirm and request extraction:

```ts
      if (b.kind !== undefined) {
        update.kind = b.kind;
        update.kind_confirmed = true;
        const willBeAvailable = b.availableToLlm ?? (existing as Row).available_to_llm !== false;
        update.parse_status = "pending";
        update.extraction_requested_at = willBeAvailable ? new Date().toISOString() : null;
        update.extraction_attempts = 0;
        update.extraction_lease_until = null;
      }
```

(select `available_to_llm` in the `existing` read), and after the update succeeds: `if (update.extraction_requested_at) requestExtraction([id], request.log);`. When only `availableToLlm` flips to false, leave the marker alone: the worker's conditional write (Task 8) refuses to store text for it.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && node --import tsx test/integration/confirm-types.test.mjs && node --import tsx test/integration/document-extraction.test.mjs`
Expected: every line `ok`. Then the context suites that read documents: `node test/integration/context-documents.test.mjs && node test/integration/context-layer.test.mjs`. Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/files.ts test/integration/confirm-types.test.mjs
git commit -m "Confirm types in one batch; extraction status for the progress line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: `picker-config` and the new settings

**Files:**
- Modify: `src/env.ts` (three variables), `.env.example`
- Modify: `src/routes/integrations.ts` (new `GET /google/picker-config`)
- Test: `test/unit/picker-config.test.ts` (pure part), `test/integration/picker-config.test.mjs`

**Interfaces:**
- Produces:
  - env `GOOGLE_PICKER_API_KEY` (string ≥ 10, optional), `GOOGLE_PROJECT_NUMBER` (digits, optional), `GOOGLE_PICKER_MAX_FILES` (int 1–50, default 10)
  - `pickerConfigProblem(e: { clientId?: string; apiKey?: string; projectNumber?: string }): string | null` (exported from `src/lib/oauth.ts`)
  - `GET /integrations/google/picker-config` → `{ clientId, apiKey, appId, accountEmail, maxFiles }`; 503 `picker_not_configured` naming the missing setting; 409 `google_disconnected`; 409 `drive_not_granted`.
  - `/integrations/providers`'s `pickerReady` becomes the real expression (Task 4 left a literal `false`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/picker-config.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerConfigProblem } from "../../src/lib/oauth.js";

test("each missing Picker setting is named", () => {
  assert.match(pickerConfigProblem({}) ?? "", /GOOGLE_CLIENT_ID/);
  assert.match(pickerConfigProblem({ clientId: "cid" }) ?? "", /GOOGLE_PICKER_API_KEY/);
  assert.match(pickerConfigProblem({ clientId: "cid", apiKey: "key" }) ?? "", /GOOGLE_PROJECT_NUMBER/);
  assert.equal(pickerConfigProblem({ clientId: "cid", apiKey: "key", projectNumber: "356256797701" }), null);
});
```

```js
// test/integration/picker-config.test.mjs (local stack has no Google settings)
import { call, check, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("picker");
const pending = await user("picker-pending", "counselor", { approved: false });
const s = await studentOf(c, "picker-student");

const r = await call(c.token, "GET", "/integrations/google/picker-config");
check("without settings the API says Drive isn't set up, naming the setting", r.status === 503 && r.body?.code === "picker_not_configured" && /GOOGLE_/.test(r.body?.error ?? ""), JSON.stringify(r.body));
const prov = await call(c.token, "GET", "/integrations/providers");
check("providers report the Picker as not ready", prov.status === 200 && prov.body.find((p) => p.provider === "google")?.pickerReady === false, JSON.stringify(prov.body));
const st = await call(s.token, "GET", "/integrations/google/picker-config");
check("a student can't read the Picker settings", st.status === 403, `status ${st.status}`);
const p = await call(pending.token, "GET", "/integrations/google/picker-config");
check("an unapproved counselor can't either", p.status === 403, `status ${p.status}`);
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./test/env.ts --test test/unit/picker-config.test.ts` → FAIL. `node test/integration/picker-config.test.mjs` → FAIL (404).

- [ ] **Step 3: Implement**

`src/env.ts`, next to the Google client settings:

```ts
  GOOGLE_PICKER_API_KEY: blankIsUnset(z.string().min(10).optional()),
  GOOGLE_PROJECT_NUMBER: blankIsUnset(z.string().regex(/^\d{6,20}$/, "GOOGLE_PROJECT_NUMBER must be the Cloud project number").optional()),
  GOOGLE_PICKER_MAX_FILES: blankIsUnset(z.coerce.number().int().min(1).max(50).default(10)),
```

`.env.example`:

```
# Google Picker (picked files only). The API key is public by nature: restrict it in Google Cloud
# to the Picker API and the app's origin. The project number is the Picker's appId.
GOOGLE_PICKER_API_KEY=
GOOGLE_PROJECT_NUMBER=
GOOGLE_PICKER_MAX_FILES=10
```

`src/lib/oauth.ts`:

```ts
export function pickerConfigProblem(e: { clientId?: string; apiKey?: string; projectNumber?: string }): string | null {
  if (!e.clientId) return "Google Drive isn't set up on this server yet (missing GOOGLE_CLIENT_ID).";
  if (!e.apiKey) return "Google Drive isn't set up on this server yet (missing GOOGLE_PICKER_API_KEY).";
  if (!e.projectNumber) return "Google Drive isn't set up on this server yet (missing GOOGLE_PROJECT_NUMBER).";
  return null;
}
```

`src/routes/integrations.ts`, before `/:provider/files` (static routes win in Fastify, but keep it visible near the files routes):

```ts
  /**
   * What the browser needs to open Google Picker (spec §4.2). The API key is public by nature and
   * restricted in Google Cloud; no token or secret is returned. The browser gets its own
   * drive.file-only token from Google.
   */
  app.get(
    "/google/picker-config",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("integrations:picker-config", 60, 60),
      ],
    },
    async (request) => {
      const problem = pickerConfigProblem({ clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_PICKER_API_KEY, projectNumber: env.GOOGLE_PROJECT_NUMBER });
      if (problem) throw new HttpError(503, problem, "picker_not_configured");
      const token = await accessTokenFor(request.auth.userId, "google"); // 409 google_disconnected / google_reconnect
      if (!hasScope(token, GOOGLE_SCOPE.driveFile)) {
        throw new HttpError(409, "Meridies needs access to the files you pick. Connect Google again and leave Drive ticked.", "drive_not_granted");
      }
      return {
        clientId: env.GOOGLE_CLIENT_ID,
        apiKey: env.GOOGLE_PICKER_API_KEY,
        appId: env.GOOGLE_PROJECT_NUMBER,
        accountEmail: token.accountEmail,
        maxFiles: env.GOOGLE_PICKER_MAX_FILES,
      };
    }
  );
```

Imports: `env` from `../env.js`; `accessTokenFor, GOOGLE_SCOPE, hasScope, pickerConfigProblem` from `../lib/oauth.js`; `unavailable` from `../lib/errors.js`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck && node test/integration/picker-config.test.mjs`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/env.ts .env.example src/lib/oauth.ts src/routes/integrations.ts test/unit/picker-config.test.ts test/integration/picker-config.test.mjs
git commit -m "GET /integrations/google/picker-config and the Picker settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Docs, the hand smoke test, and PR 1

**Files:**
- Modify: `AGENTS.md` (Connected apps; Documents and AI context; Environment table; a "Later: text backfill" note)
- Modify: `LAUNCH_CHECKLIST.md:130-140`, `DATABASE_MIGRATION_INSTRUCTIONS.md:234`
- Create: `scripts/smoke/google-picker.md`, `scripts/smoke/google-picker.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation and a by-hand check; no runtime code beyond the smoke script.

- [ ] **Step 1: AGENTS.md**

Replace the Connected apps paragraphs that describe `drive.readonly`, "lists Drive/OneDrive files" and "Google also asks for drive.file (added in the v10 sync)" with:

```md
**Google is picked files only** (spec `docs/superpowers/specs/2026-10-14-google-connector-design.md`). Connect asks for
`openid`, `email` and `drive.file`; turning Calendar on (`GET /integrations/google/authorize?add=calendar`) adds
`calendar.events`, with `login_hint` set to the connected account. The callback keeps only those scopes (plus
`userinfo.email`): anything else, such as an old `drive.readonly`, is revoked and answered 409 `google_reconnect`;
a consent signed in as a different Google account than the connected one is refused with 409 `google_other_account`.
The browser picks files in Google Picker with its own `drive.file`-only token (`include_granted_scopes: false`),
using `GET /integrations/google/picker-config`; the server imports each pick with the stored grant. Under
`drive.file`, `GET /integrations/google/files` returns only files the app can already reach (earlier picks and
supplement Docs). A Google 404 on a picked file is 409 `picked_file_unavailable`. Codes on grant problems:
`google_disconnected`, `google_reconnect`, `drive_not_granted`, `calendar_not_enabled`.
```

In "Documents and AI context" add:

```md
**Unconfirmed files.** A Google import that names no kind is `kind_confirmed = false`, `available_to_llm = false`,
with the server's guess in `kind_guess` (`lib/documentGuess.ts`: printed phrases, filename, Google file type; no
model). `POST /files/documents/confirm-types` confirms a list at once and queues text extraction for files the AI
may read (`lib/documentExtraction.ts`: stored copy, two at a time, durable `extraction_requested_at`, a 2-minute
lease per claim, recovery on boot, every minute and at `POST /internal/documents/extraction-recover`, failed after
3 attempts; `POST /files/documents/extraction-retry` re-queues a failed file). A scan is `skipped` / `no-text`
(state `empty`), never `failed`. PDFs go through `lib/pdfText.ts`
(unpdf 1.8.1 / PDF.js 6.1.200 pinned, `isEvalSupported: false`, worker thread capped at 256 MB, terminated at 10 s,
25 MB / 50 pages / 200,000 characters). **Every reader of documents uses `lib/context/documentAi.ts`:**
`documentAiDecision` for the context layer and AxIS retrieval, `documentReadableForTask` for the tracker and
submission review. A new reader must use one of them; `kind_confirmed = false` is refused by both.

**Later, not built: text backfill.** Existing documents are never extracted. If wanted, write
`scripts/backfill-document-text.ts`: dry run by default (counts), `--apply` to run, scoped by `--practice` or
`--student`, only confirmed, AI-allowed documents without `parsed_data`, by setting `extraction_requested_at` a
few at a time so the same queue and limits do the work; log counts only.
```

Environment table: add rows for `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`, `GOOGLE_PICKER_MAX_FILES` with the `.env.example` wording. Update the `src/` tree in AGENTS.md with `documentGuess.ts`, `documentExtraction.ts`, `pdfText.ts` (+ `.extract`, `.options`, `.worker`).

- [ ] **Step 2: LAUNCH_CHECKLIST.md and DATABASE_MIGRATION_INSTRUCTIONS.md**

`LAUNCH_CHECKLIST.md:130-140`: Google connects picked files (`drive.file`) and Calendar on request; no Gmail; no restricted scope, so no CASA; Railway variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, new `INTEGRATION_TOKEN_KEY`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`) only after the backend and app PRs are both live. `DATABASE_MIGRATION_INSTRUCTIONS.md:234`: the reconnect note says Google now asks for `openid email drive.file` (Calendar later); there are no existing production connections to reconnect.

- [ ] **Step 3: The hand smoke test**

`scripts/smoke/google-picker.md`: the nine steps of spec §7 "End-to-end check", verbatim, each with the expected observation, plus: "Step 7 tokeninfo: in the browser console after a pick, `fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + token).then(r => r.json())` → `scope` is exactly `https://www.googleapis.com/auth/drive.file`." and "Step 8: record whether `about.get` answered 200 under `drive.file`; if not, file it against the app's same-account step."

`scripts/smoke/google-picker.ts` (server-side half: can the stored grant open a document's Drive file, and does it get 404 on an id never picked):

```ts
/**
 * By-hand check (scripts/smoke/google-picker.md, step 3). Localhost only unless SMOKE_ALLOW_REMOTE=1.
 *   npx tsx --env-file=.env scripts/smoke/google-picker.ts <documentId> [<unpickedFileId>]
 * Reads the document's external_file_id with its owner's stored grant (metadata only), then, if
 * given, a file id that was never picked, which must answer 404.
 */
import { env } from "../../src/env.js";
import { getRemoteFile } from "../../src/lib/suiteApi.js";
import { serviceClient } from "../../src/lib/supabase.js";

const [documentId, unpicked] = process.argv.slice(2);
if (!documentId) throw new Error("usage: google-picker.ts <documentId> [<unpickedFileId>]");
if (!/127\.0\.0\.1|localhost/.test(env.SUPABASE_URL) && process.env.SMOKE_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing a non-local database without SMOKE_ALLOW_REMOTE=1");
}
const log = { warn: (o: object, m: string) => console.warn(m, o) };
const db = serviceClient();
if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
const { data: doc } = await db.from("documents").select("owner_id, external_file_id").eq("id", documentId).single();
const file = await getRemoteFile(String(doc!.owner_id), "google", String(doc!.external_file_id), null, log);
console.log("picked file readable:", file.name, file.mimeType);
if (unpicked) {
  try {
    await getRemoteFile(String(doc!.owner_id), "google", unpicked, null, log);
    console.log("UNEXPECTED: an unpicked file was readable. setAppId or the scope is wrong.");
    process.exitCode = 1;
  } catch (err) {
    console.log("unpicked file refused as expected:", (err as Error).message);
  }
}
```

- [ ] **Step 4: Full verification**

Run, with the local stack and API up:

```bash
npm run typecheck && npm run build && npm test
npm run test:integration
grep -rn "drive.readonly\|gmail.send" src | grep -v "test\|disallowed\|//" || echo "none left"
```

Expected: all green; the grep prints `none left` (any hit outside the allowlist test and comments is a leftover to remove). CI (`.github/workflows/ci.yml`) runs the same on the PR.

- [ ] **Step 5: Commit and open PR 1**

```bash
git add AGENTS.md LAUNCH_CHECKLIST.md DATABASE_MIGRATION_INSTRUCTIONS.md scripts/smoke/google-picker.md scripts/smoke/google-picker.ts
git commit -m "Docs and the by-hand Picker check for the Google connector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/google-connector
gh pr create --repo MeridiesAI/meridies-backend --base main \
  --title "Google connector: picked files only, Calendar on request, confirmed types, PDF text" \
  --body "Implements spec PR #55 (rev 5) with the queue-and-progress addition. **Do not merge until PR 0's migration is applied on production and verified** (plan Task 13); \`REQUIRED_SCHEMA\` holds the deploy if it isn't.

## What
- Google asks for \`openid email drive.file\`; Calendar adds \`calendar.events\` on request. Scope allowlist and same-account rule on every consent. \`drive.readonly\` and \`gmail.send\` are gone.
- \`GET /integrations/google/picker-config\`; imports with no kind arrive unconfirmed, kept out of AI, with a server-side type guess (no model).
- \`POST /files/documents/confirm-types\` (1–50, per-item results) and \`GET /files/documents/extraction-status\`. Confirmed files are read from the stored copy, two at a time, in a durable queue that survives restarts.
- PDFs: unpdf 1.8.1 (PDF.js 6.1.200, past CVE-2024-4367), \`isEvalSupported: false\`, worker thread with a 256 MB cap terminated at 10 s, 25 MB / 50 pages / 200,000 characters. No backfill.
- Every document reader refuses unconfirmed files. Tracker: no \"no activity\" verdict while Google is disconnected; \`liveStatus\` on every verdict.

## Decided in the plan (please confirm)
1. The tracker and submission review use \`documentReadableForTask\` (unconfirmed, keep-out, waived, practice switch, excluded, and sensitive kinds out; essays and other files in) instead of the context layer's full rule, which would stop the tracker reading essays.
2. Text after confirming comes from the stored copy for every type, not Drive's export.
3. A scan is \`parse_status = 'skipped'\`, \`parse_error = 'no-text'\` (reported as \`empty\`).

## Safe to merge with no Google variables on Railway
Every Google route answers 503 until \`GOOGLE_*\` is set, which happens only after the app PR is live too.

## Tests
Unit: oauth, suite API, document AI rules, live documents, guess, PDF extraction (version, eval flag, embedded JS, caps, termination, memory, queue order), extraction states, import defaults, picker config. Integration: migration, confirm-types, extraction (incl. restart recovery and keep-out mid-queue), picker-config. By hand: \`scripts/smoke/google-picker.md\`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

### Task 13: Release checklist (Elvin, with Claude verifying)

Not code. Do these in order and tick them in PR 1's description.

- [ ] PR 0 merged by Elvin. The "Apply migrations" run's plan lists exactly `20261024000001_documents_kind_confirmation` (anything else pending: stop and read the runbook). An approver applies it.
- [ ] Claude verifies on production, read-only (`mcp__supabase__execute_sql`):

```sql
select column_name, data_type, is_nullable, column_default from information_schema.columns
where table_schema = 'public' and table_name = 'documents'
  and column_name in ('kind_confirmed', 'kind_guess', 'extraction_requested_at', 'extraction_attempts', 'extraction_lease_until') order by 1;
select indexname from pg_indexes where tablename = 'documents' and indexname like 'documents_%idx' order by 1;
select count(*) filter (where kind_confirmed = false) as unconfirmed, count(*) filter (where extraction_requested_at is not null) as requested from public.documents;
```

  Expected: five columns as specified; both indexes; `0, 0`.
- [ ] PR 1 merged by Elvin; `/health` on the new deployment reports `schema: true`.
- [ ] The app PR (`2026-10-15-google-connector-app.md`) is merged by bcha and live.
- [ ] Elvin sets on Railway: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the verified rotated secret), new `INTEGRATION_TOKEN_KEY` (`openssl rand -base64 32`, never changed afterwards), `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER` (356256797701).
- [ ] The §7 end-to-end check on production with a test account (`scripts/smoke/google-picker.md`).
- [ ] Submit `calendar.events` for Google verification.

---

## Self-review (done while writing; kept for the executor)

- **Spec coverage:** §4.1 → Task 4; §4.2 server side → Tasks 9, 11; §4.3 import/confirm/extraction/readers/essays/tracker/config/docs/migration → Tasks 1, 2, 3, 5, 8, 9, 10, 11, 12; §4.3.1 → Task 7; §4.3.2 → Task 6; §4.5 caseload note → AGENTS.md only (no code: cleared pointers already stop tracking); §4.6 → Tasks 4, 6, 8; §5 / §9.4 → Task 13; §7 → tests in each task + Task 12 smoke; Elvin's queue/progress addition → Tasks 6, 8, 10 (status route; the progress line itself is the app plan). Microsoft's `Mail.Send` follow-up (§9.3) is a separate one-line PR, not in this plan.
- **Names used across tasks:** `toAiDoc`, `documentAiDecision`, `documentReadableForTask`, `guessKind`, `importFields`, `KindGuess`, `extractPdfText`, `extractionState`, `requestExtraction`, `recoverExtractions`, `guessText`, `connectedAccountEmail`, `pickerConfigProblem`, `GOOGLE_SCOPE`, `GOOGLE_FILE_SCOPE`, `GOOGLE_CALENDAR_SCOPE`: each defined once (Tasks 2, 7, 9, 6, 8, 8, 8, 9, 4, 11, 4, 5, 5).
- **Known judgment calls for review:** the three deviations in Global Constraints; an essay that mentions its IEP is guessed `iep-504` and kept out (sensitive wins, the safe direction; the counselor corrects it in one click).
