// test/unit/activity-import.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { markOnSheet } from "../../src/lib/activityListImport.js";
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
const proposals = (existing: { organization: string; position: string | null }[], ...entries: Record<string, unknown>[]) =>
  markOnSheet(cleanProposals({ entries }), existing);

test("an activity becomes an AI-sourced row with the organization as its name", () => {
  const { rows, skippedDuplicates } = newActivityRows(S, 0, proposals([], act("Debate Team", "Captain")));
  assert.equal(skippedDuplicates, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "ai");
  assert.equal(rows[0].name, "Debate Team");
  assert.equal(rows[0].student_id, S);
  assert.equal(rows[0].sort_order, 0);
});

test("what the sheet already holds is skipped and counted, the rest is added", () => {
  const existing = [{ organization: "Debate Team", position: "Captain" }];
  const { rows, skippedDuplicates } = newActivityRows(S, 1, proposals(existing, act("Debate Team", "Captain"), act("Robotics Club", "Member")));
  assert.deepEqual(rows.map((r) => r.organization), ["Robotics Club"]);
  assert.equal(skippedDuplicates, 1);
  assert.equal(rows[0].sort_order, 1);
});

test("an activity with no organization and any honor are not written", () => {
  const { rows } = newActivityRows(S, 0, proposals([], act(null, "Captain"), { kind: "honor", title: "National Merit Semifinalist", level: "national", gradeLevels: ["12"] }));
  assert.equal(rows.length, 0);
});

test("rows stop at the sheet's 30-row cap and sort after the existing ones", () => {
  const { rows } = newActivityRows(S, 29, proposals([], act("New One"), act("New Two")));
  assert.deepEqual(rows.map((r) => [r.organization, r.sort_order]), [["New One", 29]]);
});
