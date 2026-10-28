import assert from "node:assert/strict";
import { test } from "node:test";
import { alignActivities, majorWords } from "../../src/lib/activityAlignment.js";

const act = (over: Record<string, unknown>) => ({ organization: "", position: "", category: "", description: "", ...over });

test("sorts activities into research, service and competitions from category and words", () => {
  const out = alignActivities({
    activities: [
      act({ organization: "Cornell Bio Lab", position: "Research assistant", category: "Research", hours_per_week: 10, weeks_per_year: 20 }),
      act({ organization: "Food Bank", position: "Volunteer", category: "Community Service (Volunteer)", hours_per_week: 2, weeks_per_year: 40 }),
      act({ organization: "Robotics Team", position: "Captain", description: "Won regional championship", category: "Computer/Technology" }),
      act({ organization: "Chess Club", category: "Academic" }),
    ],
    honors: [{ name: "State Science Olympiad, 2nd place" }],
    majors: ["Computer Science"],
  });
  const by = Object.fromEntries(out.buckets.map((b) => [b.id, b]));
  assert.equal(by.research.count, 1);
  assert.equal(by.research.hoursPerYear, 200);
  assert.equal(by.service.count, 1);
  assert.equal(by.service.hoursPerYear, 80);
  assert.equal(by.competitions.count, 2); // the team and the honor
  assert.equal(out.total, 5);
  assert.deepEqual(out.read, { activities: 4, honors: 1 });
});

test("names what is missing and says so plainly", () => {
  const out = alignActivities({ activities: [act({ organization: "Chess Club", category: "Academic" })], honors: [], majors: [] });
  assert.match(out.notes[0], /Nothing listed under research, service, competitions/);
  assert.match(out.notes[1], /No intended major is on file/);
});

test("an empty list says so and claims nothing", () => {
  const out = alignActivities({ activities: [], honors: [], majors: ["Biology"] });
  assert.equal(out.total, 0);
  assert.deepEqual(out.notes, ["No activities or honors are on the sheets yet."]);
});

test("ties rows to the declared major by its own words and the field's", () => {
  const out = alignActivities({
    activities: [act({ organization: "Hackathon club", description: "Built a mobile app" }), act({ organization: "Soup kitchen", category: "Community Service (Volunteer)" })],
    honors: [],
    majors: ["Computer Science"],
  });
  assert.deepEqual(out.majorLinks, [{ activity: "Hackathon club", major: "Computer Science" }]);
  assert.match(out.notes.at(-1)!, /1 of 2 entries connect to Computer Science/);
});

test("a short field word must stand alone", () => {
  // "app" must not match "happy", "ai" must not match "maintain".
  const out = alignActivities({ activities: [act({ organization: "Happy Hands", description: "Maintain gardens" })], honors: [], majors: ["Computer Science"] });
  assert.equal(out.majorLinks.length, 0);
});

test("majorWords drops generic words and keeps the field's", () => {
  const w = majorWords("Mechanical Engineering");
  assert.ok(w.includes("mechanical") && w.includes("robotics"));
  assert.ok(!w.includes("science"));
});

test("an honor counts as a competition only when it reads like a result", () => {
  const out = alignActivities({ activities: [], honors: [{ name: "Honor Roll" }, { name: "National Merit Finalist" }], majors: [] });
  assert.equal(out.buckets.find((b) => b.id === "competitions")!.count, 1);
});
