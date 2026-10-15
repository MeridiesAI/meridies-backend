import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePlan, planFromTemplate, templateFrom, type ParsePlan, type ProfiledFile } from "../../src/lib/imports/plan.js";
import { detectSourceSystem, presetPlan, presetTarget, unmappedColumns } from "../../src/lib/imports/presets.js";
import { profileFile } from "../../src/lib/imports/profile.js";
import type { ParsedSheet } from "../../src/lib/imports/sheet.js";
import { FIELDS } from "./import-fixtures.js";

const FILE = "11111111-1111-4111-8111-111111111111";

function file(headers: string[], rows: string[][], name = "Roster", date1904 = false): ProfiledFile {
  const sheet: ParsedSheet = { name, headerRow: 1, headers, rows, rowNumbers: rows.map((_, i) => i + 2), date1904 };
  return { fileId: FILE, filename: "roster.csv", profile: profileFile([sheet]) };
}

const roster = file(
  ["Email", "First Name", "Last Name", "Weighted GPA", "GPA", "SSN", "AP Biology", "AP Courses Taken", "DOB", "Class of"],
  [
    ["jane@x.org", "Jane", "Doe", "4.1", "3.8", "123-45-6789", "5", "Bio, Chem", "25/12/2008", "2027"],
    ["john@x.org", "John", "Roe", "3.6", "3.4", "987-65-4321", "3", "None", "03/04/2009", "2027"],
  ]
);

test("presets map plain headers and leave ambiguous ones", () => {
  const plan = presetPlan([roster]);
  const cols = new Map(plan.sheets[0].columns.map((c) => [roster.profile.sheets[0].columns[c.index].header, c.target]));
  assert.deepEqual(cols.get("Email"), { kind: "key", key: "email" });
  assert.deepEqual(cols.get("First Name"), { kind: "key", key: "first_name" });
  assert.deepEqual(cols.get("Weighted GPA"), { kind: "field", table: "student_academics", field: "gpa_weighted" });
  assert.deepEqual(cols.get("AP Biology"), { kind: "score_column", exam: "AP Biology", testKind: "ap" });
  assert.deepEqual(cols.get("Class of"), { kind: "key", key: "grad_year" });
  assert.equal(cols.has("GPA"), false, "GPA alone is ambiguous");
  assert.equal(cols.has("SSN"), false, "a sensitive column is never mapped");
  assert.equal(cols.has("AP Courses Taken"), false, "not a score column: its values aren't 1 to 7");
  const dob = plan.sheets[0].columns.find((c) => roster.profile.sheets[0].columns[c.index].header === "DOB");
  assert.deepEqual(dob?.parse, { date: "DMY" }, "a day over 12 first means day-month-year");
});

test("a long-format part without its required part is left unmapped", () => {
  assert.deepEqual(presetTarget("Test Score"), { kind: "row", table: "test_scores", group: "1", part: "score" });
  const scoresOnly = file(["Email", "Name", "Test Score"], [["a@b.co", "A B", "5"]]);
  assert.equal(presetPlan([scoresOnly]).sheets[0].columns.some((c) => c.target.kind === "row"), false);
});

test("an Excel serial birthday column gets the workbook's date system", () => {
  const f = file(["Email", "Name", "Birthday"], [["a@b.co", "A B", "39448"]], "S", true);
  assert.deepEqual(presetPlan([f]).sheets[0].columns.find((c) => c.index === 2)?.parse, { date: "excel1904" });
});

test("source system detection is conservative", () => {
  assert.equal(detectSourceSystem(["Naviance ID", "First Name"]), "naviance");
  assert.equal(detectSourceSystem(["SCOIR Student ID"]), "scoir");
  assert.equal(detectSourceSystem(["Record ID", "Contact owner", "Email"]), "hubspot");
  assert.equal(detectSourceSystem(["Email", "Name"]), "unknown");
});

test("unmapped columns exclude sensitive and empty ones", () => {
  const plan = presetPlan([roster]);
  const u = unmappedColumns(plan, [roster]);
  const headers = [...u[0].indexes].map((i) => roster.profile.sheets[0].columns[i].header).sort();
  assert.deepEqual(headers, ["AP Courses Taken", "GPA"]);
});

const base = (columns: ParsePlan["sheets"][0]["columns"]): ParsePlan => ({
  version: 1,
  sheets: [{ fileId: FILE, sheet: "Roster", columns }],
  constants: {},
  sourceSystem: "unknown",
});
const email = { index: 0, target: { kind: "key", key: "email" }, source: "counselor" } as const;

test("validatePlan refuses invented sheets, columns and fields", () => {
  const ghost = validatePlan({ ...base([email]), sheets: [{ fileId: FILE, sheet: "Nope", columns: [] }] }, [roster], FIELDS);
  assert.ok(ghost.problems.some((p) => /sheet that isn't/.test(p)));
  const col = validatePlan(base([email, { index: 99, target: { kind: "ignore" }, source: "ai" }]), [roster], FIELDS);
  assert.ok(col.problems.some((p) => /no column 100/.test(p)));
  const fld = validatePlan(base([email, { index: 3, target: { kind: "field", table: "student_academics", field: "ssn" }, source: "ai" }]), [roster], FIELDS);
  assert.ok(fld.problems.some((p) => /can fill/.test(p)));
  const part = validatePlan(base([email, { index: 3, target: { kind: "row", table: "courses", group: "1", part: "teacher" }, source: "ai" }]), [roster], FIELDS);
  assert.ok(part.problems.some((p) => /no part/.test(p)));
});

test("validatePlan forces a sensitive column to ignore, whoever mapped it", () => {
  const out = validatePlan(base([email, { index: 3, target: { kind: "field", table: "student_academics", field: "gpa_weighted" }, source: "counselor" }, { index: 5, target: { kind: "field", table: "student_academics", field: "class_rank" }, source: "counselor" }]), [roster], FIELDS);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.forced.map((f) => f.header), ["SSN"]);
  assert.deepEqual(out.plan.sheets[0].columns.find((c) => c.index === 5)?.target, { kind: "ignore" });
});

test("validatePlan needs a student key, one column per field, and a row's required part", () => {
  const noKey = validatePlan(base([{ index: 3, target: { kind: "field", table: "student_academics", field: "gpa_weighted" }, source: "counselor" }]), [roster], FIELDS);
  assert.ok(noKey.problems.some((p) => /email or name/.test(p)));
  const dup = validatePlan(base([email, { index: 3, target: { kind: "field", table: "student_academics", field: "gpa_weighted" }, source: "counselor" }, { index: 4, target: { kind: "field", table: "student_academics", field: "gpa_weighted" }, source: "counselor" }]), [roster], FIELDS);
  assert.ok(dup.problems.some((p) => /two columns/.test(p)));
  const group = validatePlan(base([email, { index: 6, target: { kind: "row", table: "test_scores", group: "1", part: "score" }, source: "counselor" }]), [roster], FIELDS);
  assert.ok(group.problems.some((p) => /need a column for the exam/.test(p)));
  const keysOnly = validatePlan(base([email, { index: 1, target: { kind: "key", key: "first_name" }, source: "counselor" }]), [roster], FIELDS);
  assert.ok(keysOnly.problems.some((p) => /at least one column/.test(p)));
});

test("a template applies sheet by sheet to a file with the same headers", () => {
  const plan = presetPlan([roster]);
  const t = templateFrom(plan, roster);
  const again = planFromTemplate(t, roster);
  assert.ok(again);
  assert.deepEqual(again![0].columns.map((c) => c.target), plan.sheets[0].columns.map((c) => c.target));
  assert.ok(again![0].columns.every((c) => c.source === "template"));
});
