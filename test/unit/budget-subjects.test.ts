import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SYSTEM_CALLS_PER_MONTH } from "../../src/lib/aiBudget.js";

// Spec 1.2 / 1.10: no budget is charged to an account that isn't a person. The events-discovery budget once
// charged a made-up profile id, hit a foreign-key error on every call and was never enforced. A system job now
// names its own budget ({ system: "<job>" }); everything else charges the signed-in user.
const CALL = /\b(reserve|consumeQuota|enforceQuota)\(\s*([^,)]+)/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** First arguments that charge a made-up account, in one file's source. */
export function madeUpSubjects(source: string): string[] {
  const bad: string[] = [];
  for (const m of source.matchAll(CALL)) {
    const arg = m[2]!.trim();
    const system = /^\{\s*system:\s*["']([a-z-]+)["']\s*\}$/.exec(arg);
    if (system) {
      if (!(system[1]! in SYSTEM_CALLS_PER_MONTH)) bad.push(arg);
      continue;
    }
    if (/^["'`]/.test(arg) || UUID.test(arg) || /^[A-Z][A-Z0-9_]*$/.test(arg)) bad.push(arg);
  }
  return bad;
}

test("the check catches a made-up account", () => {
  assert.deepEqual(madeUpSubjects(`consumeQuota("00000000-0000-0000-0000-00000000e7e1", "ai_calls", "month", 2000)`).length, 1);
  assert.deepEqual(madeUpSubjects(`await enforceQuota(\n  SYSTEM_SUBJECT,\n  "ai_calls")`), ["SYSTEM_SUBJECT"]);
  assert.deepEqual(madeUpSubjects(`reserve({ system: "nightly-job" }, est, log)`), [`{ system: "nightly-job" }`]);
  assert.deepEqual(madeUpSubjects(`reserve({ system: "events-discovery" }, est, log); reserve(subjectOf(request), est, log)`), []);
});

test("no budget is charged to a made-up account", () => {
  const src = fileURLToPath(new URL("../../src", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const found = files(src).flatMap((f) => madeUpSubjects(readFileSync(f, "utf8")).map((arg) => `${relative(src, f)}: ${arg}`));
  assert.deepEqual(found, []);
});
