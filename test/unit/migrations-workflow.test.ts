// The rules .github/workflows/migrations.yml must keep, read as text (no YAML
// dependency). actionlint in ci.yml checks the syntax; this checks the intent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const raw = readFileSync(".github/workflows/migrations.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

/** The file without its comments: a `#` that starts a line or follows a space (none sits inside a string here). */
const code = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
const wf = code(raw);

/** Each job's text, by name. */
function jobs(text: string) {
  const body = text.slice(text.indexOf("\njobs:\n"));
  const out: Record<string, string> = {};
  const re = /^ {2}([a-z][\w-]*):\n/gm;
  const marks = [...body.matchAll(re)];
  marks.forEach((m, i) => {
    out[m[1]] = body.slice(m.index, marks[i + 1]?.index ?? body.length);
  });
  return out;
}
const { plan, apply } = jobs(wf);

/** The body of every `run:` script, block or single line. */
function runScripts(text: string) {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() !== "|") {
      out.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    const body: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].search(/\S/) > indent)) body.push(lines[++i]);
    out.push(body.join("\n"));
  }
  return out;
}

test("every action is pinned to a full commit, in both workflows", () => {
  for (const [name, text] of [["migrations.yml", wf], ["ci.yml", code(ci)]]) {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length > 0, name);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${u}`);
  }
});

test("both workflows pin the same Supabase CLI", () => {
  const here = /SUPABASE_CLI_VERSION:\s*"(\d+\.\d+\.\d+)"/.exec(wf)?.[1];
  const there = /supabase\/setup-cli@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+version:\s*(\S+)/.exec(ci)?.[1];
  assert.ok(here, "migrations.yml pins SUPABASE_CLI_VERSION");
  assert.equal(there, here);
});

test("triggers: a push to main that touches a migration, and a manual run; never a pull request", () => {
  assert.match(wf, /push:\n\s+branches: \[main\]\n\s+paths: \["supabase\/migrations\/\*\*"\]/);
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /pull_request|schedule:|repository_dispatch|workflow_run/);
});

test("one run at a time, never cancelled, and read-only repository access", () => {
  assert.match(wf, /concurrency:\n\s+group: supabase-migrations-production\n\s+cancel-in-progress: false/);
  assert.match(wf, /^permissions:\n\s+contents: read\n/m);
  assert.match(wf, /SUPABASE_PROJECT_REF: kerstlpuvpmstiavxblv/);
});

test("the plan runs only on main without approval; the apply waits for production-db", () => {
  assert.match(plan, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(plan, /environment: production-db-plan\n/);
  assert.match(apply, /needs: plan/);
  assert.match(apply, /environment: production-db\n/);
  assert.match(apply, /github\.ref == 'refs\/heads\/main'/);
  // A push applies only once reviewers exist; a manual run only with apply on.
  assert.match(apply, /github\.event_name == 'push' && vars\.MIGRATIONS_REVIEWERS_CONFIGURED == 'true'/);
  assert.match(apply, /github\.event_name == 'workflow_dispatch' && inputs\.apply/);
  assert.match(apply, /needs\.plan\.outputs\.configured == 'true' && needs\.plan\.outputs\.pending == 'true'/);
  assert.doesNotMatch(plan, /supabase db push --linked --skip-vault --agent no --yes/);
});

test("missing secrets: a notice, a green plan, and the apply never starts", () => {
  assert.match(plan, /::notice title=Migrations not applied::/);
  assert.match(plan, /configured=false/);
  assert.match(plan, /HAS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN != '' \}\}/);
  // Every plan step after the check is gated on it.
  const steps = plan.split(/\n {6}- /).slice(3); // after the job header, the checkout and the check itself
  for (const s of steps) assert.match(s, /if: steps\.secrets\.outputs\.configured == 'true'/, s.split("\n")[0]);
});

test("a manual apply checks the confirm value and the person who clicked, not the original actor", () => {
  assert.match(apply, /ACTOR: \$\{\{ github\.triggering_actor \}\}/);
  assert.match(apply, /APPROVERS: \$\{\{ vars\.MIGRATION_APPROVERS \}\}/);
  assert.match(apply, /CONFIRM: \$\{\{ inputs\.confirm \}\}/);
  assert.doesNotMatch(wf, /github\.actor\b/);
  // The guards run before anything else in the job.
  assert.ok(apply.indexOf("Manual run guards") < apply.indexOf("actions/checkout"));
});

test("the apply re-reads the plan, refuses drift, and checks the database before and after", () => {
  const order = ["Dry run again", "--expect-hash", "Database check before", "name: Apply", "Database check after", "--before"];
  let at = -1;
  for (const mark of order) {
    const i = apply.indexOf(mark, at + 1);
    assert.ok(i > at, `${mark} comes after the step before it`);
    at = i;
  }
  const pushes = [...wf.matchAll(/supabase db push[^\n]*/g)].map((m) => m[0]);
  assert.equal(pushes.filter((p) => !p.includes("--dry-run")).length, 1, pushes.join("\n"));
});

test("the CLI is called the one safe way", () => {
  for (const flag of ["--include-all", "--include-seed", "--include-roles", "--debug", "--skip-pooler", "--db-url", "--password", " -p "]) {
    assert.ok(!wf.includes(flag), flag);
  }
  const calls = [...wf.matchAll(/supabase (?:link|db push|db query|migration list)[^\n]*(?:\\\n[^\n]*)*/g)].map((m) => m[0]);
  assert.ok(calls.length >= 9, String(calls.length));
  for (const c of calls) assert.match(c, /--agent no/, c);
  for (const c of calls.filter((c) => c.includes("--dry-run"))) assert.match(c, /--output-format json/, c);
  for (const c of calls.filter((c) => c.startsWith("supabase db push"))) assert.match(c, /--skip-vault/, c);
});

test("secrets reach only the steps that call the CLI, and no expression is pasted into a script", () => {
  const lines = wf.split("\n");
  lines.forEach((l, i) => {
    if (!/(^|[^.\w])secrets\.[A-Z_]/.test(l) || /!= ''/.test(l)) return;
    assert.match(l, /^ {10}SUPABASE_(ACCESS_TOKEN|DB_PASSWORD): \$\{\{ secrets\.SUPABASE_(ACCESS_TOKEN|DB_PASSWORD) \}\}$/, `line ${i + 1}: ${l}`);
  });
  // Each step that holds a secret runs the CLI and nothing else of ours.
  const withSecret = wf.split(/\n {6}- /).filter((step) => /secrets\.SUPABASE_(ACCESS_TOKEN|DB_PASSWORD) \}\}/.test(step));
  assert.ok(withSecret.length >= 8, String(withSecret.length));
  for (const step of withSecret) {
    const script = runScripts(step).join("\n");
    assert.match(script, /\bsupabase (link|db push|db query|migration list)\b/, step.split("\n")[0]);
    assert.doesNotMatch(script, /\bnode\b|\bcurl\b|\bnpm\b|\bnpx\b/, step.split("\n")[0]);
  }
  for (const script of runScripts(wf)) assert.ok(!script.includes("${{"), script);
  assert.doesNotMatch(wf, /node scripts\/migrations\/plan\.mjs[^\n]*\n?[^\n]*\$\{\{/);
});

test("the checkouts keep no credentials", () => {
  const checkouts = wf.split("actions/checkout@").length - 1;
  assert.equal((wf.match(/persist-credentials: false/g) ?? []).length, checkouts);
});
