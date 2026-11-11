// test/unit/activity-list-import.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityType, gradeList, mapHeaders, markOnSheet, sheetProposals } from "../../src/lib/activityListImport.js";
import { sortBytes } from "../../src/lib/documentSort.js";

const HEADERS = ["Activity type", "Position", "Organization", "Description", "Grades", "Hours per week", "Weeks per year"];
const ROWS = [
  ["Robotics", "Team Captain", "Westlake Robotics Club", "Led 14 students; built and drove the robot at state finals", "10, 11, 12", "8", "30"],
  ["community service", "Volunteer Tutor", "Austin Public Library", "Tutored six middle-school students in math every week", "9th-11th", "3", "40"],
  ["", "", "", "", "", "", ""],
  ["Varsity", "Varsity Runner", "Westlake Cross Country", "Ran varsity two seasons", "11 & 12", "10 hrs", "16"],
];

test("headers: the Common App's columns and the usual variants are recognized", () => {
  assert.deepEqual(mapHeaders(HEADERS), { category: 0, position: 1, organization: 2, description: 3, grades: 4, hours: 5, weeks: 6 });
  assert.deepEqual(mapHeaders(["Organization Name", "Role", "Hrs/wk", "Wks/yr", "Grade levels"]), {
    organization: 0,
    position: 1,
    hours: 2,
    weeks: 3,
    grades: 4,
  });
  // Without an organization or a position, or with only one known column, it isn't an activity list.
  assert.equal(mapHeaders(["Course", "Grade", "Credits"]), null);
  assert.equal(mapHeaders(["Name", "Email"]), null);
});

test("grades: lists, ranges, ordinals and PG", () => {
  assert.deepEqual(gradeList("10, 11, 12"), ["10", "11", "12"]);
  assert.deepEqual(gradeList("9th-11th"), ["9", "10", "11"]);
  assert.deepEqual(gradeList("Grades 9 and 12"), ["9", "12"]);
  assert.deepEqual(gradeList("11 & 12"), ["11", "12"]);
  assert.deepEqual(gradeList("PG"), ["PG"]);
  assert.deepEqual(gradeList(""), []);
});

test("activity type: exact, loose and unknown", () => {
  assert.equal(activityType("Robotics"), "Robotics");
  assert.equal(activityType("athletics: jv/varsity"), "Athletics: JV/Varsity");
  assert.equal(activityType("community service"), "Community Service (Volunteer)");
  assert.equal(activityType("Varsity"), "Athletics: JV/Varsity");
  assert.equal(activityType("Part-time job"), "Work (paid)");
  assert.equal(activityType("Something unusual"), null);
  assert.equal(activityType(""), null);
});

test("a sheet becomes checked proposals; blank rows are skipped and nothing is invented", () => {
  const out = sheetProposals([{ headers: HEADERS, rows: ROWS }]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    draft: {
      kind: "activity",
      category: "Robotics",
      position: "Team Captain",
      organization: "Westlake Robotics Club",
      description: "Led 14 students; built and drove the robot at state finals",
      hoursPerWeek: 8,
      weeksPerYear: 30,
      title: null,
      level: null,
      gradeLevels: ["10", "11", "12"],
    },
    missing: [],
  });
  assert.equal(out[1]!.draft.category, "Community Service (Volunteer)");
  assert.deepEqual(out[1]!.draft.gradeLevels, ["9", "10", "11"]);
  assert.equal(out[2]!.draft.hoursPerWeek, 10);
});

test("a title row above the header is skipped; a missing column is reported missing, not guessed", () => {
  const out = sheetProposals([
    { headers: ["Jordan's activities", "", ""], rows: [["Organization", "Position", "Hours per week"], ["Debate Team", "Captain", "6"]] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.draft.organization, "Debate Team");
  assert.deepEqual(out[0]!.missing, ["category", "description", "gradeLevels", "weeksPerYear"]);
});

test("descriptions are capped at the Common App's 150 characters", () => {
  const long = "Organized weekly tutoring sessions for younger students across three schools, recruited volunteers, wrote lesson plans and tracked progress every term";
  const out = sheetProposals([{ headers: ["Organization", "Description"], rows: [["Tutors United", long + " and more words beyond the limit"]] }]);
  assert.ok(out[0]!.draft.description!.length <= 150);
});

test("a sheet that isn't an activity list yields nothing (the caller falls back to AxIS)", () => {
  assert.deepEqual(sheetProposals([{ headers: ["Course", "Term", "Grade"], rows: [["AP Calculus", "Fall", "A"]] }]), []);
});

test("rows already on the sheet are marked, by organization and position", () => {
  const out = markOnSheet(sheetProposals([{ headers: HEADERS, rows: ROWS }]), [
    { organization: "westlake robotics club", position: "Team Captain" },
    { organization: "Austin Public Library", position: "Shelver" },
  ]);
  assert.deepEqual(out.map((p) => p.onSheet), [true, false, false]);
});

test("sortBytes reads a CSV's columns, and an empty body sorts by the name alone", async () => {
  const csv = new TextEncoder().encode(`${HEADERS.join(",")}\n${ROWS[0]!.join(",")}\n`);
  assert.equal((await sortBytes(csv, "my stuff.csv", "text/csv")).kind, "activity-list");
  const byName = await sortBytes(new Uint8Array(), "Jordan Lee Resume.pdf", "application/pdf");
  assert.deepEqual(byName, { kind: "resume", basis: "filename", matched: "resume", textFound: false, keepOut: false });
});
