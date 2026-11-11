// lib/calendarLink.ts: the Google event page for an event Meridies made on the counselor's primary calendar,
// computed from the stored event id and the connected account's address; only ever for the event's owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { googleEventHtmlLink, meetingHtmlLink, needsGoogleAddress } from "../../src/lib/calendarLink.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const eidOf = (link: string) => new URL(link).searchParams.get("eid") ?? "";
const decode = (eid: string) => Buffer.from(eid, "base64url").toString("utf8");

test("the link is Google's event page with eid = base64url(eventId + ' ' + calendarId), unpadded", () => {
  const link = googleEventHtmlLink("7fjmnpsg8gf63hjoa7oh57bp8e", "jane@school.org");
  assert.ok(link);
  assert.ok(link.startsWith("https://www.google.com/calendar/event?eid="));
  const eid = eidOf(link);
  assert.equal(decode(eid), "7fjmnpsg8gf63hjoa7oh57bp8e jane@school.org");
  assert.match(eid, /^[A-Za-z0-9_-]+$/, "url-safe, no padding");
  // The known value for this pair (standard base64 with the padding dropped is the same string here).
  assert.equal(eid, Buffer.from("7fjmnpsg8gf63hjoa7oh57bp8e jane@school.org").toString("base64").replace(/=+$/, ""));
});

test("characters that differ between base64 and base64url come out url-safe", () => {
  // "?>" encodes to "Pz4" / "?~" to "P34"; an address with such bytes must still give only [A-Za-z0-9_-].
  const eid = eidOf(googleEventHtmlLink("abc~~~???", "a~b?@gmail.com")!);
  assert.match(eid, /^[A-Za-z0-9_-]+$/);
  assert.equal(decode(eid), "abc~~~??? a~b?@gmail.com");
});

test("the app's own check accepts the link (https, www.google.com, /calendar path)", () => {
  const u = new URL(googleEventHtmlLink("evt1", "me@gmail.com")!);
  assert.equal(u.protocol, "https:");
  assert.equal(u.hostname, "www.google.com");
  assert.ok(u.pathname.startsWith("/calendar"));
});

test("no link without a real calendar address: 'primary', empty, whitespace, missing", () => {
  assert.equal(googleEventHtmlLink("evt1", "primary"), null);
  assert.equal(googleEventHtmlLink("evt1", null), null);
  assert.equal(googleEventHtmlLink("evt1", ""), null);
  assert.equal(googleEventHtmlLink("evt1", "a@b@c"), null);
  assert.equal(googleEventHtmlLink("evt1", "me @gmail.com"), null);
  assert.equal(googleEventHtmlLink(null, "me@gmail.com"), null);
  assert.equal(googleEventHtmlLink("", "me@gmail.com"), null);
  assert.equal(googleEventHtmlLink("evt 1", "me@gmail.com"), null);
  assert.equal(googleEventHtmlLink("x".repeat(1025), "me@gmail.com"), null);
});

test("a meeting's link: Google only, the owner only, with the owner's address", () => {
  const row = { counselor_id: OWNER, calendar_provider: "google", calendar_event_id: "evt1" };
  const link = meetingHtmlLink(row, OWNER, "owner@school.org");
  assert.equal(decode(eidOf(link!)), "evt1 owner@school.org");
  assert.equal(meetingHtmlLink(row, OTHER, "owner@school.org"), null, "a collaborator or student gets no link");
  assert.equal(meetingHtmlLink({ ...row, calendar_provider: "microsoft" }, OWNER, "owner@school.org"), null, "Outlook: no webLink stored");
  assert.equal(meetingHtmlLink({ ...row, calendar_event_id: null }, OWNER, "owner@school.org"), null);
  assert.equal(meetingHtmlLink(row, OWNER, null), null, "no connected address: the app links the day");
  assert.equal(meetingHtmlLink({ ...row, counselor_id: undefined }, OWNER, "owner@school.org"), null);
});

test("the address is read only when one of the caller's own rows has a Google event", () => {
  const g = { counselor_id: OWNER, calendar_provider: "google", calendar_event_id: "evt1" };
  assert.equal(needsGoogleAddress([g], OWNER), true);
  assert.equal(needsGoogleAddress([g], OTHER), false);
  assert.equal(needsGoogleAddress([{ ...g, calendar_provider: "microsoft" }], OWNER), false);
  assert.equal(needsGoogleAddress([{ ...g, calendar_event_id: null }], OWNER), false);
  assert.equal(needsGoogleAddress([], OWNER), false);
});
