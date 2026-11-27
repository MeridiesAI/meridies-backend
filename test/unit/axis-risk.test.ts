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

const ago = (days: number) => new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();
const untouched = (due: string, createdAt: string | null): RiskInput => ({
  kind: "task", studentId: "s", title: "Essay", due, status: "not-started", lastActivityAt: null, createdAt,
});

test("a task with no activity yet counts its idle time from when it was assigned", () => {
  const fresh = urgency(untouched("2026-10-15", ago(0)), today, 14, 14);
  const active = urgency(task("s", "Essay", "2026-10-15", "not-started"), today, 14, 14);
  assert.equal(fresh.u, active.u, "assigned today is not stalled");
  assert.doesNotMatch(fresh.reason ?? "", /never started|no activity/);
  const old = urgency(untouched("2026-10-15", ago(30)), today, 14, 14);
  assert.ok(old.u > fresh.u, "assigned a month ago and never touched is stalled");
  assert.match(old.reason ?? "", /not started in 30 days/);
});

test("the stall factor grows from 1 at the threshold, not from all idle days", () => {
  const base = urgency(task("s", "Essay", "2026-10-15", "in-progress", ago(0)), today, 14, 14).u;
  const factor = (idle: number) => urgency(task("s", "Essay", "2026-10-15", "in-progress", ago(idle)), today, 14, 14).u / base;
  assert.ok(Math.abs(factor(13) - 1) < 1e-9);
  assert.ok(Math.abs(factor(14) - 1) < 1e-9, "no jump on the day the threshold is crossed");
  assert.ok(Math.abs(factor(15) - (1 + 1 / 21)) < 1e-9);
  assert.ok(Math.abs(factor(14 + 21) - 2) < 1e-9);
  assert.ok(Math.abs(factor(14 + 60) - 2) < 1e-9, "capped at x2");
});

test("the stall factor also multiplies an overdue task (not a deadline)", () => {
  const activeLate = urgency(task("s", "Essay", "2026-10-08", "in-progress", ago(0)), today, 14, 14).u;
  const stalledLate = urgency(task("s", "Essay", "2026-10-08", "in-progress", ago(14 + 21)), today, 14, 14).u;
  assert.ok(Math.abs(stalledLate / activeLate - 2) < 1e-9);
});

test("no activity and no assigned date is not treated as stalled", () => {
  const unknown = urgency(untouched("2026-10-15", null), today, 14, 14);
  const fresh = urgency(untouched("2026-10-15", ago(0)), today, 14, 14);
  assert.equal(unknown.u, fresh.u);
});
