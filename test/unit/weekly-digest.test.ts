import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/lib/accountability.js";
import { ALERT_DEFAULTS, type SettingsRow } from "../../src/lib/inactivity.js";
import {
  DIGEST_DEFAULT_TIMEZONE,
  buildWeeklyDigest,
  digestWanted,
  essayMovement,
  lastCompletedWeek,
  zonedDayStartUtc,
  type DigestInput,
} from "../../src/lib/weeklyDigestContent.js";
import { planReportRecipients, reportMessages, smsTextOf, type GuardianRow } from "../../src/lib/familyReportSend.js";

// ---- Week boundaries ---------------------------------------------------------------------------------------

test("the last completed week is the Monday-Sunday before this one, in the counselor's zone", () => {
  // Saturday 2026-11-07 15:00 UTC = Saturday morning in New York: last week is Oct 26 - Nov 1.
  const w = lastCompletedWeek(new Date("2026-11-07T15:00:00Z"), "America/New_York");
  assert.equal(w.periodStart, "2026-10-26");
  assert.equal(w.periodEnd, "2026-11-01");
  assert.equal(w.nextMonday, "2026-11-02");
});

test("on a Monday the week that just ended is the one reported", () => {
  const w = lastCompletedWeek(new Date("2026-11-09T05:30:00Z"), "America/New_York"); // Mon 00:30 New York
  assert.equal(w.periodStart, "2026-11-02");
  assert.equal(w.periodEnd, "2026-11-08");
});

test("the counselor's zone decides the day: Sunday night in Los Angeles is Monday in UTC", () => {
  const at = new Date("2026-11-09T05:30:00Z"); // Sun 21:30 in Los Angeles
  assert.equal(lastCompletedWeek(at, "America/Los_Angeles").periodStart, "2026-10-26");
  assert.equal(lastCompletedWeek(at, "UTC").periodStart, "2026-11-02");
});

test("a week across the end of daylight saving time starts and ends at local midnight", () => {
  // US DST ended Sunday 2026-11-01 at 02:00 local. The week Oct 26 - Nov 1 is 169 hours long in New York.
  const w = lastCompletedWeek(new Date("2026-11-03T12:00:00Z"), "America/New_York");
  assert.equal(w.periodStart, "2026-10-26");
  assert.equal(w.startUtc, "2026-10-26T04:00:00.000Z"); // EDT, UTC-4
  assert.equal(w.endUtc, "2026-11-02T05:00:00.000Z"); // EST, UTC-5
  assert.equal(Date.parse(w.endUtc) - Date.parse(w.startUtc), 169 * 3_600_000);
});

test("a week across the start of daylight saving time is 167 hours", () => {
  // US DST began Sunday 2026-03-08.
  const w = lastCompletedWeek(new Date("2026-03-10T12:00:00Z"), "America/New_York");
  assert.equal(w.periodStart, "2026-03-02");
  assert.equal(Date.parse(w.endUtc) - Date.parse(w.startUtc), 167 * 3_600_000);
});

test("local midnight in a zone east of UTC is the day before in UTC", () => {
  assert.equal(zonedDayStartUtc("2026-11-02", "Asia/Tokyo"), "2026-11-01T15:00:00.000Z");
  assert.equal(zonedDayStartUtc("2026-11-02", "Asia/Kolkata"), "2026-11-01T18:30:00.000Z");
});

test("an unknown zone falls back to the documented default", () => {
  const at = new Date("2026-11-07T15:00:00Z");
  assert.deepEqual(lastCompletedWeek(at, "Not/AZone"), lastCompletedWeek(at, DIGEST_DEFAULT_TIMEZONE));
  assert.deepEqual(lastCompletedWeek(at, null), lastCompletedWeek(at, DIGEST_DEFAULT_TIMEZONE));
  assert.equal(DIGEST_DEFAULT_TIMEZONE, "America/New_York");
});

// ---- Who gets a digest ---------------------------------------------------------------------------------------

const C = "c0000000-0000-0000-0000-000000000001";
const S1 = "50000000-0000-0000-0000-000000000001";
const S2 = "50000000-0000-0000-0000-000000000002";
const row = (over: Partial<SettingsRow>): SettingsRow => ({ ...DEFAULT_SETTINGS, ...ALERT_DEFAULTS, counselor_id: C, student_id: null, ...over }) as SettingsRow;

test("the counselor-wide row switches the digest on; a per-student row overrides it either way", () => {
  assert.equal(digestWanted([row({ weekly_digest: "draft" })], S1), true);
  assert.equal(digestWanted([row({ weekly_digest: "off" })], S1), false);
  assert.equal(digestWanted([], S1), false);
  const rows = [row({ weekly_digest: "draft" }), row({ student_id: S1, weekly_digest: "off" })];
  assert.equal(digestWanted(rows, S1), false);
  assert.equal(digestWanted(rows, S2), true);
  assert.equal(digestWanted([row({ weekly_digest: "off" }), row({ student_id: S2, weekly_digest: "draft" })], S2), true);
});

// ---- Essay movement ---------------------------------------------------------------------------------------------

const WEEK = lastCompletedWeek(new Date("2026-11-09T12:00:00Z"), "UTC"); // Nov 2 - Nov 8
const E1 = "e0000000-0000-0000-0000-000000000001";
const E2 = "e0000000-0000-0000-0000-000000000002";
const E3 = "e0000000-0000-0000-0000-000000000003";

test("essay movement compares the last count before the week with the last count in it", () => {
  const moves = essayMovement({
    week: WEEK,
    essays: [
      { id: E1, essay_kind: "personal-statement", school: null, created_at: "2026-09-01T00:00:00Z" },
      { id: E2, essay_kind: "supplement", school: "Boston University", created_at: "2026-11-03T00:00:00Z" },
      { id: E3, essay_kind: "supplement", school: null, created_at: "2026-09-01T00:00:00Z" },
    ],
    before: [
      { entity_id: E1, word_count: 300, created_at: "2026-10-20T00:00:00Z" },
      { entity_id: E1, word_count: 327, created_at: "2026-10-30T00:00:00Z" },
      { entity_id: E3, word_count: 100, created_at: "2026-10-30T00:00:00Z" },
    ],
    during: [
      { entity_id: E1, word_count: 380, created_at: "2026-11-03T00:00:00Z" },
      { entity_id: E1, word_count: 412, created_at: "2026-11-05T00:00:00Z" },
      { entity_id: E2, word_count: 150, created_at: "2026-11-04T00:00:00Z" },
      { entity_id: E3, word_count: 100, created_at: "2026-11-04T00:00:00Z" },
    ],
  });
  assert.deepEqual(moves, [
    { label: "Personal statement", words: 412, delta: 85 },
    { label: "Boston University supplement", words: 150, delta: 150 },
  ]);
});

test("an essay with no count before the week and not started in it is left out (no baseline)", () => {
  const moves = essayMovement({
    week: WEEK,
    essays: [{ id: E1, essay_kind: "personal-statement", school: null, created_at: "2026-09-01T00:00:00Z" }],
    before: [],
    during: [{ entity_id: E1, word_count: 400, created_at: "2026-11-03T00:00:00Z" }],
  });
  assert.deepEqual(moves, []);
});

test("an 'other' essay and an essay that isn't the student's are never reported", () => {
  const moves = essayMovement({
    week: WEEK,
    essays: [{ id: E1, essay_kind: "other", school: null, created_at: "2026-11-03T00:00:00Z" }],
    before: [],
    during: [
      { entity_id: E1, word_count: 50, created_at: "2026-11-03T00:00:00Z" },
      { entity_id: E2, word_count: 50, created_at: "2026-11-03T00:00:00Z" },
    ],
  });
  assert.deepEqual(moves, []);
});

// ---- The content ------------------------------------------------------------------------------------------------

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  fullName: "Ana María Lopez",
  week: WEEK,
  completed: [],
  open: [],
  deadlines: [],
  essays: [],
  ...over,
});

test("nothing done, nothing due and no essay change: no digest", () => {
  assert.equal(buildWeeklyDigest(input()), null);
});

test("the digest lists what was done, what is due or overdue, deadlines and word counts, first name only", () => {
  const d = buildWeeklyDigest(
    input({
      completed: [{ title: "Upload transcript" }, { title: "Activities list" }],
      open: [
        { title: "Brag sheet", due_date: "2026-10-30" },
        { title: "Ask for a recommendation", due_date: "2026-11-12" },
      ],
      deadlines: [{ name: "Boston University", date: "2026-11-15" }],
      essays: [{ label: "Personal statement", words: 412, delta: 85 }],
    })
  );
  assert.ok(d);
  assert.equal(d.title, "Ana's week: Nov 2 to Nov 8");
  assert.match(d.body, /^Here is Ana's week, Monday Nov 2 to Sunday Nov 8\./);
  assert.match(d.body, /Finished this week \(2\):\n- Upload transcript\n- Activities list/);
  assert.match(d.body, /- Overdue since Oct 30: Brag sheet/);
  assert.match(d.body, /- Due Nov 12: Ask for a recommendation/);
  assert.match(d.body, /College deadlines in the next two weeks:\n- Boston University: Nov 15/);
  assert.match(d.body, /- Personal statement: 412 words, \+85 this week/);
  assert.ok(!/María|Lopez/.test(d.body + d.title + d.summary + d.highlights.join(" ")), "first name only");
  assert.equal(d.summary, "Ana's week (Nov 2 to Nov 8): 2 tasks finished, 1 overdue, 1 due in the next two weeks, 1 college deadline coming up, essays +85 words.");
  assert.deepEqual(d.highlights, [
    "2 tasks finished",
    "1 overdue",
    "1 due in the next two weeks",
    "1 college deadline coming up",
    "Personal statement: 412 words, +85 this week",
  ]);
  assert.ok(d.summary.length <= 320);
});

test("an essay that lost words reads as a minus", () => {
  const d = buildWeeklyDigest(input({ essays: [{ label: "Personal statement", words: 600, delta: -40 }] }));
  assert.ok(d);
  assert.match(d.body, /Personal statement: 600 words, -40 this week/);
});

test("long lists are capped and say how many more there are", () => {
  const completed = Array.from({ length: 14 }, (_, i) => ({ title: `Task ${i + 1}` }));
  const d = buildWeeklyDigest(input({ completed }));
  assert.ok(d);
  assert.match(d.body, /- Task 10\n- and 4 more/);
  assert.ok(!d.body.includes("Task 11"));
});

test("a title is one line and bounded", () => {
  const d = buildWeeklyDigest(input({ completed: [{ title: `Line one\nline two ${"x".repeat(300)}` }] }));
  assert.ok(d);
  const line = d.body.split("\n").find((l) => l.startsWith("- Line one"));
  assert.ok(line && !line.includes("\n") && line.length <= 2 + 120);
});

test("no essay text can reach the digest: the builder only takes labels and numbers", () => {
  const SENTINEL = "SENTINEL-ESSAY-TEXT";
  // An essay row carrying a body and title is ignored past its kind and school.
  const moves = essayMovement({
    week: WEEK,
    essays: [{ id: E1, essay_kind: "personal-statement", school: null, created_at: "2026-11-03T00:00:00Z", body: SENTINEL, title: SENTINEL, prompt: SENTINEL } as never],
    before: [],
    during: [{ entity_id: E1, word_count: 10, created_at: "2026-11-03T00:00:00Z", body: SENTINEL } as never],
  });
  const d = buildWeeklyDigest(input({ essays: moves }));
  assert.ok(d);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
});

// ---- Who would receive it ---------------------------------------------------------------------------------------

const g = (over: Partial<GuardianRow>): GuardianRow => ({
  id: "g0000000-0000-0000-0000-000000000001",
  full_name: "Rosa Lopez",
  email: "rosa@example.com",
  phone: "+15555550100",
  relationship: "Mother",
  preferred_channel: "email",
  alerts_enabled: true,
  receives_reports: true,
  ...over,
});

test("recipients need copy_parents, alerts on and reports on, and reach them on their preferred channel", () => {
  const plan = planReportRecipients(
    [
      g({ id: "g1", preferred_channel: "email" }),
      g({ id: "g2", preferred_channel: "sms" }),
      g({ id: "g3", preferred_channel: "both" }),
      g({ id: "g4", alerts_enabled: false }),
      g({ id: "g5", receives_reports: false }),
      g({ id: "g6", preferred_channel: "sms", phone: null }),
      g({ id: "g7", preferred_channel: "both", email: null }),
    ],
    { copy_parents: true, copy_student: false }
  );
  assert.deepEqual(
    plan.recipients.map((r) => [r.guardianId, r.channels]),
    [
      ["g1", ["email"]],
      ["g2", ["sms"]],
      ["g3", ["email", "sms"]],
      ["g7", ["sms"]],
    ]
  );
  assert.deepEqual(plan.skipped, { optedOut: 2, noContact: 1, parentsOff: 0 });
  assert.deepEqual(
    plan.skippedGuardians.map((s) => [s.guardianId, s.reason]),
    [
      ["g4", "opted-out"],
      ["g5", "opted-out"],
      ["g6", "no-contact"],
    ]
  );
});

test("with copy_parents off nobody receives it, and every guardian is counted as switched off", () => {
  const plan = planReportRecipients([g({ id: "g1" }), g({ id: "g2" })], { copy_parents: false, copy_student: false });
  assert.deepEqual(plan.recipients, []);
  assert.deepEqual(plan.skipped, { optedOut: 0, noContact: 0, parentsOff: 2 });
});

test("the messages are exactly what the dispatcher will send: a greeting, the report, the footer; a text with its opener", () => {
  const plan = planReportRecipients([g({ id: "g1", preferred_channel: "both" })], { copy_parents: true, copy_student: false });
  const report = { title: "Ana's week: Nov 2 to Nov 8", summary: "Ana's week: 2 tasks finished.", body: "Here is Ana's week.\n\nFinished this week (2):\n- A\n- B" };
  const msgs = reportMessages(report, plan.recipients, { counselorName: "Dana Reed", studentName: "Ana María Lopez" });
  const email = msgs.find((m) => m.channel === "email");
  const sms = msgs.find((m) => m.channel === "sms");
  assert.ok(email && sms);
  assert.equal(email.subject, "Ana's week: Nov 2 to Nov 8");
  assert.equal(email.to, "rosa@example.com");
  assert.match(email.text, /^Ana's week: Nov 2 to Nov 8\n\nDear Rosa,\nHere is Ana's week\./);
  assert.match(email.text, /Sent by Dana Reed through Meridies/);
  assert.equal(sms.to, "+15555550100");
  assert.equal(sms.text, "Hi Rosa, it's Dana Reed about Ana: Ana's week: 2 tasks finished.");
});

test("a report's text is its summary, or its body, kept to one text's length", () => {
  assert.equal(smsTextOf({ title: "T", summary: "Short.", body: "Long body" }), "Short.");
  assert.equal(smsTextOf({ title: "T", summary: null, body: "Body only" }), "Body only");
  const long = smsTextOf({ title: "T", summary: null, body: "x".repeat(1000) });
  assert.equal(long.length, 320);
  assert.ok(long.endsWith("…"));
  assert.equal(smsTextOf({ title: "Title only", summary: "  ", body: null }), "Title only");
});
