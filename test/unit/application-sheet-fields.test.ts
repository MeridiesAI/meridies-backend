import assert from "node:assert/strict";
import { test } from "node:test";
import { activityBody, honorBody } from "../../src/routes/application.js";
import { toSheetActivity, toSheetHonor } from "../../src/lib/studentApplication.js";

/**
 * Every cell of the Activities and Awards & Honors sheets saves one field
 * (meridies-app components/student/ApplicationSheets.tsx). Each patch the app
 * sends must pass the route's strict body, and the column it writes must come
 * back on the sheet's DTO under the key the cell reads. A cell whose patch was
 * refused, or whose column the DTO doesn't read, looks saved and is gone after
 * a refresh (QA: "half the information goes away on refresh").
 */

type Case = { column: string; value: unknown; dto: string; expect?: unknown };

// The app's cells: [patch column, a value the app sends, DTO key the cell reads].
const ACTIVITY_CELLS: Case[] = [
  { column: "category", value: "Community Service (Volunteer)", dto: "category" },
  { column: "grade_levels", value: ["11", "12"], dto: "gradeLevels" },
  { column: "timing", value: ["school"], dto: "timing", expect: "school" },
  { column: "timing", value: ["break"], dto: "timing", expect: "break" },
  { column: "timing", value: ["year"], dto: "timing", expect: "year" },
  { column: "hours_per_week", value: 4, dto: "hoursPerWeek" },
  { column: "hours_per_week", value: 2.5, dto: "hoursPerWeek" },
  { column: "weeks_per_year", value: 40, dto: "weeksPerYear" },
  { column: "position", value: "Captain", dto: "position" },
  { column: "organization", value: "Tejas Robotics", dto: "organization" },
  { column: "description", value: "Ran weekly build sessions.\nMentored new members.", dto: "description" },
  { column: "uc_category", value: "volunteer", dto: "ucCategory" },
  { column: "uc_org_description", value: "A food bank in Austin", dto: "ucOrgDescription" },
  { column: "uc_description", value: "Sorted donations every Saturday", dto: "ucDescription" },
];

// Every category the app's dropdown offers (lib/applicationSheets.ts ACTIVITY_TYPES).
const APP_ACTIVITY_TYPES = [
  "Academic", "Art", "Athletics: Club", "Athletics: JV/Varsity", "Career-Oriented",
  "Community Service (Volunteer)", "Computer/Technology", "Cultural", "Dance", "Debate/Speech",
  "Environmental", "Family Responsibilities", "Foreign Exchange", "Journalism/Publication",
  "Junior R.O.T.C.", "LGBT", "Music: Instrumental", "Music: Vocal", "Religious", "Research",
  "Robotics", "School Spirit", "Science/Math", "Student Govt./Politics", "Theater/Drama",
  "Work (paid)", "Other Club/Activity",
];

const HONOR_CELLS: Case[] = [
  { column: "name", value: "National Merit Semifinalist", dto: "title" },
  { column: "grade_levels", value: ["12"], dto: "gradeLevels" },
  { column: "recognition_levels", value: ["national", "state-regional"], dto: "recognitionLevels" },
  { column: "uc_type", value: "academic", dto: "ucType" },
  { column: "uc_level", value: "city-community", dto: "ucLevel" },
  { column: "uc_criteria", value: "Top 1% of PSAT takers", dto: "ucEligibility" },
  { column: "uc_earned", value: "Studied every weekend", dto: "ucAchievement" },
];

const base = { id: "11111111-1111-1111-1111-111111111111", student_id: "22222222-2222-2222-2222-222222222222", sort_order: 0 };

test("every Activities cell's patch is accepted and reads back under the key the cell shows", () => {
  for (const c of ACTIVITY_CELLS) {
    const parsed = activityBody.parse({ [c.column]: c.value }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [c.column], `${c.column}: the body kept the field`);
    // What the database holds after the update, read back as the sheet reads it.
    const dto = toSheetActivity({ ...base, ...parsed }) as Record<string, unknown>;
    assert.deepEqual(dto[c.dto], c.expect ?? c.value, `${c.column} reads back as ${c.dto}`);
  }
});

test("every category the app offers is accepted", () => {
  for (const category of APP_ACTIVITY_TYPES) {
    assert.deepEqual(activityBody.parse({ category }), { category });
    assert.equal(toSheetActivity({ ...base, category }).category, category);
  }
});

test("a cell cleared back to empty saves as empty", () => {
  for (const column of ["category", "position", "organization", "description", "uc_category", "hours_per_week", "weeks_per_year"]) {
    assert.deepEqual(activityBody.parse({ [column]: null }), { [column]: null });
  }
  assert.deepEqual(activityBody.parse({ timing: [] }), { timing: [] });
});

test("the questionnaire's capitalised timing still reads as the app's value", () => {
  assert.equal(toSheetActivity({ ...base, timing: ["School"] }).timing, "school");
});

test("every Awards & Honors cell's patch is accepted and reads back under the key the cell shows", () => {
  for (const c of HONOR_CELLS) {
    const parsed = honorBody.parse({ [c.column]: c.value }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [c.column], `${c.column}: the body kept the field`);
    const dto = toSheetHonor({ ...base, ...parsed }) as Record<string, unknown>;
    assert.deepEqual(dto[c.dto], c.expect ?? c.value, `${c.column} reads back as ${c.dto}`);
  }
});

test("an unknown key is refused rather than silently dropped", () => {
  assert.throws(() => activityBody.parse({ when: "school" }));
  assert.throws(() => honorBody.parse({ title: "x" }));
});
