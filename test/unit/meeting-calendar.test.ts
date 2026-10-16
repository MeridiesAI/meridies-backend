// lib/meetingCalendar.ts: a meeting's calendar event is acted on only for its
// owner, with the caller's own id as the token owner, never the stored
// counselor_id of someone else's meeting.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calendarAccess, ownsMeeting } from "../../src/lib/meetingCalendar.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const withEvent = { counselor_id: OWNER, calendar_provider: "google", calendar_event_id: "evt12345" };

test("the owner acts on their own event with their own id", () => {
  assert.deepEqual(calendarAccess(withEvent, OWNER), {
    kind: "owner",
    ownerId: OWNER,
    provider: "google",
    eventId: "evt12345",
  });
});

test("someone else's event is never theirs to call", () => {
  assert.deepEqual(calendarAccess(withEvent, OTHER), { kind: "not-owner", provider: "google" });
  // A forged row naming the victim as owner: the attacker is not the owner.
  assert.equal(calendarAccess({ ...withEvent, counselor_id: OTHER }, OWNER).kind, "not-owner");
});

test("no pointer, a half pointer or an unknown provider is no event", () => {
  assert.deepEqual(calendarAccess({ counselor_id: OWNER, calendar_provider: null, calendar_event_id: null }, OWNER), { kind: "none" });
  assert.deepEqual(calendarAccess({ counselor_id: OWNER, calendar_provider: "google", calendar_event_id: null }, OWNER), { kind: "none" });
  assert.deepEqual(calendarAccess({ counselor_id: OWNER, calendar_provider: "google", calendar_event_id: "" }, OWNER), { kind: "none" });
  assert.deepEqual(calendarAccess({ counselor_id: OWNER, calendar_provider: "zoom", calendar_event_id: "x" }, OWNER), { kind: "none" });
});

test("ownership needs a stored owner and a caller that match exactly", () => {
  assert.equal(ownsMeeting({ counselor_id: OWNER }, OWNER), true);
  assert.equal(ownsMeeting({ counselor_id: OWNER }, OTHER), false);
  assert.equal(ownsMeeting({ counselor_id: null }, OWNER), false);
  assert.equal(ownsMeeting({}, ""), false);
  assert.equal(ownsMeeting({ counselor_id: "" }, ""), false);
  assert.equal(calendarAccess({ ...withEvent, counselor_id: undefined }, OWNER).kind, "not-owner");
});

test("routes/meetings.ts never hands a provider the stored counselor_id", () => {
  const src = readFileSync(new URL("../../src/routes/meetings.ts", import.meta.url), "utf8");
  for (const fn of ["updateCalendarEvent", "deleteCalendarEvent", "createConferenceEvent"]) {
    const calls = [...src.matchAll(new RegExp(`await ${fn}\\(\\s*([^,]+),`, "g"))].map((m) => m[1]!.trim());
    assert.ok(calls.length > 0, `${fn} is called`);
    for (const owner of calls) {
      assert.ok(
        owner === "request.auth.userId" || owner === "access.ownerId",
        `${fn} is called with ${owner}; only the caller's own id may own the token`
      );
    }
  }
});
