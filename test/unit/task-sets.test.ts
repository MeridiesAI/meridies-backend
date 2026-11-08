// Saved task sets (lib/taskSets.ts): the item schema, relative due dates, and class-year resolution.
// Nothing here reaches a database or a network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  applyBody,
  dueDateFor,
  nextMonthDay,
  studentsInClass,
  taskSetBody,
  taskSetItem,
  taskSetPatch,
  todayIn,
  TASK_KINDS,
  TASK_SET_EMAIL_DAILY_CAP,
  toTaskSet,
} from "../../src/lib/taskSets.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

// ---- the item schema --------------------------------------------------------------------------

test("an item needs a title; kind, instructions and stages are optional", () => {
  assert.ok(ok(taskSetItem, { title: "Brag sheet" }));
  assert.ok(ok(taskSetItem, { title: "Brag sheet", kind: "document", instructions: "One page", dueOffsetDays: 14 }));
  assert.ok(!ok(taskSetItem, { title: "" }));
  assert.ok(!ok(taskSetItem, { title: "   " }));
  assert.ok(!ok(taskSetItem, { title: "x".repeat(301) }));
  assert.ok(!ok(taskSetItem, { title: "A", kind: "nope" }));
  assert.ok(!ok(taskSetItem, { title: "A", studentId: "00000000-0000-0000-0000-000000000000" }), "strict: no extra keys");
  for (const k of TASK_KINDS) assert.ok(ok(taskSetItem, { title: "A", kind: k }), k);
});

test("an item's due date is an offset OR a month and day, never both, never half", () => {
  assert.ok(ok(taskSetItem, { title: "A", dueOffsetDays: 0 }));
  assert.ok(ok(taskSetItem, { title: "A", dueOffsetDays: 730 }));
  assert.ok(!ok(taskSetItem, { title: "A", dueOffsetDays: -1 }));
  assert.ok(!ok(taskSetItem, { title: "A", dueOffsetDays: 731 }));
  assert.ok(!ok(taskSetItem, { title: "A", dueOffsetDays: 1.5 }));
  assert.ok(ok(taskSetItem, { title: "A", dueMonth: 11, dueDay: 1 }));
  assert.ok(ok(taskSetItem, { title: "A", dueMonth: 2, dueDay: 29 }));
  assert.ok(!ok(taskSetItem, { title: "A", dueMonth: 2, dueDay: 30 }), "Feb 30");
  assert.ok(!ok(taskSetItem, { title: "A", dueMonth: 4, dueDay: 31 }), "Apr 31");
  assert.ok(!ok(taskSetItem, { title: "A", dueMonth: 11 }), "a month alone");
  assert.ok(!ok(taskSetItem, { title: "A", dueDay: 1 }), "a day alone");
  assert.ok(!ok(taskSetItem, { title: "A", dueOffsetDays: 3, dueMonth: 11, dueDay: 1 }), "both");
});

test("stages take a name and the same relative due rule; at most 20", () => {
  assert.ok(ok(taskSetItem, { title: "Essay", stages: [{ name: "Outline", dueOffsetDays: 7 }, { name: "Draft", dueMonth: 10, dueDay: 15 }, { name: "Polish" }] }));
  assert.ok(!ok(taskSetItem, { title: "Essay", stages: [{ name: "" }] }));
  assert.ok(!ok(taskSetItem, { title: "Essay", stages: [{ name: "A", dueDate: "2026-12-01" }] }), "no absolute dates in a reusable set");
  assert.ok(!ok(taskSetItem, { title: "Essay", stages: [{ name: "A", dueMonth: 2, dueDay: 30 }] }));
  assert.ok(!ok(taskSetItem, { title: "Essay", stages: Array.from({ length: 21 }, (_, i) => ({ name: `S${i}` })) }));
});

test("a set is a name of 1-80 characters and 1-30 items", () => {
  const item = { title: "A" };
  assert.ok(ok(taskSetBody, { name: "Junior spring", items: [item] }));
  assert.ok(ok(taskSetBody, { name: "Junior spring", items: Array.from({ length: 30 }, () => item), shared: true }));
  assert.ok(!ok(taskSetBody, { name: "Junior spring", items: Array.from({ length: 31 }, () => item) }));
  assert.ok(!ok(taskSetBody, { name: "Junior spring", items: [] }));
  assert.ok(!ok(taskSetBody, { name: "", items: [item] }));
  assert.ok(!ok(taskSetBody, { name: "x".repeat(81), items: [item] }));
  assert.ok(!ok(taskSetBody, { name: "A", items: [item], counselorId: "x" }), "strict");
  assert.ok(ok(taskSetPatch, { name: "Renamed" }));
  assert.ok(ok(taskSetPatch, { shared: false }));
  assert.ok(!ok(taskSetPatch, {}), "a patch changes something");
});

test("apply takes exactly one of studentIds (1-100) or a four-digit classYear", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.ok(ok(applyBody, { studentIds: [id] }));
  assert.ok(ok(applyBody, { classYear: "2027", notifyEmail: false }));
  assert.ok(!ok(applyBody, {}), "neither");
  assert.ok(!ok(applyBody, { studentIds: [id], classYear: "2027" }), "both");
  assert.ok(!ok(applyBody, { studentIds: [] }));
  assert.ok(!ok(applyBody, { studentIds: Array.from({ length: 101 }, () => id) }));
  assert.ok(!ok(applyBody, { studentIds: ["not-a-uuid"] }));
  assert.ok(!ok(applyBody, { classYear: "27" }));
  assert.ok(!ok(applyBody, { classYear: "2027 " }));
  assert.ok(!ok(applyBody, { classYear: "2027", extra: 1 }), "strict");
});

// ---- dates ------------------------------------------------------------------------------------

test("adding days is calendar arithmetic, safe across DST changes and month ends", () => {
  assert.equal(addDays("2026-03-07", 1), "2026-03-08"); // US spring forward on the 8th
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01"); // EU fall back on Oct 25, US Nov 1
  assert.equal(addDays("2026-11-01", 7), "2026-11-08");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(addDays("2026-01-01", 0), "2026-01-01");
  assert.equal(addDays("2026-01-01", 365), "2027-01-01");
});

test("today is the counselor's own date, UTC when the zone is unknown", () => {
  const instant = new Date("2026-11-08T03:30:00Z"); // still Nov 7 in Los Angeles
  assert.equal(todayIn("America/Los_Angeles", instant), "2026-11-07");
  assert.equal(todayIn("Asia/Tokyo", instant), "2026-11-08");
  assert.equal(todayIn(null, instant), "2026-11-08");
  assert.equal(todayIn("Not/AZone", instant), "2026-11-08");
});

test("a month and day is the next occurrence on or after today", () => {
  assert.equal(nextMonthDay(11, 15, "2026-11-07"), "2026-11-15");
  assert.equal(nextMonthDay(11, 7, "2026-11-07"), "2026-11-07", "today counts");
  assert.equal(nextMonthDay(11, 6, "2026-11-07"), "2027-11-06");
  assert.equal(nextMonthDay(1, 5, "2026-11-07"), "2027-01-05");
  assert.equal(nextMonthDay(12, 31, "2026-12-31"), "2026-12-31");
});

test("Feb 29 lands on Feb 28 in a year without one, the blast rule", () => {
  assert.equal(nextMonthDay(2, 29, "2026-11-07"), "2027-02-28");
  assert.equal(nextMonthDay(2, 29, "2027-03-01"), "2028-02-29");
  assert.equal(nextMonthDay(2, 29, "2028-02-29"), "2028-02-29");
  assert.equal(nextMonthDay(2, 29, "2028-03-01"), "2029-02-28");
  assert.equal(nextMonthDay(2, 28, "2027-02-28"), "2027-02-28");
});

test("dueDateFor reads whichever rule the item has, or none", () => {
  assert.equal(dueDateFor({ dueOffsetDays: 14 }, "2026-11-07"), "2026-11-21");
  assert.equal(dueDateFor({ dueMonth: 1, dueDay: 15 }, "2026-11-07"), "2027-01-15");
  assert.equal(dueDateFor({}, "2026-11-07"), null);
});

// ---- class year ---------------------------------------------------------------------------------

test("a class year is the active roster students with that grad year, trimmed", () => {
  const roster = [
    { id: "a", grad_year: "2027", archived_at: null, role: "student" },
    { id: "b", grad_year: " 2027 ", archived_at: null, role: "student" },
    { id: "c", grad_year: "2027", archived_at: "2026-01-01T00:00:00Z", role: "student" },
    { id: "d", grad_year: "2028", archived_at: null, role: "student" },
    { id: "e", grad_year: null, archived_at: null, role: "student" },
    { id: "f", grad_year: "2027", archived_at: null, role: "counselor" },
  ];
  assert.deepEqual(studentsInClass(roster, "2027"), ["a", "b"]);
  assert.deepEqual(studentsInClass(roster, "2030"), []);
});

// ---- the DTO and limits -------------------------------------------------------------------------

test("a set row serializes with mine/shared and its items", () => {
  const dto = toTaskSet(
    { id: "s1", counselor_id: "me", firm_id: "f1", name: "Junior spring", items: [{ title: "A" }], created_at: "t1", updated_at: "t2" },
    "me"
  );
  assert.deepEqual(dto, { id: "s1", name: "Junior spring", items: [{ title: "A" }], shared: true, mine: true, ownerId: "me", createdAt: "t1", updatedAt: "t2" });
  const theirs = toTaskSet({ id: "s2", counselor_id: "them", firm_id: null, name: "X", items: "bad", created_at: "t", updated_at: "t" }, "me");
  assert.equal(theirs.mine, false);
  assert.equal(theirs.shared, false);
  assert.deepEqual(theirs.items, []);
});

test("the daily student-email cap keeps a 100-student apply inside it", () => {
  assert.ok(TASK_SET_EMAIL_DAILY_CAP >= 100 && TASK_SET_EMAIL_DAILY_CAP <= 300);
});
