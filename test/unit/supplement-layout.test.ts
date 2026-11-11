import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combinedSections,
  detectOneDocument,
  effectiveLayout,
  readLayoutPreference,
  sourceKeyOf,
} from "../../src/lib/supplementLayout.js";

type Row = Record<string, unknown>;
let n = 0;
const row = (extra: Row): Row => ({
  id: `e${++n}`,
  essay_kind: "supplement",
  student_college_id: "sc1",
  document_id: null,
  supplement_doc_id: null,
  external_url: null,
  body: null,
  prompt: "",
  document: null,
  supplement_doc: null,
  ...extra,
});

const GDOC = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit";

test("a Google Doc is one source whatever its URL's tail", () => {
  const a = sourceKeyOf(row({ external_url: GDOC }));
  const b = sourceKeyOf(row({ external_url: "https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOp/view?usp=sharing" }));
  assert.equal(a, "gdoc:1AbCdEfGhIjKlMnOp");
  assert.equal(a, b);
});

test("two imports of one Drive file are one source; two uploads are two", () => {
  const drive = (id: string) => row({ document_id: id, document: { external_web_url: GDOC, filename: "Supplements.docx" } });
  assert.equal(sourceKeyOf(drive("d1")), sourceKeyOf(drive("d2")));
  assert.notEqual(sourceKeyOf(row({ document_id: "d1" })), sourceKeyOf(row({ document_id: "d2" })));
});

test("a link keeps its query (OneDrive needs it) but not its fragment or host case", () => {
  assert.equal(
    sourceKeyOf(row({ external_url: "https://OneDrive.live.com/edit?id=ABC#top" })),
    sourceKeyOf(row({ external_url: "https://onedrive.live.com/edit?id=ABC" }))
  );
  assert.notEqual(
    sourceKeyOf(row({ external_url: "https://onedrive.live.com/edit?id=ABC" })),
    sourceKeyOf(row({ external_url: "https://onedrive.live.com/edit?id=XYZ" }))
  );
});

test("a row with nothing behind it has no source", () => {
  assert.equal(sourceKeyOf(row({})), null);
});

test("several schools' supplements in one document are detected", () => {
  const rows = [
    row({ student_college_id: "a", document_id: "d1", document: { filename: "All supplements.docx" } }),
    row({ student_college_id: "b", document_id: "d1", document: { filename: "All supplements.docx" } }),
    row({ student_college_id: "c", document_id: "d1", document: { filename: "All supplements.docx" } }),
    row({ student_college_id: "c" }), // a prompt not started: doesn't count either way
    row({ essay_kind: "personal-statement", document_id: "ps" }),
  ];
  const one = detectOneDocument(rows);
  assert.ok(one);
  assert.equal(one!.essayIds.length, 3);
  assert.equal(one!.schoolCount, 3);
  assert.equal(one!.name, "All supplements.docx");
});

test("supplements from different documents are not one document", () => {
  const rows = [row({ document_id: "d1" }), row({ document_id: "d2" })];
  assert.equal(detectOneDocument(rows), null);
  // Mostly one, but not all.
  assert.equal(detectOneDocument([row({ external_url: GDOC }), row({ external_url: GDOC }), row({ document_id: "d3" })]), null);
});

test("one supplement on its own is not 'all in one document'", () => {
  assert.equal(detectOneDocument([row({ document_id: "d1" }), row({})]), null);
  assert.equal(detectOneDocument([]), null);
});

test("materials and the personal statement never count", () => {
  const rows = [row({ essay_kind: "other", document_id: "d1" }), row({ essay_kind: "personal-statement", document_id: "d1" }), row({ document_id: "d1" })];
  assert.equal(detectOneDocument(rows), null);
});

test("the counselor's choice wins over the automatic default", () => {
  const one = { essayIds: ["a", "b"], schoolCount: 2, name: null };
  assert.equal(effectiveLayout(null, one), "combined");
  assert.equal(effectiveLayout(null, null), "per-school");
  assert.equal(effectiveLayout("per-school", one), "per-school");
  assert.equal(effectiveLayout("combined", null), "combined");
});

test("the stored preference reads only the two layouts", () => {
  assert.equal(readLayoutPreference({ supplementsLayout: "combined" }), "combined");
  assert.equal(readLayoutPreference({ supplementsLayout: "per-school" }), "per-school");
  assert.equal(readLayoutPreference({ supplementsLayout: "grid" }), null);
  assert.equal(readLayoutPreference(null), null);
  assert.equal(readLayoutPreference([]), null);
});

const P1 = "Tell us about an intellectual experience that sparked your curiosity.";
const P2 = "Describe the community you come from and how it shaped who you are.";
const DOC = [
  "Maya's supplements",
  "",
  `Stanford: ${P1}`,
  "I took apart my grandmother's radio and found a tiny world inside it.",
  "",
  `MIT: ${P2}`,
  "My town has one stoplight and a library that stays open late.",
].join("\n");

test("one document filed on several prompts is cut at its prompts, verbatim", () => {
  const rows = [
    row({ student_college_id: "a", document_id: "d1", body: DOC, prompt: P1 }),
    row({ student_college_id: "b", document_id: "d1", body: DOC, prompt: P2 }),
  ];
  const [a, b] = combinedSections(rows);
  assert.equal(a!.from, "split");
  assert.equal(a!.text, "I took apart my grandmother's radio and found a tiny world inside it.");
  assert.equal(b!.text, "My town has one stoplight and a library that stays open late.");
  // Only the student's words: every slice is in the document.
  for (const s of [a!, b!]) assert.ok(DOC.includes(s.text!));
});

test("a shared document whose prompts aren't in it is shown whole, not guessed at", () => {
  const rows = [
    row({ document_id: "d1", body: DOC, prompt: "Why us? Tell us in a paragraph or two about the school." }),
    row({ document_id: "d1", body: DOC, prompt: P2 }),
  ];
  const sections = combinedSections(rows);
  assert.ok(sections.every((s) => s.from === "shared" && s.text === DOC.trim()));
});

test("short prompts are never looked for", () => {
  const rows = [row({ document_id: "d1", body: DOC, prompt: "Why us?" }), row({ document_id: "d1", body: DOC, prompt: P2 })];
  assert.ok(combinedSections(rows).every((s) => s.from === "shared"));
});

test("rows with their own text keep it; empty rows have none", () => {
  const rows = [row({ document_id: "d1", body: "  First answer.  " }), row({ document_id: "d2", body: "Second." }), row({})];
  const sections = combinedSections(rows);
  assert.deepEqual(
    sections.map((s) => [s.from, s.text]),
    [
      ["row", "First answer."],
      ["row", "Second."],
      ["row", null],
    ]
  );
});

test("one document filed on several rows but sliced differently keeps each row's own text", () => {
  const rows = [row({ document_id: "d1", body: "Part one.", prompt: P1 }), row({ document_id: "d1", body: "Part two.", prompt: P2 })];
  assert.deepEqual(combinedSections(rows).map((s) => s.text), ["Part one.", "Part two."]);
});

test("very long text is capped and says so", () => {
  const [s] = combinedSections([row({ document_id: "d1", body: "word ".repeat(10_000) })]);
  assert.equal(s!.truncated, true);
  assert.equal(s!.text!.length, 20_000);
});
