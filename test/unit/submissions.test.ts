import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFindings, cleanReview, nextTaskStatus, readMode } from "../../src/lib/submissionReview.js";

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
    facts: [{ label: " Weighted GPA ", value: " 4.21 " }, { label: "", value: "dropped" }],
    studentFix: "Upload something else.",
  });
  assert.equal(r.note.length, 200);
  assert.ok(!r.note.includes("  "));
  assert.deepEqual(r.findings.slice(0, 1), ["Two pages, both present."]);
  assert.ok(r.findings.every((f) => f.length <= 240));
  assert.ok(!r.findings.some((f) => f.startsWith("One. Two.")));
  assert.deepEqual(r.facts, [{ label: "Weighted GPA", value: "4.21" }]);
  assert.equal(r.studentFix, null, "an accepted file carries no fix");
  assert.deepEqual(checkFindings(r).slice(-1), ["Weighted GPA: 4.21"]);
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
    facts: "[]",
    studentFix: "Upload your resume.",
  });
  assert.deepEqual(r.findings, ["No name, experience or activities", "One page, five lines"]);
  assert.deepEqual(r.facts, []);
  assert.deepEqual(cleanReview({ verdict: "accepted", note: "ok", findings: "Single finding", facts: [] }).findings, ["Single finding"]);
  assert.deepEqual(cleanReview({ verdict: "accepted", note: "ok", findings: "[not json", facts: "nonsense" }).facts, []);
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
