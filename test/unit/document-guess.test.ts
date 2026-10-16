// test/unit/document-guess.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guessKind } from "../../src/lib/documentGuess.js";

const g = (filename: string, text: string | null = null, mimeType: string | null = "application/pdf") => guessKind({ filename, mimeType, text });

test("the guesser never imports anything that can call a model", () => {
  const src = readFileSync(new URL("../../src/lib/documentGuess.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports.filter((p) => /anthropic|axis|research|@anthropic-ai/.test(p!)), []);
  assert.ok(imports.every((p) => p!.startsWith("./") || p!.startsWith("node:")), imports.join(","));
});

test("text patterns are the strongest signal", () => {
  assert.deepEqual(g("scan.pdf", "OFFICIAL TRANSCRIPT ... Cumulative GPA 3.91"), { kind: "transcript", basis: "text", matched: "Official Transcript", textFound: true, keepOut: false });
  assert.equal(g("doc.pdf", "Your SAT Score Report from College Board").kind, "test-report");
  assert.equal(g("doc.pdf", "Department of the Treasury Form 1040 U.S. Individual Income Tax Return").kind, "financial");
  assert.equal(g("doc.pdf", "Individualized Education Program annual review").kind, "iep-504");
  assert.equal(g("doc.pdf", "Letter of Recommendation for Jordan").kind, "recommendation-letter");
  assert.equal(g("doc.pdf", "Financial Aid Award for the 2027-28 year").kind, "award-letter");
});

test("sensitive wins every conflict, and comes pre-filled as kept out", () => {
  const r = g("transcript.pdf", "Official Transcript. Cumulative GPA 3.8. FAFSA submitted.");
  assert.equal(r.kind, "financial");
  assert.equal(r.keepOut, true);
  assert.equal(g("essay.pdf", "My IEP taught me to ask for help.").kind, "iep-504");
  assert.equal(g("iep.pdf", null).keepOut, true);
});

test("the kind with more distinct matches wins; a tie is unknown", () => {
  assert.equal(g("x.pdf", "Official Transcript. Cumulative GPA 3.9. SAT total score 1450").kind, "transcript");
  assert.equal(g("x.pdf", "Resume. Activities List").kind, null);
});

test("filename keywords when there is no text, flagged as not read from the text", () => {
  assert.deepEqual(g("Jordan_Transcript_2026.pdf", ""), { kind: "transcript", basis: "filename", matched: "transcript", textFound: false, keepOut: false });
  assert.equal(g("ACT-scores.pdf").kind, "test-report");
  assert.equal(g("2025 taxes 1040.pdf").kind, "financial");
  assert.equal(g("rec letter - Ms Park.docx").kind, "recommendation-letter");
  assert.equal(g("CV.pdf").kind, "resume");
});

test("the Google file type is the weakest signal", () => {
  assert.deepEqual(g("Senior year list", null, "application/vnd.google-apps.spreadsheet"), { kind: "activity-list", basis: "type", matched: "spreadsheet named like a list", textFound: false, keepOut: false });
  assert.equal(g("Budget", null, "application/vnd.google-apps.spreadsheet").kind, null);
});

test("false friends and odd names stay unknown without throwing", () => {
  for (const name of ["Contract.pdf", "Pact essay.docx", "IMG_2041.HEIC", "Relevé de notes – 2026.pdf", "", "actual-draft.pdf", "$1,099 receipt.pdf"]) {
    const r = g(name, null);
    assert.equal(r.kind, null, name);
    assert.equal(r.basis, null, name);
  }
  assert.equal(g("x.pdf", "   ").textFound, false);
});

test("prototype property names in a filename stay unknown", () => {
  for (const name of ["Constructor University.pdf", "toString.pdf", "__proto__ notes.pdf", "hasOwnProperty valueOf.pdf"]) {
    const r = g(name, null);
    assert.equal(r.kind, null, name);
    assert.equal(r.basis, null, name);
    assert.equal(r.matched, null, name);
  }
});

test("sensitive phrases match in any case, and the spelled-out FAFSA counts", () => {
  assert.equal(g("a.pdf", "my fafsa confirmation is attached here").kind, "financial");
  assert.equal(g("a.pdf", "Fafsa submission summary for the family").kind, "financial");
  assert.equal(g("a.pdf", "wages shown on w-2 for the tax year 2025").kind, "financial");
  assert.deepEqual(g("a.pdf", "Free Application for Federal Student Aid 2027-28"), { kind: "financial", basis: "text", matched: "Free Application for Federal Student Aid", textFound: true, keepOut: true });
  assert.equal(g("a.pdf", "annual review of her iep goals and services").kind, "iep-504");
  assert.equal(g("a.pdf", "Form 1099-INT and the CSS PROFILE worksheet").keepOut, true);
});

test("a tie between filename words is unknown, even for a spreadsheet", () => {
  const r = g("Resume activities list.xlsx", null, "application/vnd.google-apps.spreadsheet");
  assert.equal(r.kind, null);
  assert.equal(r.basis, null);
  assert.equal(g("Resume activities.pdf").kind, null);
});
