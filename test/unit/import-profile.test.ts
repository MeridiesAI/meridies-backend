import assert from "node:assert/strict";
import { test } from "node:test";
import { headerLooksLikeName, maskHeader, maskValue } from "../../src/lib/imports/mask.js";
import { fingerprintOf, isWide, modelView, profileColumn, profileSheet } from "../../src/lib/imports/profile.js";
import { blockValue, flagValue, forceIgnore, sensitiveHeader } from "../../src/lib/imports/sensitive.js";
import type { ParsedSheet } from "../../src/lib/imports/sheet.js";

// --- masking ---------------------------------------------------------------

test("cells become shapes", () => {
  assert.equal(maskValue("jane.doe@gmail.com"), "<email>");
  assert.equal(maskValue("2008-01-05"), "<date>");
  assert.equal(maskValue("1/5/2008"), "<date>");
  assert.equal(maskValue("Jan 5, 2008"), "<date>");
  assert.equal(maskValue("(555) 123-4567"), "<phone>");
  assert.equal(maskValue("1450"), "<number, 4 digits>");
  assert.equal(maskValue("3.85"), "<decimal, 1 digit . 2>");
  assert.equal(maskValue("92%"), "<number, 2 digits percent>");
  assert.equal(maskValue("3.8/4.0"), "<number>/<number>");
  assert.equal(maskValue("Jane Doe"), "<text, 2 words, capitalized>");
  assert.equal(maskValue("123 Main St"), "<text, 3 words, capitalized, with digits>");
  assert.equal(maskValue(""), "<empty>");
});

test("generic domain words pass through; nothing personal does", () => {
  assert.equal(maskValue("Yes"), "yes");
  assert.equal(maskValue("AP"), "ap");
  assert.equal(maskValue("A-"), "a-");
  assert.equal(maskValue("In Progress"), "in progress");
  // Gender and citizenship values are personal data: shapes only.
  assert.equal(maskValue("Female"), "<text, 1 word, capitalized>");
  assert.equal(maskValue("US Citizen"), "<text, 2 words, capitalized>");
});

test("no real value survives masking", () => {
  const secrets = ["Jane Doe", "jane@x.org", "Lincoln High School", "123 Main St, Springfield", "Robotics captain", "1450", "3.85", "2008-01-05", "555-123-4567", "Doe, Jane", "José García-López"];
  for (const s of secrets) {
    const m = maskValue(s);
    for (const word of s.split(/[\s,@.-]+/).filter((w) => w.length >= 3)) {
      assert.ok(!m.toLowerCase().includes(word.toLowerCase()), `${s} leaked ${word} as ${m}`);
    }
  }
});

test("headers that look like people's names are masked; real headers aren't", () => {
  assert.equal(headerLooksLikeName("Jane Doe"), true);
  assert.equal(headerLooksLikeName("Doe, Jane"), true);
  assert.equal(headerLooksLikeName("First Name"), false);
  assert.equal(headerLooksLikeName("GPA Weighted"), false);
  assert.equal(headerLooksLikeName("AP Biology"), false);
  assert.equal(headerLooksLikeName("Class of 2027"), false);
  assert.equal(maskHeader("Jane Doe"), "<name>");
  assert.equal(maskHeader("jane@x.org"), "<email>");
  assert.equal(maskHeader("SAT Math"), "SAT Math");
});

test("a file with no header row: the first student's row reaches the model only as shapes", () => {
  // findHeaderRow takes the first row with two cells, so this row is the "headers".
  const first = ["jane doe", "2008-05-14", "(555) 123-4567", "12 Oak Lane", "jane.doe", "Okafor"];
  const sheet: ParsedSheet = {
    name: "S", headerRow: 1, date1904: false, headers: first, rowNumbers: [2, 3],
    rows: [["john roe", "2007-11-02", "(555) 987-6543", "4 Elm Street", "john.roe", "Smith"], ["ann lee", "2008-01-30", "(555) 222-3333", "9 Pine Road", "ann.lee", "Park"]],
  };
  const view = JSON.stringify(modelView(profileSheet(sheet), 1));
  for (const v of first) assert.ok(!view.toLowerCase().includes(v.toLowerCase()), `${v} reached the model view`);
  assert.deepEqual(modelView(profileSheet(sheet), 1).columns.map((c) => c.header), [
    "<text, 2 words, lowercase>", "<date>", "<phone>", "<text, 3 words, capitalized, with digits>", "<text, 1 word, lowercase>", "<text, 1 word, capitalized>",
  ]);
  // One value-shaped cell is masked on its own, even when the rest read as labels.
  assert.equal(maskHeader("555-123-4567"), "<phone>");
  assert.equal(maskHeader("12/3/2008"), "<date>");
  assert.equal(maskHeader("jane", ["<text, 1 word, lowercase>"]), "<text, 1 word, lowercase>");
});

test("real headers still reach the model as written", () => {
  const sheet: ParsedSheet = {
    name: "S", headerRow: 1, date1904: false, rowNumbers: [2],
    headers: ["Student Name", "Email", "Grad Year", "SAT Math", "AP Biology 2024", "Unweighted GPA", "Hometown", "Mascot"],
    rows: [["Jane Doe", "jane@x.org", "2027", "700", "5", "3.9", "Boston", "Tigers"]],
  };
  const headers = modelView(profileSheet(sheet), 1).columns.map((c) => c.header);
  assert.deepEqual(headers.slice(0, 7), ["Student Name", "Email", "Grad Year", "SAT Math", "AP Biology 2024", "Unweighted GPA", "Hometown"]);
  // A header that isn't a label and has the shape of its column is masked; the rest of the row stays readable.
  assert.equal(headers[7], "<text, 1 word, capitalized>");
});

// --- sensitive values (§7.4) ---------------------------------------------------

test("never-stored categories are recognised by header", () => {
  for (const [h, cat] of [
    ["SSN", "government-id"], ["Social Security #", "government-id"], ["Passport No", "government-id"],
    ["Driver's License", "government-id"], ["A-Number", "government-id"], ["Family Income", "financial"],
    ["Bank Account Number", "financial"], ["IEP", "health"], ["504 Plan", "health"], ["Accommodations", "health"],
    ["Diagnosis", "health"], ["Medications", "health"], ["Discipline Notes", "discipline"], ["Suspensions", "discipline"],
    ["Free/Reduced Lunch", "economic-status"], ["Fee Waiver", "economic-status"], ["Religion", "beliefs-identity"],
    ["Race/Ethnicity", "beliefs-identity"], ["Password", "login-secret"], ["Security Answer", "login-secret"],
  ] as const) {
    assert.equal(sensitiveHeader(h), cat, h);
    assert.ok(forceIgnore(h));
  }
});

test("ordinary headers are not sensitive", () => {
  for (const h of ["First Name", "Email", "GPA (Weighted)", "SAT Math", "Social Studies Grade", "Activity", "Hours per week", "Class Rank", "Gender", "Citizenship", "Student ID"]) {
    assert.equal(sensitiveHeader(h), null, h);
  }
});

test("SSN-shaped values are always blocked; a 9-digit ID is flagged, not blocked", () => {
  assert.equal(blockValue("123-45-6789", "Notes"), true);
  assert.equal(blockValue("my ssn is 123-45-6789 ok", "Description"), true);
  assert.equal(blockValue("123456789", "SSN"), true);
  assert.equal(blockValue("123456789", "Student ID"), false);
  assert.equal(flagValue("123456789", "Student ID"), true);
  assert.equal(flagValue("123456789", "SSN"), false);
  assert.equal(flagValue("12345678", "Student ID"), false);
});

// --- profile ---------------------------------------------------------------------

test("min and max only for small numbers; text and IDs give shapes only", () => {
  const gpa = profileColumn("GPA", 0, ["3.8", "4.1", "", "2.9"]);
  assert.equal(gpa.min, 2.9);
  assert.equal(gpa.max, 4.1);
  assert.equal(gpa.pctEmpty, 25);
  const ids = profileColumn("Student ID", 1, ["123456789", "987654321"]);
  assert.equal(ids.min, null);
  assert.equal(ids.max, null);
  const names = profileColumn("Name", 2, ["Zed Zulu", "Amy Adams"]);
  assert.equal(names.min, null);
  assert.equal(names.max, null);
  assert.ok(!JSON.stringify(names).includes("Zulu") && !JSON.stringify(names).includes("Adams"));
});

test("date hints: day over 12 in either position, Excel serials, year range only", () => {
  const dmy = profileColumn("DOB", 0, ["25/12/2008", "03/04/2009"]);
  assert.equal(dmy.dateHints.firstOver12, true);
  assert.equal(dmy.dateHints.secondOver12, false);
  assert.equal(dmy.yearMin, 2008);
  assert.equal(dmy.yearMax, 2009);
  assert.ok(!JSON.stringify(dmy).includes("25/12"));
  const serial = profileColumn("Birthday", 1, ["39448", "39500"]);
  assert.equal(serial.dateHints.excelSerial, true);
});

test("a sheet of students as columns is wide", () => {
  assert.equal(isWide(["Subject", "Jane Doe", "John Roe", "Ann Lee"], 10), true);
  assert.equal(isWide(Array.from({ length: 30 }, (_, i) => `Q${i}`), 4), true);
  assert.equal(isWide(["Name", "Email", "GPA"], 2), false);
});

test("the fingerprint is the normalized headers, in order", () => {
  assert.equal(fingerprintOf([["First Name", "GPA"]]), fingerprintOf([["  first   name", "gpa "]]));
  assert.notEqual(fingerprintOf([["First Name", "GPA"]]), fingerprintOf([["GPA", "First Name"]]));
});

test("the model's view carries no real cell value, no sheet name and no sensitive column", () => {
  const sheet: ParsedSheet = {
    name: "Jane Doe grades",
    headerRow: 1,
    headers: ["Student", "Email", "SSN", "GPA", "Notes"],
    rows: [
      ["Jane Doe", "jane@x.org", "123-45-6789", "3.85", "Loves robotics at Lincoln High"],
      ["John Roe", "john@x.org", "987-65-4321", "3.10", "Plays violin"],
    ],
    rowNumbers: [2, 3],
    date1904: false,
  };
  const view = JSON.stringify(modelView(profileSheet(sheet), 1));
  for (const leak of ["Jane", "Doe", "jane@x.org", "John", "123-45", "Lincoln", "robotics", "violin", "SSN", "grades"]) {
    assert.ok(!view.includes(leak), `leaked ${leak}: ${view}`);
  }
  assert.ok(view.includes('"min":3.1'));
});
