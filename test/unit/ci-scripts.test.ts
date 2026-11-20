// The CI test selector and shard plan (scripts/ci). A selector that misses a test is a CI that lies, so
// these pin what it must pick, what must run everything, and that the shards together run every file.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain .mjs with no types
import { decide, NODE_ONLY } from "../../scripts/ci/select-unit-tests.mjs";
// @ts-expect-error plain .mjs with no types
import { assertCovers, shardPlan } from "../../scripts/ci/run-unit-tests.mjs";

type Decision = { mode: string; reason: string; tests: string[] };
const pick = (changed: string[]): Decision => decide(changed);

test("a change to a module picks every test that imports it, at any depth, and not unrelated ones", () => {
  const d = pick(["src/lib/payments.ts"]);
  assert.equal(d.mode, "affected");
  assert.ok(d.tests.includes("test/unit/payments-credit.test.ts"), "imports payments directly");
  assert.ok(d.tests.includes("test/unit/stripe-webhook.test.ts"), "reaches payments through the webhook route");
  assert.ok(!d.tests.includes("test/unit/csv.test.ts"), "csv never reaches payments");
});

test("a change to a test file picks that test", () => {
  assert.ok(pick(["test/unit/csv.test.ts"]).tests.includes("test/unit/csv.test.ts"));
});

test("a change to a test helper picks the tests that import it", () => {
  assert.ok(pick(["test/unit/sharedApp.ts"]).tests.includes("test/unit/axis-ops.test.ts"));
});

test("tests that read files or start processes by path always run", () => {
  const d = pick(["src/lib/csv.ts"]);
  for (const t of ["test/unit/migrations-workflow.test.ts", "test/unit/service-callsites.test.ts", "test/unit/import-parse.test.ts"]) {
    assert.ok(d.tests.includes(t), t);
  }
});

test("anything outside src/ and test/unit/ runs everything", () => {
  for (const f of ["package.json", "package-lock.json", "tsconfig.json", "supabase/migrations/20990101000000_x.sql", "test/fixtures/x.json", "scripts/ci/run-unit-tests.mjs", ".github/workflows/ci.yml", "test/env.ts"]) {
    assert.equal(pick([f]).mode, "all", f);
  }
});

test("docs and the integration suite narrow to the always-run tests only", () => {
  const d = pick(["AGENTS.md", "docs/x.md", "test/integration/x.test.mjs"]);
  assert.equal(d.mode, "affected");
  assert.ok(!d.tests.includes("test/unit/csv.test.ts"));
});

test("the Node-only files exist", () => {
  const all = pick(["package.json"]).tests;
  for (const f of NODE_ONLY as Set<string>) assert.ok(all.includes(f), f);
});

test("the shard plan holds every file exactly once, for any count and any times", () => {
  const files = Array.from({ length: 97 }, (_, i) => `test/unit/f${i}.test.ts`);
  for (const n of [1, 2, 3, 5, 8, 120]) {
    const times: Record<string, number> = {};
    files.forEach((f, i) => {
      if (i % 7) times[f] = ((i * 7919) % 5000) + 1; // every seventh has no recorded time
    });
    const plan = shardPlan(files, times, n) as { files: string[]; ms: number }[];
    assert.equal(plan.length, n);
    assert.doesNotThrow(() => assertCovers(plan, files));
  }
});

test("the shard plan is balanced: no shard is over the even share by more than the longest file", () => {
  const times: Record<string, number> = {};
  const files = Array.from({ length: 60 }, (_, i) => {
    const f = `test/unit/g${i}.test.ts`;
    times[f] = (i * 37) % 900 + 50;
    return f;
  });
  const plan = shardPlan(files, times, 3) as { ms: number }[];
  const total = Object.values(times).reduce((a, b) => a + b, 0);
  const longest = Math.max(...Object.values(times));
  for (const s of plan) assert.ok(s.ms <= total / 3 + longest, `${s.ms} vs ${total / 3}`);
});

test("assertCovers refuses a missing, a repeated or a stray file", () => {
  const files = ["a", "b", "c"];
  assert.throws(() => assertCovers([{ files: ["a", "b"] }], files), /missing c/);
  assert.throws(() => assertCovers([{ files: ["a", "b", "c"] }, { files: ["a"] }], files), /twice a/);
  assert.throws(() => assertCovers([{ files: ["a", "b", "c", "d"] }], files), /extra d/);
});
