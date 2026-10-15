import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCell, excelSerialToIso, parseDate, parseNumber, testKindOf, valueOk } from "../../src/lib/imports/values.js";

// The same cases as test/integration/imports-values.test.mjs runs against
// private.import_value_ok: the TypeScript mirror must agree with the SQL.
test("valueOk mirrors private.import_value_ok", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["gpa", 3.85, true], ["gpa", 92, true], ["gpa", "3.8", false], ["gpa", 120, false],
    ["sat_total", 1450, true], ["sat_total", 1455.5, false], ["sat_section", 900, false],
    ["act_composite", 36, true], ["date", "2008-02-29", true], ["date", "2007-02-29", false],
    ["email", "a@b.co", true], ["email", "not-an-email", false],
    ["text:20", "4.0", true], ["text:20", "x".repeat(21), false],
    ["enum:gender", "female", true], ["enum:gender", "f", false],
    ["text[]", ["Biology", "Math"], true], ["text[]", ["", "Math"], false],
    ["bool", true, true], ["bool", "yes", false],
    ["row:test_score", { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" }, true],
    ["row:test_score", { exam: "SAT", kind: "sat", score: "1450" }, true],
    ["row:test_score", { exam: "SAT", kind: "sat", ssn: "123-45-6789" }, false],
    ["row:course", { name: "AP Chemistry", type: "ap", grade: "A-", status: "completed", school_year: "2024-25" }, true],
    ["row:activity", { name: "Robotics", position: "Captain", hours_per_week: 6, weeks_per_year: 30 }, true],
    ["row:activity", { name: "Robotics", hours_per_week: 200 }, false],
    ["enum:gender", 5, false], ["row:test_score", { exam: "SAT" }, false],
    ["row:test_score", { exam: "SAT", kind: 5 }, false], ["row:course", { name: "x", type: 5 }, false],
    ["anything", "x", false], ["gpa", null, false],
  ];
  for (const [type, v, want] of cases) assert.equal(valueOk(type, v as never), want, `${type} ${JSON.stringify(v)}`);
});

test("numbers: thousands separators, percent, comma decimals only when asked", () => {
  assert.equal(parseNumber("1,450"), 1450);
  assert.equal(parseNumber("92%"), 92);
  assert.equal(parseNumber(" 3.80 "), 3.8);
  assert.equal(parseNumber("3,8"), null);
  assert.equal(parseNumber("3,8", true), 3.8);
  assert.equal(parseNumber("12abc"), null);
});

test("GPA keeps its own scale: 3.8/4.0 is 3.8 on the 4.0 scale, 92 stays 92", () => {
  assert.deepEqual(cleanCell("gpa", "3.8/4.0"), { ok: true, value: 3.8, scale: "4.0" });
  assert.deepEqual(cleanCell("gpa", "4.3 out of 5"), { ok: true, value: 4.3, scale: "5" });
  assert.deepEqual(cleanCell("gpa", "92"), { ok: true, value: 92 });
  assert.deepEqual(cleanCell("gpa", "A"), { ok: false });
});

test("scores must be whole numbers in range", () => {
  assert.deepEqual(cleanCell("sat_total", "1,480"), { ok: true, value: 1480 });
  assert.deepEqual(cleanCell("sat_total", "1700"), { ok: false });
  assert.deepEqual(cleanCell("act_composite", "33"), { ok: true, value: 33 });
});

test("dates: ISO always, slashes by the plan's order, month names, Excel serials", () => {
  assert.equal(parseDate("2008-01-05", "DMY"), "2008-01-05");
  assert.equal(parseDate("03/04/2008", "MDY"), "2008-03-04");
  assert.equal(parseDate("03/04/2008", "DMY"), "2008-04-03");
  assert.equal(parseDate("13/04/2008", "MDY"), null);
  assert.equal(parseDate("1/5/08", undefined), "2008-01-05");
  assert.equal(parseDate("Jan 5, 2008", undefined), "2008-01-05");
  assert.equal(parseDate("5 January 2008", undefined), "2008-01-05");
  assert.equal(parseDate("39448", "excel1900"), "2008-01-01");
  assert.equal(parseDate("37986", "excel1904"), "2008-01-01");
  assert.equal(parseDate("39448", undefined), null);
});

test("Excel's phantom 29 February 1900 is accounted for", () => {
  assert.equal(excelSerialToIso(1, "excel1900"), "1900-01-01");
  assert.equal(excelSerialToIso(59, "excel1900"), "1900-02-28");
  assert.equal(excelSerialToIso(61, "excel1900"), "1900-03-01");
  assert.equal(excelSerialToIso(0, "excel1904"), null);
  assert.equal(excelSerialToIso(1, "excel1904"), "1904-01-02");
});

test("yes/no, enums and lists", () => {
  assert.deepEqual(cleanCell("bool", "Yes"), { ok: true, value: true });
  assert.deepEqual(cleanCell("bool", "n"), { ok: true, value: false });
  assert.deepEqual(cleanCell("bool", "maybe"), { ok: false });
  assert.deepEqual(cleanCell("enum:gender", "F"), { ok: true, value: "female" });
  assert.deepEqual(cleanCell("enum:citizenship", "Green card"), { ok: true, value: "permanent-resident" });
  assert.deepEqual(cleanCell("enum:test_status", "Test Optional"), { ok: true, value: "test-optional" });
  assert.deepEqual(cleanCell("text[]", "Biology; Computer Science"), { ok: true, value: ["Biology", "Computer Science"] });
  assert.deepEqual(cleanCell("text:20", "  4.0  "), { ok: true, value: "4.0" });
});

test("a test's kind comes from its name", () => {
  assert.equal(testKindOf("AP Biology"), "ap");
  assert.equal(testKindOf("IB Math HL"), "ib");
  assert.equal(testKindOf("SAT"), "sat");
  assert.equal(testKindOf("PSAT/NMSQT"), "other");
  assert.equal(testKindOf("ACT Composite"), "act");
  assert.equal(testKindOf("Duolingo"), "other");
});
