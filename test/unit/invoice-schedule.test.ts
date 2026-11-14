import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, reminderState, resolveSendTime, SEND_HOUR, validateReminderOffsets, nextYearlyDraft } from "../../src/lib/invoiceSchedule.js";

const NY = "America/New_York";
// 2026-11-13 15:00 UTC = 10:00 EST that morning.
const NOW = Date.parse("2026-11-13T15:00:00Z");

test("send now has no time", () => {
  assert.deepEqual(resolveSendTime({ mode: "now" }, { dueOn: "2026-11-30", tz: NY, now: NOW }), { ok: true, sendAt: null });
});

test("tomorrow is 9:00 tomorrow in the practice's zone", () => {
  // 9:00 EST on Nov 14 = 14:00 UTC.
  assert.deepEqual(resolveSendTime({ mode: "tomorrow" }, { dueOn: "2026-11-30", tz: NY, now: NOW }), { ok: true, sendAt: "2026-11-14T14:00:00.000Z" });
});

test("tomorrow is read in the practice's zone, not UTC", () => {
  // 02:00 UTC on Nov 14 is still Nov 13 evening in New York: tomorrow is Nov 14.
  const late = Date.parse("2026-11-14T02:00:00Z");
  assert.deepEqual(resolveSendTime({ mode: "tomorrow" }, { dueOn: "2026-11-30", tz: NY, now: late }), { ok: true, sendAt: "2026-11-14T14:00:00.000Z" });
  // The same instant in UTC would say tomorrow is Nov 15 at 9:00 UTC.
  assert.deepEqual(resolveSendTime({ mode: "tomorrow" }, { dueOn: "2026-11-30", tz: "UTC", now: late }), { ok: true, sendAt: "2026-11-15T09:00:00.000Z" });
});

test("N days before due is 9:00 that day, across the clock change", () => {
  // Due Nov 5, 2026; 7 days before is Oct 29 (EDT, UTC-4): 13:00 UTC. From Oct 1.
  const oct = Date.parse("2026-10-01T12:00:00Z");
  assert.deepEqual(resolveSendTime({ mode: "before_due", daysBefore: 7 }, { dueOn: "2026-11-05", tz: NY, now: oct }), { ok: true, sendAt: "2026-10-29T13:00:00.000Z" });
  // Due Nov 12; 7 days before is Nov 5 (EST): 14:00 UTC.
  assert.deepEqual(resolveSendTime({ mode: "before_due", daysBefore: 7 }, { dueOn: "2026-11-12", tz: NY, now: oct }), { ok: true, sendAt: "2026-11-05T14:00:00.000Z" });
});

test("a time already past is refused with a reason, never silently sent now", () => {
  const r = resolveSendTime({ mode: "before_due", daysBefore: 30 }, { dueOn: "2026-11-20", tz: NY, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "send_time_passed");
  // Today at 9:00 is already past at 10:00.
  assert.equal(resolveSendTime({ mode: "date", date: "2026-11-13" }, { dueOn: "2026-11-30", tz: NY, now: NOW }).ok, false);
});

test("pick a date sends at 9:00 that day", () => {
  assert.deepEqual(resolveSendTime({ mode: "date", date: "2026-11-20" }, { dueOn: "2026-11-30", tz: NY, now: NOW }), { ok: true, sendAt: "2026-11-20T14:00:00.000Z" });
});

test("a bad zone falls back to UTC", () => {
  assert.deepEqual(resolveSendTime({ mode: "date", date: "2026-11-20" }, { dueOn: "2026-11-30", tz: "Not/AZone", now: NOW }), { ok: true, sendAt: `2026-11-20T0${SEND_HOUR}:00:00.000Z` });
});

test("addDays works on plain dates across months and years", () => {
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("reminder offsets: small whole numbers, no repeats, at most five", () => {
  assert.deepEqual(validateReminderOffsets([3, -3, 0, 3]), { ok: true, offsets: [-3, 0, 3] });
  assert.equal(validateReminderOffsets([1, 2, 3, 4, 5, 6]).ok, false);
  assert.equal(validateReminderOffsets([45]).ok, false);
  assert.equal(validateReminderOffsets([1.5]).ok, false);
  assert.deepEqual(validateReminderOffsets([]), { ok: true, offsets: [] });
});

test("a reminder is due from 9:00 on its day, for a day and a half, then stale", () => {
  const due = "2026-11-20";
  // -3 => Nov 17 at 9:00 EST = 14:00 UTC.
  assert.equal(reminderState(due, -3, Date.parse("2026-11-17T13:59:00Z"), NY), "later");
  assert.equal(reminderState(due, -3, Date.parse("2026-11-17T14:00:00Z"), NY), "due");
  assert.equal(reminderState(due, -3, Date.parse("2026-11-18T20:00:00Z"), NY), "due");
  assert.equal(reminderState(due, -3, Date.parse("2026-11-19T14:00:00Z"), NY), "stale");
  // On the due date itself and three days after.
  assert.equal(reminderState(due, 0, Date.parse("2026-11-20T15:00:00Z"), NY), "due");
  assert.equal(reminderState(due, 3, Date.parse("2026-11-23T15:00:00Z"), NY), "due");
});

test("a yearly draft rolls its send time and its due date a year on", () => {
  const next = nextYearlyDraft({ sendAt: "2026-11-14T14:00:00.000Z", dueOn: "2026-11-30", tz: NY });
  assert.deepEqual(next, { sendAt: "2027-11-14T14:00:00.000Z", dueOn: "2027-11-30" });
  assert.equal(nextYearlyDraft({ sendAt: "2028-02-29T14:00:00.000Z", dueOn: "2028-02-29", tz: NY }).dueOn, "2029-02-28");
});
