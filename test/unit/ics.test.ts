// lib/ics.ts: the iCalendar file a meeting invite carries. RFC 5545 line
// folding and escaping, the stable UID, and nothing typed by a person can
// start a property line of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMeetingIcs,
  escapeText,
  foldLine,
  icsDate,
  meetingUid,
  meetingWhere,
  paramValue,
  plainLine,
  safeUrl,
  type IcsEventInput,
} from "../../src/lib/ics.js";

const ID = "6f1c1f9e-2a7b-4c3d-9e8f-0123456789ab";
const NOW = new Date("2026-10-15T12:00:00Z");

function event(over: Partial<IcsEventInput> = {}): IcsEventInput {
  return {
    meetingId: ID,
    sequence: 0,
    method: "REQUEST",
    startsAt: "2026-10-20T19:00:00Z",
    endsAt: "2026-10-20T19:45:00Z",
    title: "Essay check-in",
    agenda: null,
    mode: "in-person",
    location: "Room 4",
    joinUrl: null,
    organizer: { name: "Dana Counselor", email: "dana@practice.test" },
    sentBy: "onboarding@resend.dev",
    attendee: { name: "Avery Student", email: "Avery@Example.com" },
    now: NOW,
    ...over,
  };
}

/** The logical lines: unfolded, without the trailing CRLF. */
function logical(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n").slice(0, -1);
}

function prop(ics: string, name: string): string[] {
  return logical(ics).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

function assertWellFormed(ics: string) {
  assert.ok(ics.endsWith("\r\n"), "ends with CRLF");
  assert.equal(/\r(?!\n)/.test(ics), false, "no bare CR");
  assert.equal(/(?<!\r)\n/.test(ics), false, "no bare LF");
  const physical = ics.split("\r\n").slice(0, -1);
  for (const line of physical) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line over 75 octets: ${line}`);
    assert.equal(Buffer.from(line, "utf8").toString("utf8"), line, "no split character");
    assert.equal(line.includes("\uFFFD"), false);
  }
}

test("a REQUEST has the calendar, the event and exactly one attendee", () => {
  const ics = buildMeetingIcs(event());
  assertWellFormed(ics);
  const lines = logical(ics);
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("METHOD:REQUEST"));
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.includes(`UID:${meetingUid(ID)}`));
  assert.ok(lines.includes("SEQUENCE:0"));
  assert.ok(lines.includes("DTSTAMP:20261015T120000Z"));
  assert.ok(lines.includes("DTSTART:20261020T190000Z"));
  assert.ok(lines.includes("DTEND:20261020T194500Z"));
  assert.ok(lines.includes("STATUS:CONFIRMED"));
  assert.ok(lines.includes("LOCATION:Room 4"));
  assert.equal(lines.at(-1), "END:VCALENDAR");
  const attendees = prop(ics, "ATTENDEE");
  assert.equal(attendees.length, 1);
  assert.match(attendees[0]!, /RSVP=FALSE/);
  assert.match(attendees[0]!, /:mailto:avery@example\.com$/, "the address is lowercased");
  assert.deepEqual(prop(ics, "ORGANIZER"), [
    'ORGANIZER;CN="Dana Counselor";SENT-BY="mailto:onboarding@resend.dev":mailto:dana@practice.test',
  ]);
});

test("CANCEL and PUBLISH carry the matching method and status", () => {
  const cancel = buildMeetingIcs(event({ method: "CANCEL", sequence: 3 }));
  assertWellFormed(cancel);
  assert.ok(logical(cancel).includes("METHOD:CANCEL"));
  assert.ok(logical(cancel).includes("STATUS:CANCELLED"));
  assert.ok(logical(cancel).includes("SEQUENCE:3"));
  assert.equal(prop(cancel, "ATTENDEE").length, 1);

  const publish = buildMeetingIcs(event({ method: "PUBLISH", attendee: null }));
  assert.ok(logical(publish).includes("METHOD:PUBLISH"));
  assert.ok(logical(publish).includes("STATUS:CONFIRMED"));
  assert.equal(prop(publish, "ATTENDEE").length, 0, "the counselor's copy names no attendee");
  assert.throws(() => buildMeetingIcs(event({ attendee: null })), /attendee/);
});

test("the UID is the meeting's and never changes", () => {
  const a = buildMeetingIcs(event({ title: "One" }));
  const b = buildMeetingIcs(event({ title: "Two", sequence: 7, startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T11:00:00Z" }));
  assert.deepEqual(prop(a, "UID"), prop(b, "UID"));
  assert.equal(meetingUid(ID), `meeting-${ID}@meridiesai.com`);
});

test("times are written in UTC; a bad or backwards time throws", () => {
  assert.equal(icsDate("2026-10-20T15:00:00-04:00"), "20261020T190000Z");
  assert.equal(icsDate("2026-10-20T19:00:00.123Z"), "20261020T190000Z");
  assert.throws(() => icsDate("not a time"));
  assert.throws(() => buildMeetingIcs(event({ endsAt: "" })));
  assert.throws(() => buildMeetingIcs(event({ endsAt: "2026-10-20T18:00:00Z" })), /end after/);
  assert.throws(() => buildMeetingIcs(event({ sequence: -1 })));
});

test("TEXT escaping: backslash, semicolon, comma and line breaks", () => {
  assert.equal(escapeText("a,b;c\\d\nx"), "a\\,b\\;c\\\\d\\nx");
  assert.equal(escapeText("one\r\ntwo\rthree"), "one\\ntwo\\nthree");
  assert.equal(escapeText("bell\u0007 and nul\u0000"), "bell and nul");
});

test("nothing typed can start a property of its own", () => {
  const evil = "x\r\nATTENDEE:mailto:evil@x.test\r\nMETHOD:CANCEL";
  const ics = buildMeetingIcs(
    event({
      title: evil,
      agenda: evil,
      location: evil,
      organizer: { name: evil, email: "dana@practice.test" },
      attendee: { name: `"${evil}"`, email: "avery@example.com" },
    })
  );
  assertWellFormed(ics);
  assert.equal(prop(ics, "ATTENDEE").length, 1);
  assert.equal(prop(ics, "METHOD").length, 1);
  assert.equal(logical(ics).some((l) => l.startsWith("ATTENDEE:mailto:evil")), false);
  for (const l of logical(ics)) assert.equal(/[\u0000-\u0008\u000A-\u001F]/.test(l), false, "no control characters");
});

test("parameter values are quoted with quotes and controls removed", () => {
  assert.equal(paramValue('Lee, "Pat": Jr; III'), '"Lee, Pat: Jr; III"');
  assert.equal(paramValue("a\r\nb"), '"a b"');
});

test("an address that isn't an email is refused, so the caller skips that person", () => {
  assert.throws(() => buildMeetingIcs(event({ attendee: { name: null, email: "not-an-email" } })));
  assert.throws(() => buildMeetingIcs(event({ attendee: { name: null, email: "a@b.test\r\nX:1" } })));
});

test("folding: ASCII, accents, CJK, emoji, and a surrogate pair at the break", () => {
  const ascii = `SUMMARY:${"a".repeat(300)}`;
  const folded = foldLine(ascii);
  assert.equal(folded.replace(/\r\n /g, ""), ascii);
  for (const l of folded.split("\r\n")) assert.ok(Buffer.byteLength(l) <= 75);

  for (const text of ["é".repeat(120), "日本語の説明".repeat(30), "🎓".repeat(60), `${"a".repeat(72)}🎓🎓🎓`, `${"a".repeat(73)}é${"b".repeat(80)}`]) {
    const line = `DESCRIPTION:${text}`;
    const out = foldLine(line);
    assert.equal(out.replace(/\r\n /g, ""), line, "unfolds to the same line");
    for (const l of out.split("\r\n")) {
      assert.ok(Buffer.byteLength(l, "utf8") <= 75, `${Buffer.byteLength(l)} octets`);
      assert.equal(Buffer.from(l, "utf8").toString("utf8"), l);
      assert.equal(/[\uD800-\uDBFF]$/.test(l), false, "no high surrogate left dangling");
    }
  }
  assert.equal(foldLine("SHORT:x"), "SHORT:x");
});

test("a whole file with a long multibyte agenda is well formed and unfolds exactly", () => {
  const agenda = "Bring your activity list; we'll go over essays, deadlines and 奨学金 🎓. ".repeat(20);
  const ics = buildMeetingIcs(event({ agenda }));
  assertWellFormed(ics);
  const desc = prop(ics, "DESCRIPTION")[0]!;
  assert.equal(desc, `DESCRIPTION:${escapeText(agenda.trim())}`);
});

test("the place: a Meet or Teams link, the typed place, or the mode's name", () => {
  assert.equal(meetingWhere({ mode: "google-meet", location: null, joinUrl: "https://meet.google.com/abc-defg-hij" }), "https://meet.google.com/abc-defg-hij");
  assert.equal(meetingWhere({ mode: "teams", location: null, joinUrl: null }), "Microsoft Teams");
  assert.equal(meetingWhere({ mode: "google-meet", location: "  ", joinUrl: null }), "Google Meet");
  assert.equal(meetingWhere({ mode: "phone", location: null, joinUrl: null }), "Phone call");
  assert.equal(meetingWhere({ mode: "in-person", location: "Library", joinUrl: "https://x.test" }), "Library");

  const noLink = buildMeetingIcs(event({ mode: "teams", location: null, joinUrl: null }));
  assert.ok(logical(noLink).includes("LOCATION:Microsoft Teams"));
  assert.equal(prop(noLink, "URL").length, 0);
  assert.equal(prop(noLink, "DESCRIPTION").length, 0, "no empty description");

  const linked = buildMeetingIcs(event({ mode: "google-meet", location: null, joinUrl: "https://meet.google.com/abc-defg-hij", agenda: "Plan" }));
  assert.ok(logical(linked).includes("URL:https://meet.google.com/abc-defg-hij"));
  assert.ok(logical(linked).includes("DESCRIPTION:Plan\\n\\nJoin: https://meet.google.com/abc-defg-hij"));
});

test("only http(s) links are kept", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://x.test/a\r\nB:1"), "https://x.test/aB:1");
  assert.equal(safeUrl(null), null);
  const ics = buildMeetingIcs(event({ mode: "google-meet", joinUrl: "javascript:alert(1)", location: null }));
  assert.equal(prop(ics, "URL").length, 0);
  assert.ok(logical(ics).includes("LOCATION:Google Meet"));
});

test("plainLine makes a one-line subject", () => {
  assert.equal(plainLine("Hi\r\nBcc: x@y.test\tthere\u0000"), "Hi Bcc: x@y.test there");
  assert.equal(plainLine("x".repeat(300), 10).length, 10);
});
