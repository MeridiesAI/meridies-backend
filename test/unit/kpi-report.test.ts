import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, type CompletionRow } from "../../src/lib/kpi/report.js";

const row = (o: Partial<CompletionRow>): CompletionRow => ({
  task_type: "family_report", student_id: "s1", month: "2026-10-01", manual_minutes: 60, manual_is_estimate: false,
  meridies_minutes: 10, measure_method: "active", saved_minutes: 50, hourly_rate: 150, rate_is_estimate: false, ...o,
});
const names = { s1: "Ava Lee", s2: "Ben Ito" };
const empty = { aiRuns: {}, researchRuns: {} };

test("totals, students, value and the calculation line", () => {
  const r = buildReport([row({}), row({ student_id: "s2", saved_minutes: 70, manual_minutes: 90, meridies_minutes: 20 })], [], 40, empty, "2026-10", names);
  assert.equal(r.hoursSaved, 2);
  assert.equal(r.students, 2);
  assert.equal(r.valueOfTime, 300);
  assert.equal(r.valueIsEstimate, false);
  const fr = r.byTask.find((t) => t.taskType === "family_report")!;
  assert.equal(fr.completions, 2);
  assert.equal(fr.display, "saved");
  assert.equal(fr.lines[0].calc, "60 min estimate − 10 min in Meridies");
  assert.equal(fr.lines[0].studentName, "Ava Lee");
  assert.equal(r.empty, false);
});

test("an estimated manual figure says so in the calculation", () => {
  const r = buildReport([row({ manual_is_estimate: true })], [], 40, empty, "2026-10", names);
  assert.equal(r.byTask[0].lines[0].calc, "60 min estimate − 10 min in Meridies (estimated)");
  assert.equal(r.byTask[0].lines[0].estimate, true);
});

test("a task type whose total is ≤ 0 shows no time saved yet; negatives still count in the total", () => {
  const r = buildReport([row({ task_type: "meeting", saved_minutes: -20, manual_minutes: 10, meridies_minutes: 30 }), row({})], [], 40, empty, "2026-10", names);
  assert.equal(r.byTask.find((t) => t.taskType === "meeting")!.display, "no-time-saved-yet");
  assert.equal(r.hoursSaved, 0.5);
});

test("value and extra students are separate, never summed", () => {
  const hist = [row({ month: "2026-07-01", saved_minutes: 2400 }), row({ month: "2026-08-01", saved_minutes: 2400 }), row({ month: "2026-09-01", saved_minutes: 2400 }), row({})];
  const r = buildReport([row({})], hist, 40, empty, "2026-10", names);
  assert.deepEqual(r.extraStudents, { upTo: 3, basedOnMonths: 4 });
  assert.equal(typeof r.valueOfTime, "number");
  assert.equal(Object.keys(r).filter((k) => /total|combined/i.test(k)).length, 0);
});

test("no savings → no extra students and no value", () => {
  const r = buildReport([row({ saved_minutes: -5 })], [row({ saved_minutes: -5 })], 40, empty, "2026-10", names);
  assert.equal(r.extraStudents, null);
  assert.equal(r.valueOfTime, null);
});

test("a default rate marks the value estimated", () => {
  const r = buildReport([row({ rate_is_estimate: true })], [], 40, empty, "2026-10", names);
  assert.equal(r.valueIsEstimate, true);
});

test("zero rows → empty", () => {
  const r = buildReport([], [], 40, { aiRuns: { chat: 3 }, researchRuns: {} }, "2026-10", {});
  assert.equal(r.empty, true);
  assert.equal(r.hoursSaved, 0);
  assert.deepEqual(r.byTask, []);
  assert.deepEqual(r.activity.aiRuns, { chat: 3 });
});
