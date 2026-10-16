import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AI_ALLOWLIST, columns } from "../../src/lib/context/ai-allowlist.js";
import { documentAiDecision } from "../../src/lib/context/documentAi.js";

const doc = (o: Partial<{ kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean; kind_confirmed: boolean }> = {}) => ({
  kind: "transcript", available_to_llm: true, ai_access: "default", ferpa_waived: false, kind_confirmed: true, ...o,
});

test("columns() returns only allowlisted names", () => {
  assert.equal(columns("awards", ["name", "level", "year"]), "name, level, year");
  assert.throws(() => columns("profiles", ["email" as never]), /not on the AI allowlist/);
});

test("never-included data is not on the allowlist", () => {
  const all = JSON.stringify(AI_ALLOWLIST);
  for (const banned of ["student_private_notes", "student_status_overrides", "red_flags", "guardians",
    "address", "birthday", "gender", "contact_email", "phone", "email", '"profile"']) {
    assert.ok(!all.includes(banned), `${banned} must not be on the allowlist`);
  }
});

/** The argument text of every `.select(` call in `src`, found by matching parentheses. */
export function selectCalls(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.select\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Why a select argument breaks the rule, or null. */
function selectProblem(arg: string): string | null {
  if (arg.trim() === "") return "select() with no columns reads every column";
  if (arg.includes("*")) return "select with a * reads every column";
  if (!arg.includes("columns(")) return "select that doesn't take columns(...) output";
  return null;
}

test("the select guard catches select(), a star and an unlisted string", () => {
  assert.deepEqual(selectCalls('db.from("a").select().eq("x", 1)'), [""]);
  assert.notEqual(selectProblem(""), null);
  assert.notEqual(selectProblem('"*"'), null);
  assert.notEqual(selectProblem('"id, `*`"'), null);
  assert.notEqual(selectProblem('"email"'), null);
  assert.equal(selectProblem('columns("awards", ["name"])'), null);
  assert.equal(selectProblem('`${columns("essays", c)}, document:documents(${columns("documents", ["available_to_llm"])})`'), null);
});

test("every .select( in src/lib/context takes columns(...) output, with one annotated exception", () => {
  const dir = join(process.cwd(), "src/lib/context");
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const exceptions: string[] = [];
  let seen = 0;
  for (const f of walk(dir)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.select\(/g)) {
      const arg = selectCalls(src.slice(m.index ?? 0))[0] ?? "";
      seen++;
      const problem = selectProblem(arg);
      if (!problem) continue;
      const lineStart = src.lastIndexOf("\n", m.index ?? 0) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", m.index ?? 0));
      if (line.includes("// ctx-email-exception")) exceptions.push(`${f}: ${arg}`);
      else assert.fail(`${f}: ${problem}: .select(${arg})`);
    }
  }
  assert.ok(seen >= 15, `expected to find the loaders' selects, found ${seen}`);
  assert.equal(exceptions.length, 1, `exactly one annotated exception (the login email), got ${exceptions.length}`);
  assert.match(exceptions[0] ?? "", /"email"/);
});

test("keep-out always wins", () => {
  assert.deepEqual(documentAiDecision(doc({ available_to_llm: false, ai_access: "allowed" }), true), { allowed: false, reason: "keep-out" });
});
test("a waived letter is never allowed", () => {
  assert.deepEqual(documentAiDecision(doc({ kind: "recommendation-letter", ferpa_waived: true, ai_access: "allowed" }), true), { allowed: false, reason: "waived" });
});
test("explicit settings beat kind defaults", () => {
  assert.equal(documentAiDecision(doc({ ai_access: "excluded" }), true).allowed, false);
  assert.equal(documentAiDecision(doc({ kind: "financial", ai_access: "allowed" }), true).allowed, true);
});
test("kind defaults", () => {
  for (const k of ["transcript", "resume", "test-report", "activity-list"]) assert.equal(documentAiDecision(doc({ kind: k }), true).allowed, true);
  for (const k of ["recommendation-letter", "financial", "iep-504", "counselor-only", "essay", "award-letter", "common-app"])
    assert.deepEqual(documentAiDecision(doc({ kind: k }), true), { allowed: false, reason: "kind-excluded" });
  assert.deepEqual(documentAiDecision(doc({ kind: "other" }), true), { allowed: false, reason: "not-categorized" });
});
test("practice document reading off excludes everything", () => {
  assert.deepEqual(documentAiDecision(doc(), false), { allowed: false, reason: "practice-setting" });
});

import { isRestrictedDocument } from "../../src/lib/context/documentAi.js";
test("restricted documents are the ones a student may not see", () => {
  assert.equal(isRestrictedDocument({ kind: "recommendation-letter", ferpa_waived: true }), true);
  assert.equal(isRestrictedDocument({ kind: "recommendation-letter", ferpa_waived: false }), false);
  assert.equal(isRestrictedDocument({ kind: "iep-504" }), true);
  assert.equal(isRestrictedDocument({ kind: "counselor-only" }), true);
  assert.equal(isRestrictedDocument({ kind: "transcript" }), false);
});
