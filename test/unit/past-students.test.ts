import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityName,
  buildPastStudents,
  chunk,
  listResult,
  mergeSchools,
  outcomeResult,
} from "../../src/lib/pastStudents.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const MIT = "00000000-0000-4000-8000-0000000000c1";
const UCLA = "00000000-0000-4000-8000-0000000000c2";

test("list statuses: decided schools and submitted ones are applications, the rest are not", () => {
  assert.equal(listResult("accepted"), "accepted");
  assert.equal(listResult("denied"), "denied");
  assert.equal(listResult("enrolled"), "enrolled");
  assert.equal(listResult("submitted"), null);
  assert.equal(listResult("in-progress"), undefined);
  assert.equal(listResult("not-started"), undefined);
});

test("outcome results read in the list's words", () => {
  assert.equal(outcomeResult("admitted", false), "accepted");
  assert.equal(outcomeResult("admitted", true), "enrolled");
  assert.equal(outcomeResult("denied", false), "denied");
  assert.equal(outcomeResult("nonsense", false), undefined);
});

test("mergeSchools: the list wins, outcomes fill only schools the list lacks, ordered by result", () => {
  const schools = mergeSchools(
    [
      { name: "UCLA", college_id: UCLA, status: "denied", round: "RD", decision_date: "2026-03-20" },
      { name: "MIT", college_id: MIT, status: "enrolled", round: "EA", decision_date: "2025-12-14" },
      { name: "Draft school", college_id: null, status: "in-progress" },
      { name: "Bowdoin", college_id: null, status: "submitted" },
    ],
    [
      // Same school as the list's MIT: ignored even though it says something else.
      { college_name: "MIT", college_id: MIT, result: "waitlisted", enrolled: false, round: "EA" },
      // Typed by name on the list, carried by id here: still the same school.
      { college_name: "bowdoin", college_id: "00000000-0000-4000-8000-0000000000c3", result: "admitted", enrolled: false },
      // Only in the outcomes history.
      { college_name: "Reed College", college_id: null, result: "admitted", enrolled: false, round: "RD" },
    ]
  );
  assert.deepEqual(
    schools.map((s) => [s.name, s.result]),
    [
      ["MIT", "enrolled"],
      ["Reed College", "accepted"],
      ["UCLA", "denied"],
      ["Bowdoin", null],
    ]
  );
  assert.equal(schools[0].decisionDate, "2025-12-14");
  assert.equal(schools[1].decisionDate, null);
});

test("activityName falls back from name to role to organisation", () => {
  assert.equal(activityName({ name: " Robotics ", position: "Captain" }), "Robotics");
  assert.equal(activityName({ name: "", position: "Captain" }), "Captain");
  assert.equal(activityName({ organization: "Food bank" }), "Food bank");
  assert.equal(activityName({}), null);
});

test("buildPastStudents: credentials with their scale, top activities, enrolled school, newest class first", () => {
  const out = buildPastStudents({
    alumni: [
      { student_id: A, cycle: "2024-2025", college_id: null, institution_name: null },
      { student_id: B, cycle: "2025-2026", college_id: UCLA, institution_name: "UCLA (corrected)" },
    ],
    profiles: [
      { id: A, full_name: "Avery Alum", email: "a@x.test", grad_year: "2025", high_school: "Lincoln High" },
      { id: B, full_name: "Blake Alum", email: "b@x.test", grad_year: "2026", high_school: null },
    ],
    academics: [{ student_id: A, gpa_unweighted: "92.5", gpa_weighted: null, gpa_scale: "100", sat_superscore: 1480, act_composite: null }],
    activities: [
      { student_id: A, name: "Debate", sort_order: 2 },
      { student_id: A, name: "Robotics", sort_order: 0 },
      { student_id: A, name: null, position: "Tutor", sort_order: 1 },
      { student_id: A, name: "Band", sort_order: 3 },
    ],
    colleges: [{ student_id: A, name: "MIT", college_id: MIT, status: "enrolled", round: "EA" }],
    outcomes: [],
  });

  assert.deepEqual(
    out.map((s) => s.studentId),
    [B, A]
  );
  const [blake, avery] = out;
  assert.deepEqual(avery.gpa, { unweighted: 92.5, weighted: null, scale: "100" });
  assert.equal(avery.sat, 1480);
  assert.equal(avery.act, null);
  assert.deepEqual(avery.activities, { count: 4, top: ["Robotics", "Tutor", "Debate"] });
  assert.deepEqual(avery.enrolled, { name: "MIT", collegeId: MIT });
  // The alum record's own school wins over the list (the alum page corrects it).
  assert.deepEqual(blake.enrolled, { name: "UCLA (corrected)", collegeId: UCLA });
  // No academics row: nothing invented, the scale stays unknown.
  assert.deepEqual(blake.gpa, { unweighted: null, weighted: null, scale: null });
  assert.deepEqual(blake.activities, { count: 0, top: [] });
  assert.equal(blake.highSchool, null);
});

test("chunk slices ids", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});
