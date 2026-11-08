import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarFeedItem } from "../../src/lib/calendarFeed.js";
import { buildFeedIcs, feedIcsEvents, feedUid, shortName } from "../../src/lib/ics.js";
import { loggedUrl } from "../../src/lib/requestLog.js";

const NOW = new Date("2027-01-01T12:00:00Z");

function item(over: Partial<CalendarFeedItem> = {}): CalendarFeedItem {
  return {
    id: "deadline:11111111-1111-4111-8111-111111111111",
    kind: "deadline",
    ref: "11111111-1111-4111-8111-111111111111",
    type: "deadline",
    title: "Common App essay",
    date: "2027-01-15",
    startsAt: null,
    endsAt: null,
    allDay: true,
    studentId: "s1",
    attendeeIds: [],
    detail: "Private description",
    done: false,
    meetingStatus: null,
    taskId: null,
    school: null,
    ...over,
  };
}
const names = new Map([
  ["s1", "Ana María Pérez"],
  ["s2", "Ben Okafor"],
]);
const lines = (ics: string) => ics.split("\r\n");
/** Unfold (RFC 5545 3.1) so a property can be read whole. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

test("the calendar: PUBLISH, named Meridies, refreshed hourly, CRLF throughout", () => {
  const ics = buildFeedIcs([], { now: NOW });
  const ls = lines(ics);
  assert.equal(ls[0], "BEGIN:VCALENDAR");
  for (const l of [
    "VERSION:2.0",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Meridies",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ]) assert.ok(ls.includes(l), l);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends in CRLF");
});

test("short names: first name and last initial", () => {
  assert.equal(shortName("Ana María Pérez"), "Ana P.");
  assert.equal(shortName("  Ben  "), "Ben");
  assert.equal(shortName(""), null);
  assert.equal(shortName(null), null);
});

test("UIDs are feed-<kind>-<ref>@meridiesai.com, and the two college dates of one row differ", () => {
  assert.equal(feedUid("meeting:abc"), "feed-meeting-abc@meridiesai.com");
  assert.equal(feedUid("college:r1"), "feed-college-r1@meridiesai.com");
  assert.equal(feedUid("college-custom:r1"), "feed-college-custom-r1@meridiesai.com");
  assert.equal(feedUid("test:s1"), "feed-test-s1@meridiesai.com");
  // Nothing but letters, digits and dashes before the @.
  assert.equal(feedUid("x:a b\r\nc"), "feed-x-a-b--c@meridiesai.com");
});

test("an all-day item is VALUE=DATE, ending the next day", () => {
  const ics = buildFeedIcs(feedIcsEvents([item({ date: "2027-12-31" })], names), { now: NOW });
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20271231\r\n"));
  assert.ok(ics.includes("DTEND;VALUE=DATE:20280101\r\n"));
  assert.ok(ics.includes("UID:feed-deadline-11111111-1111-4111-8111-111111111111@meridiesai.com\r\n"));
  assert.ok(ics.includes("DTSTAMP:20270101T120000Z\r\n"));
});

test("a timed item is written in UTC", () => {
  const ics = buildFeedIcs(
    feedIcsEvents(
      [item({ id: "meeting:m1", kind: "meeting", ref: "m1", allDay: false, startsAt: "2027-01-15T09:30:00-05:00", endsAt: "2027-01-15T10:15:00-05:00", attendeeIds: ["s1"] })],
      names
    ),
    { now: NOW }
  );
  assert.ok(ics.includes("DTSTART:20270115T143000Z\r\n"));
  assert.ok(ics.includes("DTEND:20270115T151500Z\r\n"));
});

test("commas, semicolons, backslashes and newlines are escaped", () => {
  const ics = unfold(buildFeedIcs(feedIcsEvents([item({ studentId: null, title: "a,b;c\\d\ne" })], names), { now: NOW }));
  assert.ok(ics.includes("SUMMARY:a\\,b\\;c\\\\d\\ne\r\n"), ics);
});

test("a title can't start a property line of its own", () => {
  const evil = "x\r\nATTENDEE:mailto:evil@example.com\rEND:VEVENT\nBEGIN:VEVENT";
  const ics = buildFeedIcs(feedIcsEvents([item({ studentId: null, title: evil })], names), { now: NOW });
  const ls = lines(ics);
  assert.ok(!ls.some((l) => l.startsWith("ATTENDEE")), "no ATTENDEE line");
  assert.equal(ls.filter((l) => l === "BEGIN:VEVENT").length, 1);
  assert.equal(ls.filter((l) => l === "END:VEVENT").length, 1);
  // Every line is a property, a continuation (leading space) or empty at the very end.
  for (const l of ls.slice(0, -1)) assert.match(l, /^([A-Z-]+[;:]| )/);
});

test("long lines fold at 75 octets without splitting a character", () => {
  const ics = buildFeedIcs(feedIcsEvents([item({ studentId: null, title: "é".repeat(120) + " deadline" })], names), { now: NOW });
  for (const l of lines(ics)) assert.ok(Buffer.byteLength(l, "utf8") <= 75, `${Buffer.byteLength(l, "utf8")}: ${l}`);
  assert.ok(unfold(ics).includes(`SUMMARY:${"é".repeat(120)} deadline`));
  assert.ok(!ics.includes("�"));
});

test("privacy: meetings show first name and last initial, never title, agenda, location or link", () => {
  const meeting = item({
    id: "meeting:m1",
    kind: "meeting",
    ref: "m1",
    title: "Pérez family: FAFSA and scores 1520",
    detail: "Agenda: discuss SAT 1520 https://meet.google.com/abc-defg-hij",
    allDay: false,
    startsAt: "2027-01-15T14:00:00Z",
    endsAt: "2027-01-15T15:00:00Z",
    studentId: "s1",
    attendeeIds: ["s1", "s2"],
    meetingStatus: "scheduled",
  });
  const ics = unfold(buildFeedIcs(feedIcsEvents([meeting], names), { now: NOW }));
  assert.ok(ics.includes("SUMMARY:Meeting with Ana P.\\, Ben O.\r\n"), ics);
  for (const banned of ["Pérez", "Okafor", "FAFSA", "1520", "meet.google", "Agenda", "DESCRIPTION", "LOCATION", "URL:", "ATTENDEE", "ORGANIZER"]) {
    assert.ok(!ics.includes(banned), banned);
  }
});

test("privacy: no item carries its detail, a student's item is named by first name and initial", () => {
  const evs = feedIcsEvents(
    [
      item(),
      item({ id: "college-custom:r1", ref: "r1", title: "Stanford: your deadline", detail: "The school's deadline is Jan 5, 2027" }),
      item({ id: "test:s2", kind: "milestone", type: "test", ref: "s2", studentId: "s2", title: "Planned test date", detail: "Scheduled" }),
      item({ id: "milestone:p1", kind: "milestone", type: "milestone", ref: "p1", studentId: null, title: "Practice retreat", detail: "notes" }),
    ],
    names
  );
  const ics = unfold(buildFeedIcs(evs, { now: NOW }));
  assert.ok(ics.includes("SUMMARY:Ana P.: Common App essay\r\n"));
  assert.ok(ics.includes("SUMMARY:Ana P.: Stanford: your deadline\r\n"));
  assert.ok(ics.includes("SUMMARY:Ben O.: Planned test date\r\n"));
  assert.ok(ics.includes("SUMMARY:Practice retreat\r\n"));
  for (const banned of ["Private description", "Scheduled", "notes", "The school's", "Pérez", "Okafor", "DESCRIPTION"]) {
    assert.ok(!ics.includes(banned), banned);
  }
});

test("privacy: a student's own events and cancelled meetings never reach the file", () => {
  const evs = feedIcsEvents(
    [
      item({ id: "personal:p1", kind: "milestone", type: "personal", personal: true, title: "Therapy" }),
      item({ id: "meeting:m2", kind: "meeting", ref: "m2", allDay: false, startsAt: "2027-01-15T14:00:00Z", endsAt: null, meetingStatus: "cancelled", attendeeIds: ["s1"] }),
    ],
    names
  );
  assert.equal(evs.length, 0);
});

test("a student not named in the map reads as 'A student'", () => {
  const ics = unfold(buildFeedIcs(feedIcsEvents([item({ studentId: "unknown" })], names), { now: NOW }));
  assert.ok(ics.includes("SUMMARY:A student: Common App essay\r\n"));
});

test("the feed token never reaches the logs", () => {
  const token = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXU";
  assert.equal(loggedUrl(`/calendar/ical/${token}.ics`), "/calendar/ical/…");
  assert.equal(loggedUrl(`//calendar/ical/${token}.ics?x=1`), "/calendar/ical/…?x=…");
  assert.ok(!loggedUrl(`/calendar/ical/${token}.ics`).includes(token));
  assert.equal(loggedUrl("/calendar/ical"), "/calendar/ical");
  assert.equal(loggedUrl("/calendar/feed"), "/calendar/feed");
});
