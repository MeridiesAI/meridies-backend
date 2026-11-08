import assert from "node:assert/strict";
import { test } from "node:test";
import { hasActivityValue, mentionsIn, normalizeField, type Norm } from "../../src/lib/axis/drafts/normalize.js";
import { ACTIVITY_TYPES } from "../../src/lib/studentApplication.js";

const ok = (n: Norm<unknown>) => {
  assert.ok(n.ok, `expected a value, got ${n.ok ? "" : n.problem}`);
  return n.value;
};
const problem = (n: Norm<unknown>) => {
  assert.ok(!n.ok, `expected a problem, got ${JSON.stringify(n.ok && n.value)}`);
  return n.problem;
};

test("the 27 Common App activity types, in the app's order", () => {
  assert.equal(ACTIVITY_TYPES.length, 27);
  assert.equal(ACTIVITY_TYPES[0], "Academic");
  assert.equal(ACTIVITY_TYPES[26], "Other Club/Activity");
});

test("grades: numbers, ordinals, class names, ranges and whole spans", () => {
  const cases: [unknown, string[]][] = [
    [11, ["11"]], ["11", ["11"]], ["11th", ["11"]], ["eleventh", ["11"]], ["sophomore", ["10"]], ["jr", ["11"]],
    ["soph", ["10"]], ["freshman", ["9"]], ["senior", ["12"]], ["PG", ["PG"]], ["post-grad", ["PG"]],
    ["10-12", ["10", "11", "12"]], ["10–12", ["10", "11", "12"]], ["10 to 12", ["10", "11", "12"]],
    ["10 through 12", ["10", "11", "12"]], ["9th-12th", ["9", "10", "11", "12"]], ["grades 10–12", ["10", "11", "12"]],
    ["all four years", ["9", "10", "11", "12"]], ["all of high school", ["9", "10", "11", "12"]],
    [["12", 11, "11"], ["11", "12"]], ["Grade 11", ["11"]],
  ];
  for (const [raw, want] of cases) assert.deepEqual(ok(normalizeField("grade_levels", raw)), want, String(raw));
  const r = normalizeField("grade_levels", "grades 10–12");
  assert.ok(r.ok && r.readAs === "grades 10–12", "a converted value says how it was read");
  assert.match(problem(normalizeField("grade_levels", "13")), /grade/i);
  assert.match(problem(normalizeField("grade_levels", [11, 13])), /"13" isn't a grade/, "a bad grade in a list is refused, not dropped");
});

test("timing: summer and breaks are break, school-year words are school, both or all year is year", () => {
  const cases: [string, string[]][] = [
    ["summer", ["break"]], ["winter break", ["break"]], ["spring break", ["break"]], ["breaks", ["break"]],
    ["school year", ["school"]], ["during school", ["school"]], ["after school", ["school"]], ["fall", ["school"]],
    ["spring semester", ["school"]], ["year-round", ["year"]], ["all year", ["year"]], ["school and summer", ["year"]],
    ["break", ["break"]], ["school", ["school"]], ["year", ["year"]],
  ];
  for (const [raw, want] of cases) assert.deepEqual(ok(normalizeField("timing", raw)), want, raw);
  assert.deepEqual(ok(normalizeField("timing", ["summer"])), ["break"]);
  problem(normalizeField("timing", "sometimes"));
});

test("hours: units, decimals, minutes and ranges; per-day and over 168 ask", () => {
  const cases: [unknown, number][] = [
    [6, 6], ["6", 6], ["6hr", 6], ["6 hrs/week", 6], ["6 hours a week", 6], ["6h", 6], ["about 6", 6],
    ["6hr week", 6], ["1.5 hrs/week", 1.5], ["90 minutes a week", 1.5], ["5-6", 5.5],
  ];
  for (const [raw, want] of cases) assert.equal(ok(normalizeField("hours_per_week", raw)), want, String(raw));
  const range = normalizeField("hours_per_week", "5-6");
  assert.ok(range.ok && range.readAs === "5-6");
  assert.match(problem(normalizeField("hours_per_week", "2 hours a day")), /needs the days per week\. Ask the counselor; don't guess\./);
  assert.equal(problem(normalizeField("hours_per_week", 200)), "200 is more than 168. Ask the counselor; don't guess.");
});

test("weeks: '2 weeks/yr' is 2, 'all year' is 52, 'the school year' asks", () => {
  const cases: [unknown, number][] = [[2, 2], ["2", 2], ["2 weeks/yr", 2], ["2 week/yr", 2], ["2 wk", 2], ["all year", 52]];
  for (const [raw, want] of cases) assert.equal(ok(normalizeField("weeks_per_year", raw)), want, String(raw));
  assert.equal(problem(normalizeField("weeks_per_year", "the school year")), `"the school year" isn't a number of weeks. Ask the counselor; don't guess.`);
  problem(normalizeField("weeks_per_year", 60));
});

test("continuing, uc_category and category read only explicit words", () => {
  assert.equal(ok(normalizeField("continuing", "still")), true);
  assert.equal(ok(normalizeField("continuing", "ongoing")), true);
  assert.equal(ok(normalizeField("continuing", "plans to continue")), true);
  assert.equal(ok(normalizeField("continuing", "ended")), false);
  assert.equal(ok(normalizeField("continuing", "no longer")), false);
  assert.equal(ok(normalizeField("continuing", true)), true);

  assert.equal(ok(normalizeField("uc_category", "volunteer")), "volunteer");
  assert.equal(ok(normalizeField("uc_category", "job")), "work");
  assert.equal(ok(normalizeField("uc_category", "educational prep")), "educational-prep");
  assert.equal(
    problem(normalizeField("uc_category", "helps out")),
    "uc_category needs the counselor's own word (volunteer, work, extracurricular, educational prep). Leave it blank."
  );

  const cs = normalizeField("category", "community service");
  assert.ok(cs.ok && cs.value === "Community Service (Volunteer)" && cs.readAs === "community service");
  assert.equal(ok(normalizeField("category", "Robotics")), "Robotics");
  assert.equal(ok(normalizeField("category", "debate")), "Debate/Speech");
  assert.equal(ok(normalizeField("category", "Debate/Speech")), "Debate/Speech");
  assert.equal(problem(normalizeField("category", "chess stuff")), `"chess stuff" isn't one of the Common App activity types. Leave category blank.`);
});

test("free-text fields are trimmed; empty is a problem", () => {
  assert.equal(ok(normalizeField("organization", "  Code Club ")), "Code Club");
  assert.equal(ok(normalizeField("position", "Cofounder/Teacher")), "Cofounder/Teacher");
  problem(normalizeField("organization", "   "));
  assert.equal(ok(normalizeField("description", "  Taught 20 kids to code.  ")), "Taught 20 kids to code.");
});

test("mentionsIn reads values out of the transcript's line", () => {
  const m = mentionsIn("Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr");
  assert.deepEqual([m.grades, m.timing, m.hours, m.weeks], [["11"], ["break"], [6], [2]]);
});

test("mentionsIn finds categories and uc words by name or synonym", () => {
  const m = mentionsIn("it's community service, a volunteer thing, and some robotics");
  assert.ok(m.category.includes("Community Service (Volunteer)"));
  assert.ok(m.category.includes("Robotics"));
  assert.ok(m.uc.includes("volunteer"));
});

test("numbers without a unit are not activity values, unless bare is asked for", () => {
  assert.equal(hasActivityValue("is her 1450 good for UCLA?"), false);
  assert.equal(hasActivityValue("what are her grades?"), false);
  assert.equal(hasActivityValue("Is her SAT 1450 good for UCLA?"), false);
  assert.equal(hasActivityValue("6 hrs a week"), true);
  assert.equal(hasActivityValue("she's a junior"), true);
  assert.equal(hasActivityValue("Grade 11 Summer"), true);
  assert.deepEqual(mentionsIn("6", { bare: true }).hours, [6]);
  assert.deepEqual(mentionsIn("6").hours, []);
  assert.deepEqual(mentionsIn("grade 10", { bare: true }).hours, [], "a number a unit claimed is never bare");
  assert.deepEqual(mentionsIn("11", { bare: true }).grades, ["11"]);
});
