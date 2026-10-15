// scripts/migrations/plan.mjs: the reader the "Apply migrations" workflow runs.
//
// The fixtures in test/fixtures/supabase-cli/ are real output of Supabase CLI
// 2.121.0 (the version both workflows pin), captured against a local stack with
// the flags the workflow uses: `--agent no --output-format json`, stdout only.
//   dry-run-up-to-date.json       supabase db push --local --dry-run --skip-vault
//   dry-run-two-pending.json      the same, with two new files in supabase/migrations
//   dry-run-out-of-order.json     the same, with a file older than the newest applied (exit 1)
//   dry-run-connection-error.json supabase db push --db-url <a closed port> --dry-run (exit 1)
//   db-query-problems-*.json      supabase db query --local -f scripts/migrations/problems.sql
// CI re-runs the dry run and the query against the pinned CLI (ci.yml), so a
// format change fails there too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  codeOf,
  describe,
  lastJson,
  parseDryRun,
  parseProblems,
  planHash,
  poolerInfo,
  renderSummary,
  scanDestructive,
  scanGate,
  validateFiles,
} from "../../scripts/migrations/plan.mjs";

const FIX = "test/fixtures/supabase-cli";
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const MIGRATIONS = "supabase/migrations";
const SCRIPT = "scripts/migrations/plan.mjs";

function tempDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "migration-plan-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ---- parseDryRun, on what the CLI really prints ------------------------------

test("up to date (the CLI's own words say Local here, Remote in production; the JSON is the same)", () => {
  assert.deepEqual(parseDryRun(fixture("dry-run-up-to-date.json"), 0), { kind: "up-to-date" });
});

test("two pending files", () => {
  assert.deepEqual(parseDryRun(fixture("dry-run-two-pending.json"), 0), {
    kind: "pending",
    files: ["29991231000000_ci_parser_check.sql", "29991231000001_ci_parser_second.sql"],
  });
});

test("a file older than production's newest: the --include-all refusal, with the file it names", () => {
  assert.deepEqual(parseDryRun(fixture("dry-run-out-of-order.json"), 1), { kind: "out-of-order", files: ["20200101000000_old.sql"] });
});

test("any other CLI error is reported by its code only (the message can carry a host)", () => {
  assert.deepEqual(parseDryRun(fixture("dry-run-connection-error.json"), 1), { kind: "cli-error", code: "DbConnectError" });
});

test("fails closed on anything else", () => {
  const cases: Array<[string, number]> = [
    ["", 0],
    ["Remote database is up to date.", 0], // the text format: never parsed
    ["Would push these migrations:\n • 20261022000001_visit_offerings.sql", 0],
    ["garbage {", 0],
    ['{"upToDate":true,"dryRun":true,"migrations":[]}', 1], // a non-zero exit with a success body
    ['{"upToDate":true,"migrations":[]}', 0], // not a dry run
    ['{"upToDate":false,"dryRun":true,"migrations":[]}', 0], // pending, yet nothing listed
    ['{"upToDate":true,"dryRun":true,"migrations":["20261022000001_x.sql"]}', 0],
    ['{"upToDate":false,"dryRun":true,"migrations":[{"name":"x"}]}', 0],
    ['{"upToDate":false,"dryRun":true,"migrations":["20261022000001_x.sql"],"seeds":["seed.sql"]}', 0],
    ['["20261022000001_x.sql"]', 0],
  ];
  for (const [text, code] of cases) assert.equal(parseDryRun(text, code).kind, "unreadable", text);
});

test("the JSON line is found after log lines and CRLF", () => {
  const text = `DRY RUN: migrations will *not* be pushed to the database.\r\nConnecting to remote database...\r\n${fixture("dry-run-two-pending.json").trim()}\r\n`;
  assert.equal(parseDryRun(text, 0).kind, "pending");
  assert.deepEqual(lastJson("[\n  {\n    \"problem\": \"x\"\n  }\n]\n"), [{ problem: "x" }]);
});

// ---- validateFiles -------------------------------------------------------------

test("validateFiles takes real files in order and refuses the rest", () => {
  const dir = tempDir({ "20261021000001_a.sql": "select 1;", "20261022000001_b.sql": "select 2;", "Bad Name.sql": "" });
  validateFiles(["20261021000001_a.sql", "20261022000001_b.sql"], dir);
  validateFiles([], dir);
  assert.throws(() => validateFiles(["20261023000001_missing.sql"], dir), /not in/);
  assert.throws(() => validateFiles(["Bad Name.sql"], dir), /not a migration file name/);
  assert.throws(() => validateFiles(["../20261021000001_a.sql"], dir), /not a migration file name/);
  assert.throws(() => validateFiles(["20261022000001_b.sql", "20261021000001_a.sql"], dir), /out of order/);
  assert.throws(() => validateFiles(["20261021000001_a.sql", "20261021000001_a.sql"], dir), /out of order/);
});

// ---- describe ------------------------------------------------------------------

test("describe reads the first comment that says something", () => {
  assert.equal(describe("-- Events discovery\n-- more\ncreate table x();"), "Events discovery");
  assert.equal(describe("-- -----------------\n-- 1. The columns.\nselect 1;"), "1. The columns.");
  assert.equal(describe("create table x();\n-- later"), "");
  assert.equal(describe(`-- ${"a".repeat(300)}`).length, 160);
  assert.match(describe(readFileSync(join(MIGRATIONS, "20261017000001_counselor_approval_gate.sql"), "utf8")), /^Counselor approval gate/);
});

// ---- the destructive scan --------------------------------------------------------

test("flags the statements an approver must read", () => {
  const cases: Array<[string, string]> = [
    ["drop table if exists public.x;", "drops a table"],
    ["DROP   SCHEMA s cascade;", "drops a schema"],
    ["drop view v;", "drops a view"],
    ["drop materialized view v;", "drops a materialized view"],
    ["drop type t;", "drops a type"],
    ["alter table t drop column c;", "drops a column"],
    ["alter table only public.t drop c;", "drops a column"],
    ["alter table t drop if exists c;", "drops a column"],
    ["delete from t where x;", "deletes rows"],
    ["truncate t;", "truncates a table"],
    ["update t set a = 1;", "changes rows in place"],
    ["update public.profiles p\n   set x = 1 where y;", "changes rows in place"],
    ["update only t as q set a = 1;", "changes rows in place"],
    ["alter table t alter column c type text;", "changes a column type"],
    ["alter table t alter column c set data type bigint;", "changes a column type"],
  ];
  for (const [sql, flag] of cases) assert.ok(scanDestructive(sql).includes(flag), `${sql} -> ${scanDestructive(sql)}`);
});

test("leaves routine statements alone", () => {
  for (const sql of [
    "drop policy if exists p on t;",
    "drop function if exists f(int);",
    "drop trigger if exists tr on t;",
    "drop index if exists i;",
    "alter table t drop constraint c;",
    "alter table t alter column c drop not null;",
    "alter table t alter column c drop default;",
    "-- delete from t;\nselect 1;",
    "/* drop table t; /* nested */ still a comment */ select 1;",
    "comment on table t is 'we never delete from t or drop table t';",
    "create trigger tr before update on t for each row execute function f();",
    "alter table t add constraint fk foreign key (a) references u on update set null on delete cascade;",
    "select * from t for update;",
  ]) {
    assert.deepEqual(scanDestructive(sql), [], sql);
  }
});

test("a function body is skipped (it runs only when called); a DO block is read (it runs now)", () => {
  assert.deepEqual(scanDestructive("create or replace function f() returns void language sql as $$ delete from t $$;"), []);
  assert.deepEqual(scanDestructive("create procedure p() language plpgsql as $body$ begin truncate t; end $body$;"), []);
  assert.deepEqual(scanDestructive("do $$ begin delete from t; end $$;"), ["deletes rows"]);
  assert.deepEqual(scanDestructive("do $do$ begin update t set a = 1; end $do$;"), ["changes rows in place"]);
  // Nested: a DO block that defines a function keeps the function's body out.
  assert.deepEqual(scanDestructive("do $$ begin execute $f$ select 1 $f$; end $$;"), ["runs dynamic SQL in a DO block (read it)"]);
  assert.deepEqual(scanDestructive("do $$ begin create trigger tr after insert on t for each row execute function f(); end $$;"), []);
  assert.ok(codeOf("create function f() returns int language sql as $$ select 1 $$;").code.includes("<routine body>"));
});

test("the real FAFSA migration is flagged for its column drops and deleted rows", () => {
  const flags = scanDestructive(readFileSync(join(MIGRATIONS, "20261005030002_financial_aid_fafsa_and_scholarship_matching.sql"), "utf8"));
  assert.ok(flags.includes("drops a column"), flags.join(", "));
  assert.ok(flags.includes("deletes rows"), flags.join(", "));
});

test("the approval gate's grandfathering update, inside a DO block, is flagged", () => {
  const flags = scanDestructive(readFileSync(join(MIGRATIONS, "20261017000001_counselor_approval_gate.sql"), "utf8"));
  assert.ok(flags.includes("changes rows in place"), flags.join(", "));
});

test("scanGate: a new table without RLS or the gate is called out; a real migration that has both is not", () => {
  assert.deepEqual(scanGate("create table public.x (id int);"), [
    "creates a table without enabling RLS",
    "creates a table without private.attach_approval_gate",
  ]);
  assert.deepEqual(scanGate("create table public.x (id int); alter table public.x enable row level security;"), [
    "creates a table without private.attach_approval_gate",
  ]);
  assert.deepEqual(scanGate("-- create table x\nselect 1;"), []);
  assert.deepEqual(scanGate("create table public.x (id int); select private.attach_student_policies('x'); select private.attach_approval_gate('public.x');"), []);
  assert.deepEqual(scanGate(readFileSync(join(MIGRATIONS, "20261020000001_axis_attachments.sql"), "utf8")), []);
});

// ---- hash and summary -------------------------------------------------------------

test("planHash is stable and changes with order and content", () => {
  const dir = tempDir({ "20261021000001_a.sql": "select 1;", "20261022000001_b.sql": "select 2;" });
  const ab = planHash(["20261021000001_a.sql", "20261022000001_b.sql"], dir);
  assert.match(ab, /^[0-9a-f]{64}$/);
  assert.equal(planHash(["20261021000001_a.sql", "20261022000001_b.sql"], dir), ab);
  assert.notEqual(planHash(["20261022000001_b.sql", "20261021000001_a.sql"], dir), ab);
  assert.notEqual(planHash(["20261021000001_a.sql"], dir), ab);
  writeFileSync(join(dir, "20261022000001_b.sql"), "select 3;");
  assert.notEqual(planHash(["20261021000001_a.sql", "20261022000001_b.sql"], dir), ab);
  assert.equal(planHash([], dir), "none");
});

test("renderSummary lists each file, escapes table cells and asks for a backup when anything is flagged", () => {
  const files = ["20261021000001_a.sql", "20261022000001_b.sql"];
  const md = renderSummary({
    files,
    details: [
      { description: "Adds a | b <x>", flags: [], gate: [] },
      { description: "Drops", flags: ["drops a column"], gate: ["creates a table without enabling RLS"] },
    ],
    sha: "abcdef1234567",
    mode: "workflow_dispatch",
  });
  assert.match(md, /Migrations plan for abcdef1/);
  for (const f of files) assert.ok(md.includes(f));
  assert.ok(md.includes("Adds a \\| b &lt;x&gt;"));
  assert.match(md, /drops a column; creates a table without enabling RLS/);
  assert.match(md, /confirm a recent backup/);
  assert.match(md, /\*\*confirm\*\* = `20261022000001`/);
  const quiet = renderSummary({ files: files.slice(0, 1), details: [{ description: "", flags: [], gate: [] }], sha: "abc", mode: "push" });
  assert.doesNotMatch(quiet, /backup/);
  assert.match(quiet, /production-db/);
  assert.match(renderSummary({ files: [], details: [], sha: "abc", mode: "push" }), /up to date/);
});

test("parseProblems takes the query's rows and refuses any other shape", () => {
  assert.deepEqual(parseProblems(fixture("db-query-problems-none.json")), []);
  assert.deepEqual(parseProblems(fixture("db-query-problems-one.json")), ["rls-off:zz_tmp"]);
  for (const bad of ["", "count\n0", "{}", '[{"count":0}]', '[{"problem":1}]', "null"]) {
    assert.throws(() => parseProblems(bad), /could not read/, bad);
  }
});

test("poolerInfo keeps the host and port, never the user or password", () => {
  const info = poolerInfo("postgresql://postgres.abc:s3cret@aws-0-us-east-1.pooler.supabase.com:5432/postgres\n");
  assert.deepEqual(info, { host: "aws-0-us-east-1.pooler.supabase.com", port: "5432" });
  assert.ok(!JSON.stringify(info).includes("s3cret"));
  assert.equal(poolerInfo("not a url"), null);
});

// ---- the CLI as the workflow runs it -------------------------------------------

test("plan: up to date writes pending=false and the summary", () => {
  const dir = tempDir({});
  const outputs = join(dir, "out");
  const summary = join(dir, "summary.md");
  const r = run(["plan", "--dry-run", join(FIX, "dry-run-up-to-date.json"), "--exit-code", "0", "--dir", dir, "--outputs", outputs, "--summary", summary, "--mode", "push", "--sha", "abc1234"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(outputs, "utf8"), "pending=false\ncount=0\nnewest=\nhash=none\n");
  assert.match(readFileSync(summary, "utf8"), /up to date/);
});

test("plan: pending files give their outputs, and the hash is checked on the second read", () => {
  const dir = tempDir({ "29991231000000_ci_parser_check.sql": "-- CI parser check\nselect 1;\n", "29991231000001_ci_parser_second.sql": "-- second\nselect 2;\n" });
  const outputs = join(dir, "out");
  const dry = join(FIX, "dry-run-two-pending.json");
  const r = run(["plan", "--dry-run", dry, "--exit-code", "0", "--dir", dir, "--outputs", outputs, "--mode", "workflow_dispatch"]);
  assert.equal(r.code, 0, r.out);
  const out = Object.fromEntries(readFileSync(outputs, "utf8").trim().split("\n").map((l) => l.split("=")));
  assert.equal(out.pending, "true");
  assert.equal(out.count, "2");
  assert.equal(out.newest, "29991231000001");
  assert.match(out.hash, /^[0-9a-f]{64}$/);

  assert.equal(run(["plan", "--dry-run", dry, "--exit-code", "0", "--dir", dir, "--expect-hash", out.hash]).code, 0);
  writeFileSync(join(dir, "29991231000001_ci_parser_second.sql"), "-- second\nselect 3;\n");
  const drift = run(["plan", "--dry-run", dry, "--exit-code", "0", "--dir", dir, "--expect-hash", out.hash]);
  assert.equal(drift.code, 1);
  assert.match(drift.out, /::error::The pending list changed since the plan was shown/);
});

test("plan: the out-of-order refusal says to rename, and never suggests --include-all", () => {
  const dir = tempDir({});
  const summary = join(dir, "summary.md");
  const r = run(["plan", "--dry-run", join(FIX, "dry-run-out-of-order.json"), "--exit-code", "1", "--dir", dir, "--summary", summary]);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::A pending migration \(20200101000000_old\.sql\) is older than the newest one on production/);
  assert.match(r.out, /Never use --include-all/);
  assert.match(readFileSync(summary, "utf8"), /Rename it/);
});

test("plan: a CLI error names its code and not its message", () => {
  const r = run(["plan", "--dry-run", join(FIX, "dry-run-connection-error.json"), "--exit-code", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::The Supabase CLI reported DbConnectError/);
  assert.doesNotMatch(r.out, /127\.0\.0\.1|user=/);
});

test("plan: unreadable output, unknown flags and missing flags fail", () => {
  const dir = tempDir({ "text.txt": "Remote database is up to date.\n" });
  assert.match(run(["plan", "--dry-run", join(dir, "text.txt"), "--exit-code", "0"]).out, /::error::Could not read the dry run/);
  assert.equal(run(["plan", "--dry-run", join(dir, "text.txt"), "--exit-code", "0"]).code, 1);
  assert.match(run(["plan", "--dry-run", join(FIX, "dry-run-up-to-date.json"), "--exit-code", "0", "--expect-hsah", "x"]).out, /unknown flag: --expect-hsah/);
  assert.equal(run(["plan", "--dry-run", join(FIX, "dry-run-up-to-date.json")]).code, 1);
  assert.equal(run(["plan", "--dry-run", join(FIX, "dry-run-up-to-date.json"), "--exit-code", "0", "--mode", "pull_request"]).code, 1);
  assert.equal(run(["nonsense"]).code, 1);
  assert.equal(run([]).code, 1);
});

test("plan: a listed file that isn't in the repo fails", () => {
  const r = run(["plan", "--dry-run", join(FIX, "dry-run-two-pending.json"), "--exit-code", "0", "--dir", tempDir({})]);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::not in/);
});

test("gate: fails only on a problem this apply introduced", () => {
  const dir = tempDir({
    "none.json": fixture("db-query-problems-none.json"),
    "one.json": fixture("db-query-problems-one.json"),
    "two.json": '[{"problem":"no-approval-gate:new_table"},{"problem":"rls-off:zz_tmp"}]',
  });
  const summary = join(dir, "summary.md");
  assert.equal(run(["gate", "--after", join(dir, "none.json"), "--summary", summary]).code, 0);
  assert.match(readFileSync(summary, "utf8"), /Every public table has RLS/);
  assert.equal(run(["gate", "--before", join(dir, "one.json"), "--after", join(dir, "one.json")]).code, 0);
  const fresh = run(["gate", "--before", join(dir, "one.json"), "--after", join(dir, "two.json")]);
  assert.equal(fresh.code, 1);
  assert.match(fresh.out, /::error::This apply left a table without RLS or the approval gate: no-approval-gate:new_table/);
  assert.match(fresh.out, /::warning::Already missing before this apply: rls-off:zz_tmp/);
  const warn = run(["gate", "--after", join(dir, "one.json"), "--warn-only"]);
  assert.equal(warn.code, 0);
  assert.match(warn.out, /::warning::Missing RLS or the approval gate: rls-off:zz_tmp/);
  writeFileSync(join(dir, "bad.json"), "count\n0\n");
  assert.equal(run(["gate", "--after", join(dir, "bad.json"), "--warn-only"]).code, 1);
});

test("pooler: prints the host and port, warns on the transaction pooler, survives a missing file", () => {
  const dir = tempDir({
    session: "postgresql://postgres.ref:pw@aws-0-x.pooler.supabase.com:5432/postgres",
    transaction: "postgresql://postgres.ref:pw@aws-0-x.pooler.supabase.com:6543/postgres",
  });
  const s = run(["pooler", "--file", join(dir, "session")]);
  assert.equal(s.code, 0);
  assert.match(s.out, /aws-0-x\.pooler\.supabase\.com:5432/);
  assert.doesNotMatch(s.out, /pw|postgres\.ref/);
  assert.match(run(["pooler", "--file", join(dir, "transaction")]).out, /::warning::.*6543/);
  assert.equal(run(["pooler", "--file", join(dir, "missing")]).code, 0);
});
