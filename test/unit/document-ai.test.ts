import assert from "node:assert/strict";
import { test } from "node:test";
import { documentAiDecision, documentReadableForTask, importNameRestricted, toAiDoc, unconfirmedAttachedNote, type AiDoc } from "../../src/lib/context/documentAi.js";
import { composeTrackerNote } from "../../src/lib/trackerNote.js";

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

test("rows from the database: only kind_confirmed true is confirmed; a missing one fails closed", () => {
  assert.equal(toAiDoc({ kind: "other", available_to_llm: true }).kind_confirmed, false);
  assert.equal(toAiDoc({ kind: "transcript", available_to_llm: true }).kind_confirmed, false);
  assert.equal(documentAiDecision(toAiDoc({ kind: "transcript" }), true).allowed, false, "a reader that forgot the column reads nothing");
  assert.equal(toAiDoc({ kind: "other", kind_confirmed: true }).kind_confirmed, true);
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

test("the tracker note counts attached files that aren't categorized", () => {
  const confirmed = { kind: "essay", available_to_llm: true, kind_confirmed: true };
  const unconfirmed = { kind: "other", available_to_llm: true, kind_confirmed: false };
  assert.equal(unconfirmedAttachedNote([confirmed, null], true), "");
  assert.equal(unconfirmedAttachedNote([confirmed, unconfirmed], true), "1 attached file isn't categorized yet. Confirm its type so the tracker can read it.");
  assert.equal(unconfirmedAttachedNote([unconfirmed, { ...unconfirmed, available_to_llm: false }, confirmed], false),
    "2 attached files aren't categorized yet. Confirm their types so the tracker can read them.", "unconfirmed comes before keep-out and the practice switch");
  assert.equal(unconfirmedAttachedNote([{ kind: "other", available_to_llm: false, kind_confirmed: true }], true), "", "kept out is not 'not categorized'");
});

test("composeTrackerNote keeps the unconfirmed sentence within 300 characters", () => {
  const tail = "2 attached files aren't categorized yet. Confirm their types so the tracker can read them.";
  assert.equal(composeTrackerNote("No activity for 9 days.", tail, ""), `No activity for 9 days. ${tail}`);
  assert.equal(composeTrackerNote("No activity for 9 days.", "", "Couldn't check x live."), "No activity for 9 days. Couldn't check x live.");
  assert.equal(composeTrackerNote("Base.", tail, "Caveat."), `Base. ${tail} Caveat.`);
  const long = composeTrackerNote("x".repeat(400), tail, "Couldn't check a live.");
  assert.ok(long.length <= 300, String(long.length));
  assert.ok(long.endsWith(tail));
  assert.ok(!long.includes("Couldn't check"), "the caveat goes first");
});

test("an import's name stays out of the student log for a restricted kind or a keep-out guess", () => {
  assert.equal(importNameRestricted("other", null), false);
  assert.equal(importNameRestricted("other", { kind: "transcript", keepOut: false }), false);
  assert.equal(importNameRestricted("other", { kind: "iep-504", keepOut: true }), true);
  assert.equal(importNameRestricted("other", { kind: "iep-504", keepOut: false }), true);
  assert.equal(importNameRestricted("other", { kind: "financial", keepOut: true }), true);
  assert.equal(importNameRestricted("counselor-only", null), true);
  assert.equal(importNameRestricted("other", { kind: null, keepOut: false }), false);
});

import { toDocument } from "../../src/lib/serialize.js";

test("a student caller never gets the server's type guess", () => {
  const row = { id: "d1", kind: "other", kind_confirmed: false, kind_guess: { kind: "iep-504", basis: "filename", matched: "IEP", textFound: false, keepOut: true } };
  assert.equal(toDocument(row, "student").kindGuess, null);
  assert.equal(toDocument(row, "counselor").kindGuess?.kind, "iep-504");
  assert.equal(toDocument(row).kindGuess?.kind, "iep-504");
});
