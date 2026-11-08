// GET /me/booking/types: why booking isn't available, and the counselor's two change rules (lib/booking.ts
// bookingTypesAnswer). Pure: the route reads the rows, this decides what the student is told.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingTypesAnswer, type MeetingTypeDto } from "../../src/lib/booking.js";

const type: MeetingTypeDto = { id: "t1", name: "Check-in", durationMinutes: 30, mode: "phone", active: true, sortOrder: 0 };
const row = {
  enabled: true,
  time_zone: "America/Chicago",
  weekly_hours: { 1: [{ start: "09:00", end: "12:00" }] },
  min_notice_hours: 24,
  max_days_ahead: 30,
  buffer_minutes: 15,
  cancel_cutoff_hours: 6,
  students_can_reschedule: false,
};
const SETTING_KEYS = ["cutoffHours", "studentsCanChange"];
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

test("no counselor or an unapproved one: counselor_unavailable, and nothing about their settings", () => {
  for (const a of [
    bookingTypesAnswer({ hasCounselor: false, approved: false, settingsRow: row, types: [type] }),
    bookingTypesAnswer({ hasCounselor: true, approved: false, settingsRow: row, types: [type] }),
  ]) {
    assert.deepEqual(a, { available: false, reason: "counselor_unavailable", timeZone: null, types: [] });
  }
});

test("never set up: not_set_up, no settings fields", () => {
  const a = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: null, types: [] });
  assert.deepEqual(a, { available: false, reason: "not_set_up", timeZone: null, types: [] });
});

test("paused: the two change rules, still nothing else", () => {
  const a = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: { ...row, enabled: false }, types: [type] });
  assert.deepEqual(a, { available: false, reason: "paused", timeZone: null, types: [], cutoffHours: 6, studentsCanChange: false });
});

test("on but no active types: no_types, with the change rules", () => {
  const a = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: row, types: [] });
  assert.deepEqual(a, { available: false, reason: "no_types", timeZone: null, types: [], cutoffHours: 6, studentsCanChange: false });
});

test("available: the types, the zone and the change rules; never hours, notice, buffer or calendar state", () => {
  const a = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: { ...row, students_can_reschedule: true }, types: [type] });
  assert.deepEqual(a, { available: true, reason: null, timeZone: "America/Chicago", types: [type], cutoffHours: 6, studentsCanChange: true });
  for (const k of Object.keys(a)) assert.ok(["available", "reason", "timeZone", "types", ...SETTING_KEYS].includes(k), k);
  assert.ok(SETTING_KEYS.every((k) => has(a, k)));
});
