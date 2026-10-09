# Import Pipeline — Step 1 (Foundation + Lost-Data Fix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the database foundation of the import pipeline (tables, access rules, the `imports` bucket, the change list), the save/undo/apply machinery that runs as background jobs on a restricted database login, the "Ready to apply" queue that fixes today's lost-data bug, and the GPA-scale audit, all without any upload or parsing code (that is step 2).

**Architecture:** Eight additive SQL migrations hold the schema and every write path (`commit_import`, `undo_import`, `apply_held_item`) as `SECURITY DEFINER` functions with fixed, per-target SQL, no dynamic SQL. Browsers only *request* a job through small RLS-checked functions; the Fastify backend then runs the job inside one transaction on a `pg` connection that logs in as `import_worker`, a role that can do nothing but execute those functions. A cron route sweeps stuck jobs, expires held data, sends expiry warnings and compacts old change values.

**Tech Stack:** Supabase Postgres 15 (plpgsql, RLS, Storage), Fastify 5, TypeScript strict (ESM, NodeNext), `pg` (new), `zod`, Node's test runner (`node:test` via tsx) for unit tests, `.mjs` persona scripts (`test/integration/harness.mjs`) for integration tests, `fast-check` (new, dev).

**Spec:** `docs/superpowers/specs/2026-10-09-import-pipeline-design.md` (v2 + round 5). Plain-English summary: `docs/superpowers/specs/2026-10-09-import-pipeline-plain-english.md`. If they disagree, the full spec wins; if this plan and the spec disagree, stop and ask.

## Global Constraints

- Repo: `meridies-backend`. Work on a branch `feat/imports-step1` from `main`. **Open PRs only; never merge. Never run `supabase db push` against production; never apply migrations to production.** Migrations are tested locally with `supabase start` / `supabase db reset`.
- Migrations are additive and idempotent (`if not exists`, `drop … if exists` before `create`, `on conflict do nothing`). Every new public table enables RLS in the same file that creates it (CI fails otherwise).
- Every new `SECURITY DEFINER` function: `set search_path = ''`, fully qualified names (`public.`, `private.`), `revoke all … from public, anon` and explicit grants.
- **No dynamic SQL** in any import function: no `execute`, no `format('%I')`. Targets and fields are chosen with `case`/`if` over fixed names.
- Import targets are exactly: `student_academics`, `student_personal_details` (single-row), `test_scores`, `courses`, `activities` (multi-row).
- Undo window: **30 days** (`undo_until = committed_at + interval '30 days'`). Held data after acceptance: **30 days** (`held_until`), warning **7 days** before. Statement timeout for a job transaction: **`300s`**. Max rows per import: **5,000** in total.
- `IMPORT_DATABASE_URL` must log in as **`import_worker`**; the backend refuses to run import jobs (and exits at boot) if `current_user` is anything else. Production uses Supabase's **session pooler**, never the transaction pooler.
- TypeScript: strict, no `any`, ESM imports with `.js` extensions, Zod `.strict()` on request bodies, thin route handlers with logic in `src/lib/imports/`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit after every task (more often is fine).
- Error messages shown to counselors are plain sentences (e.g. "Couldn't save. Nothing was changed. Try again.").

### Running things locally (used by every task)

```bash
# once per machine: start the local stack from the repo root (uses supabase/config.toml)
supabase start
# after adding or editing a migration: rebuild the local database from every migration
supabase db reset
# load the env the integration harness needs
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)=' \
  | sed -e 's/^API_URL=/export SUPABASE_URL=/' -e 's/^ANON_KEY=/export SUPABASE_ANON_KEY=/' \
        -e 's/^SERVICE_ROLE_KEY=/export SUPABASE_SERVICE_ROLE_KEY=/' -e 's/^DB_URL=/export DB_URL=/')"
# give the restricted login a local password (local/CI only; production is done by hand)
psql "$DB_URL" -c "alter role import_worker login password 'local-import-worker-pw'"
export IMPORT_DATABASE_URL="postgresql://import_worker:local-import-worker-pw@127.0.0.1:54322/postgres"
# API for route tests (separate terminal, same env):
PORT=4100 CRON_SECRET=local-test-cron-secret-0123456789abcdef npx tsx src/index.ts
# a single integration script:
API_URL=http://127.0.0.1:4100 CRON_SECRET=local-test-cron-secret-0123456789abcdef node test/integration/<file>.test.mjs
```

An integration script passes when every line prints `PASS` and the exit code is 0.

## Review Focus

1. **A GPA of 92 next to a 4.0-scale school** — commit must report "needs a 100-point scale" in the validation list, never half-write; the Close-cycle function and fit/odds must not crash or treat 92 as excellent (tests in Task 5 and Task 12).
2. **Undo after the student edited a field** — the student's value must survive and the change must be reported as kept (`undo_skipped`), including when only the GPA was edited but the scale is being undone (Task 6 test "scale undo that would break the GPA is skipped").
3. **A held item whose accepting account has a different name** — applying must be refused until the counselor types the student's name (Task 10 test).
4. **A double-clicked Save / two tabs** — exactly one job runs, the second request gets 409 "already being saved", no change applied twice (Task 5 SQL test + Task 10 API test).
5. **The backend pointed at the `postgres` superuser connection string** — the server must refuse at boot, not quietly run jobs with RLS bypassed (Task 8 test).

---

## File Structure

**Create — migrations** (`supabase/migrations/`), each one responsibility:
- `20261014000001_imports_schema.sql` — tables, columns, `import_fields` seed, GPA widening, `source` on `test_scores`/`courses`, firm stamping, client guard trigger, heartbeat job name, RLS enabled (no policies yet).
- `20261014000002_imports_access.sql` — `can_view_import`, `can_manage_import`, `import_can_write_student`, table policies and grants, the `imports` bucket and its storage policies, the `import_worker` role.
- `20261014000003_imports_values.sql` — value checking (`import_value_ok`), hashing, `import_current_value`, the validation trigger, `import_validate`.
- `20261014000004_imports_apply.sql` — `import_set_field` (compare-and-set), `import_insert_row`, `import_row_snapshot`, `import_delete_row`.
- `20261014000005_imports_commit.sql` — `request_import_commit`, `commit_import`, `fail_import_job`, `import_jobs_due`.
- `20261014000006_imports_undo.sql` — `request_import_undo`, `undo_import`.
- `20261014000007_imports_held.sql` — `accept_invitation` (redefined), `import_hold_legacy_rows`, `import_held_queue`, `request_held_apply`, `apply_held_item`, `expire_import_holds`.
- `20261014000008_imports_provenance_and_gpa.sql` — `import_field_provenance`, `compact_imports`, `close_admission_cycle` GPA guard.

**Create — backend code:**
- `src/lib/imports/db.ts` — the `import_worker` pool, role check, one-transaction helper.
- `src/lib/imports/jobs.ts` — run/kick a job, the sweep.
- `src/lib/imports/names.ts` — the name-matching rule (spec §4.4).
- `src/lib/imports/errors.ts` — Postgres error → HTTP error for import functions.
- `src/lib/gpa.ts` — scale-aware GPA helpers.
- `src/routes/imports.ts` — `GET /imports/held`, `GET /imports/:id`, `POST /imports/:id/commit`, `POST /imports/:id/undo`, `POST /imports/held/:itemId/apply`.

**Create — tests:**
- `test/unit/import-names.test.ts`, `test/unit/gpa.test.ts`, `test/unit/import-db.test.ts`
- `test/integration/imports-helpers.mjs` (shared fixtures)
- `test/integration/imports-schema.test.mjs`, `imports-values.test.mjs`, `imports-commit.test.mjs`, `imports-undo.test.mjs`, `imports-held.test.mjs`, `imports-provenance.test.mjs`, `imports-api.test.mjs`, `imports-undo-property.test.mjs`
- `test/integration/imports-load.mjs` (not matched by `*.test.mjs`; run before release)

**Modify:**
- `test/integration/harness.mjs` — export `SB`, `ANON`, add `rest()` and `sqlAsync()`.
- `src/env.ts` — `IMPORT_DATABASE_URL`, `hasImportWorker`.
- `src/index.ts` — verify the worker role at boot.
- `src/app.ts` — register `importRoutes` at `/imports`.
- `src/routes/internal.ts` — `POST /internal/imports/sweep`.
- `src/lib/heartbeat.ts` — `"import-sweep"` job.
- GPA call sites: `src/routes/collegesV10.ts`, `src/lib/studentPage.ts`, `src/lib/studentAid.ts`, `src/routes/outcomes.ts`, `src/routes/applicationAi.ts`, `src/routes/overviewSummaries.ts`, `src/routes/students.ts`, `src/routes/records.ts`.
- `package.json` (deps + `test:imports-load`), `.env.example`, `.github/workflows/ci.yml`, `AGENTS.md`, spec §15 (one line).

**Separate repo, separate PR (Task 13):** `meridies-app` — show the GPA scale wherever GPA is shown.

---

### Task 1: Schema migration and shared test fixtures

**Files:**
- Create: `supabase/migrations/20261014000001_imports_schema.sql`
- Modify: `test/integration/harness.mjs`
- Create: `test/integration/imports-helpers.mjs`
- Test: `test/integration/imports-schema.test.mjs`

**Interfaces:**
- Consumes: existing `public.roster_imports`, `public.roster_import_rows`, `public.invitations`, `public.profiles`, `public.firms`, `private.crm_workspace_firm(uuid) returns uuid`, `public.set_updated_at()`.
- Produces: tables `public.import_fields`, `public.import_templates`, `public.import_files`, `public.import_items`, `public.import_changes`; new `roster_imports` columns (`firm_id, source_system, template_id, permission_confirmed_by, permission_confirmed_at, committed_at, undone_at, expires_at, undo_until, compacted_at, ai_spend_cents, job_actor, job_requested_at, job_error, job_result`); `student_academics.gpa_*` as `numeric(6,3)` with constraint `student_academics_gpa_range`; `test_scores.source`, `courses.source`; heartbeat job `import-sweep`. Harness exports `SB`, `ANON`, `rest(token, method, path, body)`, `sqlAsync(query)`. Helpers module exports listed in Step 3.

- [ ] **Step 1: Create the branch**

```bash
cd meridies-backend && git switch main && git pull --ff-only && git switch -c feat/imports-step1
```

- [ ] **Step 2: Extend the harness**

In `test/integration/harness.mjs`, change the two `const` lines for `SB` and `ANON` to exports, and add two helpers at the end of the file:

```js
export const SB = need("SUPABASE_URL");
export const ANON = need("SUPABASE_ANON_KEY");
```

```js
/** PostgREST / Storage as a signed-in user (RLS applies). `path` starts with /rest/v1 or /storage/v1. */
export async function rest(token, method, path, body, headers = {}) {
  const isJson = body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string";
  const r = await fetch(SB + path, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, ...(isJson ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

/** Like sql(), but async, so two statements can race (concurrency tests). */
export async function sqlAsync(query) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) =>
    execFile(PSQL, [DB_URL, "-tAc", query], (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())))
  );
}
```

- [ ] **Step 3: Write the shared fixtures**

Create `test/integration/imports-helpers.mjs`:

```js
// Fixtures for the import-pipeline suites. Everything here writes as the
// postgres superuser through psql, the way step 2's staging code will write
// as the backend: the browser never inserts items or changes.
import { sql, user } from "./harness.mjs";

export const q = (s) => String(s).replace(/'/g, "''");
export const lit = (v) => (v === null || v === undefined ? "null" : `'${q(JSON.stringify(v))}'::jsonb`);

/** A student account on `counselor`'s roster. */
export async function studentOf(counselor, tag = "student") {
  const s = await user(tag, "student");
  await sql(`update public.profiles set counselor_id = '${counselor.id}' where id = '${s.id}'`);
  return s;
}

/** A firm owned by `owner`, with `members` (seat 'counselor'); profiles.firm_id set for all. */
export async function firmWith(owner, members = []) {
  const firmId = await sql(`with f as (insert into public.firms (name, owner_id) values ('Test firm ${Date.now()}', '${owner.id}') returning id) select id from f`);
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${owner.id}', 'owner') on conflict do nothing`);
  for (const m of members) {
    await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${m.id}', 'counselor') on conflict do nothing`);
  }
  await sql(`update public.profiles set firm_id = '${firmId}' where id in (${[owner, ...members].map((u) => `'${u.id}'`).join(",")})`);
  return firmId;
}

/** A new-pipeline import in `status` (default 'review'). */
export async function makeImport(counselor, { status = "review", sourceSystem = "unknown" } = {}) {
  return sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status, source_system)
    values ('${counselor.id}', 'test.csv', 'csv', '${status}', '${sourceSystem}') returning id) select id from i`);
}

/** An item matched to `studentId` (or a new_invite when studentId is null). */
export async function addItem(importId, { studentId = null, status = "matched_email", name = "Test Student", invitationId = null } = {}) {
  return sql(`with i as (insert into public.import_items (import_id, match_status, student_id, invitation_id, imported_name, match_confidence)
    values ('${importId}', '${status}', ${studentId ? `'${studentId}'` : "null"}, ${invitationId ? `'${invitationId}'` : "null"}, '${q(name)}', 'high') returning id) select id from i`);
}

/**
 * A staged change. old_value is read from the database the way staging will
 * (private.import_current_value), unless `oldValue` is given explicitly.
 */
export async function addChange(importId, itemId, { target, field, value, op = "set_field", decision = "accept", studentId = null, oldValue }) {
  const old =
    oldValue !== undefined
      ? lit(oldValue)
      : op === "set_field" && studentId
        ? `private.import_current_value('${target}', '${field}', '${studentId}')`
        : "null";
  return sql(`with c as (insert into public.import_changes (import_id, item_id, target_table, field, op, old_value, new_value, decision, source_ref)
    values ('${importId}', '${itemId}', '${target}', '${field}', '${op}', ${old}, ${lit(value)}, '${decision}', 'Sheet1!A1') returning id) select id from c`);
}

export async function importRow(importId) {
  return JSON.parse(await sql(`select row_to_json(i) from public.roster_imports i where id = '${importId}'`));
}

export async function changeRow(changeId) {
  return JSON.parse(await sql(`select row_to_json(c) from public.import_changes c where id = '${changeId}'`));
}

export async function academics(studentId) {
  const raw = await sql(`select row_to_json(a) from public.student_academics a where student_id = '${studentId}'`);
  return raw ? JSON.parse(raw) : null;
}
```

- [ ] **Step 4: Write the failing test**

Create `test/integration/imports-schema.test.mjs`:

```js
// Import pipeline step 1, Task 1: the schema exists and enforces its shape.
import { check, sql, user } from "./harness.mjs";
import { makeImport, studentOf, firmWith, q } from "./imports-helpers.mjs";

const tables = await sql(`select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'
  and tablename in ('import_fields','import_templates','import_files','import_items','import_changes')`);
check("all five import tables exist", tables === "import_changes,import_fields,import_files,import_items,import_templates", tables);

const rls = await sql(`select count(*) from pg_tables where schemaname = 'public' and tablename like 'import_%' and rowsecurity = false`);
check("RLS is on for every import table", rls === "0", rls);

const fields = await sql(`select count(*) from public.import_fields`);
check("import_fields is seeded (17 fields + 3 row targets)", fields === "20", fields);
const star = await sql(`select string_agg(target_table, ',' order by target_table) from public.import_fields where field = '*'`);
check("each multi-row target has a '*' row", star === "activities,courses,test_scores", star);

const c = await user("imp-schema");
const s = await studentOf(c);
// 100-point GPA fits once the scale says so…
await sql(`insert into public.student_academics (student_id, gpa_scale, gpa_weighted) values ('${s.id}', '100', 92.5)`);
check("a 92.5 GPA is stored on a 100-point scale", (await sql(`select gpa_weighted from public.student_academics where student_id = '${s.id}'`)) === "92.500");
// …and is refused on a 4-point scale.
let refused = false;
try { await sql(`update public.student_academics set gpa_scale = '4.0' where student_id = '${s.id}'`); } catch { refused = true; }
check("a 92.5 GPA is refused on a 4.0 scale", refused);

const ts = await sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name in ('test_scores','courses') and column_name = 'source'`);
check("test_scores and courses carry a source column", ts === "source,source", ts);

// Firm stamping: an import created by a firm member records the firm.
const owner = await user("imp-schema-owner");
const member = await user("imp-schema-member");
const firmId = await firmWith(owner, [member]);
const imp = await makeImport(member);
check("an import records its firm at creation", (await sql(`select firm_id from public.roster_imports where id = '${imp}'`)) === firmId);
const solo = await makeImport(c);
check("a solo counselor's import has no firm", (await sql(`select coalesce(firm_id::text, 'null') from public.roster_imports where id = '${solo}'`)) === "null");

// The change list refuses a field that isn't on the list.
const item = await sql(`with i as (insert into public.import_items (import_id, match_status, student_id) values ('${solo}', 'matched_email', '${s.id}') returning id) select id from i`);
let fk = false;
try { await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value) values ('${solo}', '${item}', 'profiles', 'role', 'set_field', '"counselor"')`); } catch { fk = true; }
check("a change to a field not in import_fields can't be stored", fk);

const hb = await sql(`select count(*) from public.job_heartbeats where job = 'import-sweep'`);
check("the import-sweep heartbeat row exists", hb === "1");
```

- [ ] **Step 5: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-schema.test.mjs`
Expected: FAIL lines (the tables don't exist yet; `sql()` throws on the first `insert`).

- [ ] **Step 6: Write the migration**

Create `supabase/migrations/20261014000001_imports_schema.sql`:

```sql
-- Import pipeline, step 1: the tables.
-- Spec: docs/superpowers/specs/2026-10-09-import-pipeline-design.md §3–§4.
-- Additive: roster_imports is extended, not renamed; roster_import_rows stays
-- for history. Policies arrive in 20261014000002; until then RLS denies all.

-- ---------------------------------------------------------------------------
-- roster_imports, extended
-- ---------------------------------------------------------------------------

alter table public.roster_imports drop constraint if exists roster_imports_source_check;
alter table public.roster_imports add constraint roster_imports_source_check
  check (source in ('csv','google','microsoft','manual','xlsx','google-sheet','pdf','mixed'));

-- Old statuses (mapping, importing, complete, failed) stay valid for the old
-- roster flow until it is retired.
alter table public.roster_imports drop constraint if exists roster_imports_status_check;
alter table public.roster_imports add constraint roster_imports_status_check
  check (status in ('mapping','importing','complete','failed',
                    'draft','profiling','staging','review','committing','committed',
                    'undoing','undone','expired'));

alter table public.roster_imports
  add column if not exists firm_id                 uuid references public.firms(id) on delete set null,
  add column if not exists source_system           text not null default 'unknown'
    check (source_system in ('naviance','scoir','cialfo','hubspot','collegeplannerpro',
                             'counselmore','gradbetter','other','unknown')),
  add column if not exists template_id             uuid,
  add column if not exists permission_confirmed_by uuid references public.profiles(id) on delete set null,
  add column if not exists permission_confirmed_at timestamptz,
  add column if not exists committed_at            timestamptz,
  add column if not exists undone_at               timestamptz,
  add column if not exists expires_at              timestamptz,
  add column if not exists undo_until              timestamptz,
  add column if not exists compacted_at            timestamptz,
  add column if not exists ai_spend_cents          integer not null default 0 check (ai_spend_cents >= 0),
  add column if not exists job_actor               uuid references public.profiles(id) on delete set null,
  add column if not exists job_requested_at        timestamptz,
  add column if not exists job_error               jsonb,
  add column if not exists job_result              jsonb;

comment on column public.roster_imports.firm_id is
  'The practice the import belongs to, stamped at creation (private.crm_workspace_firm) so leaving the firm does not change who may see it. Null for a solo counselor.';
comment on column public.roster_imports.source_system is
  'Where the data came from (not the file format). Drives provenance: a later import from the same system may update values this one wrote.';

update public.roster_imports i
   set firm_id = private.crm_workspace_firm(i.counselor_id)
 where i.firm_id is null;

create or replace function private.roster_imports_stamp_firm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.firm_id := private.crm_workspace_firm(new.counselor_id);
  return new;
end;
$$;
revoke all on function private.roster_imports_stamp_firm() from public, anon, authenticated;

drop trigger if exists roster_imports_stamp_firm on public.roster_imports;
create trigger roster_imports_stamp_firm before insert on public.roster_imports
  for each row execute function private.roster_imports_stamp_firm();

-- The browser may keep using the old roster flow's columns and statuses, but
-- every new-pipeline status and job column moves only through the
-- SECURITY DEFINER functions (which run as the function owner, not as
-- `authenticated`).
create or replace function private.roster_imports_guard_client()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_statuses constant text[] := array['mapping','importing','complete','failed'];
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.status in ('committing','committed','undoing','undone') then
      raise exception 'A saved import can''t be deleted; undo it instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('mapping','draft')
       or new.committed_at is not null or new.undo_until is not null or new.undone_at is not null
       or new.compacted_at is not null or new.job_actor is not null or new.job_requested_at is not null
       or new.job_error is not null or new.job_result is not null then
      raise exception 'Import status changes go through the API' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.counselor_id is distinct from old.counselor_id
     or new.firm_id is distinct from old.firm_id
     or new.committed_at is distinct from old.committed_at
     or new.undo_until is distinct from old.undo_until
     or new.undone_at is distinct from old.undone_at
     or new.compacted_at is distinct from old.compacted_at
     or new.job_actor is distinct from old.job_actor
     or new.job_requested_at is distinct from old.job_requested_at
     or new.job_error is distinct from old.job_error
     or new.job_result is distinct from old.job_result
     or (new.status is distinct from old.status
         and not (old.status = any (v_old_statuses) and new.status = any (v_old_statuses))) then
    raise exception 'Import status changes go through the API' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.roster_imports_guard_client() from public, anon, authenticated;

drop trigger if exists roster_imports_guard_client on public.roster_imports;
create trigger roster_imports_guard_client before insert or update or delete on public.roster_imports
  for each row execute function private.roster_imports_guard_client();

-- ---------------------------------------------------------------------------
-- import_fields: the only things an import may write (spec §4.1)
-- ---------------------------------------------------------------------------

create table if not exists public.import_fields (
  target_table text not null check (target_table in
                 ('student_academics','student_personal_details','test_scores','courses','activities')),
  field        text not null check (length(field) between 1 and 63),
  value_type   text not null check (length(value_type) between 1 and 63),
  sensitivity  smallint not null check (sensitivity between 1 and 3),
  primary key (target_table, field)
);

insert into public.import_fields (target_table, field, value_type, sensitivity) values
  ('student_academics', 'gpa_unweighted',   'gpa',              3),
  ('student_academics', 'gpa_weighted',     'gpa',              3),
  ('student_academics', 'gpa_scale',        'text:20',          3),
  ('student_academics', 'class_rank',       'text:40',          3),
  ('student_academics', 'class_rank_value', 'text:40',          3),
  ('student_academics', 'test_status',      'enum:test_status', 3),
  ('student_academics', 'sat_ebrw',         'sat_section',      3),
  ('student_academics', 'sat_math',         'sat_section',      3),
  ('student_academics', 'sat_superscore',   'sat_total',        3),
  ('student_academics', 'act_composite',    'act_composite',    3),
  ('student_personal_details', 'contact_email',   'email',            1),
  ('student_personal_details', 'address',         'text:400',         2),
  ('student_personal_details', 'gender',          'enum:gender',      2),
  ('student_personal_details', 'birthday',        'date',             2),
  ('student_personal_details', 'citizenship',     'enum:citizenship', 2),
  ('student_personal_details', 'first_gen',       'bool',             2),
  ('student_personal_details', 'intended_majors', 'text[]',           1),
  ('test_scores', '*', 'row:test_score', 3),
  ('courses',     '*', 'row:course',     1),
  ('activities',  '*', 'row:activity',   1)
on conflict (target_table, field) do update
  set value_type = excluded.value_type, sensitivity = excluded.sensitivity;

alter table public.import_fields enable row level security;
revoke all on table public.import_fields from anon, authenticated;

-- ---------------------------------------------------------------------------
-- import_templates, import_files, import_items, import_changes
-- ---------------------------------------------------------------------------

create table if not exists public.import_templates (
  id            uuid primary key default gen_random_uuid(),
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 200),
  source_system text not null default 'unknown'
                check (source_system in ('naviance','scoir','cialfo','hubspot','collegeplannerpro',
                                         'counselmore','gradbetter','other','unknown')),
  fingerprint   text not null check (length(fingerprint) between 8 and 128),
  parse_plan    jsonb not null default '{}'::jsonb,
  use_count     integer not null default 0 check (use_count >= 0),
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (counselor_id, fingerprint)
);
drop trigger if exists import_templates_set_updated_at on public.import_templates;
create trigger import_templates_set_updated_at before update on public.import_templates
  for each row execute function public.set_updated_at();
alter table public.import_templates enable row level security;
revoke all on table public.import_templates from anon, authenticated;

alter table public.roster_imports drop constraint if exists roster_imports_template_fk;
alter table public.roster_imports add constraint roster_imports_template_fk
  foreign key (template_id) references public.import_templates(id) on delete set null;

create table if not exists public.import_files (
  id            uuid primary key default gen_random_uuid(),
  import_id     uuid not null references public.roster_imports(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  storage_path  text not null unique check (length(storage_path) between 3 and 600),
  filename      text not null check (length(btrim(filename)) between 1 and 300),
  mime_type     text check (length(mime_type) <= 200),
  detected_type text check (detected_type in ('csv','xlsx','pdf','unknown')),
  size_bytes    bigint check (size_bytes >= 0),
  sha256        text check (sha256 ~ '^[0-9a-f]{64}$'),
  kind          text not null check (kind in ('sheet','pdf')),
  status        text not null default 'registered' check (status in ('registered','profiled','failed','excluded')),
  error         text check (length(error) <= 500),
  profile       jsonb,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists import_files_import_idx on public.import_files (import_id);
drop trigger if exists import_files_set_updated_at on public.import_files;
create trigger import_files_set_updated_at before update on public.import_files
  for each row execute function public.set_updated_at();
alter table public.import_files enable row level security;
revoke all on table public.import_files from anon, authenticated;

create table if not exists public.import_items (
  id               uuid primary key default gen_random_uuid(),
  import_id        uuid not null references public.roster_imports(id) on delete cascade,
  file_id          uuid references public.import_files(id) on delete set null,
  -- Set when the item was carried over from the old roster flow (§5.8).
  legacy_row_id    uuid unique references public.roster_import_rows(id) on delete set null,
  locator          jsonb not null default '{}'::jsonb,
  match_status     text not null check (match_status in
                     ('matched_email','suggested','confirmed','new_invite','awaiting_counselor',
                      'applying','applied','skipped','expired','failed')),
  match_confidence text check (match_confidence in ('high','medium','low')),
  match_reasons    text[] not null default '{}',
  -- Cascade: deleting a student's account deletes their import data and
  -- fingerprints with it (spec §5.10, §10).
  student_id       uuid references public.profiles(id) on delete cascade,
  invitation_id    uuid references public.invitations(id) on delete set null,
  imported_name    text check (length(imported_name) <= 200),
  match_key        jsonb not null default '{}'::jsonb,
  candidates       jsonb not null default '[]'::jsonb,
  skip_reason      text check (length(skip_reason) <= 300),
  held_until       timestamptz,
  hold_warned_at   timestamptz,
  invite_state     text not null default 'unsent' check (invite_state in ('unsent','sent','failed')),
  job_actor        uuid references public.profiles(id) on delete set null,
  job_requested_at timestamptz,
  job_error        jsonb,
  error            text check (length(error) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint import_items_student_when_matched check (
    match_status not in ('matched_email','confirmed','awaiting_counselor','applying','applied')
    or student_id is not null)
);
create index if not exists import_items_import_idx on public.import_items (import_id, match_status);
create index if not exists import_items_student_idx on public.import_items (student_id) where student_id is not null;
create index if not exists import_items_invitation_idx on public.import_items (invitation_id) where invitation_id is not null;
drop trigger if exists import_items_set_updated_at on public.import_items;
create trigger import_items_set_updated_at before update on public.import_items
  for each row execute function public.set_updated_at();
alter table public.import_items enable row level security;
revoke all on table public.import_items from anon, authenticated;

create table if not exists public.import_changes (
  id             uuid primary key default gen_random_uuid(),
  import_id      uuid not null references public.roster_imports(id) on delete cascade,
  item_id        uuid not null references public.import_items(id) on delete cascade,
  target_table   text not null,
  field          text not null,
  op             text not null check (op in ('set_field','insert_row')),
  target_row_id  uuid,
  old_value      jsonb,
  new_value      jsonb,
  -- What the database actually holds after applying (normalized, e.g. 3.800),
  -- the value undo compares against. Dropped at compaction.
  applied_value  jsonb,
  -- sha256 of applied_value, kept after compaction for provenance (§5.6).
  -- Personal data: reversible for low-variety fields; deleted with the student.
  new_value_hash text check (new_value_hash ~ '^[0-9a-f]{64}$'),
  old_source     text check (old_source in ('empty','student','counselor','intake','import')),
  risk           numeric(8,3) not null default 0 check (risk >= 0),
  pattern_key    text check (length(pattern_key) <= 200),
  decision       text not null default 'keep_old' check (decision in ('auto','accept','keep_old','reject')),
  state          text not null default 'staged' check (state in
                   ('staged','applied','skipped_stale','skipped_invalid','undone','undo_skipped','failed')),
  source_ref     text check (length(source_ref) <= 200),
  ai_cleaned     boolean not null default false,
  error          text check (length(error) <= 500),
  applied_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint import_changes_field_fk foreign key (target_table, field)
    references public.import_fields (target_table, field),
  constraint import_changes_op_matches_field check ((op = 'insert_row') = (field = '*')),
  constraint import_changes_staged_has_value check (state <> 'staged' or new_value is not null)
);
create index if not exists import_changes_import_idx on public.import_changes (import_id, state);
create index if not exists import_changes_item_idx on public.import_changes (item_id);
create index if not exists import_changes_provenance_idx
  on public.import_changes (target_table, field, applied_at desc) where state = 'applied';
drop trigger if exists import_changes_set_updated_at on public.import_changes;
create trigger import_changes_set_updated_at before update on public.import_changes
  for each row execute function public.set_updated_at();
alter table public.import_changes enable row level security;
revoke all on table public.import_changes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- GPA: stored as given with its scale, never converted (§2, §4.1)
-- ---------------------------------------------------------------------------

alter table public.student_academics drop constraint if exists student_academics_gpa_unweighted_check;
alter table public.student_academics drop constraint if exists student_academics_gpa_weighted_check;
alter table public.student_academics
  alter column gpa_unweighted type numeric(6,3),
  alter column gpa_weighted   type numeric(6,3);
alter table public.student_academics drop constraint if exists student_academics_gpa_range;
alter table public.student_academics add constraint student_academics_gpa_range check (
  (gpa_unweighted is null or (gpa_unweighted >= 0 and gpa_unweighted <=
     case when coalesce(gpa_scale, '') ~ '^\s*100' then 110 else 10 end))
  and
  (gpa_weighted is null or (gpa_weighted >= 0 and gpa_weighted <=
     case when coalesce(gpa_scale, '') ~ '^\s*100' then 110 else 10 end))
);
comment on constraint student_academics_gpa_range on public.student_academics is
  'Up to 10 on 4/5/10-point scales; up to 110 (weighted bonus) when gpa_scale starts with 100. Readers must check gpa_scale (src/lib/gpa.ts).';

-- ---------------------------------------------------------------------------
-- Imported rows say so (§7.5): every AI module treats them as data.
-- ---------------------------------------------------------------------------

alter table public.test_scores
  add column if not exists source text not null default 'manual'
    check (source in ('manual','intake','import','ai'));
alter table public.courses
  add column if not exists source text not null default 'manual'
    check (source in ('manual','intake','import','ai'));

-- ---------------------------------------------------------------------------
-- The import sweep's heartbeat (lib/heartbeat.ts)
-- ---------------------------------------------------------------------------

alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
alter table public.job_heartbeats add constraint job_heartbeats_job_check
  check (job in ('accountability-sweep','message-dispatch','scorecard-ingest','resources-link-check','import-sweep'));
insert into public.job_heartbeats (job, expected_every)
values ('import-sweep', interval '15 minutes')
on conflict (job) do nothing;
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-schema.test.mjs`
Expected: every line `PASS`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261014000001_imports_schema.sql test/integration/harness.mjs test/integration/imports-helpers.mjs test/integration/imports-schema.test.mjs
git commit -m "feat(imports): schema for the change-list import pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Access rules, the imports bucket and the import_worker role

**Files:**
- Create: `supabase/migrations/20261014000002_imports_access.sql`
- Modify: `test/integration/imports-schema.test.mjs` (append RLS/storage checks)

**Interfaces:**
- Consumes: Task 1 tables; `private.crm_firm_member(uuid, uuid)`, `private.crm_firm_admin(uuid, uuid)`, `private.counselor_can_edit_student(uuid, uuid)`.
- Produces: `private.can_view_import(p_import uuid, p_viewer uuid) returns boolean`, `private.can_manage_import(p_import uuid, p_viewer uuid) returns boolean`, `private.import_can_write_student(p_import uuid, p_student uuid, p_actor uuid) returns boolean`; select-only policies; storage bucket `imports`; role `import_worker` (NOLOGIN, `usage` on schema `public`).

- [ ] **Step 1: Write the failing test (append to `imports-schema.test.mjs`)**

```js
// ---- Task 2: who can see what ----------------------------------------------
import { rest } from "./harness.mjs";

const ownerA = await user("imp-acl-owner");
const counselorA = await user("imp-acl-member");
const outsider = await user("imp-acl-outsider");
await firmWith(ownerA, [counselorA]);
const studentA = await studentOf(counselorA, "imp-acl-student");
const impA = await makeImport(counselorA);
const itemA = await sql(`with i as (insert into public.import_items (import_id, match_status, student_id) values ('${impA}', 'matched_email', '${studentA.id}') returning id) select id from i`);

const seen = async (u, table, col = "import_id") => {
  const r = await rest(u.token, "GET", `/rest/v1/${table}?select=id&${col}=eq.${impA}`);
  return Array.isArray(r.body) ? r.body.length : -1;
};
check("the uploader sees their import", (await seen(counselorA, "roster_imports", "id")) === 1);
check("the uploader sees its items", (await seen(counselorA, "import_items")) === 1);
check("the firm owner (admin) sees the import", (await seen(ownerA, "roster_imports", "id")) === 1);
check("the firm owner sees its items", (await seen(ownerA, "import_items")) === 1);
check("a counselor outside the firm sees nothing", (await seen(outsider, "roster_imports", "id")) === 0);
check("the student sees nothing", (await seen(studentA, "import_items")) === 0);

const ins = await rest(counselorA.token, "POST", "/rest/v1/import_changes", {
  import_id: impA, item_id: itemA, target_table: "student_academics", field: "gpa_weighted", op: "set_field", new_value: 4,
});
check("the browser can't insert a change", ins.status === 401 || ins.status === 403, `status ${ins.status}`);

const bump = await rest(counselorA.token, "PATCH", `/rest/v1/roster_imports?id=eq.${impA}`, { status: "committed" });
check("the browser can't move an import to committed", bump.status >= 400, `status ${bump.status}`);

const fieldsSeen = await rest(counselorA.token, "GET", "/rest/v1/import_fields?select=field");
check("counselors can read the field list", Array.isArray(fieldsSeen.body) && fieldsSeen.body.length === 20);

// Leaving the firm: the uploader loses access, the owner keeps it.
await sql(`delete from public.firm_members where profile_id = '${counselorA.id}'`);
await sql(`update public.profiles set firm_id = null where id = '${counselorA.id}'`);
check("an uploader who left the firm no longer sees the import", (await seen(counselorA, "roster_imports", "id")) === 0);
check("the firm owner still sees it", (await seen(ownerA, "roster_imports", "id")) === 1);

// Storage: upload only into your own draft import.
const solo = await user("imp-acl-solo");
const draft = await makeImport(solo, { status: "draft" });
const csv = new TextEncoder().encode("name,email\nA,a@test.local\n");
const up = await rest(solo.token, "POST", `/storage/v1/object/imports/${solo.id}/${draft}/f1-test.csv`, csv, { "Content-Type": "text/csv" });
check("a counselor can upload into their own draft import", up.status === 200, `status ${up.status} ${JSON.stringify(up.body)}`);
const reviewImp = await makeImport(solo, { status: "review" });
const up2 = await rest(solo.token, "POST", `/storage/v1/object/imports/${solo.id}/${reviewImp}/f2-test.csv`, csv, { "Content-Type": "text/csv" });
check("uploading into an import that isn't a draft is refused", up2.status >= 400, `status ${up2.status}`);
const up3 = await rest(outsider.token, "POST", `/storage/v1/object/imports/${solo.id}/${draft}/f3-test.csv`, csv, { "Content-Type": "text/csv" });
check("uploading into someone else's folder is refused", up3.status >= 400, `status ${up3.status}`);
const read = await rest(outsider.token, "GET", `/storage/v1/object/imports/${solo.id}/${draft}/f1-test.csv`);
check("someone else can't read the file", read.status >= 400, `status ${read.status}`);

const role = await sql(`select rolcanlogin::text from pg_roles where rolname = 'import_worker'`);
check("the import_worker role exists", role === "false" || role === "true", role);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-schema.test.mjs`
Expected: Task 1 lines PASS; Task 2 lines FAIL (e.g. "the uploader sees their import" — RLS denies everything).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000002_imports_access.sql`:

```sql
-- Import pipeline, step 1: who can see and run imports (spec §6.3–§6.4), the
-- private `imports` bucket (§3) and the restricted worker role (§6.2).

-- ---------------------------------------------------------------------------
-- The two access functions. Every policy and every job calls these, so
-- widening access later is a change here only (Appendix A).
-- ---------------------------------------------------------------------------

create or replace function private.can_view_import(p_import uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null and exists (
    select 1 from public.roster_imports i
    where i.id = p_import
      and (
        (i.counselor_id = p_viewer
         and (i.firm_id is null or private.crm_firm_member(i.firm_id, p_viewer)))
        or (i.firm_id is not null and private.crm_firm_admin(i.firm_id, p_viewer))
      )
  );
$$;

-- Same rule today; kept separate so "who may undo" can diverge from "who may see".
create or replace function private.can_manage_import(p_import uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_import(p_import, p_viewer);
$$;

-- May this actor write this student's record on behalf of this import?
-- The student's counselor (or a write collaborator), or an admin of the
-- import's firm when the student's counselor is in that firm.
create or replace function private.import_can_write_student(p_import uuid, p_student uuid, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student is not null and p_actor is not null and (
    private.counselor_can_edit_student(p_student, p_actor)
    or exists (
      select 1
      from public.roster_imports i
      join public.profiles s on s.id = p_student
      where i.id = p_import
        and i.firm_id is not null
        and private.crm_firm_admin(i.firm_id, p_actor)
        and s.counselor_id is not null
        and private.crm_firm_member(i.firm_id, s.counselor_id)
    )
  );
$$;

revoke all on function private.can_view_import(uuid, uuid) from public, anon;
revoke all on function private.can_manage_import(uuid, uuid) from public, anon;
revoke all on function private.import_can_write_student(uuid, uuid, uuid) from public, anon;
grant execute on function private.can_view_import(uuid, uuid) to authenticated;
grant execute on function private.can_manage_import(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- roster_imports: reads follow can_view_import; the old flow's own writes stay.
-- ---------------------------------------------------------------------------

drop policy if exists roster_imports_owner on public.roster_imports;
drop policy if exists roster_imports_select on public.roster_imports;
create policy roster_imports_select on public.roster_imports
  for select to authenticated
  using (private.can_view_import(id, (select auth.uid())));

drop policy if exists roster_imports_insert_own on public.roster_imports;
create policy roster_imports_insert_own on public.roster_imports
  for insert to authenticated
  with check (counselor_id = (select auth.uid()));

drop policy if exists roster_imports_update_own on public.roster_imports;
create policy roster_imports_update_own on public.roster_imports
  for update to authenticated
  using (counselor_id = (select auth.uid()) and private.can_view_import(id, (select auth.uid())))
  with check (counselor_id = (select auth.uid()));

drop policy if exists roster_imports_delete_own on public.roster_imports;
create policy roster_imports_delete_own on public.roster_imports
  for delete to authenticated
  using (counselor_id = (select auth.uid()) and private.can_view_import(id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- New tables: the browser reads; it never writes (§6.3).
-- ---------------------------------------------------------------------------

grant select on table public.import_files, public.import_items, public.import_changes,
                      public.import_templates, public.import_fields to authenticated;

drop policy if exists import_files_select on public.import_files;
create policy import_files_select on public.import_files
  for select to authenticated using (private.can_view_import(import_id, (select auth.uid())));

drop policy if exists import_items_select on public.import_items;
create policy import_items_select on public.import_items
  for select to authenticated using (private.can_view_import(import_id, (select auth.uid())));

drop policy if exists import_changes_select on public.import_changes;
create policy import_changes_select on public.import_changes
  for select to authenticated using (private.can_view_import(import_id, (select auth.uid())));

drop policy if exists import_templates_select on public.import_templates;
create policy import_templates_select on public.import_templates
  for select to authenticated using (counselor_id = (select auth.uid()));

drop policy if exists import_fields_select on public.import_fields;
create policy import_fields_select on public.import_fields
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Storage: the private `imports` bucket (§3)
-- Path: <counselor_id>/<import_id>/<file_id>-<safe name>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 26214400, array[
  'text/csv', 'text/plain', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.import_object_import_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_second text := split_part(p_name, '/', 2);
begin
  if split_part(p_name, '/', 3) = '' then
    return null;
  end if;
  if v_second !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_second::uuid;
end;
$$;

create or replace function private.import_upload_allowed(p_name text, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null
     and split_part(p_name, '/', 1) = p_viewer::text
     and exists (
       select 1 from public.roster_imports i
       where i.id = private.import_object_import_id(p_name)
         and i.counselor_id = p_viewer
         and i.status = 'draft'
     );
$$;

revoke all on function private.import_object_import_id(text) from public, anon;
revoke all on function private.import_upload_allowed(text, uuid) from public, anon;
grant execute on function private.import_object_import_id(text) to authenticated;
grant execute on function private.import_upload_allowed(text, uuid) to authenticated;

drop policy if exists imports_objects_insert on storage.objects;
create policy imports_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imports' and private.import_upload_allowed(name, (select auth.uid())));

drop policy if exists imports_objects_select on storage.objects;
create policy imports_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'imports'
         and private.can_view_import(private.import_object_import_id(name), (select auth.uid())));
-- No update or delete policy: uploads never overwrite, and the backend deletes.

-- ---------------------------------------------------------------------------
-- import_worker: the only login the backend's direct connection may use.
-- Created NOLOGIN; LOGIN and its password are set by hand outside git
-- (production) or by CI/local setup. It gets EXECUTE on the job functions in
-- the migrations that define them, and nothing else.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'import_worker') then
    create role import_worker nologin noinherit;
  end if;
end;
$$;
grant usage on schema public to import_worker;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-schema.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Check the old roster flow still works**

Run: `supabase db reset`, start the API (see "Running things locally"), then `node test/integration/overview-invites.test.mjs && node test/integration/hardening.test.mjs`
Expected: all PASS (the old `POST /roster/imports` path inserts and reads through the new policies).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261014000002_imports_access.sql test/integration/imports-schema.test.mjs
git commit -m "feat(imports): access functions, policies, imports bucket, import_worker role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Value checking, current values and the validation trigger

**Files:**
- Create: `supabase/migrations/20261014000003_imports_values.sql`
- Test: `test/integration/imports-values.test.mjs`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:
  - `private.import_num(v jsonb) returns numeric` (null unless a JSON number), `private.import_str(v jsonb) returns text` (null unless a JSON string).
  - `private.import_value_ok(p_type text, v jsonb) returns boolean` — the type rules for every `import_fields.value_type`.
  - `private.import_value_hash(v jsonb) returns text` — 64-char hex sha256 of `v::text` (`'null'` for SQL null).
  - `private.import_current_value(p_target text, p_field text, p_student uuid) returns jsonb` — the stored value as JSON (`null` when empty; empty `intended_majors` is `null`). **Staging (step 2) must read `old_value` with this function.**
  - Trigger `import_changes_validate` (skips rows with `state = 'skipped_invalid'`, which are cells waiting for cleanup).
  - `private.import_validate(p_import uuid, p_item uuid) returns jsonb` — array of `{changeId, sourceRef, message}` for accepted, staged changes on applicable items (`p_item` null = whole import, applicable = `matched_email`/`confirmed`; `p_item` given = that item, applicable = `applying`).

- [ ] **Step 1: Write the failing test**

Create `test/integration/imports-values.test.mjs`:

```js
// Import pipeline step 1, Task 3: value checking and current values.
import { check, sql, user } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, lit } from "./imports-helpers.mjs";

const ok = async (type, v) => (await sql(`select private.import_value_ok('${type}', ${lit(v)})`)) === "t";

check("gpa 3.85 is valid", await ok("gpa", 3.85));
check("gpa 92 is a valid number (scale checked later)", await ok("gpa", 92));
check("gpa '3.8' as text is not valid", !(await ok("gpa", "3.8")));
check("gpa 120 is not valid", !(await ok("gpa", 120)));
check("sat_total 1450 is valid", await ok("sat_total", 1450));
check("sat_total 1455.5 is not valid", !(await ok("sat_total", 1455.5)));
check("sat_section 900 is not valid", !(await ok("sat_section", 900)));
check("act_composite 36 is valid", await ok("act_composite", 36));
check("date 2008-02-29 is valid", await ok("date", "2008-02-29"));
check("date 2007-02-29 is not valid", !(await ok("date", "2007-02-29")));
check("email is checked", (await ok("email", "a@b.co")) && !(await ok("email", "not-an-email")));
check("text:20 enforces length", (await ok("text:20", "4.0")) && !(await ok("text:20", "x".repeat(21))));
check("enum:gender", (await ok("enum:gender", "female")) && !(await ok("enum:gender", "f")));
check("text[] majors", (await ok("text[]", ["Biology", "Math"])) && !(await ok("text[]", ["", "Math"])));
check("bool", (await ok("bool", true)) && !(await ok("bool", "yes")));
check("row:test_score valid", await ok("row:test_score", { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" }));
check("row:test_score without a date is valid", await ok("row:test_score", { exam: "SAT", kind: "sat", score: "1450" }));
check("row:test_score with an unknown key is not valid", !(await ok("row:test_score", { exam: "SAT", kind: "sat", ssn: "123-45-6789" })));
check("row:course valid", await ok("row:course", { name: "AP Chemistry", type: "ap", grade: "A-", status: "completed", school_year: "2024-25" }));
check("row:activity valid", await ok("row:activity", { name: "Robotics", position: "Captain", hours_per_week: 6, weeks_per_year: 30 }));
check("row:activity with 200 hours a week is not valid", !(await ok("row:activity", { name: "Robotics", hours_per_week: 200 })));
check("unknown type is never valid", !(await ok("anything", "x")));

const h = await sql(`select private.import_value_hash('3.8'::jsonb)`);
check("hash is 64 hex chars", /^[0-9a-f]{64}$/.test(h), h);

const c = await user("imp-values");
const s = await studentOf(c);
check("current value of an empty record is null", (await sql(`select coalesce(private.import_current_value('student_academics','gpa_weighted','${s.id}')::text, 'null')`)) === "null");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s.id}', 3.8, '4.0')`);
check("current value reads the stored number", (await sql(`select private.import_current_value('student_academics','gpa_weighted','${s.id}')::text`)) === "3.800");
await sql(`insert into public.student_personal_details (student_id) values ('${s.id}')`);
check("empty majors read as null", (await sql(`select coalesce(private.import_current_value('student_personal_details','intended_majors','${s.id}')::text, 'null')`)) === "null");

// The trigger refuses a bad staged value but keeps a flagged one.
const imp = await makeImport(c);
const item = await addItem(imp, { studentId: s.id });
let refused = false;
try { await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1700, studentId: s.id }); } catch { refused = true; }
check("a staged SAT of 1700 is refused", refused);
await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, state) values ('${imp}', '${item}', 'student_academics', 'sat_superscore', 'set_field', '"1450 (superscore)"', 'skipped_invalid')`);
check("a flagged cell waiting for cleanup is kept", (await sql(`select count(*) from public.import_changes where import_id = '${imp}' and state = 'skipped_invalid'`)) === "1");

// import_validate: GPA 92 on a 4.0 scale is reported; with the scale change accepted it isn't.
await addChange(imp, item, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: s.id });
let problems = JSON.parse(await sql(`select private.import_validate('${imp}', null)`));
check("GPA 92 on a 4.0 scale is reported", problems.length === 1 && /100-point/.test(problems[0].message), JSON.stringify(problems));
await addChange(imp, item, { target: "student_academics", field: "gpa_scale", value: "100", studentId: s.id });
problems = JSON.parse(await sql(`select private.import_validate('${imp}', null)`));
check("GPA 92 with the scale changed to 100 passes", problems.length === 0, JSON.stringify(problems));

await addChange(imp, item, { target: "student_personal_details", field: "birthday", value: "1975-01-01", studentId: s.id });
problems = JSON.parse(await sql(`select private.import_validate('${imp}', null)`));
check("a 1975 birthday is reported", problems.some((p) => /birthday/i.test(p.message)), JSON.stringify(problems));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-values.test.mjs`
Expected: fails at the first `sql()` call (`function private.import_value_ok(unknown, jsonb) does not exist`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000003_imports_values.sql`:

```sql
-- Import pipeline, step 1: what a valid imported value is (spec §4.2), the
-- value the database holds now (staging reads old_value with this), the
-- fingerprint (§5.10) and the pre-commit validation pass (§5.7 step 3).

create or replace function private.import_num(v jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when v is not null and jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric end;
$$;

create or replace function private.import_str(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when v is not null and jsonb_typeof(v) = 'string' then v #>> '{}' end;
$$;

create or replace function private.import_is_date(p text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  perform p::date;
  return true;
exception when others then
  return false;
end;
$$;

-- A JSON value that is absent or JSON null.
create or replace function private.import_absent(v jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select v is null or jsonb_typeof(v) = 'null';
$$;

create or replace function private.import_text_ok(v jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select private.import_str(v) is not null
     and length(btrim(private.import_str(v))) between 1 and p_max;
$$;

create or replace function private.import_value_ok(p_type text, v jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  n numeric;
  s text;
begin
  if private.import_absent(v) then
    return false;
  end if;

  if p_type = 'gpa' then
    n := private.import_num(v);
    return n is not null and n between 0 and 110;
  elsif p_type = 'sat_total' then
    n := private.import_num(v);
    return n is not null and n = trunc(n) and n between 400 and 1600;
  elsif p_type = 'sat_section' then
    n := private.import_num(v);
    return n is not null and n = trunc(n) and n between 200 and 800;
  elsif p_type = 'act_composite' then
    n := private.import_num(v);
    return n is not null and n = trunc(n) and n between 1 and 36;
  elsif p_type = 'date' then
    return private.import_is_date(private.import_str(v));
  elsif p_type = 'email' then
    s := private.import_str(v);
    return s is not null and length(s) <= 320 and s ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$';
  elsif p_type = 'bool' then
    return jsonb_typeof(v) = 'boolean';
  elsif p_type like 'text:%' then
    return private.import_text_ok(v, split_part(p_type, ':', 2)::integer);
  elsif p_type = 'text[]' then
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 10 then
      return false;
    end if;
    return not exists (
      select 1 from jsonb_array_elements(v) e where not private.import_text_ok(e, 200)
    );
  elsif p_type = 'enum:gender' then
    return private.import_str(v) in ('female','male','non-binary','undisclosed');
  elsif p_type = 'enum:citizenship' then
    return private.import_str(v) in ('us-citizen','permanent-resident','international');
  elsif p_type = 'enum:test_status' then
    return private.import_str(v) in ('not-started','prepping','scheduled','taken','retaking','test-optional');
  elsif p_type = 'row:test_score' then
    if jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in ('exam','kind','score','taken_on')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'exam', 200)
       and private.import_str(v -> 'kind') in ('ap','sat','act','ib','toefl','ielts','other')
       and (private.import_absent(v -> 'score') or private.import_text_ok(v -> 'score', 40))
       and (private.import_absent(v -> 'taken_on') or private.import_is_date(private.import_str(v -> 'taken_on')));
  elsif p_type = 'row:course' then
    if jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in ('name','type','grade','status','school_year')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'name', 300)
       and (private.import_absent(v -> 'type')
            or private.import_str(v -> 'type') in ('ap','ib','honors','dual-enrollment','college','other'))
       and (private.import_absent(v -> 'grade') or private.import_text_ok(v -> 'grade', 40))
       and (private.import_absent(v -> 'status')
            or private.import_str(v -> 'status') in ('planned','in-progress','completed'))
       and (private.import_absent(v -> 'school_year') or private.import_text_ok(v -> 'school_year', 40));
  elsif p_type = 'row:activity' then
    if jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in
               ('name','position','organization','category','hours_per_week','weeks_per_year','description','grade_levels')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'name', 300)
       and (private.import_absent(v -> 'position') or private.import_text_ok(v -> 'position', 200))
       and (private.import_absent(v -> 'organization') or private.import_text_ok(v -> 'organization', 200))
       and (private.import_absent(v -> 'category') or private.import_text_ok(v -> 'category', 100))
       and (private.import_absent(v -> 'hours_per_week')
            or coalesce(private.import_num(v -> 'hours_per_week') between 0 and 168, false))
       and (private.import_absent(v -> 'weeks_per_year')
            or coalesce(private.import_num(v -> 'weeks_per_year') = trunc(private.import_num(v -> 'weeks_per_year'))
                        and private.import_num(v -> 'weeks_per_year') between 0 and 52, false))
       and (private.import_absent(v -> 'description') or private.import_text_ok(v -> 'description', 2000))
       and (private.import_absent(v -> 'grade_levels') or private.import_value_ok('text[]', v -> 'grade_levels'));
  end if;
  return false;
end;
$$;

create or replace function private.import_value_hash(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(v, 'null'::jsonb)::text, 'UTF8')), 'hex');
$$;

create or replace function private.import_current_value(p_target text, p_field text, p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.student_academics;
  d public.student_personal_details;
begin
  if p_target = 'student_academics' then
    select * into a from public.student_academics where student_id = p_student;
    if not found then return null; end if;
    return case p_field
      when 'gpa_unweighted'   then to_jsonb(a.gpa_unweighted)
      when 'gpa_weighted'     then to_jsonb(a.gpa_weighted)
      when 'gpa_scale'        then to_jsonb(a.gpa_scale)
      when 'class_rank'       then to_jsonb(a.class_rank)
      when 'class_rank_value' then to_jsonb(a.class_rank_value)
      when 'test_status'      then to_jsonb(a.test_status)
      when 'sat_ebrw'         then to_jsonb(a.sat_ebrw)
      when 'sat_math'         then to_jsonb(a.sat_math)
      when 'sat_superscore'   then to_jsonb(a.sat_superscore)
      when 'act_composite'    then to_jsonb(a.act_composite)
    end;
  elsif p_target = 'student_personal_details' then
    select * into d from public.student_personal_details where student_id = p_student;
    if not found then return null; end if;
    return case p_field
      when 'contact_email'   then to_jsonb(d.contact_email)
      when 'address'         then to_jsonb(d.address)
      when 'gender'          then to_jsonb(d.gender)
      when 'birthday'        then to_jsonb(d.birthday)
      when 'citizenship'     then to_jsonb(d.citizenship)
      when 'first_gen'       then to_jsonb(d.first_gen)
      when 'intended_majors' then case when cardinality(d.intended_majors) = 0 then null
                                       else to_jsonb(d.intended_majors) end
    end;
  end if;
  raise exception 'Not a single-row import target: %', p_target using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- Every staged value is checked against import_fields.value_type on write.
-- A cell waiting for cleanup is stored as 'skipped_invalid' and not checked.
-- ---------------------------------------------------------------------------

create or replace function private.import_changes_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
begin
  if new.new_value is null or new.state = 'skipped_invalid' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.new_value is not distinct from old.new_value
     and new.state is not distinct from old.state then
    return new;
  end if;
  select f.value_type into v_type
  from public.import_fields f
  where f.target_table = new.target_table and f.field = new.field;
  if v_type is null or not private.import_value_ok(v_type, new.new_value) then
    raise exception 'Imported value for %.% is not valid', new.target_table, new.field
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists import_changes_validate on public.import_changes;
create trigger import_changes_validate before insert or update of new_value, state on public.import_changes
  for each row execute function private.import_changes_validate();

-- ---------------------------------------------------------------------------
-- The validation pass (§5.7 step 3): every problem, reported once.
-- ---------------------------------------------------------------------------

create or replace function private.import_validate(p_import uuid, p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c record;
  v_type text;
  v_scale text;
  v_problems jsonb := '[]'::jsonb;
  v_gpa numeric;
  v_date date;
begin
  for c in
    select ch.*, it.student_id as item_student
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import
      and ch.state = 'staged'
      and ch.decision in ('auto','accept')
      and (
        (p_item is null and it.match_status in ('matched_email','confirmed'))
        or (p_item is not null and it.id = p_item and it.match_status = 'applying')
      )
    order by ch.created_at
  loop
    select f.value_type into v_type from public.import_fields f
    where f.target_table = c.target_table and f.field = c.field;

    if v_type is null or not private.import_value_ok(v_type, c.new_value) then
      v_problems := v_problems || jsonb_build_object(
        'changeId', c.id, 'sourceRef', c.source_ref,
        'message', format('%s isn''t a valid value for %s', coalesce(c.new_value #>> '{}', 'This'), c.field));
      continue;
    end if;

    if c.target_table = 'student_academics' and c.field in ('gpa_weighted','gpa_unweighted') then
      v_gpa := private.import_num(c.new_value);
      -- The scale in effect after this import: an accepted scale change on the
      -- same item, else what the record holds now.
      select private.import_str(s.new_value) into v_scale
      from public.import_changes s
      where s.item_id = c.item_id and s.field = 'gpa_scale' and s.target_table = 'student_academics'
        and s.state = 'staged' and s.decision in ('auto','accept')
      limit 1;
      if v_scale is null then
        v_scale := private.import_str(private.import_current_value('student_academics', 'gpa_scale', c.item_student));
      end if;
      if v_gpa > 10 and coalesce(v_scale, '') !~ '^\s*100' then
        v_problems := v_problems || jsonb_build_object(
          'changeId', c.id, 'sourceRef', c.source_ref,
          'message', format('GPA %s needs a 100-point scale. Set the GPA scale to 100 or fix the value.', v_gpa));
      end if;
    end if;

    if c.target_table = 'student_personal_details' and c.field = 'birthday' then
      v_date := private.import_str(c.new_value)::date;
      if v_date < date '1980-01-01' or v_date > date '2030-12-31' then
        v_problems := v_problems || jsonb_build_object(
          'changeId', c.id, 'sourceRef', c.source_ref,
          'message', format('Birthday %s is outside 1980–2030', v_date));
      end if;
    end if;
  end loop;
  return v_problems;
end;
$$;

revoke all on function private.import_num(jsonb) from public, anon;
revoke all on function private.import_str(jsonb) from public, anon;
revoke all on function private.import_is_date(text) from public, anon;
revoke all on function private.import_absent(jsonb) from public, anon;
revoke all on function private.import_text_ok(jsonb, integer) from public, anon;
revoke all on function private.import_value_ok(text, jsonb) from public, anon;
revoke all on function private.import_value_hash(jsonb) from public, anon;
revoke all on function private.import_current_value(text, text, uuid) from public, anon, authenticated;
revoke all on function private.import_validate(uuid, uuid) from public, anon, authenticated;
revoke all on function private.import_changes_validate() from public, anon, authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-values.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261014000003_imports_values.sql test/integration/imports-values.test.mjs
git commit -m "feat(imports): value checking, current values, validation pass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Writing to the five targets (compare-and-set, inserts, snapshots)

**Files:**
- Create: `supabase/migrations/20261014000004_imports_apply.sql`
- Modify: `test/integration/imports-values.test.mjs` (append)

**Interfaces:**
- Consumes: Task 3 helpers.
- Produces:
  - `private.import_set_field(p_target text, p_field text, p_student uuid, p_expected jsonb, p_new jsonb) returns boolean` — one `UPDATE … WHERE col IS NOT DISTINCT FROM expected`; creates the empty single-row record first if missing; `true` when one row changed.
  - `private.import_insert_row(p_target text, p_student uuid, p_row jsonb) returns uuid` — inserts with `source = 'import'`; returns `null` when a duplicate already exists (spec §4.3 keys).
  - `private.import_row_snapshot(p_target text, p_row_id uuid) returns jsonb` — the importable columns of that row, `null` if gone.
  - `private.import_delete_row(p_target text, p_row_id uuid) returns boolean`.

- [ ] **Step 1: Write the failing test (append)**

```js
// ---- Task 4: compare-and-set and inserts ------------------------------------
const s2 = await studentOf(c, "imp-apply");
const set = async (field, expected, value, target = "student_academics") =>
  (await sql(`select private.import_set_field('${target}', '${field}', '${s2.id}', ${lit(expected)}, ${lit(value)})`)) === "t";

check("filling an empty field succeeds", await set("sat_superscore", null, 1400));
check("compare-and-set with the right old value succeeds", await set("sat_superscore", 1400, 1450));
check("compare-and-set with a stale old value changes nothing", !(await set("sat_superscore", 1400, 1500)));
check("the value is the last good write", (await sql(`select sat_superscore from public.student_academics where student_id = '${s2.id}'`)) === "1450");
check("3.8 matches a stored 3.800", (await set("gpa_weighted", null, 3.8)) && (await set("gpa_weighted", 3.8, 3.9)));
check("majors replace as an array", await set("intended_majors", null, ["Biology"], "student_personal_details"));
check("majors compare-and-set", await set("intended_majors", ["Biology"], ["Biology", "Chemistry"], "student_personal_details"));
check("birthday is set as a date", (await set("birthday", null, "2008-04-01", "student_personal_details")) &&
  (await sql(`select birthday from public.student_personal_details where student_id = '${s2.id}'`)) === "2008-04-01");
check("clearing back to empty works (undo path)", await set("sat_superscore", 1450, null));

const row = { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" };
const rid = await sql(`select private.import_insert_row('test_scores', '${s2.id}', ${lit(row)})`);
check("a test score row is inserted", /^[0-9a-f-]{36}$/.test(rid), rid);
check("it is marked as imported", (await sql(`select source from public.test_scores where id = '${rid}'`)) === "import");
const dup = await sql(`select coalesce(private.import_insert_row('test_scores', '${s2.id}', ${lit(row)})::text, 'null')`);
check("the same exam on the same date is a duplicate", dup === "null");
const undated = await sql(`select coalesce(private.import_insert_row('test_scores', '${s2.id}', ${lit({ exam: "AP Biology", kind: "ap", score: "5" })})::text, 'null')`);
check("an undated row with the same exam and score is a duplicate", undated === "null");
const snap = JSON.parse(await sql(`select private.import_row_snapshot('test_scores', '${rid}')`));
check("snapshot carries the importable columns", snap.exam === "AP Biology" && snap.taken_on === "2025-05-10", JSON.stringify(snap));
const course = await sql(`select private.import_insert_row('courses', '${s2.id}', ${lit({ name: "AP Chemistry", type: "ap", school_year: "2024-25" })})`);
check("a course is inserted", /^[0-9a-f-]{36}$/.test(course));
const courseDup = await sql(`select coalesce(private.import_insert_row('courses', '${s2.id}', ${lit({ name: "ap chemistry", school_year: "2024-25" })})::text, 'null')`);
check("same course name and year (any case) is a duplicate", courseDup === "null");
const act = await sql(`select private.import_insert_row('activities', '${s2.id}', ${lit({ name: "Robotics", grade_levels: ["11", "12"] })})`);
check("an activity is inserted with grade levels", (await sql(`select array_to_string(grade_levels, ',') from public.activities where id = '${act}'`)) === "11,12");
check("a row is deleted by id", (await sql(`select private.import_delete_row('activities', '${act}')`)) === "t");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-values.test.mjs`
Expected: Task 3 lines PASS; the Task 4 block fails with `function private.import_set_field(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000004_imports_apply.sql`:

```sql
-- Import pipeline, step 1: the only code that writes imported values into
-- student records. Fixed statements per target and field (no dynamic SQL,
-- spec §6.2). Each single-row write is one compare-and-set UPDATE, so a value
-- a person changed after review is never overwritten (§5.7 step 4).

create or replace function private.import_set_field(
  p_target text, p_field text, p_student uuid, p_expected jsonb, p_new jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  e jsonb := case when private.import_absent(p_expected) then null else p_expected end;
  v jsonb := case when private.import_absent(p_new) then null else p_new end;
begin
  if p_target = 'student_academics' then
    insert into public.student_academics (student_id) values (p_student) on conflict (student_id) do nothing;
    case p_field
      when 'gpa_unweighted' then
        update public.student_academics set gpa_unweighted = (v #>> '{}')::numeric
         where student_id = p_student and gpa_unweighted is not distinct from (e #>> '{}')::numeric;
      when 'gpa_weighted' then
        update public.student_academics set gpa_weighted = (v #>> '{}')::numeric
         where student_id = p_student and gpa_weighted is not distinct from (e #>> '{}')::numeric;
      when 'gpa_scale' then
        update public.student_academics set gpa_scale = v #>> '{}'
         where student_id = p_student and gpa_scale is not distinct from e #>> '{}';
      when 'class_rank' then
        update public.student_academics set class_rank = v #>> '{}'
         where student_id = p_student and class_rank is not distinct from e #>> '{}';
      when 'class_rank_value' then
        update public.student_academics set class_rank_value = v #>> '{}'
         where student_id = p_student and class_rank_value is not distinct from e #>> '{}';
      when 'test_status' then
        update public.student_academics set test_status = v #>> '{}'
         where student_id = p_student and test_status is not distinct from e #>> '{}';
      when 'sat_ebrw' then
        update public.student_academics set sat_ebrw = (v #>> '{}')::integer
         where student_id = p_student and sat_ebrw is not distinct from (e #>> '{}')::integer;
      when 'sat_math' then
        update public.student_academics set sat_math = (v #>> '{}')::integer
         where student_id = p_student and sat_math is not distinct from (e #>> '{}')::integer;
      when 'sat_superscore' then
        update public.student_academics set sat_superscore = (v #>> '{}')::integer
         where student_id = p_student and sat_superscore is not distinct from (e #>> '{}')::integer;
      when 'act_composite' then
        update public.student_academics set act_composite = (v #>> '{}')::integer
         where student_id = p_student and act_composite is not distinct from (e #>> '{}')::integer;
      else
        raise exception 'Not an importable field: student_academics.%', p_field using errcode = '22023';
    end case;
  elsif p_target = 'student_personal_details' then
    insert into public.student_personal_details (student_id) values (p_student) on conflict (student_id) do nothing;
    case p_field
      when 'contact_email' then
        update public.student_personal_details set contact_email = v #>> '{}'
         where student_id = p_student and contact_email is not distinct from e #>> '{}';
      when 'address' then
        update public.student_personal_details set address = v #>> '{}'
         where student_id = p_student and address is not distinct from e #>> '{}';
      when 'gender' then
        update public.student_personal_details set gender = v #>> '{}'
         where student_id = p_student and gender is not distinct from e #>> '{}';
      when 'birthday' then
        update public.student_personal_details set birthday = (v #>> '{}')::date
         where student_id = p_student and birthday is not distinct from (e #>> '{}')::date;
      when 'citizenship' then
        update public.student_personal_details set citizenship = v #>> '{}'
         where student_id = p_student and citizenship is not distinct from e #>> '{}';
      when 'first_gen' then
        update public.student_personal_details set first_gen = (v #>> '{}')::boolean
         where student_id = p_student and first_gen is not distinct from (e #>> '{}')::boolean;
      when 'intended_majors' then
        update public.student_personal_details
           set intended_majors = coalesce(array(select jsonb_array_elements_text(coalesce(v, '[]'::jsonb))), '{}')
         where student_id = p_student
           and intended_majors = coalesce(array(select jsonb_array_elements_text(coalesce(e, '[]'::jsonb))), '{}');
      else
        raise exception 'Not an importable field: student_personal_details.%', p_field using errcode = '22023';
    end case;
  else
    raise exception 'Not a single-row import target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

create or replace function private.import_text_array(v jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when v is not null and jsonb_typeof(v) = 'array'
              then array(select jsonb_array_elements_text(v)) else '{}'::text[] end;
$$;

-- Duplicate keys are final for v1.0 (spec §4.3).
create or replace function private.import_insert_row(p_target text, p_student uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_target = 'test_scores' then
    if exists (
      select 1 from public.test_scores t
      where t.student_id = p_student
        and t.kind = p_row ->> 'kind'
        and lower(btrim(t.exam)) = lower(btrim(p_row ->> 'exam'))
        and (
          (t.taken_on is not null and p_row ->> 'taken_on' is not null
           and t.taken_on = (p_row ->> 'taken_on')::date)
          or ((t.taken_on is null or p_row ->> 'taken_on' is null)
              and t.score is not distinct from (p_row ->> 'score'))
        )
    ) then
      return null;
    end if;
    insert into public.test_scores (student_id, exam, kind, score, taken_on, source)
    values (p_student, p_row ->> 'exam', p_row ->> 'kind', p_row ->> 'score',
            (p_row ->> 'taken_on')::date, 'import')
    returning id into v_id;
  elsif p_target = 'courses' then
    if exists (
      select 1 from public.courses c
      where c.student_id = p_student
        and lower(btrim(c.name)) = lower(btrim(p_row ->> 'name'))
        and c.school_year is not distinct from (p_row ->> 'school_year')
    ) then
      return null;
    end if;
    insert into public.courses (student_id, name, type, grade, status, school_year, source)
    values (p_student, p_row ->> 'name', p_row ->> 'type', p_row ->> 'grade',
            p_row ->> 'status', p_row ->> 'school_year', 'import')
    returning id into v_id;
  elsif p_target = 'activities' then
    if exists (
      select 1 from public.activities a
      where a.student_id = p_student
        and lower(btrim(coalesce(a.name, ''))) = lower(btrim(p_row ->> 'name'))
    ) then
      return null;
    end if;
    insert into public.activities (student_id, name, position, organization, category,
                                   hours_per_week, weeks_per_year, description, grade_levels, source)
    values (p_student, p_row ->> 'name', p_row ->> 'position', p_row ->> 'organization', p_row ->> 'category',
            (p_row ->> 'hours_per_week')::numeric, (p_row ->> 'weeks_per_year')::integer,
            p_row ->> 'description', private.import_text_array(p_row -> 'grade_levels'), 'import')
    returning id into v_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  return v_id;
end;
$$;

create or replace function private.import_row_snapshot(p_target text, p_row_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_target = 'test_scores' then
    select jsonb_build_object('exam', exam, 'kind', kind, 'score', score, 'taken_on', taken_on)
      into v from public.test_scores where id = p_row_id;
  elsif p_target = 'courses' then
    select jsonb_build_object('name', name, 'type', type, 'grade', grade, 'status', status, 'school_year', school_year)
      into v from public.courses where id = p_row_id;
  elsif p_target = 'activities' then
    select jsonb_build_object('name', name, 'position', position, 'organization', organization,
                              'category', category, 'hours_per_week', hours_per_week,
                              'weeks_per_year', weeks_per_year, 'description', description,
                              'grade_levels', grade_levels)
      into v from public.activities where id = p_row_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  return v;
end;
$$;

create or replace function private.import_delete_row(p_target text, p_row_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
begin
  if p_target = 'test_scores' then
    delete from public.test_scores where id = p_row_id;
  elsif p_target = 'courses' then
    delete from public.courses where id = p_row_id;
  elsif p_target = 'activities' then
    delete from public.activities where id = p_row_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function private.import_set_field(text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.import_text_array(jsonb) from public, anon;
revoke all on function private.import_insert_row(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.import_row_snapshot(text, uuid) from public, anon, authenticated;
revoke all on function private.import_delete_row(text, uuid) from public, anon, authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-values.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261014000004_imports_apply.sql test/integration/imports-values.test.mjs
git commit -m "feat(imports): compare-and-set writes and deduplicated inserts per target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Requesting and running a commit

**Files:**
- Create: `supabase/migrations/20261014000005_imports_commit.sql`
- Test: `test/integration/imports-commit.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `public.request_import_commit(p_import uuid) returns void` — callable by `authenticated`; checks `can_manage_import(p_import, auth.uid())`; `review → committing`; errors: `42501` (not yours), `55000` (wrong status, message "That import is already being saved" when already committing/undoing, else "Only an import in review can be saved").
  - `public.commit_import(p_import uuid, p_actor uuid) returns jsonb` — EXECUTE to `import_worker`, `service_role`. Result `{status}` where status ∈ `committed` | `review` (validation problems, in `problems`) | `busy` (locked by another runner) | `not-requested`.
  - `public.fail_import_job(p_kind text, p_id uuid, p_message text) returns void` — worker; `committing → review`, `undoing → committed`, held item `applying → awaiting_counselor`; stores `{message}` in `job_error`.
  - `public.import_jobs_due(p_stale_seconds integer) returns table(kind text, id uuid, actor uuid)` — worker; jobs requested longer ago than `p_stale_seconds`.
  - `roster_imports.job_result` after commit: `{applied, stale, skippedItems, students}`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/imports-commit.test.mjs`:

```js
// Import pipeline step 1, Task 5: commit is all-or-nothing, compare-and-set, audited.
import { check, sql, sqlAsync, user, rest } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, importRow, changeRow, academics, firmWith } from "./imports-helpers.mjs";

const c = await user("imp-commit");
const s = await studentOf(c, "imp-commit-student");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s.id}', 3.5, '4.0')`);

// Request through the browser path (RLS-checked function).
const imp = await makeImport(c);
const item = await addItem(imp, { studentId: s.id });
const gpa = await addChange(imp, item, { target: "student_academics", field: "gpa_weighted", value: 3.8, studentId: s.id });
const sat = await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1450, studentId: s.id });
const kept = await addChange(imp, item, { target: "student_academics", field: "act_composite", value: 30, studentId: s.id, decision: "keep_old" });
const score = await addChange(imp, item, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" } });

const other = await user("imp-commit-other");
const denied = await rest(other.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp });
check("another counselor can't request a commit", denied.status >= 400, `status ${denied.status}`);
const req = await rest(c.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp });
check("the uploader can request a commit", req.status === 204 || req.status === 200, `status ${req.status} ${JSON.stringify(req.body)}`);
const again = await rest(c.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp });
check("a second request is refused as already in progress", again.status >= 400 && /already being saved/.test(JSON.stringify(again.body)), JSON.stringify(again.body));

// A student edit between review and commit.
await sql(`update public.student_academics set sat_superscore = 1500 where student_id = '${s.id}'`);

const out = JSON.parse(await sql(`select public.commit_import('${imp}', '${c.id}')`));
check("commit reports committed", out.status === "committed", JSON.stringify(out));
const a = await academics(s.id);
check("the accepted GPA is applied", Number(a.gpa_weighted) === 3.8);
check("the student's SAT edit survives", a.sat_superscore === 1500);
check("the stale change is reported", (await changeRow(sat)).state === "skipped_stale");
check("a keep-old change is not applied", (await changeRow(kept)).state === "staged" && a.act_composite === null);
check("the test score row is inserted", (await sql(`select count(*) from public.test_scores where student_id = '${s.id}' and source = 'import'`)) === "1");
const gpaRow = await changeRow(gpa);
check("applied changes keep a fingerprint of what was written", /^[0-9a-f]{64}$/.test(gpaRow.new_value_hash) && Number(gpaRow.applied_value) === 3.8);
check("applied insert keeps the new row id", /^[0-9a-f-]{36}$/.test((await changeRow(score)).target_row_id));
const row = await importRow(imp);
check("import is committed with a 30-day undo window", row.status === "committed" && Math.round((Date.parse(row.undo_until) - Date.parse(row.committed_at)) / 86400000) === 30);
check("result counts are recorded", row.job_result.applied === 2 && row.job_result.stale === 1, JSON.stringify(row.job_result));
const audit = await sql(`select metadata::text from public.audit_log where action = 'import.committed' and entity_id = '${imp}'`);
check("an audit row is written inside the commit", audit.includes('"applied": 2'), audit);
check("the audit row holds counts, not student ids", !audit.includes(s.id));
check("running the job again changes nothing", JSON.parse(await sql(`select public.commit_import('${imp}', '${c.id}')`)).status === "not-requested");

// Validation: every problem reported, nothing applied, back to review.
const s2 = await studentOf(c, "imp-commit-student2");
const imp2 = await makeImport(c);
const item2 = await addItem(imp2, { studentId: s2.id });
await addChange(imp2, item2, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: s2.id });
await addChange(imp2, item2, { target: "student_personal_details", field: "birthday", value: "1975-01-01", studentId: s2.id });
await addChange(imp2, item2, { target: "student_academics", field: "sat_superscore", value: 1300, studentId: s2.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp2}'`);
const out2 = JSON.parse(await sql(`select public.commit_import('${imp2}', '${c.id}')`));
check("validation problems send the import back to review", out2.status === "review" && out2.problems.length === 2, JSON.stringify(out2));
check("nothing was applied", (await academics(s2.id)) === null);
check("the problems are stored for the review screen", (await importRow(imp2)).job_error.problems.length === 2);

// A student moved to another counselor is skipped, not a rollback.
const s3 = await studentOf(c, "imp-commit-student3");
const imp3 = await makeImport(c);
const item3 = await addItem(imp3, { studentId: s3.id });
await addChange(imp3, item3, { target: "student_academics", field: "sat_superscore", value: 1300, studentId: s3.id });
await sql(`update public.profiles set counselor_id = '${other.id}' where id = '${s3.id}'`);
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp3}'`);
const out3 = JSON.parse(await sql(`select public.commit_import('${imp3}', '${c.id}')`));
check("a reassigned student's item is skipped and the import still commits", out3.status === "committed" &&
  (await sql(`select match_status from public.import_items where id = '${item3}'`)) === "skipped");

// Two runners at once: exactly one applies.
const s4 = await studentOf(c, "imp-commit-student4");
const imp4 = await makeImport(c);
const item4 = await addItem(imp4, { studentId: s4.id });
await addChange(imp4, item4, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "SAT", kind: "sat", score: "1400" } });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp4}'`);
const [r1, r2] = await Promise.all([
  sqlAsync(`select public.commit_import('${imp4}', '${c.id}')`),
  sqlAsync(`select public.commit_import('${imp4}', '${c.id}')`),
]);
const statuses = [JSON.parse(r1).status, JSON.parse(r2).status].sort().join(",");
check("two runners: one commits, the other is busy or finds it done", statuses === "busy,committed" || statuses === "committed,not-requested", statuses);
check("the row was inserted once", (await sql(`select count(*) from public.test_scores where student_id = '${s4.id}'`)) === "1");

// Scale before value: GPA 92 with the scale change in the same import.
const s5 = await studentOf(c, "imp-commit-student5");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s5.id}', 3.5, '4.0')`);
const imp5 = await makeImport(c);
const item5 = await addItem(imp5, { studentId: s5.id });
await addChange(imp5, item5, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: s5.id });
await addChange(imp5, item5, { target: "student_academics", field: "gpa_scale", value: "100", studentId: s5.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp5}'`);
const out5 = JSON.parse(await sql(`select public.commit_import('${imp5}', '${c.id}')`));
check("GPA 92 commits when the scale changes to 100 in the same import", out5.status === "committed" && Number((await academics(s5.id)).gpa_weighted) === 92, JSON.stringify(out5));

// Failure bookkeeping and the due-job list.
const imp6 = await makeImport(c);
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}', job_requested_at = now() - interval '5 minutes' where id = '${imp6}'`);
const due = await sql(`select count(*) from public.import_jobs_due(60) where id = '${imp6}' and kind = 'commit'`);
check("a commit requested 5 minutes ago is due for the sweep", due === "1");
await sql(`select public.fail_import_job('commit', '${imp6}', 'Couldn''t save. Nothing was changed. Try again.')`);
const failed = await importRow(imp6);
check("a failed commit goes back to review with the message", failed.status === "review" && /Nothing was changed/.test(failed.job_error.message));

// Firm admin may commit a firm member's import.
const owner = await user("imp-commit-owner");
const member = await user("imp-commit-member");
await firmWith(owner, [member]);
const s7 = await studentOf(member, "imp-commit-student7");
const imp7 = await makeImport(member);
const item7 = await addItem(imp7, { studentId: s7.id });
await addChange(imp7, item7, { target: "student_academics", field: "act_composite", value: 31, studentId: s7.id });
const adminReq = await rest(owner.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp7 });
check("the firm owner can request a member's commit", adminReq.status === 204 || adminReq.status === 200, `status ${adminReq.status}`);
const out7 = JSON.parse(await sql(`select public.commit_import('${imp7}', '${owner.id}')`));
check("the firm owner's commit applies to the member's student", out7.status === "committed" && (await academics(s7.id)).act_composite === 31);

const grants = await sql(`select has_function_privilege('authenticated', 'public.commit_import(uuid, uuid)', 'execute')::text || ',' || has_function_privilege('import_worker', 'public.commit_import(uuid, uuid)', 'execute')::text`);
check("only the worker (not the browser) can run commit_import", grants === "false,true", grants);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-commit.test.mjs`
Expected: FAIL ("the uploader can request a commit" — `request_import_commit` doesn't exist), then a thrown error at the first `commit_import` call.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000005_imports_commit.sql`:

```sql
-- Import pipeline, step 1: saving an import (spec §5.7).
-- The browser requests; the backend's import_worker runs commit_import in one
-- transaction on a direct connection. Two runners can't both apply: the
-- import row is locked with SKIP LOCKED and the status must be 'committing'.

create or replace function public.request_import_commit(p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_status text;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select status into v_status from public.roster_imports where id = p_import for update;
  if v_status in ('committing','undoing') then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v_status <> 'review' then
    raise exception 'Only an import in review can be saved' using errcode = '55000';
  end if;
  update public.roster_imports
     set status = 'committing', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_import;
end;
$$;

create or replace function public.commit_import(p_import uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_problems jsonb;
  c record;
  v_ok boolean;
  v_row uuid;
  v_applied integer := 0;
  v_stale integer := 0;
  v_skipped_items integer := 0;
  v_students integer := 0;
  v_result jsonb;
begin
  select * into v from public.roster_imports where id = p_import for update skip locked;
  if not found then
    if exists (select 1 from public.roster_imports where id = p_import) then
      return jsonb_build_object('status', 'busy');
    end if;
    raise exception 'No such import' using errcode = 'P0002';
  end if;
  if v.status <> 'committing' then
    return jsonb_build_object('status', 'not-requested', 'current', v.status);
  end if;
  if not private.can_manage_import(p_import, p_actor) then
    update public.roster_imports
       set status = 'review', job_error = jsonb_build_object('message', 'You no longer have access to this import')
     where id = p_import;
    return jsonb_build_object('status', 'review');
  end if;

  -- Step 2: students the actor may no longer write are skipped with a reason.
  update public.import_items i
     set match_status = 'skipped', skip_reason = 'This student is no longer on your roster'
   where i.import_id = p_import
     and i.match_status in ('matched_email','confirmed')
     and not private.import_can_write_student(p_import, i.student_id, p_actor);
  get diagnostics v_skipped_items = row_count;

  -- Step 3: one validation pass; any problem sends the import back untouched.
  v_problems := private.import_validate(p_import, null);
  if jsonb_array_length(v_problems) > 0 then
    update public.roster_imports
       set status = 'review',
           job_error = jsonb_build_object('message', 'Some values need fixing before saving', 'problems', v_problems)
     where id = p_import;
    return jsonb_build_object('status', 'review', 'problems', v_problems);
  end if;

  -- Step 4: apply. A GPA scale is written before the GPA on the same item.
  for c in
    select ch.id, ch.op, ch.target_table, ch.field, ch.old_value, ch.new_value, it.student_id
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import
      and ch.state = 'staged'
      and ch.decision in ('auto','accept')
      and it.match_status in ('matched_email','confirmed')
    order by it.id, (ch.field = 'gpa_scale') desc, ch.created_at
    for update of ch
  loop
    if c.op = 'set_field' then
      v_ok := private.import_set_field(c.target_table, c.field, c.student_id, c.old_value, c.new_value);
      if v_ok then
        update public.import_changes
           set state = 'applied', applied_at = now(),
               applied_value = private.import_current_value(c.target_table, c.field, c.student_id),
               new_value_hash = private.import_value_hash(private.import_current_value(c.target_table, c.field, c.student_id))
         where id = c.id;
        v_applied := v_applied + 1;
      else
        update public.import_changes
           set state = 'skipped_stale', error = 'Changed since you reviewed it; the newer value was kept'
         where id = c.id;
        v_stale := v_stale + 1;
      end if;
    else
      v_row := private.import_insert_row(c.target_table, c.student_id, c.new_value);
      if v_row is null then
        update public.import_changes
           set state = 'skipped_stale', error = 'Already on the student''s record'
         where id = c.id;
        v_stale := v_stale + 1;
      else
        update public.import_changes
           set state = 'applied', applied_at = now(), target_row_id = v_row,
               applied_value = private.import_row_snapshot(c.target_table, v_row),
               new_value_hash = private.import_value_hash(private.import_row_snapshot(c.target_table, v_row))
         where id = c.id;
        v_applied := v_applied + 1;
      end if;
    end if;
  end loop;

  select count(distinct it.student_id) into v_students
  from public.import_changes ch
  join public.import_items it on it.id = ch.item_id
  where ch.import_id = p_import and ch.state = 'applied';

  v_result := jsonb_build_object('applied', v_applied, 'stale', v_stale,
                                 'skippedItems', v_skipped_items, 'students', v_students);

  -- Step 5: the audit row is part of the same transaction. Counts only.
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'import.committed', 'roster_import', p_import, v_result);

  -- Step 6.
  update public.roster_imports
     set status = 'committed', committed_at = now(), undo_until = now() + interval '30 days',
         job_error = null, job_result = v_result
   where id = p_import;

  return jsonb_build_object('status', 'committed') || v_result;
end;
$$;

create or replace function public.fail_import_job(p_kind text, p_id uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'commit' then
    update public.roster_imports set status = 'review', job_error = jsonb_build_object('message', p_message)
     where id = p_id and status = 'committing';
  elsif p_kind = 'undo' then
    update public.roster_imports set status = 'committed', job_error = jsonb_build_object('message', p_message)
     where id = p_id and status = 'undoing';
  elsif p_kind = 'apply' then
    update public.import_items set match_status = 'awaiting_counselor', job_error = jsonb_build_object('message', p_message)
     where id = p_id and match_status = 'applying';
  else
    raise exception 'Unknown import job kind: %', p_kind using errcode = '22023';
  end if;
end;
$$;

create or replace function public.import_jobs_due(p_stale_seconds integer)
returns table (kind text, id uuid, actor uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select case i.status when 'committing' then 'commit' else 'undo' end, i.id, i.job_actor
  from public.roster_imports i
  where i.status in ('committing','undoing')
    and i.job_actor is not null
    and coalesce(i.job_requested_at, 'epoch'::timestamptz) < now() - make_interval(secs => p_stale_seconds)
  union all
  select 'apply', it.id, it.job_actor
  from public.import_items it
  where it.match_status = 'applying'
    and it.job_actor is not null
    and coalesce(it.job_requested_at, 'epoch'::timestamptz) < now() - make_interval(secs => p_stale_seconds);
$$;

revoke all on function public.request_import_commit(uuid) from public, anon;
grant execute on function public.request_import_commit(uuid) to authenticated;

revoke all on function public.commit_import(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_import_job(text, uuid, text) from public, anon, authenticated;
revoke all on function public.import_jobs_due(integer) from public, anon, authenticated;
grant execute on function public.commit_import(uuid, uuid) to import_worker, service_role;
grant execute on function public.fail_import_job(text, uuid, text) to import_worker, service_role;
grant execute on function public.import_jobs_due(integer) to import_worker, service_role;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-commit.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261014000005_imports_commit.sql test/integration/imports-commit.test.mjs
git commit -m "feat(imports): all-or-nothing commit with compare-and-set and in-transaction audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Undo

**Files:**
- Create: `supabase/migrations/20261014000006_imports_undo.sql`
- Test: `test/integration/imports-undo.test.mjs`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `public.request_import_undo(p_import uuid) returns void` — `authenticated`; `committed → undoing`; errors `42501`, `55000` ("That import is already being saved" / "Only a saved import can be undone"), `P0001` ("Undo is only available for 30 days after saving").
  - `public.undo_import(p_import uuid, p_actor uuid) returns jsonb` — worker; `{status: 'undone', reverted, kept, invitationsRevoked}` or `busy` / `not-requested` / `committed` (window passed).

- [ ] **Step 1: Write the failing test**

Create `test/integration/imports-undo.test.mjs`:

```js
// Import pipeline step 1, Task 6: undo reverts what nobody edited since.
import { check, sql, user, rest } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, importRow, changeRow, academics } from "./imports-helpers.mjs";

const c = await user("imp-undo");
const s = await studentOf(c, "imp-undo-student");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale, sat_superscore) values ('${s.id}', 3.5, '4.0', 1300)`);

async function committed(changes, studentId = s.id) {
  const imp = await makeImport(c);
  const item = await addItem(imp, { studentId });
  const ids = [];
  for (const ch of changes) ids.push(await addChange(imp, item, { studentId, ...ch }));
  await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
  const out = JSON.parse(await sql(`select public.commit_import('${imp}', '${c.id}')`));
  if (out.status !== "committed") throw new Error("setup commit failed " + JSON.stringify(out));
  return { imp, ids };
}

const { imp, ids } = await committed([
  { target: "student_academics", field: "gpa_weighted", value: 3.9 },
  { target: "student_academics", field: "sat_superscore", value: 1450 },
  { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Biology", kind: "ap", score: "5" } },
  { target: "activities", field: "*", op: "insert_row", value: { name: "Robotics" } },
]);
// After the commit the student edits their SAT and the activity.
await sql(`update public.student_academics set sat_superscore = 1500 where student_id = '${s.id}'`);
await sql(`update public.activities set position = 'Captain' where student_id = '${s.id}' and name = 'Robotics'`);

const other = await user("imp-undo-other");
check("another counselor can't request undo", (await rest(other.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: imp })).status >= 400);
const req = await rest(c.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: imp });
check("the uploader can request undo", req.status === 204 || req.status === 200, `status ${req.status} ${JSON.stringify(req.body)}`);
const out = JSON.parse(await sql(`select public.undo_import('${imp}', '${c.id}')`));
check("undo reports what it reverted and kept", out.status === "undone" && out.reverted === 2 && out.kept === 2, JSON.stringify(out));
const a = await academics(s.id);
check("the untouched GPA is restored", Number(a.gpa_weighted) === 3.5);
check("the student's SAT edit is kept", a.sat_superscore === 1500);
check("the kept SAT change is marked undo_skipped", (await changeRow(ids[1])).state === "undo_skipped");
check("the unedited test score is deleted", (await sql(`select count(*) from public.test_scores where student_id = '${s.id}'`)) === "0");
check("the edited activity is kept", (await sql(`select count(*) from public.activities where student_id = '${s.id}'`)) === "1");
const row = await importRow(imp);
check("import is undone with a timestamp", row.status === "undone" && row.undone_at !== null);
check("an audit row is written", (await sql(`select count(*) from public.audit_log where action = 'import.undone' and entity_id = '${imp}'`)) === "1");
check("undo can't run twice", (await rest(c.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: imp })).status >= 400);

// Scale and GPA: GPA reverts before the scale, and a scale undo that would break an edited GPA is skipped.
const s2 = await studentOf(c, "imp-undo-scale");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s2.id}', 3.8, '4.0')`);
const r2 = await committed([
  { target: "student_academics", field: "gpa_scale", value: "100" },
  { target: "student_academics", field: "gpa_weighted", value: 92 },
], s2.id);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${r2.imp}'`);
const o2 = JSON.parse(await sql(`select public.undo_import('${r2.imp}', '${c.id}')`));
const a2 = await academics(s2.id);
check("undo restores GPA then scale", o2.status === "undone" && Number(a2.gpa_weighted) === 3.8 && a2.gpa_scale === "4.0", JSON.stringify(a2));

const s3 = await studentOf(c, "imp-undo-scale-edited");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s3.id}', 3.8, '4.0')`);
const r3 = await committed([
  { target: "student_academics", field: "gpa_scale", value: "100" },
  { target: "student_academics", field: "gpa_weighted", value: 92 },
], s3.id);
await sql(`update public.student_academics set gpa_weighted = 93 where student_id = '${s3.id}'`);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${r3.imp}'`);
const o3 = JSON.parse(await sql(`select public.undo_import('${r3.imp}', '${c.id}')`));
const a3 = await academics(s3.id);
check("scale undo that would break the GPA is skipped", o3.status === "undone" && a3.gpa_scale === "100" && Number(a3.gpa_weighted) === 93, JSON.stringify({ o3, a3 }));

// Pending invitations from the import are revoked; held data is dropped.
const s4email = `undo-invite-${Date.now()}@test.local`;
const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token) values ('${c.id}', '${s4email}', 'tok-${Date.now()}') returning id) select id from i`);
const imp4 = await makeImport(c);
const item4 = await addItem(imp4, { status: "new_invite", invitationId: inv });
await addChange(imp4, item4, { target: "student_academics", field: "sat_superscore", value: 1400, oldValue: null });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp4}'`);
await sql(`select public.commit_import('${imp4}', '${c.id}')`);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${imp4}'`);
const o4 = JSON.parse(await sql(`select public.undo_import('${imp4}', '${c.id}')`));
check("undo revokes the import's pending invitations", o4.invitationsRevoked === 1 && (await sql(`select status from public.invitations where id = '${inv}'`)) === "revoked");
check("held data for that invitation is dropped", (await sql(`select match_status from public.import_items where id = '${item4}'`)) === "skipped");

// After 30 days: no undo.
const { imp: old } = await committed([{ target: "student_academics", field: "act_composite", value: 33 }]);
await sql(`update public.roster_imports set undo_until = now() - interval '1 minute' where id = '${old}'`);
const late = await rest(c.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: old });
check("undo after 30 days is refused with a reason", late.status >= 400 && /30 days/.test(JSON.stringify(late.body)), JSON.stringify(late.body));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-undo.test.mjs`
Expected: FAIL at "the uploader can request undo" (`request_import_undo` doesn't exist), then a thrown error.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000006_imports_undo.sql`:

```sql
-- Import pipeline, step 1: undo (spec §5.9). Reverts every applied change
-- whose value is still what the import wrote; anything edited since is kept
-- and reported. Includes held data applied later from "Ready to apply".

create or replace function public.request_import_undo(p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if v.status in ('committing','undoing') then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v.status <> 'committed' then
    raise exception 'Only a saved import can be undone' using errcode = '55000';
  end if;
  if v.undo_until is null or now() >= v.undo_until then
    raise exception 'Undo is only available for 30 days after saving' using errcode = 'P0001';
  end if;
  update public.roster_imports
     set status = 'undoing', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_import;
end;
$$;

create or replace function public.undo_import(p_import uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  c record;
  v_ok boolean;
  v_reverted integer := 0;
  v_kept integer := 0;
  v_revoked integer := 0;
  v_result jsonb;
begin
  select * into v from public.roster_imports where id = p_import for update skip locked;
  if not found then
    if exists (select 1 from public.roster_imports where id = p_import) then
      return jsonb_build_object('status', 'busy');
    end if;
    raise exception 'No such import' using errcode = 'P0002';
  end if;
  if v.status <> 'undoing' then
    return jsonb_build_object('status', 'not-requested', 'current', v.status);
  end if;
  if not private.can_manage_import(p_import, p_actor) or v.undo_until is null or now() >= v.undo_until then
    update public.roster_imports
       set status = 'committed',
           job_error = jsonb_build_object('message', 'Undo is only available for 30 days after saving, by someone with access')
     where id = p_import;
    return jsonb_build_object('status', 'committed');
  end if;

  -- Newest first; a GPA is restored before its scale.
  for c in
    select ch.id, ch.op, ch.target_table, ch.field, ch.old_value, ch.applied_value, ch.target_row_id, it.student_id
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import and ch.state = 'applied'
    order by ch.applied_at desc, (ch.field = 'gpa_scale') asc, ch.created_at desc
    for update of ch
  loop
    if c.op = 'set_field' then
      begin
        v_ok := private.import_set_field(c.target_table, c.field, c.student_id, c.applied_value, c.old_value);
      exception when check_violation then
        -- e.g. restoring a 4.0 scale under a GPA someone set to 93 since.
        v_ok := false;
      end;
    else
      v_ok := private.import_row_snapshot(c.target_table, c.target_row_id) is not distinct from c.applied_value
              and private.import_delete_row(c.target_table, c.target_row_id);
    end if;
    if v_ok then
      update public.import_changes set state = 'undone' where id = c.id;
      v_reverted := v_reverted + 1;
    else
      update public.import_changes set state = 'undo_skipped', error = 'Edited since the import; kept' where id = c.id;
      v_kept := v_kept + 1;
    end if;
  end loop;

  update public.invitations
     set status = 'revoked'
   where status = 'pending'
     and id in (select it.invitation_id from public.import_items it
                where it.import_id = p_import and it.match_status = 'new_invite' and it.invitation_id is not null);
  get diagnostics v_revoked = row_count;

  update public.import_items
     set match_status = 'skipped', skip_reason = 'The import was undone'
   where import_id = p_import and match_status in ('new_invite','awaiting_counselor');
  update public.import_changes
     set state = 'undone'
   where import_id = p_import and state = 'staged'
     and item_id in (select it.id from public.import_items it
                     where it.import_id = p_import and it.skip_reason = 'The import was undone');

  v_result := jsonb_build_object('reverted', v_reverted, 'kept', v_kept, 'invitationsRevoked', v_revoked);
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'import.undone', 'roster_import', p_import, v_result);

  update public.roster_imports
     set status = 'undone', undone_at = now(), job_error = null, job_result = v_result
   where id = p_import;

  return jsonb_build_object('status', 'undone') || v_result;
end;
$$;

revoke all on function public.request_import_undo(uuid) from public, anon;
grant execute on function public.request_import_undo(uuid) to authenticated;
revoke all on function public.undo_import(uuid, uuid) from public, anon, authenticated;
grant execute on function public.undo_import(uuid, uuid) to import_worker, service_role;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-undo.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261014000006_imports_undo.sql test/integration/imports-undo.test.mjs
git commit -m "feat(imports): 30-day undo that keeps later edits and revokes pending invites

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Held data — acceptance routing, the queue, applying, expiry

**Files:**
- Create: `supabase/migrations/20261014000007_imports_held.sql`
- Test: `test/integration/imports-held.test.mjs`

**Interfaces:**
- Consumes: Tasks 3–6; the current `public.accept_invitation(text)` body in `20261005010002_overview_invitation_intake_and_referrals.sql`.
- Produces:
  - `public.accept_invitation(p_token text) returns uuid` — unchanged behavior plus: `new_invite` items for this invitation → `awaiting_counselor` with `student_id` and `held_until = now() + 30 days`; old-flow `roster_import_rows` for this invitation are carried into the same queue (`private.import_hold_legacy_rows`).
  - `public.import_held_queue() returns jsonb` — `authenticated`; array of `{itemId, importId, importedName, studentId, studentName, studentEmail, heldUntil, jobError, changes: [{id, targetTable, field, op, newValue, currentValue, defaultDecision}]}` for items in `awaiting_counselor` the caller can view.
  - `public.request_held_apply(p_item uuid, p_decisions jsonb) returns void` — `authenticated`; `p_decisions` = `{ "<changeId>": "accept" | "keep_old" | "reject" }`; `awaiting_counselor → applying`.
  - `public.apply_held_item(p_item uuid, p_actor uuid) returns jsonb` — worker; `{status: 'applied', applied, stale}` | `awaiting_counselor` (problems) | `busy` | `not-requested`.
  - `public.expire_import_holds() returns jsonb` — worker; `{expired, warn: [{itemId, counselorId, counselorEmail, counselorName, importedName, heldUntil}]}`; marks `hold_warned_at` for the returned items.

- [ ] **Step 1: Write the failing test**

Create `test/integration/imports-held.test.mjs`:

```js
// Import pipeline step 1, Task 7: held data never attaches by itself (§5.8).
import { check, sql, user, rest } from "./harness.mjs";
import { makeImport, addItem, addChange, academics, q } from "./imports-helpers.mjs";

const c = await user("imp-held");
const tag = Date.now();

async function invite(email) {
  const token = `held-${tag}-${Math.random().toString(36).slice(2)}`;
  const id = await sql(`with i as (insert into public.invitations (counselor_id, email, token, full_name) values ('${c.id}', '${email}', '${token}', 'Jane Doe') returning id) select id from i`);
  return { id, token };
}

// New pipeline: committed import with a new_invite item.
const inv = await invite(`held-${tag}@test.local`);
const imp = await makeImport(c);
const item = await addItem(imp, { status: "new_invite", invitationId: inv.id, name: "Jane Doe" });
const satChange = await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1450, oldValue: null, decision: "auto" });
await addChange(imp, item, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Biology", kind: "ap", score: "5" }, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
await sql(`select public.commit_import('${imp}', '${c.id}')`);

const student = await user("held-student", "student");
const acc = await rest(student.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: inv.token });
check("the student accepts the invitation", acc.status === 200, `status ${acc.status} ${JSON.stringify(acc.body)}`);
check("nothing attaches on acceptance", (await academics(student.id)) === null);
const st = await sql(`select match_status || ',' || (student_id = '${student.id}')::text || ',' || (held_until > now() + interval '29 days')::text from public.import_items where id = '${item}'`);
check("the item waits for the counselor for 30 days", st === "awaiting_counselor,true,true", st);

const queue = await rest(c.token, "POST", "/rest/v1/rpc/import_held_queue", {});
const entry = (queue.body ?? []).find((e) => e.itemId === item);
check("the counselor's queue shows the item", !!entry, JSON.stringify(queue.body).slice(0, 300));
check("the queue shows the account's name and the imported name", entry?.importedName === "Jane Doe" && entry?.studentName === "held-student");
check("an empty field defaults to accept", entry?.changes.find((ch) => ch.field === "sat_superscore")?.defaultDecision === "accept");

const otherC = await user("imp-held-other");
const theirs = await rest(otherC.token, "POST", "/rest/v1/rpc/import_held_queue", {});
check("another counselor's queue doesn't show it", !(theirs.body ?? []).some((e) => e.itemId === item));

// The student types an SAT during intake; the counselor keeps it.
await sql(`insert into public.student_academics (student_id, sat_superscore) values ('${student.id}', 1500)`);
const scoreChange = entry.changes.find((ch) => ch.op === "insert_row").id;
const decisions = { [satChange]: "keep_old", [scoreChange]: "accept" };
const req = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: item, p_decisions: decisions });
check("the counselor requests apply", req.status === 204 || req.status === 200, `status ${req.status} ${JSON.stringify(req.body)}`);
const out = JSON.parse(await sql(`select public.apply_held_item('${item}', '${c.id}')`));
check("apply reports applied", out.status === "applied" && out.applied === 1, JSON.stringify(out));
check("the student's own SAT is kept", (await academics(student.id)).sat_superscore === 1500);
check("the accepted test score is added", (await sql(`select count(*) from public.test_scores where student_id = '${student.id}' and source = 'import'`)) === "1");
check("the item is applied", (await sql(`select match_status from public.import_items where id = '${item}'`)) === "applied");
check("an audit row is written", (await sql(`select count(*) from public.audit_log where action = 'import.held_applied' and entity_id = '${item}'`)) === "1");

// Undo of the import reverts the held data that was applied.
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${imp}'`);
const undo = JSON.parse(await sql(`select public.undo_import('${imp}', '${c.id}')`));
check("undo reverts applied held data too", undo.status === "undone" && (await sql(`select count(*) from public.test_scores where student_id = '${student.id}'`)) === "0", JSON.stringify(undo));

// Old roster flow: a row that was sent as an invitation lands in the queue on acceptance.
const legacyInv = await invite(`legacy-${tag}@test.local`);
const legacyImp = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${c.id}', 'old.csv', 'csv', 'complete') returning id) select id from i`);
await sql(`insert into public.roster_import_rows (import_id, counselor_id, row_number, full_name, email, gpa_weighted, sat_total, intended_major, status, invitation_id)
  values ('${legacyImp}', '${c.id}', 2, 'Sam Lee', 'legacy-${tag}@test.local', 3.7, 1380, 'Biology', 'invited', '${legacyInv.id}')`);
const legacyStudent = await user("legacy-student", "student");
await rest(legacyStudent.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: legacyInv.token });
const legacyItem = await sql(`select id from public.import_items where student_id = '${legacyStudent.id}' and match_status = 'awaiting_counselor'`);
check("an old-flow row is carried into the queue", /^[0-9a-f-]{36}$/.test(legacyItem), legacyItem);
const legacyFields = await sql(`select string_agg(field, ',' order by field) from public.import_changes where item_id = '${legacyItem}'`);
check("its GPA, SAT and major are held", legacyFields === "gpa_weighted,intended_majors,sat_superscore", legacyFields);
check("still nothing attaches", (await academics(legacyStudent.id)) === null);

// Expiry: a warning 7 days before, then the data is wiped.
const soon = await sql(`with x as (update public.import_items set held_until = now() + interval '3 days' where id = '${legacyItem}' returning id) select id from x`);
const exp1 = JSON.parse(await sql(`select public.expire_import_holds()`));
check("a hold ending within 7 days is returned for a warning", exp1.warn.some((w) => w.itemId === soon && w.counselorEmail === c.email), JSON.stringify(exp1));
const exp1b = JSON.parse(await sql(`select public.expire_import_holds()`));
check("the warning is returned only once", !exp1b.warn.some((w) => w.itemId === soon));
await sql(`update public.import_items set held_until = now() - interval '1 minute' where id = '${legacyItem}'`);
const exp2 = JSON.parse(await sql(`select public.expire_import_holds()`));
check("an expired hold is wiped", exp2.expired >= 1 && (await sql(`select count(*) from public.import_changes where item_id = '${legacyItem}'`)) === "0");
check("the item is marked expired", (await sql(`select match_status from public.import_items where id = '${legacyItem}'`)) === "expired");

// A pending invitation that expired takes its held data with it.
const inv3 = await invite(`never-${tag}@test.local`);
const imp3 = await makeImport(c);
const item3 = await addItem(imp3, { status: "new_invite", invitationId: inv3.id });
await addChange(imp3, item3, { target: "student_academics", field: "act_composite", value: 30, oldValue: null, decision: "auto" });
await sql(`update public.invitations set expires_at = now() - interval '1 minute' where id = '${inv3.id}'`);
await sql(`select public.expire_import_holds()`);
check("data for a never-accepted invitation expires with it", (await sql(`select match_status from public.import_items where id = '${item3}'`)) === "expired");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-held.test.mjs`
Expected: FAIL at "the item waits for the counselor for 30 days" (status is still `new_invite`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000007_imports_held.sql`. **The `accept_invitation` body is the one in `20261005010002_overview_invitation_intake_and_referrals.sql` with two additions marked `-- NEW`;** copy it exactly as below.

```sql
-- Import pipeline, step 1: held data (spec §5.8). Data for an invited student
-- never attaches on acceptance; it waits in the counselor's "Ready to apply"
-- queue for 30 days. This also carries the old roster flow's staged values
-- into the queue, which fixes the lost-data bug.

create or replace function private.import_hold_legacy_rows(p_invitation uuid, p_student uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.roster_import_rows;
  v_item uuid;
begin
  for r in
    select * from public.roster_import_rows
    where invitation_id = p_invitation and status = 'invited'
  loop
    if exists (select 1 from public.import_items where legacy_row_id = r.id) then
      continue;
    end if;
    insert into public.import_items (import_id, legacy_row_id, locator, match_status, match_confidence,
                                     match_reasons, student_id, invitation_id, imported_name, match_key, held_until)
    values (r.import_id, r.id, jsonb_build_object('row', r.row_number), 'awaiting_counselor', 'medium',
            array['legacy'], p_student, p_invitation, r.full_name,
            jsonb_build_object('email', r.email, 'fullName', r.full_name),
            now() + interval '30 days')
    returning id into v_item;

    insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, decision, source_ref, state)
    select r.import_id, v_item, x.t, x.f, 'set_field', x.v, 'keep_old', 'Row ' || r.row_number,
           case when private.import_value_ok(fl.value_type, x.v) then 'staged' else 'skipped_invalid' end
    from (values
      ('student_academics', 'gpa_weighted',   to_jsonb(r.gpa_weighted)),
      ('student_academics', 'gpa_unweighted', to_jsonb(r.gpa_unweighted)),
      ('student_academics', 'sat_superscore', to_jsonb(r.sat_total)),
      ('student_academics', 'act_composite',  to_jsonb(r.act_composite)),
      ('student_personal_details', 'intended_majors',
         case when r.intended_major is null or btrim(r.intended_major) = '' then null
              else jsonb_build_array(btrim(r.intended_major)) end)
    ) as x(t, f, v)
    join public.import_fields fl on fl.target_table = x.t and fl.field = x.f
    where x.v is not null;
  end loop;
end;
$$;
revoke all on function private.import_hold_legacy_rows(uuid, uuid) from public, anon, authenticated;

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_role          text;
  v_counselor     uuid;
  v_inv           public.invitations;
  v_inviter_role  text;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select role, counselor_id into v_role, v_counselor
  from public.profiles where id = v_user;

  if v_role is distinct from 'student' then
    raise exception 'Only students can accept an invitation' using errcode = '42501';
  end if;
  if v_counselor is not null then
    raise exception 'You are already connected to a counselor' using errcode = '23505';
  end if;

  select * into v_inv
  from public.invitations
  where token = p_token
  for update;

  if not found then
    raise exception 'That invitation link is not valid' using errcode = 'P0002';
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'That invitation was revoked' using errcode = 'P0001';
  end if;
  if v_inv.status = 'accepted' then
    raise exception 'That invitation has already been used' using errcode = '23505';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'That invitation link has expired' using errcode = 'P0001';
  end if;
  if v_inv.counselor_id = v_user then
    raise exception 'You cannot accept your own invitation' using errcode = 'P0001';
  end if;

  select role into v_inviter_role from public.profiles where id = v_inv.counselor_id;
  if v_inviter_role is distinct from 'counselor' then
    raise exception 'That invitation is no longer valid' using errcode = 'P0001';
  end if;

  update public.invitations
     set status = 'accepted', accepted_by = v_user, accepted_at = now()
   where id = v_inv.id;

  update public.profiles
     set counselor_id = v_inv.counselor_id,
         grad_year    = coalesce(nullif(grad_year, ''), v_inv.grad_year::text),
         timezone     = coalesce(nullif(timezone, ''), v_inv.timezone)
   where id = v_user;

  -- NEW: imported data for this invitation waits for the counselor (§5.8).
  update public.import_items
     set match_status = 'awaiting_counselor', student_id = v_user,
         held_until = now() + interval '30 days'
   where invitation_id = v_inv.id and match_status = 'new_invite';

  -- NEW: the old roster flow's staged values join the same queue.
  perform private.import_hold_legacy_rows(v_inv.id, v_user);

  return v_inv.counselor_id;
end;
$function$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The "Ready to apply" queue
-- ---------------------------------------------------------------------------

create or replace function public.import_held_queue()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(entry order by entry ->> 'heldUntil'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'itemId', it.id,
      'importId', it.import_id,
      'importedName', it.imported_name,
      'studentId', it.student_id,
      'studentName', p.full_name,
      'studentEmail', p.email,
      'heldUntil', it.held_until,
      'jobError', it.job_error,
      'changes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', ch.id,
          'targetTable', ch.target_table,
          'field', ch.field,
          'op', ch.op,
          'newValue', ch.new_value,
          'currentValue', case when ch.op = 'set_field'
                               then private.import_current_value(ch.target_table, ch.field, it.student_id) end,
          'defaultDecision', case
             when ch.op = 'insert_row' then 'accept'
             when private.import_current_value(ch.target_table, ch.field, it.student_id) is null then 'accept'
             else 'keep_old' end
        ) order by ch.target_table, ch.field)
        from public.import_changes ch
        where ch.item_id = it.id and ch.state = 'staged'
      ), '[]'::jsonb)
    ) as entry
    from public.import_items it
    join public.profiles p on p.id = it.student_id
    where it.match_status = 'awaiting_counselor'
      and private.can_view_import(it.import_id, (select auth.uid()))
  ) q;
$$;

create or replace function public.request_held_apply(p_item uuid, p_decisions jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.import_items;
  k text;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v from public.import_items where id = p_item for update;
  if not found or not private.can_manage_import(v.import_id, v_me) then
    raise exception 'That held import isn''t yours' using errcode = '42501';
  end if;
  if v.match_status = 'applying' then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v.match_status <> 'awaiting_counselor' then
    raise exception 'That data is no longer waiting to be applied' using errcode = '55000';
  end if;
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'object' then
    raise exception 'Decisions are required' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_decisions) loop
    if p_decisions ->> k not in ('accept','keep_old','reject') then
      raise exception 'Unknown decision %', p_decisions ->> k using errcode = '22023';
    end if;
  end loop;

  update public.import_changes ch
     set decision = p_decisions ->> ch.id::text
   where ch.item_id = p_item and ch.state = 'staged' and p_decisions ? ch.id::text;

  update public.import_items
     set match_status = 'applying', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_item;
end;
$$;

create or replace function public.apply_held_item(p_item uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it public.import_items;
  v_problems jsonb;
  c record;
  v_current jsonb;
  v_ok boolean;
  v_row uuid;
  v_applied integer := 0;
  v_stale integer := 0;
  v_result jsonb;
begin
  select * into it from public.import_items where id = p_item for update skip locked;
  if not found then
    if exists (select 1 from public.import_items where id = p_item) then
      return jsonb_build_object('status', 'busy');
    end if;
    raise exception 'No such item' using errcode = 'P0002';
  end if;
  if it.match_status <> 'applying' then
    return jsonb_build_object('status', 'not-requested', 'current', it.match_status);
  end if;
  if not private.can_manage_import(it.import_id, p_actor)
     or not private.import_can_write_student(it.import_id, it.student_id, p_actor) then
    update public.import_items
       set match_status = 'awaiting_counselor',
           job_error = jsonb_build_object('message', 'You no longer have access to this student')
     where id = p_item;
    return jsonb_build_object('status', 'awaiting_counselor');
  end if;

  v_problems := private.import_validate(it.import_id, p_item);
  if jsonb_array_length(v_problems) > 0 then
    update public.import_items
       set match_status = 'awaiting_counselor',
           job_error = jsonb_build_object('message', 'Some values need fixing before applying', 'problems', v_problems)
     where id = p_item;
    return jsonb_build_object('status', 'awaiting_counselor', 'problems', v_problems);
  end if;

  for c in
    select ch.id, ch.op, ch.target_table, ch.field, ch.new_value
    from public.import_changes ch
    where ch.item_id = p_item and ch.state = 'staged' and ch.decision in ('auto','accept')
    order by (ch.field = 'gpa_scale') desc, ch.created_at
    for update of ch
  loop
    if c.op = 'set_field' then
      -- The counselor decided against what the record holds now.
      v_current := private.import_current_value(c.target_table, c.field, it.student_id);
      v_ok := private.import_set_field(c.target_table, c.field, it.student_id, v_current, c.new_value);
      if v_ok then
        update public.import_changes
           set old_value = v_current, state = 'applied', applied_at = now(),
               applied_value = private.import_current_value(c.target_table, c.field, it.student_id),
               new_value_hash = private.import_value_hash(private.import_current_value(c.target_table, c.field, it.student_id))
         where id = c.id;
        v_applied := v_applied + 1;
      else
        update public.import_changes
           set state = 'skipped_stale', error = 'Changed while applying; the newer value was kept'
         where id = c.id;
        v_stale := v_stale + 1;
      end if;
    else
      v_row := private.import_insert_row(c.target_table, it.student_id, c.new_value);
      if v_row is null then
        update public.import_changes set state = 'skipped_stale', error = 'Already on the student''s record' where id = c.id;
        v_stale := v_stale + 1;
      else
        update public.import_changes
           set state = 'applied', applied_at = now(), target_row_id = v_row,
               applied_value = private.import_row_snapshot(c.target_table, v_row),
               new_value_hash = private.import_value_hash(private.import_row_snapshot(c.target_table, v_row))
         where id = c.id;
        v_applied := v_applied + 1;
      end if;
    end if;
  end loop;

  v_result := jsonb_build_object('applied', v_applied, 'stale', v_stale);
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'import.held_applied', 'import_item', p_item, v_result);
  update public.import_items set match_status = 'applied', job_error = null where id = p_item;
  return jsonb_build_object('status', 'applied') || v_result;
end;
$$;

create or replace function public.expire_import_holds()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired integer := 0;
  v_more integer := 0;
  v_warn jsonb;
begin
  -- Never-accepted invitations: the data goes when the invitation does.
  with gone as (
    update public.import_items it
       set match_status = 'expired', skip_reason = 'The invitation expired before it was accepted'
      from public.invitations i
     where it.invitation_id = i.id
       and it.match_status = 'new_invite'
       and (i.status = 'revoked' or (i.status = 'pending' and i.expires_at < now()))
    returning it.id
  )
  delete from public.import_changes ch using gone where ch.item_id = gone.id and ch.state = 'staged';
  select count(*) into v_expired from public.import_items
   where match_status = 'expired' and skip_reason = 'The invitation expired before it was accepted'
     and updated_at > now() - interval '1 minute';

  -- Accepted but never applied within 30 days.
  with gone as (
    update public.import_items
       set match_status = 'expired', skip_reason = 'Held data expired after 30 days'
     where match_status = 'awaiting_counselor' and held_until < now()
    returning id
  )
  delete from public.import_changes ch using gone where ch.item_id = gone.id and ch.state = 'staged';
  select count(*) into v_more from public.import_items
   where match_status = 'expired' and skip_reason = 'Held data expired after 30 days'
     and updated_at > now() - interval '1 minute';
  v_expired := v_expired + v_more;

  -- Warn once, 7 days before.
  with due as (
    update public.import_items it
       set hold_warned_at = now()
     where it.match_status = 'awaiting_counselor'
       and it.hold_warned_at is null
       and it.held_until < now() + interval '7 days'
    returning it.id, it.import_id, it.imported_name, it.held_until
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', due.id, 'counselorId', i.counselor_id, 'counselorEmail', p.email,
           'counselorName', p.full_name, 'importedName', due.imported_name, 'heldUntil', due.held_until)), '[]'::jsonb)
    into v_warn
    from due
    join public.roster_imports i on i.id = due.import_id
    join public.profiles p on p.id = i.counselor_id;

  if v_expired > 0 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (null, 'import.holds_expired', 'import_item', null, jsonb_build_object('expired', v_expired));
  end if;
  return jsonb_build_object('expired', v_expired, 'warn', v_warn);
end;
$$;

revoke all on function public.import_held_queue() from public, anon;
revoke all on function public.request_held_apply(uuid, jsonb) from public, anon;
grant execute on function public.import_held_queue() to authenticated;
grant execute on function public.request_held_apply(uuid, jsonb) to authenticated;
revoke all on function public.apply_held_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.expire_import_holds() from public, anon, authenticated;
grant execute on function public.apply_held_item(uuid, uuid) to import_worker, service_role;
grant execute on function public.expire_import_holds() to import_worker, service_role;
```

Note on the expiry counts: the "updated_at in the last minute" count can over-count if the sweep runs twice within a minute; it only feeds the audit summary. If that matters to the reviewer, replace each `with gone … delete …` with a `with gone as (…), del as (delete … returning 1) select count(*) from gone` form. Either is acceptable.

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-held.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Re-run the invitation suites (accept_invitation changed)**

Run (API running): `node test/integration/overview-invites.test.mjs && node test/integration/hardening.test.mjs && node test/integration/stress-fixes.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261014000007_imports_held.sql test/integration/imports-held.test.mjs
git commit -m "fix(imports): hold imported data for the counselor instead of losing it on acceptance

Old roster rows and new imports both wait in a Ready to apply queue for
30 days; nothing attaches automatically.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Provenance, compaction and the Close-cycle GPA guard

**Files:**
- Create: `supabase/migrations/20261014000008_imports_provenance_and_gpa.sql`
- Test: `test/integration/imports-provenance.test.mjs`

**Interfaces:**
- Consumes: Tasks 3–7; `public.close_admission_cycle(text)` in `20261005010003_overview_outcomes_and_alumni.sql`.
- Produces:
  - `public.import_field_provenance(p_student uuid, p_target text, p_field text) returns jsonb` — worker/service; `{importId, sourceSystem, templateId, matchesCurrent}` for the latest applied change to that field, or `null`. Step 2 uses it for review defaults (§5.6).
  - `public.compact_imports() returns integer` — worker/service; number of changes compacted.
  - `close_admission_cycle` copies GPAs into `admission_outcomes` only when ≤ 10.

- [ ] **Step 1: Write the failing test**

Create `test/integration/imports-provenance.test.mjs`:

```js
// Import pipeline step 1, Task 8: provenance survives compaction; deletion removes fingerprints.
import { check, sql, user, SB } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, changeRow } from "./imports-helpers.mjs";

const c = await user("imp-prov");
const s = await studentOf(c, "imp-prov-student");

const imp = await makeImport(c, { sourceSystem: "collegeplannerpro" });
const item = await addItem(imp, { studentId: s.id });
const ch = await addChange(imp, item, { target: "student_academics", field: "gpa_weighted", value: 3.8, studentId: s.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
await sql(`select public.commit_import('${imp}', '${c.id}')`);

const prov = async () => JSON.parse((await sql(`select coalesce(public.import_field_provenance('${s.id}', 'student_academics', 'gpa_weighted')::text, 'null')`)));
let p = await prov();
check("provenance names the source system", p?.sourceSystem === "collegeplannerpro" && p?.importId === imp, JSON.stringify(p));
check("the value is still what the import wrote", p?.matchesCurrent === true);

// 30 days later: compaction drops the values, keeps the fingerprint.
await sql(`update public.roster_imports set undo_until = now() - interval '1 minute' where id = '${imp}'`);
const n = Number(await sql(`select public.compact_imports()`));
check("compaction reports work done", n >= 1, String(n));
const row = await changeRow(ch);
check("compacted change has no values", row.old_value === null && row.new_value === null && row.applied_value === null);
check("compacted change keeps its fingerprint", /^[0-9a-f]{64}$/.test(row.new_value_hash));
check("the import is marked compacted", (await sql(`select (compacted_at is not null)::text from public.roster_imports where id = '${imp}'`)) === "true");
p = await prov();
check("provenance still works after compaction", p?.matchesCurrent === true);

await sql(`update public.student_academics set gpa_weighted = 3.9 where student_id = '${s.id}'`);
p = await prov();
check("after a person edits the value, it no longer matches", p?.matchesCurrent === false);

// Held data waiting for a counselor is not compacted.
const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token) values ('${c.id}', 'prov-${Date.now()}@test.local', 'prov-${Date.now()}') returning id) select id from i`);
const imp2 = await makeImport(c);
const held = await addItem(imp2, { status: "new_invite", invitationId: inv });
const heldCh = await addChange(imp2, held, { target: "student_academics", field: "act_composite", value: 30, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committed', committed_at = now() - interval '31 days', undo_until = now() - interval '1 day' where id = '${imp2}'`);
await sql(`select public.compact_imports()`);
check("held data is not compacted", (await changeRow(heldCh)).new_value === 30);

// Deleting the student's account deletes their import data and fingerprints.
await sql(`delete from auth.users where id = '${s.id}'`);
check("account deletion removes the student's import changes", (await sql(`select count(*) from public.import_changes where id = '${ch}'`)) === "0");

// Close cycle never copies a 100-point GPA into admission_outcomes.
const fn = await sql(`select pg_get_functiondef('public.close_admission_cycle(text)'::regprocedure)`);
check("close_admission_cycle guards GPAs over 10", fn.includes("sa.gpa_weighted <= 10") && fn.includes("sa.gpa_unweighted <= 10"));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && node test/integration/imports-provenance.test.mjs`
Expected: throws at `import_field_provenance` (doesn't exist).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261014000008_imports_provenance_and_gpa.sql`:

```sql
-- Import pipeline, step 1: provenance (spec §5.6), compaction (§5.10) and the
-- one database function that copies GPAs somewhere with a 10-point limit.

create or replace function public.import_field_provenance(p_student uuid, p_target text, p_field text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'importId', ch.import_id,
    'sourceSystem', i.source_system,
    'templateId', i.template_id,
    'matchesCurrent', ch.new_value_hash = private.import_value_hash(
                        private.import_current_value(p_target, p_field, p_student))
  )
  from public.import_changes ch
  join public.import_items it on it.id = ch.item_id
  join public.roster_imports i on i.id = ch.import_id
  where it.student_id = p_student
    and ch.target_table = p_target
    and ch.field = p_field
    and ch.op = 'set_field'
    and ch.state = 'applied'
    and ch.new_value_hash is not null
  order by ch.applied_at desc
  limit 1;
$$;

-- After the undo window: drop values, keep fingerprints (personal data,
-- deleted with the student's account by cascade). Held data that is still
-- waiting is left alone; it has its own 30-day clock (§5.8).
create or replace function public.compact_imports()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_deleted integer := 0;
begin
  update public.import_changes ch
     set old_value = null, new_value = null, applied_value = null
    from public.roster_imports i, public.import_items it
   where i.id = ch.import_id
     and it.id = ch.item_id
     and i.undo_until is not null and i.undo_until < now()
     and it.match_status not in ('new_invite','awaiting_counselor','applying')
     and ch.state <> 'staged'
     and (ch.old_value is not null or ch.new_value is not null or ch.applied_value is not null);
  get diagnostics v_n = row_count;

  -- Staged changes nobody applied (kept-old, rejected, unconfirmed): not needed.
  delete from public.import_changes ch
   using public.roster_imports i, public.import_items it
   where i.id = ch.import_id
     and it.id = ch.item_id
     and i.undo_until is not null and i.undo_until < now()
     and it.match_status not in ('new_invite','awaiting_counselor','applying')
     and ch.state = 'staged';
  get diagnostics v_deleted = row_count;

  update public.import_files f
     set profile = null
    from public.roster_imports i
   where i.id = f.import_id and i.undo_until is not null and i.undo_until < now() and f.profile is not null;

  update public.roster_imports
     set compacted_at = now()
   where undo_until is not null and undo_until < now() and compacted_at is null;

  return v_n + v_deleted;
end;
$$;

revoke all on function public.import_field_provenance(uuid, text, text) from public, anon, authenticated;
revoke all on function public.compact_imports() from public, anon, authenticated;
grant execute on function public.import_field_provenance(uuid, text, text) to import_worker, service_role;
grant execute on function public.compact_imports() to import_worker, service_role;
```

Then append the Close-cycle guard: **copy the complete `create or replace function public.close_admission_cycle(p_cycle text)` statement from `supabase/migrations/20261005010003_overview_outcomes_and_alumni.sql`** (from its `create or replace function` line through its closing `$function$;`, plus the `revoke`/`grant` lines that follow it in that file) into the end of this migration, under this header, and change exactly one line inside the `insert into public.admission_outcomes … select` list:

```sql
-- ---------------------------------------------------------------------------
-- Close cycle copies GPAs into admission_outcomes, whose columns stay ≤ 10.
-- A 100-point GPA (allowed in student_academics since 20261014000001) is
-- recorded as unknown there rather than failing the whole close.
-- Copied from 20261005010003; the only change is the GPA line in the select.
-- ---------------------------------------------------------------------------
```

Replace:

```sql
      sa.gpa_unweighted, sa.gpa_weighted, sa.sat_superscore, sa.act_composite,
```

with:

```sql
      case when sa.gpa_unweighted <= 10 then sa.gpa_unweighted end,
      case when sa.gpa_weighted <= 10 then sa.gpa_weighted end,
      sa.sat_superscore, sa.act_composite,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `supabase db reset && node test/integration/imports-provenance.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Run every SQL suite together**

Run: `supabase db reset && for f in test/integration/imports-*.test.mjs; do node "$f" || exit 1; done`
Expected: all PASS (Task 10's `imports-api.test.mjs` and Task 11's property test don't exist yet).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261014000008_imports_provenance_and_gpa.sql test/integration/imports-provenance.test.mjs
git commit -m "feat(imports): provenance by fingerprint, 30-day compaction, close-cycle GPA guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The import_worker connection and job runner

**Files:**
- Modify: `package.json` (add `pg`, `@types/pg`, `fast-check`; script `test:imports-load`)
- Modify: `src/env.ts`, `src/index.ts`, `src/lib/heartbeat.ts`, `.env.example`
- Create: `src/lib/imports/db.ts`, `src/lib/imports/jobs.ts`
- Test: `test/unit/import-db.test.ts`

**Interfaces:**
- Consumes: SQL functions from Tasks 5–8; `serviceClient()`; `beat()`; `sendEmail`, `brandedEmail`, `brandedText` from `src/lib/email.ts`; `acquire_job_lease` / `release_job_lease` RPCs.
- Produces:
  - `env.IMPORT_DATABASE_URL?: string`, `hasImportWorker: boolean` in `src/env.ts`.
  - `src/lib/imports/db.ts`: `importPool(): Pool | null`; `assertWorkerRole(client: Queryable): Promise<void>` (throws `WrongWorkerRoleError`); `withWorkerTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>`; `verifyImportWorkerAtBoot(log): Promise<void>`; classes `ImportWorkerUnavailable`, `WrongWorkerRoleError`; type `Queryable`.
  - `src/lib/imports/jobs.ts`: `type ImportJobKind = "commit" | "undo" | "apply"`; `runImportJob(kind, id, actor, log): Promise<{ status: string } & Record<string, unknown>>`; `kickImportJob(kind, id, actor, log): void`; `runImportSweep(log): Promise<ImportSweepOutcome>`.
  - Heartbeat `Job` type includes `"import-sweep"`.

- [ ] **Step 1: Add the dependencies**

```bash
npm install pg@^8.13.1 && npm install -D @types/pg@^8.11.10 fast-check@^3.23.1
```

In `package.json` `scripts`, add:

```json
"test:imports-load": "node test/integration/imports-load.mjs"
```

- [ ] **Step 2: Write the failing unit test**

Create `test/unit/import-db.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerRole, WrongWorkerRoleError } from "../../src/lib/imports/db.js";

const fake = (user: string) => ({
  query: async (_sql: string) => ({ rows: [{ current_user: user }] }),
});

test("the import_worker login is accepted", async () => {
  await assertWorkerRole(fake("import_worker"));
});

test("the postgres superuser login is refused", async () => {
  await assert.rejects(assertWorkerRole(fake("postgres")), WrongWorkerRoleError);
});

test("the service role login is refused", async () => {
  await assert.rejects(assertWorkerRole(fake("service_role")), /import_worker/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/lib/imports/db.js'`.

- [ ] **Step 4: Add the env var**

In `src/env.ts`, inside `envSchema` after `SUPABASE_SERVICE_ROLE_KEY`:

```ts
  // Import pipeline jobs (save, undo, apply held data) run on a direct
  // Postgres connection that must log in as the restricted `import_worker`
  // role, through Supabase's SESSION pooler (never the transaction pooler).
  // Optional: unset, import commit/undo/apply answer 503.
  IMPORT_DATABASE_URL: blankIsUnset(z.string().url().optional()),
```

and after `export const hasServiceRole = …`:

```ts
export const hasImportWorker = Boolean(env.IMPORT_DATABASE_URL);
```

In `.env.example`, add:

```bash
# Import pipeline jobs. Must log in as import_worker (never postgres) via the
# Supabase SESSION pooler, e.g.
# postgresql://import_worker.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
IMPORT_DATABASE_URL=
```

- [ ] **Step 5: Write `src/lib/imports/db.ts`**

```ts
/**
 * The import pipeline's database connection (spec §6.2).
 *
 * Save, undo and applying held data run as one transaction each, longer than
 * an HTTP request through PostgREST may last, so they use a direct `pg`
 * connection. That connection must log in as `import_worker`, a role that
 * can execute the job functions and nothing else. A pasted superuser string
 * would bypass every access rule, so it is refused at boot and per job.
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { env } from "../../env.js";

export type Queryable = {
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export class ImportWorkerUnavailable extends Error {
  constructor(message = "IMPORT_DATABASE_URL is not set") {
    super(message);
    this.name = "ImportWorkerUnavailable";
  }
}

export class WrongWorkerRoleError extends Error {
  constructor(actual: string) {
    super(`IMPORT_DATABASE_URL must log in as import_worker, not ${actual}`);
    this.name = "WrongWorkerRoleError";
  }
}

let pool: Pool | null = null;
let verified: Promise<void> | null = null;

export function importPool(): Pool | null {
  if (!env.IMPORT_DATABASE_URL) return null;
  pool ??= new pg.Pool({
    connectionString: env.IMPORT_DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 30_000,
    application_name: "meridies-import-worker",
  });
  return pool;
}

export async function assertWorkerRole(client: Queryable): Promise<void> {
  const { rows } = await client.query("select current_user");
  const actual = String(rows[0]?.current_user ?? "unknown");
  if (actual !== "import_worker") throw new WrongWorkerRoleError(actual);
}

/** One transaction on the worker connection, with the job statement timeout. */
export async function withWorkerTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = importPool();
  if (!p) throw new ImportWorkerUnavailable();
  const client = await p.connect();
  try {
    verified ??= assertWorkerRole(client).catch((err: unknown) => {
      verified = null;
      throw err;
    });
    await verified;
    await client.query("begin");
    await client.query("set local statement_timeout = '300s'");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type BootLog = { info: (m: string) => void; error: (o: object, m?: string) => void };

/**
 * Called once at boot. A wrong role is fatal (exit 1); an unreachable
 * database only disables imports until it answers.
 */
export async function verifyImportWorkerAtBoot(log: BootLog): Promise<void> {
  const p = importPool();
  if (!p) {
    log.info("IMPORT_DATABASE_URL unset: import save/undo/apply are disabled");
    return;
  }
  try {
    const client = await p.connect();
    try {
      await assertWorkerRole(client);
      log.info("import worker connection verified (import_worker)");
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof WrongWorkerRoleError) {
      log.error({ err: err.message }, "refusing to start: IMPORT_DATABASE_URL is not the import_worker login");
      process.exit(1);
    }
    log.error({ err }, "import worker connection failed at boot; imports will retry per job");
  }
}
```

- [ ] **Step 6: Run the unit test**

Run: `npm test`
Expected: the three `import-db` tests PASS (other unit tests unchanged).

- [ ] **Step 7: Verify at boot**

In `src/index.ts`, after `const app = buildApp();`:

```ts
import { verifyImportWorkerAtBoot } from "./lib/imports/db.js";
```

(put the import with the others at the top) and before `app.listen(…)`:

```ts
await verifyImportWorkerAtBoot(app.log);
```

- [ ] **Step 8: Write `src/lib/imports/jobs.ts`**

In `src/lib/heartbeat.ts`, change the `Job` type to:

```ts
export type Job = "accountability-sweep" | "message-dispatch" | "scorecard-ingest" | "resources-link-check" | "import-sweep";
```

Create `src/lib/imports/jobs.ts`:

```ts
/**
 * Running import jobs (spec §5.7–§5.10).
 *
 * The route requests a job (a status change under RLS) and kicks it here at
 * once; the cron sweep picks up any job still waiting after a minute (a
 * crash, a deploy). Each job is one transaction on the import_worker
 * connection; the SQL function locks with SKIP LOCKED, so the kick and the
 * sweep can never both apply the same import.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { beat } from "../heartbeat.js";
import { brandedEmail, brandedText, sendEmail } from "../email.js";
import { serviceClient } from "../supabase.js";
import { env } from "../../env.js";
import { withWorkerTransaction } from "./db.js";

export type ImportJobKind = "commit" | "undo" | "apply";
export type ImportJobOutcome = { status: string } & Record<string, unknown>;

type Log = {
  info: (o: object | string, m?: string) => void;
  warn: (o: object | string, m?: string) => void;
  error: (o: object | string, m?: string) => void;
};

const FUNCTION_FOR: Record<ImportJobKind, string> = {
  commit: "public.commit_import",
  undo: "public.undo_import",
  apply: "public.apply_held_item",
};

const FAILURE_MESSAGE = "Couldn't save. Nothing was changed. Try again.";

export async function runImportJob(
  kind: ImportJobKind,
  id: string,
  actor: string,
  log: Log
): Promise<ImportJobOutcome> {
  try {
    return await withWorkerTransaction(async (c) => {
      const { rows } = await c.query(`select ${FUNCTION_FOR[kind]}($1, $2) as out`, [id, actor]);
      return rows[0].out as ImportJobOutcome;
    });
  } catch (err) {
    log.error({ err, kind, id }, "import job failed; rolled back");
    await withWorkerTransaction((c) =>
      c.query("select public.fail_import_job($1, $2, $3)", [kind, id, FAILURE_MESSAGE])
    ).catch((e: unknown) => log.error({ err: e, kind, id }, "import job: could not record the failure"));
    return { status: "failed" };
  }
}

/** Fire-and-forget after the HTTP reply; the client polls for the result. */
export function kickImportJob(kind: ImportJobKind, id: string, actor: string, log: Log): void {
  setImmediate(() => {
    void runImportJob(kind, id, actor, log);
  });
}

export type ImportSweepOutcome =
  | { ran: true; jobs: number; expired: number; warned: number; compacted: number }
  | { ran: false; reason: "no-service-role" | "no-worker" | "locked" | "lease-error" };

const LEASE = "import-sweep";
const LEASE_TTL_SECONDS = 15 * 60;
const STALE_SECONDS = 60;

export async function runImportSweep(log: Log): Promise<ImportSweepOutcome> {
  const svc = serviceClient();
  if (!svc) return { ran: false, reason: "no-service-role" };
  if (!env.IMPORT_DATABASE_URL) return { ran: false, reason: "no-worker" };

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
    p_name: LEASE,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseErr) return { ran: false, reason: "lease-error" };
  if (acquired !== true) return { ran: false, reason: "locked" };

  try {
    const due = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select kind, id, actor from public.import_jobs_due($1)", [STALE_SECONDS]);
      return rows as Array<{ kind: ImportJobKind; id: string; actor: string }>;
    });
    for (const job of due) await runImportJob(job.kind, job.id, job.actor, log);

    const holds = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.expire_import_holds() as out");
      return rows[0].out as { expired: number; warn: HoldWarning[] };
    });
    for (const w of holds.warn) await warnHoldExpiring(w, log);

    const compacted = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.compact_imports() as n");
      return Number(rows[0].n);
    });

    await beat("import-sweep", true, undefined, log);
    const outcome = { ran: true as const, jobs: due.length, expired: holds.expired, warned: holds.warn.length, compacted };
    log.info(outcome, "import sweep finished");
    return outcome;
  } catch (err) {
    await beat("import-sweep", false, err instanceof Error ? err.message : String(err), log);
    throw err;
  } finally {
    const { error } = await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
    if (error) log.warn({ code: error.code }, "import sweep: lease release failed");
  }
}

type HoldWarning = {
  itemId: string;
  counselorId: string;
  counselorEmail: string;
  counselorName: string | null;
  importedName: string | null;
  heldUntil: string;
};

/** In-app and email, 7 days before held data expires (§5.8). */
async function warnHoldExpiring(w: HoldWarning, log: Log): Promise<void> {
  const svc = serviceClient();
  const who = w.importedName ?? "A student";
  const when = new Date(w.heldUntil).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const title = `${who}'s imported data expires ${when}`;
  const body = "Review it in Ready to apply before then, or it will be deleted.";
  const href = "/dashboard/counselor/imports/held";
  if (svc) {
    const { error } = await svc.from("notifications").insert({
      recipient_id: w.counselorId,
      kind: "system",
      urgency: "high",
      title,
      body,
      href,
    });
    if (error) log.warn({ code: error.code, itemId: w.itemId }, "hold warning: notification insert failed");
  }
  const email = {
    heading: title,
    paragraphs: [body],
    cta: { label: "Open Ready to apply", url: `${env.APP_URL}${href}` },
  };
  await sendEmail({
    to: w.counselorEmail,
    subject: title,
    html: brandedEmail(email),
    text: brandedText(email),
    template: "import-hold-expiring",
    recipient_kind: "counselor",
    recipient_id: w.counselorId,
  });
}
```

- [ ] **Step 9: Typecheck and unit tests**

Run: `npm run typecheck && npm test`
Expected: both pass. (If `sendEmail`'s argument type rejects `recipient_kind`/`recipient_id`, they come from `DeliveryColumns` in `src/lib/email.ts`; keep them.)

- [ ] **Step 10: Boot check against the superuser string**

Run (local stack up): `IMPORT_DATABASE_URL="$DB_URL" PORT=4199 npx tsx src/index.ts; echo "exit $?"`
Expected: a log line "refusing to start: IMPORT_DATABASE_URL is not the import_worker login" and `exit 1`.

Run: `IMPORT_DATABASE_URL="postgresql://import_worker:local-import-worker-pw@127.0.0.1:54322/postgres" PORT=4199 npx tsx src/index.ts` (after the `alter role … login password` line from "Running things locally")
Expected: "import worker connection verified (import_worker)" and the server listens; stop it with Ctrl-C.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/env.ts src/index.ts src/lib/heartbeat.ts src/lib/imports/db.ts src/lib/imports/jobs.ts .env.example test/unit/import-db.test.ts
git commit -m "feat(imports): import_worker connection, job runner and sweep

Refuses to start when IMPORT_DATABASE_URL is not the import_worker login.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Name rule, routes and the cron sweep

**Files:**
- Create: `src/lib/imports/names.ts`, `src/lib/imports/errors.ts`, `src/routes/imports.ts`
- Modify: `src/app.ts`, `src/routes/internal.ts`, `.github/workflows/ci.yml`
- Test: `test/unit/import-names.test.ts`, `test/integration/imports-api.test.mjs`

**Interfaces:**
- Consumes: Task 9 (`runImportJob`, `kickImportJob`, `runImportSweep`, `hasImportWorker`); Task 5–7 RPCs; `requireRole`, `limit`, `fromPostgrest`, `HttpError`.
- Produces:
  - `src/lib/imports/names.ts`: `normalizeName(s: string): string`; `parseName(s: string): { first: string; surnames: string[] }`; `firstNamesMatch(a: string, b: string): boolean`; `namesMatch(imported: string, account: string, preferred?: string | null): boolean`.
  - `src/lib/imports/errors.ts`: `fromImportRpc(error: { code?: string; message?: string } | null): HttpError`.
  - Routes (all `app.authenticate` + `requireRole("counselor")`):
    - `GET /imports/held` → `HeldEntry[]` (shape of `import_held_queue()` plus `nameMismatch: boolean`).
    - `GET /imports/:id` → `{ id, status, committedAt, undoUntil, undoneAt, jobError, jobResult }`.
    - `POST /imports/:id/commit` → 202 `{ status: "committing" }`; 409 already in progress / wrong status; 503 without the worker.
    - `POST /imports/:id/undo` → 202 `{ status: "undoing" }`; 409; 410 window passed; 503.
    - `POST /imports/held/:itemId/apply` body `{ decisions: Record<uuid, "accept"|"keep_old"|"reject">, confirmName?: string }` → 202 `{ status: "applying" }`; 409 `{ code: "name-confirmation-required" }` when the names don't match and `confirmName` isn't the account's name.
    - `POST /internal/imports/sweep` (CRON_SECRET) → outcome JSON; 409 when locked; 503 without service role or worker.

- [ ] **Step 1: Write the failing name-rule test**

Create `test/unit/import-names.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstNamesMatch, namesMatch, normalizeName, parseName } from "../../src/lib/imports/names.js";

test("accents, case and punctuation are ignored", () => {
  assert.equal(normalizeName("  José  O'Brien "), "jose obrien");
  assert.ok(namesMatch("JOSE OBRIEN", "José O'Brien"));
});

test("'Last, First' is understood", () => {
  assert.deepEqual(parseName("Doe, Jane"), { first: "jane", surnames: ["doe"] });
  assert.ok(namesMatch("Doe, Jane", "Jane Doe"));
});

test("hyphenated and two-part surnames match either part", () => {
  assert.ok(namesMatch("Maria Garcia-Lopez", "Maria Lopez"));
  assert.ok(namesMatch("Maria Lopez", "Maria Garcia Lopez"));
});

test("a middle name doesn't break the match", () => {
  assert.ok(namesMatch("John Michael Smith", "John Smith"));
});

test("nicknames in the same group match", () => {
  assert.ok(firstNamesMatch("Robert", "Bob"));
  assert.ok(namesMatch("Liz Chen", "Elizabeth Chen"));
});

test("names sharing a nickname but in different groups don't match", () => {
  assert.ok(!firstNamesMatch("Samuel", "Samantha"));
});

test("twins with the same last name stay apart", () => {
  assert.ok(!namesMatch("Ana Smith", "Eva Smith"));
});

test("an initial never matches", () => {
  assert.ok(!namesMatch("J. Smith", "John Smith"));
});

test("a preferred name counts", () => {
  assert.ok(namesMatch("Xiaoming Li", "Kevin Li", "Xiaoming"));
});

test("different last names don't match", () => {
  assert.ok(!namesMatch("Jane Doe", "Jane Roe"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../src/lib/imports/names.js'`.

- [ ] **Step 3: Write `src/lib/imports/names.ts`**

```ts
/**
 * The name rule for matching imported rows to accounts (spec §4.4).
 * Too strict and everything becomes a suggestion; too loose and twins on a
 * shared parent email collapse into one student. Both first and last name
 * must match; initials never do.
 */

const NICKNAME_GROUPS: readonly string[][] = [
  ["robert", "bob", "rob", "bobby", "robbie"],
  ["william", "will", "bill", "billy", "liam"],
  ["elizabeth", "liz", "beth", "eliza", "lizzie", "betsy"],
  ["katherine", "catherine", "kate", "katie", "kathy", "cate"],
  ["michael", "mike", "mikey"],
  ["christopher", "chris"],
  ["alexander", "alex", "xander"],
  ["alexandra", "alex", "lexi", "sasha"],
  ["jonathan", "jon", "john", "johnny"],
  ["joseph", "joe", "joey"],
  ["daniel", "dan", "danny"],
  ["matthew", "matt"],
  ["nicholas", "nick", "nico"],
  ["benjamin", "ben", "benji"],
  ["samuel", "sam", "sammy"],
  ["samantha", "sam", "sammy"],
  ["jennifer", "jen", "jenny"],
  ["jessica", "jess", "jessie"],
  ["margaret", "maggie", "meg", "peggy"],
  ["richard", "rich", "rick"],
  ["james", "jim", "jimmy", "jamie"],
  ["anthony", "tony"],
  ["andrew", "andy", "drew"],
  ["victoria", "vicky", "tori"],
  ["rebecca", "becky", "becca"],
  ["abigail", "abby"],
  ["madeline", "maddie"],
  ["thomas", "tom", "tommy"],
  ["edward", "ed", "eddie", "ted"],
  ["steven", "stephen", "steve"],
  ["timothy", "tim"],
  ["zachary", "zach", "zack"],
  ["isabella", "isabel", "bella", "izzy"],
  ["olivia", "liv", "livvy"],
  ["gabriel", "gabe"],
  ["gabriela", "gabriella", "gabby"],
  ["patricia", "pat", "patty", "trish"],
  ["natalie", "nat"],
  ["nathaniel", "nathan", "nate"],
  ["eleanor", "ellie", "nora"],
  ["charlotte", "charlie"],
  ["charles", "charlie", "chuck"],
  ["francisco", "paco", "pancho"],
  ["jose", "pepe"],
  ["guillermo", "memo"],
  ["alejandro", "alex", "ale"],
];

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseName(s: string): { first: string; surnames: string[] } {
  const n = normalizeName(s);
  let first: string;
  let last: string;
  if (n.includes(",")) {
    const [l, f] = n.split(",", 2);
    last = l.trim();
    first = (f ?? "").trim().split(" ")[0] ?? "";
  } else {
    const parts = n.split(" ").filter(Boolean);
    first = parts[0] ?? "";
    last = parts.slice(1).join(" ");
  }
  const surnames = last.split(/[\s-]+/).filter(Boolean);
  return { first, surnames };
}

export function firstNamesMatch(a: string, b: string): boolean {
  const x = normalizeName(a).replace(/[^a-z]/g, "");
  const y = normalizeName(b).replace(/[^a-z]/g, "");
  if (x.length < 2 || y.length < 2) return false;
  if (x === y) return true;
  return NICKNAME_GROUPS.some((g) => g.includes(x) && g.includes(y));
}

function surnamesMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return b.includes(lastA) || a.includes(lastB);
}

export function namesMatch(imported: string, account: string, preferred?: string | null): boolean {
  const i = parseName(imported);
  const a = parseName(account);
  if (!surnamesMatch(i.surnames, a.surnames)) return false;
  if (firstNamesMatch(i.first, a.first)) return true;
  return Boolean(preferred) && firstNamesMatch(i.first, preferred as string);
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: all `import-names` tests PASS.

- [ ] **Step 5: Write the failing API test**

Create `test/integration/imports-api.test.mjs`:

```js
// Import pipeline step 1, Task 10: the HTTP surface and the sweep, end to end.
import { API, CRON_SECRET, call, check, sql, user, rest } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, academics } from "./imports-helpers.mjs";

async function waitFor(token, id, done) {
  for (let i = 0; i < 60; i++) {
    const r = await call(token, "GET", `/imports/${id}`);
    if (done(r.body)) return r.body;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("timed out waiting for import " + id);
}

const c = await user("imp-api");
const s = await studentOf(c, "imp-api-student");
const imp = await makeImport(c);
const item = await addItem(imp, { studentId: s.id });
await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1420, studentId: s.id });

const other = await user("imp-api-other");
check("another counselor gets 404 for the import", (await call(other.token, "GET", `/imports/${imp}`)).status === 404);

const [first, second] = await Promise.all([
  call(c.token, "POST", `/imports/${imp}/commit`),
  call(c.token, "POST", `/imports/${imp}/commit`),
]);
const codes = [first.status, second.status].sort().join(",");
check("a double-clicked save starts one job and refuses the other", codes === "202,409", codes);
const done = await waitFor(c.token, imp, (b) => b.status !== "committing");
check("the job commits", done.status === "committed", JSON.stringify(done));
check("the value is saved", (await academics(s.id)).sat_superscore === 1420);
check("the import shows a 30-day undo window", typeof done.undoUntil === "string");

const undo = await call(c.token, "POST", `/imports/${imp}/undo`);
check("undo starts", undo.status === 202, `status ${undo.status}`);
const undone = await waitFor(c.token, imp, (b) => b.status !== "undoing");
check("undo finishes", undone.status === "undone" && undone.jobResult.reverted === 1, JSON.stringify(undone));
check("the value is reverted", (await academics(s.id)).sat_superscore === null);

// Held data with a name mismatch needs the typed name.
const tag = Date.now();
const token = `api-held-${tag}`;
const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token) values ('${c.id}', 'apiheld-${tag}@test.local', '${token}') returning id) select id from i`);
const imp2 = await makeImport(c);
const item2 = await addItem(imp2, { status: "new_invite", invitationId: inv, name: "Jane Doe" });
const ch2 = await addChange(imp2, item2, { target: "student_academics", field: "act_composite", value: 32, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp2}'`);
await sql(`select public.commit_import('${imp2}', '${c.id}')`);
const st = await user("imp-api-held-student", "student");
await sql(`update public.profiles set full_name = 'John Roe' where id = '${st.id}'`);
await rest(st.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });

const held = await call(c.token, "GET", "/imports/held");
const entry = (held.body ?? []).find((e) => e.itemId === item2);
check("the queue flags a name mismatch", entry?.nameMismatch === true, JSON.stringify(entry));
const noName = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" } });
check("applying a mismatched item without the typed name is refused", noName.status === 409 && noName.body.code === "name-confirmation-required", JSON.stringify(noName.body));
const wrongName = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" }, confirmName: "Jane Doe" });
check("typing the imported name instead of the account's is refused", wrongName.status === 409);
const ok = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" }, confirmName: "john roe" });
check("typing the account's name applies", ok.status === 202, `status ${ok.status} ${JSON.stringify(ok.body)}`);
for (let i = 0; i < 60 && (await sql(`select match_status from public.import_items where id = '${item2}'`)) === "applying"; i++) await new Promise((r) => setTimeout(r, 500));
check("the held value is applied", (await academics(st.id))?.act_composite === 32);

// The sweep: requires the cron secret; runs stuck jobs and records a heartbeat.
const noSecret = await fetch(`${API}/internal/imports/sweep`, { method: "POST" });
check("the sweep needs the cron secret", noSecret.status === 401, `status ${noSecret.status}`);
const s3 = await studentOf(c, "imp-api-stuck");
const imp3 = await makeImport(c);
const item3 = await addItem(imp3, { studentId: s3.id });
await addChange(imp3, item3, { target: "student_academics", field: "act_composite", value: 29, studentId: s3.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}', job_requested_at = now() - interval '5 minutes' where id = '${imp3}'`);
const sweep = await fetch(`${API}/internal/imports/sweep`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const sweepBody = await sweep.json();
check("the sweep runs", sweep.status === 200 && sweepBody.ran === true && sweepBody.jobs >= 1, JSON.stringify(sweepBody));
check("the stuck commit was finished by the sweep", (await academics(s3.id))?.act_composite === 29);
check("the sweep recorded its heartbeat", (await sql(`select (last_ok_at > now() - interval '1 minute')::text from public.job_heartbeats where job = 'import-sweep'`)) === "true");
```

- [ ] **Step 6: Write `src/lib/imports/errors.ts`**

```ts
import { HttpError, conflict, forbidden, fromPostgrest, notFound } from "../errors.js";

/**
 * Errors from the import RPCs carry sentences we wrote for counselors
 * (request_import_commit, request_import_undo, request_held_apply), so those
 * messages are passed through; anything else goes through fromPostgrest.
 */
export function fromImportRpc(error: { code?: string; message?: string } | null): HttpError {
  if (!error) return new HttpError(500, "Database error");
  const message = error.message ?? "";
  switch (error.code) {
    case "42501":
      return notFound("That import isn't on your account");
    case "55000":
      return conflict(message || "That import is busy");
    case "P0001":
      return new HttpError(410, message || "That's no longer possible");
    case "22023":
      return new HttpError(400, message || "That request isn't valid");
    case "28000":
      return forbidden();
    default:
      return fromPostgrest(error);
  }
}
```

- [ ] **Step 7: Write `src/routes/imports.ts`**

```ts
/**
 * Import pipeline, step 1 routes (spec §5.7–§5.9).
 *
 * The browser never runs a save, undo or apply: it requests one through an
 * RLS-checked function, and the job runs on the import_worker connection.
 * Upload, mapping and review routes arrive in step 2.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasImportWorker } from "../env.js";
import { fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { fromImportRpc } from "../lib/imports/errors.js";
import { kickImportJob } from "../lib/imports/jobs.js";
import { namesMatch, normalizeName } from "../lib/imports/names.js";
import { limit } from "../lib/limits.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ itemId: z.string().uuid() });
const applyBody = z
  .object({
    decisions: z.record(z.string().uuid(), z.enum(["accept", "keep_old", "reject"])),
    confirmName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type HeldChange = {
  id: string;
  targetTable: string;
  field: string;
  op: "set_field" | "insert_row";
  newValue: unknown;
  currentValue: unknown;
  defaultDecision: "accept" | "keep_old";
};

type HeldEntry = {
  itemId: string;
  importId: string;
  importedName: string | null;
  studentId: string;
  studentName: string;
  studentEmail: string;
  heldUntil: string;
  jobError: unknown;
  changes: HeldChange[];
  nameMismatch: boolean;
};

function requireWorker(): void {
  if (!hasImportWorker) throw unavailable("Imports aren't set up on this server yet");
}

async function heldQueue(request: FastifyRequest): Promise<HeldEntry[]> {
  const { data, error } = await request.db.rpc("import_held_queue");
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Omit<HeldEntry, "nameMismatch">[]).map((e) => ({
    ...e,
    nameMismatch: e.importedName ? !namesMatch(e.importedName, e.studentName) : false,
  }));
}

function toImportStatus(r: Row) {
  return {
    id: String(r.id),
    status: String(r.status),
    committedAt: (r.committed_at as string | null) ?? null,
    undoUntil: (r.undo_until as string | null) ?? null,
    undoneAt: (r.undone_at as string | null) ?? null,
    jobError: r.job_error ?? null,
    jobResult: r.job_result ?? null,
  };
}

export default async function importRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/held", { preHandler: [...counselor, limit("imports:held", 120, 60)] }, async (request) =>
    heldQueue(request)
  );

  app.get("/:id", { preHandler: [...counselor, limit("imports:status", 600, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("roster_imports")
      .select("id, status, committed_at, undo_until, undone_at, job_error, job_result")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That import isn't on your account");
    return toImportStatus(data as Row);
  });

  app.post("/:id/commit", { preHandler: [...counselor, limit("imports:commit", 20, 3600)] }, async (request, reply) => {
    requireWorker();
    const { id } = idParam.parse(request.params);
    const { error } = await request.db.rpc("request_import_commit", { p_import: id });
    if (error) throw fromImportRpc(error);
    kickImportJob("commit", id, request.auth.userId, request.log);
    return reply.code(202).send({ status: "committing" });
  });

  app.post("/:id/undo", { preHandler: [...counselor, limit("imports:undo", 20, 3600)] }, async (request, reply) => {
    requireWorker();
    const { id } = idParam.parse(request.params);
    const { error } = await request.db.rpc("request_import_undo", { p_import: id });
    if (error) throw fromImportRpc(error);
    kickImportJob("undo", id, request.auth.userId, request.log);
    return reply.code(202).send({ status: "undoing" });
  });

  app.post(
    "/held/:itemId/apply",
    { preHandler: [...counselor, limit("imports:apply", 120, 3600)] },
    async (request, reply) => {
      requireWorker();
      const { itemId } = itemParam.parse(request.params);
      const body = applyBody.parse(request.body);

      const entry = (await heldQueue(request)).find((e) => e.itemId === itemId);
      if (!entry) throw notFound("That data is no longer waiting to be applied");
      if (entry.nameMismatch) {
        const typed = body.confirmName ? normalizeName(body.confirmName) : "";
        if (typed !== normalizeName(entry.studentName)) {
          return reply.code(409).send({
            code: "name-confirmation-required",
            message: `The account is ${entry.studentName}, but the file says ${entry.importedName}. Type ${entry.studentName} to confirm.`,
          });
        }
      }

      const { error } = await request.db.rpc("request_held_apply", { p_item: itemId, p_decisions: body.decisions });
      if (error) throw fromImportRpc(error);
      kickImportJob("apply", itemId, request.auth.userId, request.log);
      return reply.code(202).send({ status: "applying" });
    }
  );

}
```

- [ ] **Step 8: Register the routes and the sweep**

In `src/app.ts`, add with the other route imports:

```ts
import importRoutes from "./routes/imports.js";
```

and after `app.register(rosterRoutes, { prefix: "/roster" });`:

```ts
  app.register(importRoutes, { prefix: "/imports" });
```

In `src/routes/internal.ts`, add the import:

```ts
import { runImportSweep } from "../lib/imports/jobs.js";
```

and inside `internalRoutes`, after the `/resources/link-check` route:

```ts
  /**
   * Every 5–15 minutes: finish import jobs a crash or deploy left waiting,
   * expire held data (warning 7 days before) and compact changes past the
   * 30-day undo window.
   */
  app.post(
    "/imports/sweep",
    { preHandler: [requireCronSecret], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const r = await runImportSweep(request.log);
      if (!r.ran) {
        if (r.reason === "locked") return reply.code(409).send({ ran: false, reason: "An import sweep is already running" });
        const reason =
          r.reason === "no-worker"
            ? "Set IMPORT_DATABASE_URL to run import jobs"
            : r.reason === "no-service-role"
              ? "The import sweep needs the service role key"
              : "The import sweep could not take its lease";
        return reply.code(503).send({ ran: false, reason });
      }
      return r;
    }
  );
```

Also extend the comment block at the top of `internal.ts`:

```ts
 * and every 5–15 minutes, the import pipeline's sweep:
 *     "$API_URL/internal/imports/sweep"
```

- [ ] **Step 9: Give CI the worker login**

In `.github/workflows/ci.yml`, in the `integration` job, add a step after "Every public table has RLS":

```yaml
      - name: Turn on the import_worker login (CI only)
        run: |
          psql "$DB_URL" -c "alter role import_worker login password 'ci-import-worker-pw'"
          echo "IMPORT_DATABASE_URL=postgresql://import_worker:ci-import-worker-pw@127.0.0.1:54322/postgres" >> "$GITHUB_ENV"
```

(The "Start the API" step inherits `IMPORT_DATABASE_URL` from `$GITHUB_ENV`.)

- [ ] **Step 10: Run the tests**

Run: `npm run typecheck && npm test`
Expected: pass.
Run: `supabase db reset`, re-run the `alter role` line, start the API with `IMPORT_DATABASE_URL` set (see "Running things locally"), then `node test/integration/imports-api.test.mjs`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/imports/names.ts src/lib/imports/errors.ts src/routes/imports.ts src/app.ts src/routes/internal.ts .github/workflows/ci.yml test/unit/import-names.test.ts test/integration/imports-api.test.mjs
git commit -m "feat(imports): commit/undo/held routes, name rule, import sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Undo property test and the 5,000-row load test

**Files:**
- Create: `test/integration/imports-undo-property.test.mjs`, `test/integration/imports-load.mjs`

**Interfaces:**
- Consumes: Tasks 5–6 SQL functions, Task 10 routes, `fast-check`.
- Produces: no code; two test files.

- [ ] **Step 1: Write the property test**

Create `test/integration/imports-undo-property.test.mjs`:

```js
// Import pipeline step 1, Task 11: random import / edit / undo sequences never
// corrupt a record (spec §9 "Undo properties"). The model: an import writes
// a value if the field still holds what staging saw; undo restores the old
// value only where the field still holds what that import wrote.
import fc from "fast-check";
import { check, sql, user } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange } from "./imports-helpers.mjs";

const c = await user("imp-prop");
const FIELDS = ["sat_superscore", "act_composite"];
const VALUES = { sat_superscore: [1200, 1300, 1400, 1500], act_composite: [24, 28, 32, 35] };

const op = fc.oneof(
  fc.record({ kind: fc.constant("import"), field: fc.constantFrom(...FIELDS), pick: fc.nat(3) }),
  fc.record({ kind: fc.constant("edit"), field: fc.constantFrom(...FIELDS), pick: fc.nat(3) }),
  fc.record({ kind: fc.constant("undo"), back: fc.nat(3) })
);

let failures = 0;
await fc.assert(
  fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
    const s = await studentOf(c, "imp-prop-student");
    const model = { sat_superscore: null, act_composite: null };
    const committed = []; // { imp, field, wrote, old }
    for (const o of ops) {
      if (o.kind === "import") {
        const value = VALUES[o.field][o.pick];
        const imp = await makeImport(c);
        const item = await addItem(imp, { studentId: s.id });
        await addChange(imp, item, { target: "student_academics", field: o.field, value, studentId: s.id });
        await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
        await sql(`select public.commit_import('${imp}', '${c.id}')`);
        const old = model[o.field];
        if (old !== value) {
          model[o.field] = value;
          committed.push({ imp, field: o.field, wrote: value, old, undone: false });
        }
      } else if (o.kind === "edit") {
        const value = VALUES[o.field][o.pick] + 1;
        await sql(`insert into public.student_academics (student_id) values ('${s.id}') on conflict do nothing`);
        await sql(`update public.student_academics set ${o.field} = ${value} where student_id = '${s.id}'`);
        model[o.field] = value;
      } else {
        const live = committed.filter((x) => !x.undone);
        const target = live[live.length - 1 - (o.back % Math.max(live.length, 1))];
        if (!target) continue;
        await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${target.imp}'`);
        await sql(`select public.undo_import('${target.imp}', '${c.id}')`);
        target.undone = true;
        if (model[target.field] === target.wrote) model[target.field] = target.old;
      }
    }
    const raw = await sql(`select coalesce(row_to_json(a)::text, '{}') from public.student_academics a where student_id = '${s.id}'`);
    const db = JSON.parse(raw || "{}");
    const ok = FIELDS.every((f) => (db[f] ?? null) === model[f]);
    if (!ok) failures++;
    return ok;
  }),
  { numRuns: 20 }
).catch((err) => {
  console.error(err.message);
  failures++;
});
check("random import/edit/undo sequences match the model", failures === 0);
```

- [ ] **Step 2: Run it**

Run: `supabase db reset && node test/integration/imports-undo-property.test.mjs`
Expected: PASS. If it fails, fast-check prints the shrunk counterexample; fix the SQL (not the model) unless the model contradicts spec §5.9.

- [ ] **Step 3: Write the load test**

Create `test/integration/imports-load.mjs`:

```js
// Pre-release load test (spec §9 "Load"): commit and undo the import maximum,
// 5,000 rows in total × every single-row field + one insert per row, through
// the API and the import_worker connection, within the 300 s timeout.
// Not part of `npm run test:integration` (slow). Run: npm run test:imports-load
import { call, check, sql, user } from "./harness.mjs";

const ROWS = Number(process.env.IMPORT_LOAD_ROWS ?? 5000);
const c = await user("imp-load");

const imp = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${c.id}', 'load.csv', 'csv', 'review') returning id) select id from i`);
console.log(`creating ${ROWS} students…`);
// Students are created directly (auth admin API would take minutes).
await sql(`
  with s as (
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
    select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'load-' || g || '-' || extract(epoch from now())::bigint || '@test.local', '', now(),
           jsonb_build_object('full_name', 'Load Student ' || g, 'role', 'student'), now(), now()
    from generate_series(1, ${ROWS}) g
    returning id
  )
  update public.profiles p set counselor_id = '${c.id}', role = 'student' from s where p.id = s.id`);
const students = Number(await sql(`select count(*) from public.profiles where counselor_id = '${c.id}'`));
check(`${ROWS} students exist`, students === ROWS, String(students));

console.log("staging changes…");
await sql(`insert into public.import_items (import_id, match_status, student_id, match_confidence)
  select '${imp}', 'matched_email', p.id, 'high' from public.profiles p where p.counselor_id = '${c.id}'`);
await sql(`
  insert into public.import_changes (import_id, item_id, target_table, field, op, old_value, new_value, decision)
  select '${imp}', it.id, f.t, f.f, 'set_field', null, f.v, 'accept'
  from public.import_items it
  cross join (values
    ('student_academics','gpa_unweighted','3.7'::jsonb), ('student_academics','gpa_weighted','4.1'::jsonb),
    ('student_academics','gpa_scale','"4.0"'::jsonb), ('student_academics','class_rank','"12/400"'::jsonb),
    ('student_academics','class_rank_value','"top 5%"'::jsonb), ('student_academics','test_status','"taken"'::jsonb),
    ('student_academics','sat_ebrw','720'::jsonb), ('student_academics','sat_math','740'::jsonb),
    ('student_academics','sat_superscore','1460'::jsonb), ('student_academics','act_composite','33'::jsonb),
    ('student_personal_details','contact_email','"load@test.local"'::jsonb), ('student_personal_details','address','"1 Main St"'::jsonb),
    ('student_personal_details','gender','"undisclosed"'::jsonb), ('student_personal_details','birthday','"2008-01-01"'::jsonb),
    ('student_personal_details','citizenship','"us-citizen"'::jsonb), ('student_personal_details','first_gen','false'::jsonb),
    ('student_personal_details','intended_majors','["Biology"]'::jsonb)
  ) as f(t, f, v)
  where it.import_id = '${imp}'`);
await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, decision)
  select '${imp}', it.id, 'test_scores', '*', 'insert_row', '{"exam":"AP Biology","kind":"ap","score":"5"}'::jsonb, 'accept'
  from public.import_items it where it.import_id = '${imp}'`);
const total = Number(await sql(`select count(*) from public.import_changes where import_id = '${imp}'`));
console.log(`${total} changes staged`);

async function timed(path, waitWhile) {
  const t0 = Date.now();
  const r = await call(c.token, "POST", path);
  if (r.status !== 202) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
  for (;;) {
    const s = await call(c.token, "GET", `/imports/${imp}`);
    if (s.body.status !== waitWhile) return { ms: Date.now() - t0, body: s.body };
    await new Promise((res) => setTimeout(res, 1000));
  }
}

const commit = await timed(`/imports/${imp}/commit`, "committing");
console.log(`commit: ${commit.ms} ms`, commit.body.jobResult);
check("commit finishes within 300 s", commit.body.status === "committed" && commit.ms < 300_000, `${commit.ms} ms ${commit.body.status}`);
const undo = await timed(`/imports/${imp}/undo`, "undoing");
console.log(`undo: ${undo.ms} ms`, undo.body.jobResult);
check("undo finishes within 300 s", undo.body.status === "undone" && undo.ms < 300_000, `${undo.ms} ms ${undo.body.status}`);
```

- [ ] **Step 4: Run the load test once**

Run (API up with `IMPORT_DATABASE_URL`): `npm run test:imports-load`
Expected: both checks PASS; note the two timings in the PR description. If commit exceeds 300 s, **stop and report** (spec §5.7: the row limit is lowered rather than splitting the transaction; that decision belongs to Elvin).

- [ ] **Step 5: Commit**

```bash
git add test/integration/imports-undo-property.test.mjs test/integration/imports-load.mjs
git commit -m "test(imports): undo property test and 5,000-row load test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: GPA audit in the backend

**Files:**
- Create: `src/lib/gpa.ts`, `test/unit/gpa.test.ts`
- Modify: `src/routes/collegesV10.ts:172-202`, `src/lib/studentPage.ts` (info card ~`105-140`, `deriveClassRank` call, polygon ~`372-400`, Zod ~`221-222`), `src/lib/studentAid.ts:452,483`, `src/routes/outcomes.ts:128-142`, `src/routes/applicationAi.ts:84`, `src/routes/overviewSummaries.ts:44,99-100`, `src/routes/students.ts:~140-152`, `src/routes/records.ts:185-186`

**Interfaces:**
- Produces: `src/lib/gpa.ts`:
  - `type GpaScaleKind = "four" | "five" | "ten" | "hundred" | "other" | "unknown"`
  - `gpaScaleKind(scale: string | null | undefined): GpaScaleKind`
  - `fourPointGpa(value: number | null | undefined, scale: string | null | undefined): number | null` — the value when it can be compared with 4/5-point bands (scale four/five, or unknown with value ≤ 5.5), else `null`.
  - `gpaLabel(value: number | null | undefined, scale: string | null | undefined): string | null` — e.g. `"3.8 (4.0 scale)"`, `"92 (100-point scale)"`, `"3.8"` when the scale is unknown.
- DTO additions: `gpaScale: string | null` on the student page info card, the overview summary rows and the `MeridiesUser.profile` extra (`gpaScale`).

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/gpa.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fourPointGpa, gpaLabel, gpaScaleKind } from "../../src/lib/gpa.js";

test("scale kinds", () => {
  assert.equal(gpaScaleKind("4.0"), "four");
  assert.equal(gpaScaleKind("4"), "four");
  assert.equal(gpaScaleKind("5.0 weighted"), "five");
  assert.equal(gpaScaleKind("10"), "ten");
  assert.equal(gpaScaleKind("100"), "hundred");
  assert.equal(gpaScaleKind("100-point"), "hundred");
  assert.equal(gpaScaleKind("12"), "other");
  assert.equal(gpaScaleKind(null), "unknown");
  assert.equal(gpaScaleKind("  "), "unknown");
});

test("only 4/5-point GPAs feed fit, odds and class rank", () => {
  assert.equal(fourPointGpa(3.8, "4.0"), 3.8);
  assert.equal(fourPointGpa(4.6, "5.0"), 4.6);
  assert.equal(fourPointGpa(3.8, null), 3.8);
  assert.equal(fourPointGpa(92, "100"), null);
  assert.equal(fourPointGpa(8.5, "10"), null);
  assert.equal(fourPointGpa(7, null), null);
  assert.equal(fourPointGpa(null, "4.0"), null);
});

test("labels show the scale", () => {
  assert.equal(gpaLabel(3.8, "4.0"), "3.8 (4.0 scale)");
  assert.equal(gpaLabel(92, "100"), "92 (100-point scale)");
  assert.equal(gpaLabel(3.8, null), "3.8");
  assert.equal(gpaLabel(null, "4.0"), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/gpa.ts`**

```ts
/**
 * GPA with its scale (spec §4.1). Since 20261014000001 a 92 on a 100-point
 * scale can sit next to a 3.8 on a 4.0 scale, so nothing may compare, chart
 * or rank a GPA without reading `student_academics.gpa_scale`. Fit, odds,
 * class rank and scholarship minimums are 4/5-point models: anything else is
 * "unknown" to them rather than a guess.
 */

export type GpaScaleKind = "four" | "five" | "ten" | "hundred" | "other" | "unknown";

export function gpaScaleKind(scale: string | null | undefined): GpaScaleKind {
  const s = (scale ?? "").trim();
  if (!s) return "unknown";
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return "other";
  if (n === 4) return "four";
  if (n === 5) return "five";
  if (n === 10) return "ten";
  if (n === 100) return "hundred";
  return "other";
}

export function fourPointGpa(
  value: number | null | undefined,
  scale: string | null | undefined
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const kind = gpaScaleKind(scale);
  if (kind === "four" || kind === "five") return value;
  if (kind === "unknown" && value <= 5.5) return value;
  return null;
}

export function gpaLabel(
  value: number | null | undefined,
  scale: string | null | undefined
): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const shown = Number(value.toFixed(3)).toString();
  const kind = gpaScaleKind(scale);
  if (kind === "unknown") return shown;
  if (kind === "hundred") return `${shown} (100-point scale)`;
  return `${shown} (${(scale ?? "").trim()} scale)`;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: the `gpa` tests PASS.

- [ ] **Step 5: Fit and odds — `src/routes/collegesV10.ts` `studentNumbers`**

Add `import { fourPointGpa, gpaLabel } from "../lib/gpa.js";` with the other imports. Change the academics select to:

```ts
      .select("gpa_unweighted, gpa_scale, sat_superscore, sat_ebrw, sat_math")
```

and the returned `numbers` to:

```ts
    numbers: {
      sat,
      gpaUnweighted: fourPointGpa(a.gpa_unweighted != null ? Number(a.gpa_unweighted) : null, a.gpa_scale as string | null),
      gpaText: gpaLabel(a.gpa_unweighted != null ? Number(a.gpa_unweighted) : null, a.gpa_scale as string | null),
    },
```

In the `list-explain` prompt (~line 349) change `unweighted GPA ${student.numbers.gpaUnweighted ?? "none"}` to `unweighted GPA ${student.numbers.gpaText ?? "none"}`.

`StudentNumbers` in `src/lib/collegesV10.ts` stays `{ sat; gpaUnweighted }`; the extra `gpaText` field is allowed because callers pass `student.numbers` structurally. If `npm run typecheck` reports an excess-property error at a call site, pass `{ sat: numbers.sat, gpaUnweighted: numbers.gpaUnweighted }` there.

- [ ] **Step 6: Student page — `src/lib/studentPage.ts`**

Add `import { fourPointGpa } from "./gpa.js";`.

Info card (the academics select is already `*`): replace

```ts
  const gpaWeighted = n(a.gpa_weighted);
  const rank = await deriveClassRank(db, s(p.high_school_id), gpaWeighted);
```

with

```ts
  const gpaWeighted = n(a.gpa_weighted);
  const gpaScale = s(a.gpa_scale);
  const rankGpa = fourPointGpa(gpaWeighted, gpaScale);
  const rank =
    gpaWeighted !== null && rankGpa === null
      ? { read: null, reason: "Class rank needs a GPA on a 4- or 5-point scale" }
      : await deriveClassRank(db, s(p.high_school_id), rankGpa);
```

and add `gpaScale,` to the returned object right after `gpaUnweighted: n(a.gpa_unweighted),`, and `gpaScale: string | null;` to the DTO type next to `gpaUnweighted: number | null;` (~line 67).

Polygon (~line 376): change the select to `"gpa_weighted, gpa_scale, sat_superscore, act_composite, rigor_count"` and

```ts
  const gpa = n(a.gpa_weighted);
```

to

```ts
  const gpa = fourPointGpa(n(a.gpa_weighted), s(a.gpa_scale));
```

Zod patch (~lines 221-222): change both `z.number().min(0).max(10).nullable()` to `z.number().min(0).max(110).nullable()` (the database check ties the maximum to the scale and answers 23514 → 400 "That value isn't allowed").

- [ ] **Step 7: Scholarships — `src/lib/studentAid.ts`**

Add `import { fourPointGpa } from "./gpa.js";`. Change the select at ~452 to `.select("gpa_weighted, gpa_scale")` and the attribute at ~483 to:

```ts
    gpa: fourPointGpa(n((academics.data as Row | null)?.gpa_weighted), s((academics.data as Row | null)?.gpa_scale)),
```

(`s` is the file's existing string helper; if the file has none, use `((academics.data as Row | null)?.gpa_scale as string | null) ?? null`.)

- [ ] **Step 8: Outcomes — `src/routes/outcomes.ts`**

Add `import { fourPointGpa } from "../lib/gpa.js";`. Change the select at ~131 to `"gpa_weighted, gpa_unweighted, gpa_scale, sat_superscore, act_composite"` and the two copy lines to:

```ts
      const scale = (a?.gpa_scale as string | null | undefined) ?? null;
      if (body.gpaWeighted === undefined) insert.gpa_weighted = fourPointGpa(a?.gpa_weighted == null ? null : Number(a.gpa_weighted), scale);
      if (body.gpaUnweighted === undefined) insert.gpa_unweighted = fourPointGpa(a?.gpa_unweighted == null ? null : Number(a.gpa_unweighted), scale);
```

(`admission_outcomes` keeps its ≤ 10 limit; a 100-point GPA is recorded as unknown there, matching Task 8's Close-cycle change.)

- [ ] **Step 9: AI context, overview, profile, records**

- `src/routes/applicationAi.ts:84`: add `gpa_scale` to the select string (`"gpa_unweighted, gpa_weighted, gpa_scale, sat_superscore, …"`). The academics object goes to the model as-is, so it now sees the scale.
- `src/routes/overviewSummaries.ts:44`: add `gpa_scale` to the select; at ~99-100 add `gpaScale: (a?.gpa_scale as string | null) ?? null,` after `gpaUnweighted`.
- `src/routes/students.ts` (~150): add `gpaScale: a?.gpa_scale ?? undefined,` to `extraProfile`; if the academics select there isn't `*`, add `gpa_scale` to it.
- `src/routes/records.ts:185-186`: change both `.max(10)` to `.max(110)`.

- [ ] **Step 10: Verify nothing else reads GPA unscaled**

Run: `grep -rnE "gpa_(un)?weighted|gpaWeighted|gpaUnweighted" src | grep -v "src/lib/gpa.ts" | grep -v "roster.ts" | grep -v "serialize.ts"`
Expected: every remaining line is in a file changed in Steps 5–9, or is a pure pass-through (a DTO field that now travels with `gpaScale`). If you find a new comparison or chart, wrap it with `fourPointGpa` the same way.

Run: `npm run typecheck && npm test`
Expected: pass.

- [ ] **Step 11: Commit**

```bash
git add src/lib/gpa.ts test/unit/gpa.test.ts src/routes/collegesV10.ts src/lib/studentPage.ts src/lib/studentAid.ts src/routes/outcomes.ts src/routes/applicationAi.ts src/routes/overviewSummaries.ts src/routes/students.ts src/routes/records.ts
git commit -m "fix(gpa): read the GPA scale everywhere GPA is compared, ranked or sent to AI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs, full verification and the PR

**Files:**
- Modify: `AGENTS.md`, `docs/superpowers/specs/2026-10-09-import-pipeline-design.md` (§15 item 1, one line)

- [ ] **Step 1: AGENTS.md**

Add `lib/imports/`, `lib/gpa.ts` and `routes/imports.ts` to the tree listing, and add this section after "Documents and AI context":

```markdown
### Import pipeline (step 1)

Spec: `docs/superpowers/specs/2026-10-09-import-pipeline-design.md`.

- **The browser never writes import data.** It reads `roster_imports`,
  `import_files`, `import_items`, `import_changes` under
  `private.can_view_import` (uploader while in the practice, plus firm
  owners/admins) and *requests* jobs through `request_import_commit`,
  `request_import_undo`, `request_held_apply`.
- **Jobs run on `IMPORT_DATABASE_URL` as `import_worker`** (session pooler,
  never the transaction pooler, never the `postgres` login; the server exits
  at boot otherwise). `commit_import`, `undo_import` and `apply_held_item` are
  one transaction each with `statement_timeout = 300s`, lock with SKIP LOCKED,
  and write their audit row inside the transaction.
- **No dynamic SQL.** Writes go through `private.import_set_field` (one
  compare-and-set UPDATE per field) and `private.import_insert_row` (fixed
  columns, `source = 'import'`). `import_fields` is the only list of
  importable fields; `import_changes (target_table, field)` has a foreign key to it.
- **Staging must read `old_value` with `private.import_current_value`** so the
  compare-and-set matches what the database holds.
- **Held data never attaches on acceptance**: `accept_invitation` moves it to
  the counselor's "Ready to apply" queue for 30 days (old roster rows too).
- **GPA has a scale.** Read GPA through `src/lib/gpa.ts`; fit, odds, class
  rank and scholarship minimums use `fourPointGpa`, which returns null for
  non-4/5-point scales.
- **Imported text is data.** Rows with `source = 'import'` (activities, test
  scores, courses) must be passed to any model as data, never as instructions.
- Cron: `POST /internal/imports/sweep` every 5–15 minutes (finishes stuck
  jobs, expires held data with a 7-day warning, compacts after 30 days).
```

Add a row to the environment table:

```markdown
| `IMPORT_DATABASE_URL` | Optional; import save/undo/apply. Must log in as `import_worker` via the Supabase session pooler. The role is created NOLOGIN by migration; turn on its login and set its password by hand |
```

and in "Scheduled jobs", a third cron:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://<api-host>/internal/imports/sweep"
```

- [ ] **Step 2: Spec §15 item 1**

In the spec's §15 item 1, after "the held-data queue routes", add: `, plus the commit/undo/status routes (moved here from step 2 so the job runner is exercised end to end)`. Commit this change on the spec branch PR (#31), not on `feat/imports-step1`, if that PR is still open; otherwise include it here.

- [ ] **Step 3: Full verification**

```bash
npm run typecheck && npm run build && npm test
supabase db reset
psql "$DB_URL" -c "alter role import_worker login password 'local-import-worker-pw'"
# start the API with IMPORT_DATABASE_URL (see "Running things locally"), then:
npm run test:integration
test "$(psql "$DB_URL" -tAc "select count(*) from pg_tables where schemaname='public' and rowsecurity=false")" = "0" && echo "RLS ok"
```

Expected: everything passes, including the pre-existing persona suites; "RLS ok".

- [ ] **Step 4: Commit and open the PR**

```bash
git add AGENTS.md
git commit -m "docs(imports): AGENTS.md section, env var and cron for the import pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/imports-step1
gh pr create --title "Import pipeline step 1: foundation and the lost-data fix" --body "$(cat <<'EOF'
## Summary

Database foundation for the import pipeline plus the fix for imported roster data being lost on acceptance. Imported data for invited students now waits in a counselor "Ready to apply" queue instead of disappearing. No upload or parsing yet (step 2).

## Why

Spec: docs/superpowers/specs/2026-10-09-import-pipeline-design.md (§15 step 1). Plan: docs/superpowers/plans/2026-10-09-import-pipeline-step1.md.

## Repos affected

- [ ] meridies-landing
- [ ] meridies-demo
- [ ] meridies-app (GPA scale display follows in its own PR)
- [x] meridies-backend

## How I tested

- [x] `npm run typecheck` and `npm run build` clean
- [x] Unit tests (name rule, GPA scale, worker role check)
- [x] Integration: schema/RLS/storage, values, commit, undo, held data, provenance/compaction, API, undo property test
- [x] Load test: 5,000 rows, commit <TIMING> / undo <TIMING>

## Migrations / env changes

- [x] Schema migration included: 20261014000001–20261014000008 (NOT applied to production)
- [x] New env var `IMPORT_DATABASE_URL` (added to `.env.example`; set on Railway by the team after creating the import_worker login)
- New cron: `POST /internal/imports/sweep` every 5–15 min

## Risk

- `accept_invitation` and `close_admission_cycle` are redefined (bodies copied, additions marked).
- `student_academics` GPA columns widened to numeric(6,3) with a scale-tied check.
- Production rollout: rehearse on a Supabase branch first; apply per file and verify; never `db push`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace `<TIMING>` with the two numbers from Task 11 Step 4 before running the command. Do not merge.

---

### Task 14 (separate repo): Show the GPA scale in the app

**Files (repo `meridies-app`, branch `feat/gpa-scale-display`):**
- Modify: `lib/api.ts` (types near lines 104, 3023, 3045, 3502), `lib/profileDisplay.ts:40-41`, `components/overview/status.ts:32-33`, `app/dashboard/student/profile/StudentProfileSelf.tsx:96-97`, `components/assistant/AxisPanel.tsx:81-82`, `components/student/StudentInfoCard.tsx:265-272`

**Interfaces:**
- Consumes: backend DTO field `gpaScale: string | null` (Task 12) on the student page info card, overview summaries and the user profile.
- Produces: `formatGpa(value: number | string | null | undefined, scale: string | null | undefined): string` and `gpaPercent(value, scale): number | null` in `lib/profileDisplay.ts`.

- [ ] **Step 1: Types**

In `lib/api.ts`, add `gpaScale?: string;` next to `gpaUnweighted?: string;` (~line 105) and `gpaScale: string | null;` next to each `gpaUnweighted: number | null;` (~3024, ~3502), and `gpaScale?: string | null;` next to `gpaUnweighted?: number | null;` (~3046).

- [ ] **Step 2: Helpers in `lib/profileDisplay.ts`**

```ts
/** "3.8 (4.0)" / "92 (100)" / "3.8" — a GPA is never shown without its scale when we know it. */
export function formatGpa(value: number | string | null | undefined, scale: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const s = (scale ?? "").trim();
  return s ? `${value} (${s})` : String(value);
}

/** 0–100 for the polygon/status bars; null when the scale isn't 4/5-point. */
export function gpaPercent(value: number | string | null | undefined, scale: string | null | undefined): number | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const sc = Number.parseFloat((scale ?? "").trim());
  if (Number.isFinite(sc) && sc !== 4 && sc !== 5) return null;
  if (!Number.isFinite(sc) && n > 5.5) return null;
  return Math.max(0, Math.min(100, (n / 4.5) * 100));
}
```

Replace lines 40-41:

```ts
  const gpa = parseFloat(profile.gpaWeighted ?? "");
  const academics = Number.isFinite(gpa) && gpa > 0 ? clampPct((gpa / 4.5) * 100) : 30;
```

with:

```ts
  const academics = clampPct(gpaPercent(profile.gpaWeighted, profile.gpaScale) ?? 30);
```

- [ ] **Step 3: Call sites**

- `components/overview/status.ts:32-33` → `const academics = clampPct(gpaPercent(s?.gpaWeighted, s?.gpaScale) ?? 30);` (import `gpaPercent`).
- `StudentProfileSelf.tsx:96-97` → `value={formatGpa(profile.gpaWeighted, profile.gpaScale)}` and `value={formatGpa(profile.gpaUnweighted, profile.gpaScale)}`.
- `AxisPanel.tsx:82` → `{formatGpa(profile.gpaWeighted, profile.gpaScale)}`.
- `StudentInfoCard.tsx:265,270` → labels `` `GPA (weighted${info.gpaScale ? `, ${info.gpaScale} scale` : ""})` `` and the same for unweighted.

- [ ] **Step 4: Verify and open the PR**

Run: `npm run build && npm run lint`
Expected: clean. Open a PR titled "Show the GPA scale wherever GPA is shown" that references meridies-backend's step-1 PR; do not merge. The app PR must merge after the backend PR (cross-repo rule: backend first).

---

## Self-Review Notes (for the reviewer of this plan)

- **Spec coverage, step 1 (§15.1):** migration/bucket/tables/`import_fields`/GPA widening/policies/access functions → Tasks 1–2; `commit_import`/`undo_import`/`apply_held_item` → Tasks 5–7; job runner on the import_worker connection → Task 9; held-data queue routes → Task 10; `accept_invitation` routing incl. old rows → Task 7; GPA audit → Tasks 8 (SQL), 12 (backend), 14 (app); SQL/RLS/concurrency/provenance/load tests → Tasks 1–8, 10, 11. Compaction (§5.10) and expiry warnings (§5.8) are included because the sweep owns them.
- **Deliberately not in step 1:** upload registration, profiling worker, parse plan, staging, cleanup, matching, review screen, raw-file deletion, invitation sending after commit, bounce pause (all step 2); app import screens (step 3).
- **One spec deviation:** commit/undo/status routes are in step 1 (spec §15 listed them in step 2); Task 13 Step 2 updates the spec line.
