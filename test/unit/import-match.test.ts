import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRecords, schoolMatch, toPayload, type RosterStudent } from "../../src/lib/imports/match.js";
import type { ParsePlan } from "../../src/lib/imports/plan.js";
import { applyPlan, columnLetter, type ParsedFile } from "../../src/lib/imports/rows.js";
import type { ParsedSheet } from "../../src/lib/imports/sheet.js";
import { FIELDS } from "./import-fixtures.js";

const FILE = "11111111-1111-4111-8111-111111111111";
const sheet = (headers: string[], rows: string[][], name = "Roster"): ParsedSheet => ({
  name, headerRow: 1, headers, rows, rowNumbers: rows.map((_, i) => i + 2), date1904: false,
});
const file = (s: ParsedSheet): ParsedFile => ({ fileId: FILE, filename: "r.csv", sheets: [s] });
type Col = ParsePlan["sheets"][0]["columns"][0];
const plan = (columns: Col[], constants: ParsePlan["constants"] = {}): ParsePlan => ({
  version: 1, sheets: [{ fileId: FILE, sheet: "Roster", columns }], constants, sourceSystem: "unknown",
});
const k = (index: number, key: "email" | "full_name" | "first_name" | "last_name" | "grad_year" | "high_school"): Col => ({ index, target: { kind: "key", key }, source: "counselor" });
const fld = (index: number, table: "student_academics" | "student_personal_details", field: string): Col => ({ index, target: { kind: "field", table, field }, source: "counselor" });

const roster: RosterStudent[] = [
  { id: "s-jane", name: "Jane Doe", email: "jane@x.org", gradYear: "2027", highSchool: "Lincoln High School", birthday: "2009-03-04", archived: false },
  { id: "s-rob", name: "Robert Smith", email: "rob@x.org", gradYear: "2027", highSchool: "Lincoln High School", birthday: null, archived: false },
  { id: "s-ann", name: "Ann Lee", email: "ann.lee@x.org", gradYear: "2028", highSchool: "Roosevelt Academy", birthday: "2010-01-01", archived: false },
  { id: "s-old", name: "Old Student", email: "old@x.org", gradYear: "2020", highSchool: null, birthday: null, archived: true },
];

test("column letters", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
});

test("rows become records: keys, cleaned values, source refs and pattern keys", () => {
  const out = applyPlan(
    plan([k(0, "email"), k(1, "full_name"), fld(2, "student_academics", "gpa_weighted"), fld(3, "student_personal_details", "birthday"), k(4, "grad_year")]),
    [file(sheet(["Email", "Name", "W GPA", "DOB", "Class"], [["JANE@X.ORG", "Jane Doe", "4.1/5", "3/4/2009", "Class of 2027"]]))],
    FIELDS
  );
  assert.equal(out.rows, 1);
  const r = out.records[0];
  assert.deepEqual(r.key, { email: "jane@x.org", name: "Jane Doe", birthday: "2009-03-04", gradYear: 2027, highSchool: null });
  const gpa = r.values.find((v) => v.field === "gpa_weighted")!;
  assert.equal(gpa.value, 4.1);
  assert.equal(gpa.sourceRef, "Roster!C2");
  assert.equal(gpa.patternKey, "student_academics.gpa_weighted|Roster!C");
  assert.deepEqual(r.values.find((v) => v.field === "gpa_scale")?.value, "5", "the scale written in the cell is kept");
});

test("a GPA scale constant is recorded beside each GPA, never applied to the number", () => {
  const out = applyPlan(plan([k(0, "email"), fld(1, "student_academics", "gpa_unweighted")], { gpaScale: "100" }), [file(sheet(["Email", "GPA"], [["a@b.co", "93"]]))], FIELDS);
  const vals = Object.fromEntries(out.records[0].values.map((v) => [v.field, v.value]));
  assert.deepEqual(vals, { gpa_unweighted: 93, gpa_scale: "100" });
});

test("a value that won't clean is kept for a fix; an SSN is dropped and counted; a 9-digit ID is flagged", () => {
  const out = applyPlan(
    plan([k(0, "email"), fld(1, "student_academics", "sat_superscore"), fld(2, "student_academics", "class_rank")]),
    [file(sheet(["Email", "SAT", "Rank"], [["a@b.co", "about 1400", "123-45-6789"], ["c@d.co", "1400", "123456789"]]))],
    FIELDS
  );
  const [a, b] = out.records;
  assert.deepEqual(a.values.map((v) => [v.field, v.invalid, v.value]), [["sat_superscore", true, "about 1400"]]);
  assert.equal(out.blocked, 1);
  assert.deepEqual(b.values.find((v) => v.field === "class_rank")?.flags, ["nine_digit_id"]);
});

test("long-format rows build test scores, courses and activities; score columns too", () => {
  const out = applyPlan(
    plan([
      k(0, "email"), k(1, "full_name"),
      { index: 2, target: { kind: "row", table: "test_scores", group: "1", part: "exam" }, source: "counselor" },
      { index: 3, target: { kind: "row", table: "test_scores", group: "1", part: "score" }, source: "counselor" },
      { index: 4, target: { kind: "row", table: "test_scores", group: "1", part: "taken_on" }, source: "counselor" },
      { index: 5, target: { kind: "score_column", exam: "AP Biology", testKind: "ap" }, source: "preset" },
    ]),
    [file(sheet(["Email", "Name", "Test", "Score", "Date", "AP Biology"], [["a@b.co", "A B", "SAT", "1450", "2025-03-08", "5"], ["a@b.co", "A B", "ACT", "33", "June 7, 2025", ""]]))],
    FIELDS
  );
  const rows = out.records.flatMap((r) => r.values.filter((v) => v.op === "insert_row").map((v) => v.value));
  assert.deepEqual(rows, [
    { exam: "AP Biology", kind: "ap", score: "5" },
    { exam: "SAT", score: "1450", taken_on: "2025-03-08", kind: "sat" },
    { exam: "ACT", score: "33", taken_on: "2025-06-07", kind: "act" },
  ]);
});

test("template drift: 20% or more of the mapped cells failing on a template file", () => {
  const p = plan([k(0, "email"), fld(1, "student_academics", "sat_superscore")]);
  const bad = file(sheet(["Email", "SAT"], [["a@b.co", "x"], ["b@b.co", "y"], ["c@b.co", "1400"], ["d@b.co", "1300"], ["e@b.co", "1200"]]));
  assert.deepEqual(applyPlan(p, [bad], FIELDS, new Set([FILE])).drift, [FILE]);
  assert.deepEqual(applyPlan(p, [bad], FIELDS).drift, [], "only a template's file can drift");
});

// --- matching -------------------------------------------------------------------

function itemsFor(rows: string[][], headers = ["Email", "Name", "GPA", "DOB", "Class", "School"]) {
  const p = plan([k(0, "email"), k(1, "full_name"), fld(2, "student_academics", "gpa_weighted"), fld(3, "student_personal_details", "birthday"), k(4, "grad_year"), k(5, "high_school")]);
  return matchRecords(applyPlan(p, [file(sheet(headers, rows))], FIELDS).records, roster);
}

test("email and a matching name (nicknames too) is matched", () => {
  const [a, b] = itemsFor([["jane@x.org", "Jane Doe", "4.0", "", "", ""], ["rob@x.org", "Bob Smith", "3.5", "", "", ""]]);
  assert.equal(a.matchStatus, "matched_email");
  assert.equal(a.studentId, "s-jane");
  assert.equal(a.confidence, "high");
  assert.equal(b.matchStatus, "matched_email");
  assert.equal(b.studentId, "s-rob");
});

test("email match with a different name is a low-confidence suggestion, never a match", () => {
  const [a] = itemsFor([["jane@x.org", "John Doe", "4.0", "", "", ""]]);
  assert.equal(a.matchStatus, "suggested");
  assert.equal(a.confidence, "low");
  assert.equal(a.studentId, null);
  assert.deepEqual(a.reasons, ["email", "name_mismatch"]);
  assert.deepEqual(a.candidates.map((c) => c.id), ["s-jane"]);
});

test("siblings on a parent's email are never merged, matched or invited on their own", () => {
  const items = itemsFor([["parent@x.org", "Mia Park", "3.9", "", "", ""], ["parent@x.org", "Leo Park", "3.1", "", "", ""]]);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.matchStatus === "skipped" && i.flags.includes("shared_email")));
  const onRoster = itemsFor([["jane@x.org", "Jane Doe", "3.9", "", "", ""], ["jane@x.org", "Jill Doe", "3.1", "", "", ""]]);
  assert.ok(onRoster.every((i) => i.matchStatus === "suggested" && i.reasons.includes("shared_email")));
});

test("a long-format file merges one student's rows into one item; disagreeing values conflict", () => {
  const items = itemsFor([["jane@x.org", "Jane Doe", "4.0", "", "", ""], ["jane@x.org", "Jane Doe", "4.2", "", "", ""], ["jane@x.org", "Jane Doe", "4.0", "", "", ""]]);
  assert.equal(items.length, 1);
  const gpa = items[0].changes.find((c) => c.field === "gpa_weighted")!;
  assert.ok(gpa.flags.includes("conflict_in_file"));
  assert.deepEqual(gpa.alternatives?.map((a) => a.value), [4, 4.2]);
});

test("fallbacks only suggest: name + birthday + school, or name + grad year + school", () => {
  const [byBirthday] = itemsFor([["jane.doe@gmail.com", "Jane Doe", "4.0", "2009-03-04", "", "Lincoln High School"]]);
  assert.equal(byBirthday.matchStatus, "suggested");
  assert.equal(byBirthday.confidence, "high");
  assert.deepEqual(byBirthday.candidates.map((c) => c.id), ["s-jane"]);
  const [byYear] = itemsFor([["", "Ann Lee", "3.0", "", "2028", "Roosevelt Acad."]]);
  assert.equal(byYear.matchStatus, "suggested");
  assert.equal(byYear.confidence, "medium");
  const [noSchool] = itemsFor([["", "Ann Lee", "3.0", "", "2028", ""]]);
  assert.equal(noSchool.matchStatus, "skipped", "a name and year alone never suggest");
});

test("initials never match", () => {
  const [a] = itemsFor([["jane@x.org", "J Doe", "4.0", "", "", ""]]);
  assert.equal(a.matchStatus, "suggested");
});

test("no match: an email is invited, no email is skipped; an archived student is skipped", () => {
  const [inv, skip, old] = itemsFor([["new@x.org", "New Kid", "3.0", "", "", ""], ["", "Nomail Kid", "3.0", "", "", ""], ["old@x.org", "Old Student", "3.0", "", "", ""]]);
  assert.equal(inv.matchStatus, "new_invite");
  assert.equal(skip.matchStatus, "skipped");
  assert.equal(skip.skipReason, "No email to invite");
  assert.equal(old.matchStatus, "skipped");
  assert.equal(old.skipReason, "This student is archived");
});

test("only the uploader's roster is matched: an unknown email is never matched to anyone", () => {
  const [a] = matchRecords(applyPlan(plan([k(0, "email"), k(1, "full_name"), fld(2, "student_academics", "gpa_weighted")]), [file(sheet(["Email", "Name", "GPA"], [["jane@x.org", "Jane Doe", "4"]]))], FIELDS).records, []);
  assert.equal(a.matchStatus, "new_invite");
});

test("school matching", () => {
  assert.equal(schoolMatch("Lincoln High School", "lincoln high school"), "exact");
  assert.equal(schoolMatch("Lincoln HS", "Lincoln High School"), "exact");
  assert.equal(schoolMatch("Roosevelt Acad.", "Roosevelt Academy"), "fuzzy");
  assert.equal(schoolMatch("Lincoln High", "Roosevelt High"), null);
  assert.equal(schoolMatch(null, "x"), null);
});

test("the payload leaves out the changes of rows nothing can be done with", () => {
  const items = itemsFor([["", "Nomail Kid", "3.0", "", "", ""], ["new@x.org", "New Kid", "3.0", "", "", ""]]);
  const p = toPayload(items, { rows: 2, blocked: 0 });
  assert.equal(p.items.length, 2);
  assert.deepEqual([...new Set(p.changes.map((c) => c.item))], [items[1].key]);
});
