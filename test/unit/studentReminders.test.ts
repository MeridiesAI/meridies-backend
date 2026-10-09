import assert from "node:assert/strict";
import { test } from "node:test";
import { localDate, reminderSms, reminderTemplate } from "../../src/lib/studentReminders.js";

test("tomorrow is the counselor's calendar date, not the server's", () => {
  // 03:00 UTC on Oct 10 is still Oct 9 in New York.
  const now = new Date("2026-10-10T03:00:00Z");
  assert.equal(localDate("America/New_York", now, 0), "2026-10-09");
  assert.equal(localDate("America/New_York", now, 1), "2026-10-10");
  assert.equal(localDate("UTC", now, 1), "2026-10-11");
});

test("an unknown time zone falls back to UTC rather than throwing", () => {
  assert.equal(localDate("Not/AZone", new Date("2026-10-10T03:00:00Z"), 0), "2026-10-10");
});

test("one reminder per due date: a re-dated task gets a new template", () => {
  assert.notEqual(reminderTemplate("2026-10-10"), reminderTemplate("2026-10-11"));
  assert.ok(reminderTemplate("2026-10-10").startsWith("task-due-reminder:"));
});

test("the text fits one message and names the task", () => {
  const sms = reminderSms("Common App essay", "https://app.meridiesai.com/dashboard/student?task=x");
  assert.ok(sms.includes("Common App essay"));
  assert.ok(sms.length < 160);
});
