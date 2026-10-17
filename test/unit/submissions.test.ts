import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFindings, cleanReview, nextTaskStatus, readMode, refusalFor } from "../../src/lib/submissionReview.js";

test("AxIS opens PDFs and images itself, reads Word and text files, and refuses the rest", () => {
  assert.deepEqual(readMode("transcript.PDF", null), { kind: "attachment", mediaType: "application/pdf" });
  assert.deepEqual(readMode("scan", "application/pdf"), { kind: "attachment", mediaType: "application/pdf" });
  assert.deepEqual(readMode("photo.jpg", "application/octet-stream"), { kind: "attachment", mediaType: "image/jpeg" });
  assert.deepEqual(readMode("photo", "image/webp"), { kind: "attachment", mediaType: "image/webp" });
  assert.deepEqual(readMode("resume.docx", null), { kind: "text" });
  assert.deepEqual(readMode("notes.txt", null), { kind: "text" });
  assert.deepEqual(readMode("sheet.xlsx", null), { kind: "unreadable" });
  assert.deepEqual(readMode("photo.heic", "image/heic"), { kind: "unreadable" });
});

test("a verdict never downgrades a closed task, and only reopens one waiting on a check", () => {
  assert.equal(nextTaskStatus("review", "accepted"), "complete");
  assert.equal(nextTaskStatus("not-started", "accepted"), "complete");
  assert.equal(nextTaskStatus("complete", "accepted"), null);
  assert.equal(nextTaskStatus("review", "needs-fix"), "in-progress");
  assert.equal(nextTaskStatus("complete", "needs-fix"), null);
  assert.equal(nextTaskStatus("in-progress", "needs-fix"), null);
});

test("model output is trimmed, capped and filtered before anyone reads it", () => {
  const r = cleanReview({
    verdict: "accepted",
    note: "  This   is the\\ntranscript.  " + "x".repeat(300),
    findings: ["Two pages, both present.", "One. Two. Three sentences would be a paragraph.", "x".repeat(300)],
    weightedGpa: " 4.21 ",
    unweightedGpa: "",
    classRank: null,
    testScores: [],
    studentFix: "Upload something else.",
  });
  assert.equal(r.note.length, 200);
  assert.ok(!r.note.includes("  "));
  assert.deepEqual(r.findings.slice(0, 1), ["Two pages, both present."]);
  assert.ok(r.findings.every((f) => f.length <= 240));
  assert.ok(!r.findings.some((f) => f.startsWith("One. Two.")));
  assert.deepEqual(r.facts, [{ label: "Weighted GPA", value: "4.21" }]);
  assert.equal(r.studentFix, null, "an accepted file carries no fix");
  assert.deepEqual(checkFindings(r)[0], "Weighted GPA: 4.21", "figures come first");
});

test("a needs-fix verdict tells the student what to do, and an unknown verdict is refused", () => {
  const r = cleanReview({ verdict: "needs-fix", note: "", findings: [], facts: [], studentFix: "Upload the full transcript, not page 1." });
  assert.equal(r.studentFix, "Upload the full transcript, not page 1.");
  assert.equal(r.note, "Needs another look.");
  assert.throws(() => cleanReview({ verdict: "maybe", note: "", findings: [], facts: [] }));
});

test("a list the model sent as JSON text is read back as a list", () => {
  const r = cleanReview({
    verdict: "needs-fix",
    note: "This is a grocery list, not a resume.",
    findings: '["No name, experience or activities", "One page, five lines"]',
    testScores: "[]",
    studentFix: "Upload your resume.",
  });
  assert.deepEqual(r.findings, ["No name, experience or activities", "One page, five lines"]);
  assert.deepEqual(r.facts, []);
  assert.deepEqual(cleanReview({ verdict: "accepted", note: "ok", findings: "Single finding" }).findings, ["Single finding"]);
  assert.deepEqual(cleanReview({ verdict: "accepted", note: "ok", findings: "[not json", testScores: 7 }).facts, []);
});

test("findings wrapped in <item> markup come out as separate bullets", () => {
  const r = cleanReview({
    verdict: "accepted",
    note: "ok",
    findings: ["<item>Official transcript.</item> <item>Name matches.</item>"],
    facts: [],
  });
  assert.deepEqual(r.findings, ["Official transcript.", "Name matches."]);
});

test("printed figures become facts the counselor reads; missing or garbled ones don't", () => {
  const r = cleanReview({
    verdict: "accepted",
    note: "ok",
    findings: [],
    weightedGpa: "4.12",
    unweightedGpa: null,
    classRank: "24 of 410",
    testScores: ["SAT 1450"],
  });
  assert.deepEqual(checkFindings(r), ["Weighted GPA: 4.12", "Class rank: 24 of 410", "Test score: SAT 1450"]);
  // What the model leaked when it garbled a tool call: no figure, verdict intact.
  const garbled = cleanReview({
    verdict: "accepted",
    note: "ok",
    findings: [],
    weightedGpa: '\n  <parameter name="weightedGpa">4.12',
    testScores: ['<parameter name="item">SAT'],
  });
  assert.equal(garbled.verdict, "accepted");
  assert.deepEqual(garbled.facts, []);
});

test("submission review refuses an unconfirmed file with a reason the student's counselor can act on", () => {
  assert.equal(refusalFor({ kind: "other", kind_confirmed: false }, true), "Choose a type for this file first, so AxIS knows what it is.");
  assert.equal(refusalFor({ kind: "other", available_to_llm: false, kind_confirmed: true }, true), "This file is kept out of AI, so AxIS didn't read it.");
  assert.equal(refusalFor({ kind: "essay", kind_confirmed: true }, true), null);
  assert.equal(refusalFor({ kind: "essay" }, true), "Choose a type for this file first, so AxIS knows what it is.", "a row without the column fails closed");
  assert.equal(refusalFor({ kind: "financial", kind_confirmed: true }, true), "This kind of file stays out of AI, so AxIS didn't read it.");
  assert.equal(refusalFor({ kind: "essay", kind_confirmed: true }, false), "Automatic document reading is off for this practice.");
});

test("the counselor's Submit email carries at most 60 characters of the student's display name", async () => {
  const { intakeSubmittedHeading, SUBJECT_NAME_MAX } = await import("../../src/lib/newStudentIntake.js");
  assert.equal(intakeSubmittedHeading("Ana Lopez"), "Ana Lopez sent what you asked for");
  assert.equal(intakeSubmittedHeading("   "), "Your new student sent what you asked for");
  const long = intakeSubmittedHeading(`Click https://evil.example now ${"x".repeat(200)}`);
  assert.ok(long.length <= SUBJECT_NAME_MAX + " sent what you asked for".length, String(long.length));
});
