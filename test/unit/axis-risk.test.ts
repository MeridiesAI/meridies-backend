import assert from "node:assert/strict";
import { test } from "node:test";
import { rankStudents, urgency, type RiskInput } from "../../src/lib/axis/risk.js";

const today = "2026-10-11";
const task = (studentId: string, title: string, due: string, status = "in-progress", lastActivityAt: string | null = new Date().toISOString()): RiskInput => ({
  kind: "task", studentId, title, due, status, lastActivityAt,
});

test("overdue work outranks anything due later, and ages", () => {
  const late = urgency(task("s", "Essay", "2026-10-08"), today, 14, 7).u;
  const soon = urgency(task("s", "Essay", "2026-10-12", "not-started"), today, 14, 7).u;
  const later = urgency(task("s", "Essay", "2026-10-20"), today, 14, 7).u;
  assert.ok(late > soon && soon > later && later > 0);
  assert.ok(urgency(task("s", "Essay", "2026-09-20"), today, 14, 7).u > late);
  assert.equal(urgency(task("s", "Essay", "2026-12-01"), today, 14, 7).u, 0, "beyond the horizon");
});

test("a stalled task counts for more than an active one, and says why", () => {
  const active = urgency(task("s", "Supplement", "2026-10-15"), today, 14, 7);
  const stalled = urgency(task("s", "Supplement", "2026-10-15", "in-progress", "2026-09-25T00:00:00Z"), today, 14, 7);
  assert.ok(stalled.u > active.u);
  assert.match(stalled.reason ?? "", /no activity for \d+ days/);
});

test("one bad item outranks several mild ones; an open red flag outranks mild items; every rank carries reasons", () => {
  const roster = [{ id: "a", name: "Ava" }, { id: "b", name: "Ben" }, { id: "c", name: "Cy" }];
  const items: RiskInput[] = [
    task("a", "Common App essay", "2026-10-01"),
    task("b", "Activity list", "2026-10-22"), task("b", "Resume", "2026-10-23"), task("b", "Brag sheet", "2026-10-24"),
  ];
  const ranked = rankStudents(roster, items, new Map([["c", 1]]), { today, horizonDays: 14, stallAfterDays: 7 });
  assert.deepEqual(ranked.map((r) => r.studentId), ["a", "c", "b"]);
  assert.match(ranked[0]!.reasons[0]!, /"Common App essay" is 10 days overdue/);
  assert.deepEqual(ranked[1]!.reasons, ["1 open red flag"]);
});
