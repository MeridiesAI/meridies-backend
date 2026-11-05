// What .github/workflows/axis-evals.yml must keep (AxIS security PR B, spec §5.2). actionlint in ci.yml checks the
// syntax; this checks the intent: the real-model evals never run on a pull request (whose code must never see
// the key), pass with a notice when the secret is missing, pin the same Supabase CLI as the other workflows, and
// keep scores only for main.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const raw = readFileSync(".github/workflows/axis-evals.yml", "utf8");
const wf = parse(raw) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { evals: { steps: { name?: string; id?: string; if?: string; uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }[] } };
};
const steps = wf.jobs.evals.steps;

test("the evals run on main pushes that touch AxIS and by hand, never on a pull request", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["push", "workflow_dispatch"]);
  const push = wf.on.push as { branches: string[]; paths: string[] };
  assert.deepEqual(push.branches, ["main"]);
  for (const p of ["src/lib/axis/**", "src/lib/context/**", "src/lib/anthropic.ts", "src/lib/submissionReview.ts", "evals/axis/**"]) assert.ok(push.paths.includes(p), p);
  assert.deepEqual(wf.permissions, { contents: "write", issues: "write" });
});

test("without the secret every step after the check is skipped, with a notice", () => {
  assert.equal(steps[0]!.id, "key");
  assert.match(steps[0]!.run!, /::notice::/);
  for (const s of steps.slice(1)) {
    if (s.if === "failure()") continue;
    assert.match(s.if ?? "", /steps\.key\.outputs\.run == 'true'/, s.name ?? s.uses ?? s.run ?? "a step");
  }
});

test("the key reaches only the API's own step", () => {
  const withKey = steps.filter((s) => JSON.stringify(s).includes("secrets.ANTHROPIC_API_KEY")).map((s) => s.name ?? s.id);
  assert.deepEqual(withKey, ["Is the key set?", "Start the API"]);
});

test("actions are pinned to a full SHA, and the Supabase CLI to the version the other workflows use", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses!, /@[0-9a-f]{40}$/, s.uses);
  const pinned = /SUPABASE_CLI_VERSION:\s*"?([\d.]+)"?/.exec(readFileSync(".github/workflows/migrations.yml", "utf8"))?.[1];
  const here = steps.find((s) => s.uses?.startsWith("supabase/setup-cli@"))?.with?.version;
  assert.ok(pinned, "migrations.yml pins SUPABASE_CLI_VERSION");
  assert.equal(String(here), pinned);
});

test("scores are stored and issues opened only for main; a drop always fails the run", () => {
  const run = steps.find((s) => s.id === "evals")!.run!;
  assert.match(run, /refs\/heads\/main.*--store scores\/scores\.jsonl/s);
  assert.match(run, /--baseline scores\/scores\.jsonl/);
  for (const name of ["Keep the score", "Alert on a drop"]) assert.match(steps.find((s) => s.name === name)!.if!, /github\.ref == 'refs\/heads\/main'/, name);
  assert.match(steps.find((s) => s.name === "Alert on a drop")!.run!, /gh issue list --label axis-eval --state open/);
  assert.equal(steps.find((s) => s.name === "Fail on a drop")!.run, "exit 1");
});
