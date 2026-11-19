import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTRACT_BODY_MAX,
  STARTER_SECTIONS,
  addClause,
  copyTitle,
  moveClause,
  removeClause,
  renderContractText,
  unresolvedFields,
  type ContractSection,
  type SignatureBlock,
} from "../../src/lib/contractDraft.js";

const VALUES = { student_name: "Ava Lee", family_name: "Pat Lee", counselor_name: "Jane Roe", date: "November 18, 2026" };
const SIGNATURE: SignatureBlock = { signerName: "Jane Roe", practiceName: "Roe College Consulting", signedOn: "November 18, 2026", imageSha256: null };
const SECTIONS: ContractSection[] = [
  { id: "services", kind: "text", heading: "Services", body: "We will help {{student_name}} apply." },
  { id: "prereq", kind: "list", heading: "Prerequisites", items: ["Transcript shared", "Intake form"] },
  { id: "refunds", kind: "clause", heading: "Refunds", body: "Fees are refundable within 3 days." },
];
const textSection = (body: string): ContractSection[] => [{ id: "a", kind: "text", heading: "H", body }];
const ids = (sections: ContractSection[]) => sections.map((s) => s.id);

test("renders the exact text", () => {
  const r = renderContractText({ title: "Consulting agreement", sections: SECTIONS, values: VALUES, signature: SIGNATURE });
  const expected =
    "Consulting agreement\n\n1. Services\nWe will help Ava Lee apply.\n\n2. Prerequisites\n- Transcript shared\n- Intake form\n\n3. Refunds\nFees are refundable within 3 days.\n\nSigned for Roe College Consulting by Jane Roe, November 18, 2026.";
  assert.deepEqual(r, { ok: true, title: "Consulting agreement", bodyText: expected });

  const sha = "a".repeat(64);
  const drawn = renderContractText({ title: "Consulting agreement", sections: SECTIONS, values: VALUES, signature: { ...SIGNATURE, imageSha256: sha } });
  assert.deepEqual(drawn, { ok: true, title: "Consulting agreement", bodyText: `${expected}\nSignature image SHA-256: ${sha}` });
});

test("is deterministic", () => {
  const input = { title: "Consulting agreement", sections: SECTIONS, values: VALUES, signature: SIGNATURE };
  assert.deepEqual(renderContractText(input), renderContractText(input));
});

test("merges into the title, headings, bodies and list items", () => {
  const sections: ContractSection[] = [
    { id: "a", kind: "text", heading: "For {{family_name}}", body: "x" },
    { id: "b", kind: "list", heading: "List", items: ["{{counselor_name}} reviews"] },
  ];
  const r = renderContractText({ title: "{{student_name}} agreement", sections, values: VALUES, signature: SIGNATURE });
  assert.ok(r.ok);
  assert.equal(r.title, "Ava Lee agreement");
  assert.ok(r.bodyText.startsWith("Ava Lee agreement\n\n1. For Pat Lee\nx\n\n2. List\n- Jane Roe reviews\n\n"));
  assert.deepEqual(unresolvedFields("{{fee}}", sections, {}), ["fee", "family_name", "counselor_name"]);
});

test("reports unknown and empty fields", () => {
  const sections: ContractSection[] = [
    { id: "a", kind: "text", heading: "Fees {{fee}}", body: "{{ family_name }} owes {{fee}} {{Family_Name}} {{fee 2}}" },
  ];
  // Names are the trimmed token text: de-duplicated, first-seen order, case-sensitive, anything else unknown.
  assert.deepEqual(unresolvedFields("T", sections, {}), ["fee", "family_name", "Family_Name", "fee 2"]);
  // Whitespace inside the braces is tolerated: {{ family_name }} is the known field.
  assert.deepEqual(unresolvedFields("T", sections, { family_name: "Pat Lee" }), ["fee", "Family_Name", "fee 2"]);

  const family = textSection("{{family_name}}");
  assert.deepEqual(unresolvedFields("T", family, { family_name: "" }), ["family_name"]);
  assert.deepEqual(unresolvedFields("T", family, { family_name: "  \n" }), ["family_name"]);
  assert.deepEqual(unresolvedFields("T", family, { family_name: "Pat Lee" }), []);
  // An unfilled field is also found in a list item and the title.
  assert.deepEqual(
    unresolvedFields("{{date}}", [{ id: "l", kind: "list", heading: "L", items: ["{{student_name}}"] }], {}),
    ["date", "student_name"],
  );

  const r = renderContractText({ title: "T", sections, values: { student_name: "Ava" }, signature: SIGNATURE });
  assert.deepEqual(r, { ok: false, reason: "unresolved", fields: ["fee", "family_name", "Family_Name", "fee 2"] });
});

test("does not expand a value that looks like a field", () => {
  const r = renderContractText({ title: "T", sections: textSection("Hi {{student_name}} {{family_name}}"), values: { ...VALUES, student_name: "{{date}}", family_name: "$&" }, signature: SIGNATURE });
  assert.ok(r.ok);
  assert.ok(r.bodyText.includes("1. H\nHi {{date}} $&\n"));
});

test("caps the rendered text", () => {
  const render = (body: string) => renderContractText({ title: "T", sections: textSection(body), values: {}, signature: SIGNATURE });
  const base = render("");
  assert.ok(base.ok);
  const pad = CONTRACT_BODY_MAX - base.bodyText.length;
  // "é😀" is 3 UTF-16 units but 2 code points: the cap counts .length.
  const body = "é😀".repeat(Math.floor(pad / 3)) + "a".repeat(pad % 3);
  const atCap = render(body);
  assert.ok(atCap.ok);
  assert.equal(atCap.bodyText.length, CONTRACT_BODY_MAX);
  assert.ok([...atCap.bodyText].length < CONTRACT_BODY_MAX);
  assert.deepEqual(render(`${body}a`), { ok: false, reason: "too_long" });
});

test("edit helpers", () => {
  const starter = addClause(addClause(STARTER_SECTIONS, "n1"), "n2");
  const added = starter.at(-1);
  assert.deepEqual(added, { id: "n2", kind: "clause", heading: "New clause", body: "" });
  assert.equal(starter.length, STARTER_SECTIONS.length + 2);
  assert.equal(STARTER_SECTIONS.length, 8, "the starter is not mutated by addClause");

  // Only a clause is removable.
  assert.deepEqual(removeClause(SECTIONS, "services"), SECTIONS);
  assert.deepEqual(ids(removeClause(SECTIONS, "prereq")), ["services", "prereq", "refunds"]);
  assert.deepEqual(ids(removeClause(SECTIONS, "refunds")), ["services", "prereq"]);

  // Clauses reorder among clauses; the first three sections never move and nothing moves off the end.
  const first = STARTER_SECTIONS[3].id;
  const last = starter.at(-1)!.id;
  assert.deepEqual(ids(moveClause(starter, first, -1)), ids(starter));
  assert.deepEqual(ids(moveClause(starter, last, 1)), ids(starter));
  assert.deepEqual(ids(moveClause(starter, first, 1)).slice(0, 5), [...ids(starter).slice(0, 3), ids(starter)[4], first]);
  assert.deepEqual(ids(moveClause(starter, last, -1)).slice(-2), [last, ids(starter).at(-2)!]);
  for (const id of ids(STARTER_SECTIONS).slice(0, 3)) assert.deepEqual(ids(moveClause(starter, id, 1)), ids(starter));
  assert.deepEqual(ids(moveClause(SECTIONS, "refunds", -1)), ids(SECTIONS));
  assert.deepEqual(ids(moveClause(starter, "missing", 1)), ids(starter));

  const copy = copyTitle("x".repeat(160));
  assert.equal(copy.length, 160);
  assert.ok(copy.endsWith("(copy)"));
  assert.equal(copyTitle("Consulting agreement"), "Consulting agreement (copy)");
  // A cut never leaves half an emoji behind.
  assert.equal(copyTitle(`${"x".repeat(152)}😀😀`), `${"x".repeat(152)} (copy)`);
});

test("the starter renders once the family's names are filled", () => {
  assert.deepEqual(ids(STARTER_SECTIONS).slice(0, 3), ["services", "prerequisites", "fees"]);
  assert.deepEqual(STARTER_SECTIONS.slice(3).map((s) => s.kind), Array(5).fill("clause"));
  assert.deepEqual(STARTER_SECTIONS.slice(3).map((s) => s.heading), [
    "Cancellation and refunds",
    "No guarantee of admission",
    "Confidentiality",
    "Communication",
    "Ending this agreement",
  ]);
  assert.deepEqual(unresolvedFields("T", STARTER_SECTIONS, VALUES), []);
  assert.deepEqual(unresolvedFields("T", STARTER_SECTIONS, {}), ["counselor_name", "student_name", "family_name"]);
  const r = renderContractText({ title: "T", sections: STARTER_SECTIONS, values: VALUES, signature: SIGNATURE });
  assert.ok(r.ok);
  assert.ok(!r.bodyText.includes("{{"));
});
