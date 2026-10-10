import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AI_ALLOWLIST, columns } from "../../src/lib/context/ai-allowlist.js";
import { documentAiDecision } from "../../src/lib/context/documentAi.js";

const doc = (o: Partial<{ kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean }> = {}) => ({
  kind: "transcript", available_to_llm: true, ai_access: "default", ferpa_waived: false, ...o,
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

test("no select('*') anywhere in src/lib/context", () => {
  const dir = join(process.cwd(), "src/lib/context");
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(dir)) assert.ok(!/select\(\s*["'`]\*/.test(readFileSync(f, "utf8")), `${f} uses select *`);
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
