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

test("email goes only to the sign-in address, never the one typed in Settings", async () => {
  const { reminderDestinations } = await import("../../src/lib/studentReminders.js");
  const to = reminderDestinations(
    { email_enabled: true, sms_enabled: false, sms_phone: null },
    { email: "student@school.test", phone_recorded_by_counselor: null }
  );
  assert.deepEqual(to, { email: "student@school.test", sms: null });
  assert.equal(reminderDestinations({ email_enabled: false }, { email: "student@school.test" }).email, null);
});

test("a text goes only to the number the counselor recorded, and only when the student chose that number", async () => {
  const { reminderDestinations, normalizePhone } = await import("../../src/lib/studentReminders.js");
  assert.equal(normalizePhone("(555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("1 555 123 4567"), "+15551234567");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("123"), null);
  const recorded = { email: "s@x.test", phone_recorded_by_counselor: "(555) 123-4567" };
  assert.equal(reminderDestinations({ sms_enabled: true, sms_phone: "+15551234567" }, recorded).sms, "+15551234567");
  assert.equal(reminderDestinations({ sms_enabled: true, sms_phone: "+19005550100" }, recorded).sms, null, "a stranger's number");
  assert.equal(reminderDestinations({ sms_enabled: true, sms_phone: "+15551234567" }, { email: "s@x.test" }).sms, null, "nothing recorded");
  assert.equal(reminderDestinations({ sms_enabled: false, sms_phone: "+15551234567" }, recorded).sms, null);
});

test("a text never carries a title the student wrote, and a counselor's title is short and link-free", async () => {
  const { smsTitle, reminderSms, SMS_TITLE_MAX } = await import("../../src/lib/studentReminders.js");
  assert.equal(smsTitle("Click https://evil.example/login to verify", "student"), null);
  assert.equal(smsTitle("Common App essay", "student"), null);
  assert.equal(smsTitle("Common App essay", "counselor"), "Common App essay");
  assert.equal(smsTitle("See www.evil.example", "counselor"), null);
  assert.equal(smsTitle("Visit evil.com now", "counselor"), null);
  assert.equal(smsTitle("Call 5551234567", "counselor"), null);
  const long = smsTitle("x".repeat(200), "counselor")!;
  assert.ok(long.length <= SMS_TITLE_MAX);
  const generic = reminderSms(null, "https://app.meridiesai.com/dashboard/student?task=x");
  assert.ok(generic.startsWith("Meridies: a task on your To-Do is due tomorrow."));
  assert.ok(generic.length < 160);
});

test("an email never carries a title the student wrote, nor a long display name", async () => {
  const { emailTitle, reminderSubject, reminderEmail, greetingName } = await import("../../src/lib/studentReminders.js");
  assert.equal(emailTitle("Verify at https://evil.example", "student"), null);
  assert.equal(emailTitle("Verify at https://evil.example", null), null);
  assert.equal(emailTitle("Common App essay", "counselor"), "Common App essay");
  assert.equal(reminderSubject(null), "A task on your To-Do is due tomorrow");
  assert.equal(reminderSubject("Common App essay"), "Due tomorrow: Common App essay");
  assert.ok(reminderSubject("x".repeat(400)).length <= 120);
  const generic = reminderEmail("Ana", null, "https://app.test/x");
  assert.ok(!JSON.stringify(generic).includes("evil"));
  assert.equal(greetingName("  Ana Maria Lopez "), "Ana");
  assert.equal(greetingName(""), "there");
  assert.equal(greetingName("x".repeat(300)).length, 40);
});
