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
