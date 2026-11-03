import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanProposals, EMPTY_DRAFT, modelTurn, notAnAchievement } from "../../src/lib/profileUpdates.js";

test("luck and purchases are never achievements", () => {
  assert.equal(notAnAchievement({ ...EMPTY_DRAFT, kind: "honor", title: "Lottery Winner" }), true);
  assert.equal(notAnAchievement({ ...EMPTY_DRAFT, kind: "honor", title: "Won the raffle at the fair" }), true);
  assert.equal(notAnAchievement({ ...EMPTY_DRAFT, kind: "activity", description: "Bought a new car" }), true);
  assert.equal(notAnAchievement({ ...EMPTY_DRAFT, kind: "honor", title: "AIME Qualifier" }), false);
  assert.equal(notAnAchievement({ ...EMPTY_DRAFT, kind: "activity", organization: "Robotics Club", description: "Built a lottery-ball sorter" }), true);
});

test("the model files only on an explicit readyToFile, and only an explicit false refuses", () => {
  const base = { kind: "honor", record: { title: "AIME Qualifier" }, question: "Which grade?" };
  assert.equal(modelTurn.parse(base).readyToFile, false);
  assert.equal(modelTurn.parse({ ...base, readyToFile: "true" }).readyToFile, false);
  assert.equal(modelTurn.parse({ ...base, readyToFile: true }).readyToFile, true);
  assert.equal(modelTurn.parse(base).listable, true);
  assert.equal(modelTurn.parse({ ...base, listable: false }).listable, false);
});

test("document proposals are checked like a chat turn", () => {
  const got = cleanProposals({
    entries: [
      { kind: "activity", organization: "Robotics Club", position: "Captain", category: "Robotics", description: "Led a team of 12 to regionals", gradeLevels: ["10", "11"], hoursPerWeek: 6, weeksPerYear: 30 },
      { kind: "activity", organization: "Robotics Club", position: "Captain" },
      { kind: "honor", title: "Lottery Winner", level: "state-regional", gradeLevels: ["11"] },
      { kind: "honor", title: "AIME Qualifier", level: "national", gradeLevels: ["11"] },
      { kind: "nonsense", title: "x" },
    ],
  });
  assert.equal(got.length, 2);
  assert.equal(got[1]!.draft.title, "AIME Qualifier");
  assert.deepEqual(got[1]!.missing, []);
  assert.equal(cleanProposals(null).length, 0);
});
