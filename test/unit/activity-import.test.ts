// test/unit/activity-import.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { newActivityRows } from "../../src/lib/activityImport.js";
import { cleanProposals } from "../../src/lib/profileUpdates.js";

const S = "00000000-0000-0000-0000-000000000001";
const act = (organization: string | null, position: string | null = null) => ({
  kind: "activity",
  organization,
  position,
  category: "Academic",
  description: "Led weekly practice",
  gradeLevels: ["11"],
  hoursPerWeek: 4,
  weeksPerYear: 30,
});
const proposals = (...entries: Record<string, unknown>[]) => cleanProposals({ entries });

test("an activity becomes an AI-sourced row with the organization as its name", () => {
  const { rows, skippedDuplicates } = newActivityRows(S, [], proposals(act("Debate Team", "Captain")));
  assert.equal(skippedDuplicates, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "ai");
  assert.equal(rows[0].name, "Debate Team");
  assert.equal(rows[0].student_id, S);
  assert.equal(rows[0].sort_order, 0);
});

test("what the sheet already holds is skipped, whatever the case or punctuation", () => {
  const existing = [{ organization: "debate team!", position: "captain" }];
  const { rows, skippedDuplicates } = newActivityRows(S, existing, proposals(act("Debate Team", "Captain"), act("Robotics Club", "Member")));
  assert.deepEqual(rows.map((r) => r.organization), ["Robotics Club"]);
  assert.equal(skippedDuplicates, 1);
});

test("the same organization with an unstated position on either side is the same activity", () => {
  const existing = [{ organization: "Debate Team", position: null }];
  assert.equal(newActivityRows(S, existing, proposals(act("Debate Team", "Captain"))).rows.length, 0);
  assert.equal(newActivityRows(S, [{ organization: "Debate Team", position: "Captain" }], proposals(act("Debate Team", null))).rows.length, 0);
});

test("two different positions at one organization are both kept", () => {
  const { rows } = newActivityRows(S, [{ organization: "Debate Team", position: "Member" }], proposals(act("Debate Team", "Captain")));
  assert.equal(rows.length, 1);
});

test("an activity with no organization and any honor are not written", () => {
  const { rows } = newActivityRows(S, [], proposals(act(null, "Captain"), { kind: "honor", title: "National Merit Semifinalist", level: "national", gradeLevels: ["12"] }));
  assert.equal(rows.length, 0);
});

test("rows stop at the sheet's 30-row cap and sort after the existing ones", () => {
  const existing = Array.from({ length: 29 }, (_, i) => ({ organization: `Club ${i}`, position: null }));
  const { rows } = newActivityRows(S, existing, proposals(act("New One"), act("New Two")));
  assert.deepEqual(rows.map((r) => [r.organization, r.sort_order]), [["New One", 29]]);
});
