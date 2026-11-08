import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanSchema, validatePlan, planFromTemplate, templateFrom, type ParsePlan, type ProfiledFile, type Target } from "../../src/lib/imports/plan.js";
import { detectSourceSystem, presetPlan, presetSheetsFor, presetTarget, unmappedColumns, vendorTarget, VENDOR_PRESETS, type VendorPresets } from "../../src/lib/imports/presets.js";
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

test("the questionnaire's own targets aren't offered to a spreadsheet column", async () => {
  const { singleFields } = await import("../../src/lib/imports/fields.js");
  const names = singleFields(FIELDS).map((f) => `${f.table}.${f.field}`);
  assert.ok(names.includes("student_academics.gpa_weighted"));
  assert.ok(!names.includes("student_academics.gpa_band"));
  assert.ok(!names.some((n) => n.startsWith("profiles.") || n.startsWith("awards.")));
});

// --- vendor presets (College Planner Pro, Counselmore) -------------------------------
//
// SYNTHETIC: not a real CPP/Counselmore export. We have no export from either
// tool. Every header below is a guess at how such a tool might label a column;
// these tests pin how the guesses behave, not that either tool uses them. When
// a real export arrives, re-derive the presets and these fixtures from it.

const f2 = (headers: string[], rows: string[][], fileId = FILE): ProfiledFile => ({
  fileId,
  filename: "synthetic.csv",
  profile: profileFile([{ name: "Roster", headerRow: 1, headers, rows, rowNumbers: rows.map((_, i) => i + 2), date1904: false }]),
});
const headerOf = (f: ProfiledFile, index: number) => f.profile.sheets[0].columns[index].header;
const byHeader = (f: ProfiledFile, sheetIndex = 0) =>
  new Map(presetSheetsFor(f)[sheetIndex].columns.map((c) => [headerOf(f, c.index), c]));

/** [header, what the vendor table maps it to]. Each is one alternative of an alias; none is known to be a real export header. */
const VENDOR_SAMPLES: Array<[string, Target]> = [
  ["Student's Email", { kind: "key", key: "email" }],
  ["Student's Email Address", { kind: "key", key: "email" }],
  ["Student's E-mail", { kind: "key", key: "email" }],
  ["Student's Name", { kind: "key", key: "full_name" }],
  ["Student's Full Name", { kind: "key", key: "full_name" }],
  ["Name of Student", { kind: "key", key: "full_name" }],
  ["Student First", { kind: "key", key: "first_name" }],
  ["Student's First Name", { kind: "key", key: "first_name" }],
  ["Student Given Name", { kind: "key", key: "first_name" }],
  ["Student Last", { kind: "key", key: "last_name" }],
  ["Student's Last Name", { kind: "key", key: "last_name" }],
  ["Student Surname", { kind: "key", key: "last_name" }],
  ["Student Family Name", { kind: "key", key: "last_name" }],
  ["Graduating Class", { kind: "key", key: "grad_year" }],
  ["Graduation Class", { kind: "key", key: "grad_year" }],
  ["Grad Class", { kind: "key", key: "grad_year" }],
  ["Graduating Year", { kind: "key", key: "grad_year" }],
  ["Grad Yr", { kind: "key", key: "grad_year" }],
  ["Graduation Yr", { kind: "key", key: "grad_year" }],
  ["High School Graduation Year", { kind: "key", key: "grad_year" }],
  ["High School Grad Year", { kind: "key", key: "grad_year" }],
  ["Anticipated Graduation Year", { kind: "key", key: "grad_year" }],
  ["Projected Graduation Year", { kind: "key", key: "grad_year" }],
  ["Highschool", { kind: "key", key: "high_school" }],
  ["Highschool Name", { kind: "key", key: "high_school" }],
  ["High School Attended", { kind: "key", key: "high_school" }],
  ["Current High School Name", { kind: "key", key: "high_school" }],
  ["Cumulative GPA Weighted", { kind: "field", table: "student_academics", field: "gpa_weighted" }],
  ["GPA (Cumulative, Weighted)", { kind: "field", table: "student_academics", field: "gpa_weighted" }],
  ["Weighted GPA (Cumulative)", { kind: "field", table: "student_academics", field: "gpa_weighted" }],
  ["GPA (W)", { kind: "field", table: "student_academics", field: "gpa_weighted" }],
  ["Cumulative GPA Unweighted", { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
  ["GPA (Cumulative, Unweighted)", { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
  ["Unweighted GPA (Cumulative)", { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
  ["GPA (UW)", { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
  ["GPA (Unw)", { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
  ["Unw GPA", { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
  ["SAT Total Score", { kind: "field", table: "student_academics", field: "sat_superscore" }],
  ["SAT Composite Score", { kind: "field", table: "student_academics", field: "sat_superscore" }],
  ["SAT Combined", { kind: "field", table: "student_academics", field: "sat_superscore" }],
  ["SAT Combined Score", { kind: "field", table: "student_academics", field: "sat_superscore" }],
  ["SAT Math Section", { kind: "field", table: "student_academics", field: "sat_math" }],
  ["SAT EBRW Section", { kind: "field", table: "student_academics", field: "sat_ebrw" }],
  ["SAT ERW Section", { kind: "field", table: "student_academics", field: "sat_ebrw" }],
  ["SAT Reading/Writing Score", { kind: "field", table: "student_academics", field: "sat_ebrw" }],
  ["SAT Reading and Writing Section", { kind: "field", table: "student_academics", field: "sat_ebrw" }],
  ["SAT Evidence-Based Reading and Writing Section", { kind: "field", table: "student_academics", field: "sat_ebrw" }],
  ["ACT Composite Score", { kind: "field", table: "student_academics", field: "act_composite" }],
  ["First Gen Student", { kind: "field", table: "student_personal_details", field: "first_gen" }],
  ["First-Generation Student", { kind: "field", table: "student_personal_details", field: "first_gen" }],
  ["First Generation Status", { kind: "field", table: "student_personal_details", field: "first_gen" }],
  ["First Gen Status", { kind: "field", table: "student_personal_details", field: "first_gen" }],
  ["Intended Major(s)", { kind: "field", table: "student_personal_details", field: "intended_majors" }],
  ["Prospective Major", { kind: "field", table: "student_personal_details", field: "intended_majors" }],
  ["Prospective Majors", { kind: "field", table: "student_personal_details", field: "intended_majors" }],
  ["Prospective Major(s)", { kind: "field", table: "student_personal_details", field: "intended_majors" }],
  ["Major(s) of Interest", { kind: "field", table: "student_personal_details", field: "intended_majors" }],
  ["Hrs/Wk", { kind: "row", table: "activities", group: "1", part: "hours_per_week" }],
  ["Hours/Wk", { kind: "row", table: "activities", group: "1", part: "hours_per_week" }],
  ["Hrs/Week", { kind: "row", table: "activities", group: "1", part: "hours_per_week" }],
  ["Wks/Yr", { kind: "row", table: "activities", group: "1", part: "weeks_per_year" }],
  ["Weeks/Yr", { kind: "row", table: "activities", group: "1", part: "weeks_per_year" }],
  ["Wks/Year", { kind: "row", table: "activities", group: "1", part: "weeks_per_year" }],
];

/** Headers a vendor preset must leave alone: ambiguous, or nothing in an import can hold them. */
const NEVER_MAPPED = [
  "GPA", "Grade", "School", "Rank", "SAT Date", "ACT Date", "SAT Highest", "Test Date Taken",
  "Parent Email", "Parent's Email", "Guardian Email", "Parent Name", "Parent/Guardian Name", "Guardian Phone", "Parent Phone", "Mother's Email",
  "Student ID", "CPP ID", "Counselmore ID", "Counselor", "Notes", "Status",
];

for (const vendor of ["collegeplannerpro", "counselmore"] as const) {
  test(`${vendor}: each vendor alias maps to its field, and only for that vendor`, () => {
    for (const [header, target] of VENDOR_SAMPLES) {
      assert.deepEqual(vendorTarget(header, vendor), target, `${header} under ${vendor}`);
      assert.equal(presetTarget(header), null, `${header}: a vendor alias is one the generic presets do not already know`);
      assert.equal(vendorTarget(header, "unknown"), null, `${header} with no vendor`);
      assert.equal(vendorTarget(header, "naviance"), null, `${header} under another tool`);
    }
  });

  test(`${vendor}: ambiguous headers and parent columns are never mapped`, () => {
    const named = vendor === "counselmore" ? "Counselmore ID" : "College Planner Pro ID";
    const others = NEVER_MAPPED.filter((h) => h !== "CPP ID" && h !== "Counselmore ID");
    for (const header of NEVER_MAPPED) {
      assert.equal(vendorTarget(header, vendor), null, header);
      assert.equal(presetTarget(header), null, `${header}: the generic presets leave it too`);
    }
    const f = f2([named, "Student's Email", ...others], [["id1", "a@b.co", ...others.map(() => "x")]]);
    assert.equal(detectSourceSystem(f.profile.sheets[0].columns.map((c) => c.header)), vendor);
    assert.deepEqual([...byHeader(f).keys()], ["Student's Email"], "only the student's email maps: no parent column ever becomes the student's email");
  });
}

test("a vendor named in a header gets that vendor's aliases, marked preset-unverified", () => {
  // SYNTHETIC: not a real CPP export.
  const cpp = f2(
    ["College Planner Pro ID", "Student's Email", "Student First", "Student Last", "Graduating Class", "Highschool", "Cumulative GPA Weighted", "Unweighted GPA", "SAT Total Score", "ACT Composite Score", "Intended Major(s)", "Parent Email", "Notes"],
    [["c1", "jane@x.org", "Jane", "Doe", "2027", "Lincoln High School", "4.1", "3.8", "1450", "32", "Biology", "mom@x.org", "hello"]]
  );
  const sheet = presetSheetsFor(cpp)[0];
  const cols = byHeader(cpp);
  assert.equal(detectSourceSystem(cpp.profile.sheets[0].columns.map((c) => c.header)), "collegeplannerpro");
  for (const h of ["Student's Email", "Student First", "Student Last", "Graduating Class", "Highschool", "Cumulative GPA Weighted", "SAT Total Score", "ACT Composite Score", "Intended Major(s)"]) {
    assert.equal(cols.get(h)?.source, "preset-unverified", `${h} came from a vendor guess`);
  }
  assert.deepEqual(cols.get("Student's Email")?.target, { kind: "key", key: "email" });
  assert.deepEqual(cols.get("Cumulative GPA Weighted")?.target, { kind: "field", table: "student_academics", field: "gpa_weighted" });
  assert.equal(cols.get("Unweighted GPA")?.source, "preset", "a header the generic presets already know stays a plain preset, even in a vendor's file");
  assert.deepEqual(cols.get("Unweighted GPA")?.target, { kind: "field", table: "student_academics", field: "gpa_unweighted" });
  for (const h of ["College Planner Pro ID", "Parent Email", "Notes"]) assert.equal(cols.has(h), false, `${h} stays unmapped`);
  assert.equal(sheet.columns.filter((c) => c.source === "preset-unverified").length, 9);
  assert.equal(presetPlan([cpp]).sourceSystem, "collegeplannerpro");
  assert.deepEqual(presetPlan([cpp]).sheets, presetSheetsFor(cpp));
});

test("the same headers without a vendor named map generically: nothing is guessed", () => {
  // SYNTHETIC: not a real export. Identical to the file above but for the vendor's name.
  const plain = f2(
    ["Student ID", "Student's Email", "Student First", "Student Last", "Graduating Class", "Highschool", "Cumulative GPA Weighted", "Unweighted GPA", "SAT Total Score", "ACT Composite Score", "Intended Major(s)"],
    [["c1", "jane@x.org", "Jane", "Doe", "2027", "Lincoln High School", "4.1", "3.8", "1450", "32", "Biology"]]
  );
  const sheet = presetSheetsFor(plain)[0];
  assert.deepEqual(sheet.columns.map((c) => headerOf(plain, c.index)), ["Unweighted GPA"]);
  assert.ok(sheet.columns.every((c) => c.source === "preset"));
  assert.equal(presetPlan([plain]).sourceSystem, "unknown");
});

test("counselmore is detected from its name, with or without a space", () => {
  assert.equal(detectSourceSystem(["Counselmore Student ID", "Email"]), "counselmore");
  assert.equal(detectSourceSystem(["Counsel More ID"]), "counselmore");
  assert.equal(detectSourceSystem(["College Planner Pro ID"]), "collegeplannerpro");
  assert.equal(detectSourceSystem(["CPP ID", "Email"]), "collegeplannerpro");
  const cm = f2(["Counselmore ID", "Student's Name", "GPA (UW)", "Hrs/Wk", "Activity"], [["m1", "Jane Doe", "3.8", "5", "Chess"]]);
  const cols = byHeader(cm);
  assert.equal(cols.get("Student's Name")?.source, "preset-unverified");
  assert.equal(cols.get("GPA (UW)")?.source, "preset-unverified");
  assert.equal(cols.get("Hrs/Wk")?.source, "preset-unverified", "a row part survives because its Activity column is mapped");
  assert.equal(cols.get("Activity")?.source, "preset");
  assert.equal(presetPlan([cm]).sourceSystem, "counselmore");
});

test("a vendor's row part without its required part is still dropped", () => {
  const cm = f2(["Counselmore ID", "Student's Name", "Hrs/Wk"], [["m1", "Jane Doe", "5"]]);
  assert.equal(byHeader(cm).has("Hrs/Wk"), false, "hours without an activity name would be an orphan row");
});

test("the vendor is read per file: another file in the same import is not guessed at", () => {
  const FILE_B = "22222222-2222-4222-8222-222222222222";
  const cpp = f2(["College Planner Pro ID", "Student's Email", "Student First"], [["c1", "a@b.co", "Jane"]]);
  const other = f2(["Student's Email", "Student First"], [["a@b.co", "Jane"]], FILE_B);
  assert.equal(presetSheetsFor(cpp)[0].columns.length, 2);
  assert.equal(presetSheetsFor(other)[0].columns.length, 0, "no vendor in this file's headers");
  const plan = presetPlan([cpp, other]);
  assert.equal(plan.sourceSystem, "collegeplannerpro", "the plan names the vendor any file names");
  assert.deepEqual(plan.sheets.map((s) => s.columns.length), [2, 0]);
});

test("a vendor's table is consulted before the generic one", () => {
  // An invented table, only to prove the order: the real tables never override a generic alias.
  const tables: VendorPresets = {
    counselmore: [
      [/^gpa$/, { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
      [/^weighted gpa$/, { kind: "field", table: "student_academics", field: "gpa_unweighted" }],
    ],
  };
  assert.deepEqual(vendorTarget("GPA", "counselmore", tables), { kind: "field", table: "student_academics", field: "gpa_unweighted" });
  assert.equal(vendorTarget("GPA", "collegeplannerpro", tables), null);
  const named = f2(["Counselmore ID", "Email", "GPA", "Weighted GPA"], [["m1", "a@b.co", "3.8", "4.1"]]);
  const withVendor = presetSheetsFor(named, tables)[0].columns;
  assert.deepEqual(withVendor.map((c) => [c.index, c.target.kind === "field" ? c.target.field : c.target.kind, c.source]), [
    [1, "key", "preset"],
    [2, "gpa_unweighted", "preset-unverified"],
    [3, "gpa_unweighted", "preset-unverified"],
  ], "the vendor's reading wins over the generic one for Weighted GPA");
  const unnamed = f2(["Email", "GPA", "Weighted GPA"], [["a@b.co", "3.8", "4.1"]]);
  assert.deepEqual(presetSheetsFor(unnamed, tables)[0].columns.map((c) => c.source), ["preset", "preset"], "no vendor, no override");
});

test("the real vendor tables exist only for the two tools named, and never contradict a generic alias", () => {
  assert.deepEqual(Object.keys(VENDOR_PRESETS).sort(), ["collegeplannerpro", "counselmore"]);
  for (const [vendor, table] of Object.entries(VENDOR_PRESETS)) {
    assert.ok((table?.length ?? 0) > 0, vendor);
    for (const [, target] of table ?? []) {
      assert.ok(["key", "field", "row"].includes(target.kind), "a vendor alias is never a guess at an exam score column or an ignore");
    }
  }
});

test("a preset-unverified mapping is a valid plan, kept by validatePlan and a saved template", () => {
  const cpp = f2(["College Planner Pro ID", "Student's Email", "Cumulative GPA Weighted"], [["c1", "jane@x.org", "4.1"]]);
  const plan: ParsePlan = presetPlan([cpp]);
  assert.ok(plan.sheets[0].columns.every((c) => c.source === "preset-unverified"));
  assert.ok(parsePlanSchema.safeParse(plan).success, "the API stores it");
  const check = validatePlan(plan, [cpp], FIELDS);
  assert.deepEqual(check.problems, []);
  assert.ok(check.plan.sheets[0].columns.every((c) => c.source === "preset-unverified"));
  const again = planFromTemplate(templateFrom(plan, cpp), cpp);
  assert.ok(again?.[0].columns.every((c) => c.source === "template"), "a layout the counselor remembered reads as their template, not as a guess");
  assert.equal(parsePlanSchema.safeParse({ ...plan, sheets: [{ ...plan.sheets[0], columns: [{ ...plan.sheets[0].columns[0], source: "vendor" }] }] }).success, false, "an unknown source is still refused");
});

test("generic behaviour is unchanged when no vendor is named", () => {
  const plan = presetPlan([roster]);
  assert.equal(plan.sourceSystem, "unknown");
  assert.ok(plan.sheets[0].columns.every((c) => c.source === "preset"));
  assert.deepEqual(presetSheetsFor(roster), plan.sheets);
});
