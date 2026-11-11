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
  for (const name of ["Contract.pdf", "Pact.docx", "IMG_2041.HEIC", "Relevé de notes – 2026.pdf", "", "actual-draft.pdf", "$1,099 receipt.pdf"]) {
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

// ---- Files auto-sort: the printed text of realistic uploads (the app's e2e/fixtures/autosortFiles.ts) ----------

const RESUME = [
  "Jordan Lee",
  "jordan.lee@example.com | (555) 201-3344 | Austin, TX",
  "EDUCATION",
  "Westlake High School, Austin, TX - Class of 2027, GPA 3.9 unweighted",
  "EXPERIENCE",
  "Robotics Club - Team Captain, 2023-present: led 14 students to the state finals",
  "City Library - Volunteer Tutor, 2022-present: tutored 6 middle-school students in math, 3 hours per week",
  "SKILLS",
  "Python, CAD (Fusion 360), Spanish (conversational)",
].join("\n");

const ACTIVITY_SHEET = [
  "Activity type, Position, Organization, Description, Grades, Hours per week, Weeks per year",
  "Robotics, Team Captain, Westlake Robotics Club, Led 14 students, 10, 11, 12, 8, 30",
  "Community Service (Volunteer), Volunteer Tutor, Austin Public Library, Tutored math, 9, 10, 11, 3, 40",
].join("\n");

const ACTIVITY_DOC = [
  "Activities List - Jordan Lee",
  "1. Westlake Robotics Club - Team Captain (Grades 10-12, 8 hours per week, 30 weeks per year)",
  "2. Austin Public Library - Volunteer Tutor (Grades 9-11, 3 hours per week, 40 weeks per year)",
].join("\n");

const TRANSCRIPT = [
  "Westlake High School - Unofficial Transcript",
  "Student: Jordan Lee   Student ID: 204-118   Grade: 11",
  "AP Calculus AB              2025-26  A       1.0",
  "Cumulative GPA: 3.92 (unweighted)   Class Rank: 18 / 512",
].join("\n");

const PARAGRAPH =
  "The first time I held a soldering iron I burned my thumb, and the second time I burned the table. My grandfather, who fixed radios in Manila for forty years, laughed and handed me the iron again, and I sat with him until the light went. ";
const ESSAY_PLAIN = [PARAGRAPH.repeat(2), PARAGRAPH.replace("first", "last").repeat(2), PARAGRAPH.repeat(1)].join("\n\n");
const ESSAY_LABELLED = ["Personal Statement", "Prompt: Some students have a background, identity, interest, or talent...", PARAGRAPH, "Word count: 612"].join("\n");

test("auto-sort: a resume with no title is read from its sections and contact line", () => {
  assert.deepEqual(g("Jordan_Lee_final.docx", RESUME), { kind: "resume", basis: "text", matched: "resume sections", textFound: true, keepOut: false });
  // One stray "hours per week" in a bullet doesn't tie a resume with an activity list.
  assert.equal(g("x.pdf", `RESUME\n${RESUME}`).kind, "resume");
});

test("auto-sort: an activity list is read from the Common App's columns, in a sheet or a document", () => {
  assert.equal(g("my stuff.csv", ACTIVITY_SHEET, "text/csv").kind, "activity-list");
  assert.equal(g("Jordan ECs.xlsx", ACTIVITY_SHEET, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").kind, "activity-list");
  assert.equal(g("Jordan - list.docx", ACTIVITY_DOC).kind, "activity-list");
  assert.equal(g("x.pdf", "Hrs/wk 5, wks/yr 30 and the Position/Leadership column").kind, "activity-list");
});

test("auto-sort: a transcript keeps winning on its printed phrases", () => {
  assert.equal(g("Scan_0042.pdf", TRANSCRIPT).kind, "transcript");
});

test("auto-sort: an essay is read from its labels, or from long first-person paragraphs", () => {
  assert.deepEqual(g("draft v3.docx", ESSAY_LABELLED), { kind: "essay", basis: "text", matched: "Personal Statement", textFound: true, keepOut: false });
  assert.deepEqual(g("draft v3.docx", ESSAY_PLAIN), { kind: "essay", basis: "text", matched: "written as an essay", textFound: true, keepOut: false });
  // A recommendation letter is first-person prose too; its printed phrase wins and the shape is not counted.
  assert.equal(g("x.pdf", `Letter of Recommendation for Jordan Lee\n\n${PARAGRAPH.repeat(3)}\n\n${PARAGRAPH.repeat(2)}`).kind, "recommendation-letter");
  // A short note in the first person is not an essay.
  assert.equal(g("x.docx", "I will send my forms on Friday. My counselor has my transcript.").kind, null);
});

test("auto-sort: filenames for the new categories, with word boundaries", () => {
  assert.equal(g("Activities List.xlsx", null).kind, "activity-list");
  assert.equal(g("Activity list.pdf", null).kind, "activity-list");
  assert.equal(g("Extracurriculars.docx", null).kind, "activity-list");
  assert.equal(g("Why Stanford essay.docx", null).kind, "essay");
  assert.equal(g("Personal Statement - Satya.docx", null).kind, "essay");
  assert.equal(g("Said yes to Duke.pdf", null).kind, null); // "aid" inside a word is no aid form
  assert.equal(g("Common App Activities.csv", null, "text/csv").kind, "activity-list"); // "act" inside a word is no ACT
});

test("auto-sort: a sensitive phrase still wins over the new signals", () => {
  assert.equal(g("Jordan ECs.xlsx", `${ACTIVITY_SHEET}\nFAFSA submitted`).kind, "financial");
  assert.equal(g("essay.docx", `${ESSAY_LABELLED}\nMy IEP taught me`).keepOut, true);
});
