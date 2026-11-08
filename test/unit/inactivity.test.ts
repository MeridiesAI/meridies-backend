import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/lib/accountability.js";
import {
  ALERT_DEFAULTS,
  ESSAY_NOTICE_PER_ESSAY_SECONDS,
  ESSAY_NOTICES_PER_STUDENT_DAY,
  LAST_ACTIVE_WRITE_EVERY_MS,
  essayBodyChanged,
  essayNoticeTitle,
  firstNameOf,
  inactiveDays,
  inactivityTitle,
  lastActivityAt,
  selectInactive,
  settingsFor,
  shouldTouchLastActive,
  type InactivityStudent,
  type SettingsRow,
} from "../../src/lib/inactivity.js";

const NOW = new Date("2026-11-07T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const C = "c0000000-0000-0000-0000-000000000001";

const base = (over: Partial<SettingsRow> = {}): SettingsRow => ({
  ...DEFAULT_SETTINGS,
  ...ALERT_DEFAULTS,
  counselor_id: C,
  student_id: null,
  quiet_hours_start: null,
  quiet_hours_end: null,
  timezone: "UTC",
  ...over,
});

const student = (id: string, over: Partial<InactivityStudent> = {}): InactivityStudent => ({
  id,
  full_name: `Ana ${id} Lopez`,
  created_at: daysAgo(60),
  last_active_at: null,
  ...over,
});

test("the alert settings are off by default", () => {
  assert.deepEqual(ALERT_DEFAULTS, { inactive_alert_days: null, notify_on_essay: false, weekly_digest: "off" });
});

test("last activity is the later of the sign-in mark and the newest progress event", () => {
  assert.equal(lastActivityAt(daysAgo(3), daysAgo(5), daysAgo(90)), daysAgo(3));
  assert.equal(lastActivityAt(daysAgo(9), daysAgo(2), daysAgo(90)), daysAgo(2));
  assert.equal(lastActivityAt(null, daysAgo(4), daysAgo(90)), daysAgo(4));
  assert.equal(lastActivityAt(daysAgo(4), null, daysAgo(90)), daysAgo(4));
});

test("a student who never did anything counts from when they joined", () => {
  assert.equal(lastActivityAt(null, null, daysAgo(20)), daysAgo(20));
});

test("the streak key is stable: the same instant, normalised", () => {
  // Postgres hands back "+00:00"; JS writes "Z". Both are the same streak.
  assert.equal(lastActivityAt("2026-11-01T10:00:00+00:00", null, daysAgo(90)), "2026-11-01T10:00:00.000Z");
});

test("whole days since the last activity", () => {
  assert.equal(inactiveDays(daysAgo(7), NOW), 7);
  assert.equal(inactiveDays(new Date(NOW.getTime() - 6.9 * 86_400_000).toISOString(), NOW), 6);
});

test("a per-student row wins over the counselor's, which wins over the defaults", () => {
  const rows = [base({ inactive_alert_days: 7 }), base({ student_id: "s1", inactive_alert_days: null })];
  assert.equal(settingsFor(rows, "s1").inactive_alert_days, null);
  assert.equal(settingsFor(rows, "s2").inactive_alert_days, 7);
  assert.equal(settingsFor([], "s2").inactive_alert_days, null);
  assert.equal(settingsFor([], "s2").weekly_digest, "off");
});

test("selects students inactive N days or more, and only them", () => {
  const rows = [base({ inactive_alert_days: 7 })];
  const out = selectInactive({
    students: [student("a", { last_active_at: daysAgo(8) }), student("b", { last_active_at: daysAgo(2) }), student("c", { last_active_at: daysAgo(7) })],
    lastEvents: new Map(),
    settingsRows: rows,
    now: NOW,
  });
  assert.deepEqual(out.map((o) => [o.studentId, o.days]), [["a", 8], ["c", 7]]);
  assert.equal(out[0].lastActivityAt, daysAgo(8));
});

test("a recent progress event keeps a student off the list", () => {
  const out = selectInactive({
    students: [student("a", { last_active_at: daysAgo(30) })],
    lastEvents: new Map([["a", daysAgo(1)]]),
    settingsRows: [base({ inactive_alert_days: 7 })],
    now: NOW,
  });
  assert.equal(out.length, 0);
});

test("a student who joined fewer than N days ago is not alerted on", () => {
  const out = selectInactive({
    students: [student("a", { created_at: daysAgo(3) })],
    lastEvents: new Map(),
    settingsRows: [base({ inactive_alert_days: 7 })],
    now: NOW,
  });
  assert.equal(out.length, 0);
});

test("no alert when the setting is off, or switched off for that student", () => {
  const students = [student("a", { last_active_at: daysAgo(30) }), student("b", { last_active_at: daysAgo(30) })];
  assert.equal(selectInactive({ students, lastEvents: new Map(), settingsRows: [base()], now: NOW }).length, 0);
  const rows = [base({ inactive_alert_days: 7 }), base({ student_id: "a", inactive_alert_days: null })];
  assert.deepEqual(selectInactive({ students, lastEvents: new Map(), settingsRows: rows, now: NOW }).map((o) => o.studentId), ["b"]);
});

test("a per-student threshold applies to that student only", () => {
  const rows = [base({ inactive_alert_days: 30 }), base({ student_id: "a", inactive_alert_days: 5 })];
  const students = [student("a", { last_active_at: daysAgo(6) }), student("b", { last_active_at: daysAgo(6) })];
  assert.deepEqual(selectInactive({ students, lastEvents: new Map(), settingsRows: rows, now: NOW }).map((o) => o.studentId), ["a"]);
});

test("nobody is selected inside the counselor's quiet hours", () => {
  // 15:00 UTC sits inside a 14 -> 16 window.
  const rows = [base({ inactive_alert_days: 7, quiet_hours_start: 14, quiet_hours_end: 16 })];
  const out = selectInactive({ students: [student("a", { last_active_at: daysAgo(30) })], lastEvents: new Map(), settingsRows: rows, now: NOW });
  assert.equal(out.length, 0);
  const open = [base({ inactive_alert_days: 7, quiet_hours_start: 21, quiet_hours_end: 8 })];
  assert.equal(selectInactive({ students: [student("a", { last_active_at: daysAgo(30) })], lastEvents: new Map(), settingsRows: open, now: NOW }).length, 1);
});

test("accountability switched off for a student means no inactivity alert either", () => {
  const rows = [base({ inactive_alert_days: 7, enabled: false })];
  assert.equal(selectInactive({ students: [student("a", { last_active_at: daysAgo(30) })], lastEvents: new Map(), settingsRows: rows, now: NOW }).length, 0);
});

test("the last-active mark is written at most once an hour", () => {
  assert.equal(LAST_ACTIVE_WRITE_EVERY_MS, 3_600_000);
  assert.equal(shouldTouchLastActive(null, NOW), true);
  assert.equal(shouldTouchLastActive(new Date(NOW.getTime() - 59 * 60_000).toISOString(), NOW), false);
  assert.equal(shouldTouchLastActive(new Date(NOW.getTime() - 61 * 60_000).toISOString(), NOW), true);
  assert.equal(shouldTouchLastActive("not a date", NOW), true);
});

test("an essay body changed only when its text differs", () => {
  assert.equal(essayBodyChanged("draft", "draft"), false);
  assert.equal(essayBodyChanged(null, ""), false);
  assert.equal(essayBodyChanged(undefined, null), false);
  assert.equal(essayBodyChanged("draft", "draft two"), true);
  assert.equal(essayBodyChanged(null, "first words"), true);
});

test("titles carry a first name only, bounded, and never essay text", () => {
  assert.equal(firstNameOf("  Ana María Lopez "), "Ana");
  assert.equal(firstNameOf(""), "Your student");
  assert.equal(firstNameOf(null), "Your student");
  assert.equal(firstNameOf("x".repeat(80)).length, 40);
  assert.equal(inactivityTitle("Ana Lopez", 9), "Ana hasn't been active in 9 days");
  assert.equal(inactivityTitle("Ana Lopez", 1), "Ana hasn't been active in 1 day");
  assert.equal(essayNoticeTitle("Ana Lopez"), "Ana worked on an essay");
});

test("essay notice throttles: one an essay per six hours, twenty a student a day", () => {
  assert.equal(ESSAY_NOTICE_PER_ESSAY_SECONDS, 6 * 3600);
  assert.equal(ESSAY_NOTICES_PER_STUDENT_DAY, 20);
});
