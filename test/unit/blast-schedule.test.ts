import assert from "node:assert/strict";
import { test } from "node:test";
import { audienceInput, nextYear, validScheduleTime } from "../../src/lib/blasts.js";

test("a yearly blast keeps its local time a year on", () => {
  // 9:00 in New York, in July (EDT, UTC-4) and again in January (EST, UTC-5).
  assert.equal(nextYear("2026-07-01T13:00:00.000Z", "America/New_York"), "2027-07-01T13:00:00.000Z");
  assert.equal(nextYear("2026-01-15T14:00:00.000Z", "America/New_York"), "2027-01-15T14:00:00.000Z");
});

test("a yearly blast stays at the same local time when the clocks change on other dates", () => {
  // 9:00 EST on 2026-11-03 (DST ended Nov 1); in 2027 DST ends Nov 7, so Nov 3 is still EDT.
  assert.equal(nextYear("2026-11-03T14:00:00.000Z", "America/New_York"), "2027-11-03T13:00:00.000Z");
});

test("February 29 becomes February 28 in a common year", () => {
  assert.equal(nextYear("2028-02-29T14:00:00.000Z", "America/New_York"), "2029-02-28T14:00:00.000Z");
});

test("an unknown time zone falls back to UTC instead of throwing", () => {
  assert.equal(nextYear("2026-06-01T09:00:00.000Z", "Not/AZone"), "2027-06-01T09:00:00.000Z");
});

test("a scheduled time must be ahead, and not years away", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  assert.equal(validScheduleTime("2026-10-30T12:00:30Z", now), false);
  assert.equal(validScheduleTime("2026-10-29T12:00:00Z", now), false);
  assert.equal(validScheduleTime("2026-10-31T12:00:00Z", now), true);
  assert.equal(validScheduleTime("2040-01-01T00:00:00Z", now), false);
  assert.equal(validScheduleTime("not a date", now), false);
});

test("an audience is filters, the ticked students and a recipient type", () => {
  const a = audienceInput.parse({});
  assert.deepEqual(a, { recipientType: "students", classYears: [], colleges: [], statuses: [] });
  assert.equal(audienceInput.parse({ recipientType: "parents", classYears: ["2027"] }).recipientType, "parents");
  assert.throws(() => audienceInput.parse({ audienceKind: "roster" }));
  assert.throws(() => audienceInput.parse({ recipientType: "everyone" }));
  assert.throws(() => audienceInput.parse({ studentIds: ["nope"] }));
});
