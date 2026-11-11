// A counselor cancels a public-link booking (lib/publicBookingCancel.ts): only their own scheduled row, once; the
// calendar event deleted best effort; the booker's .ics CANCEL matches the original invite's UID at SEQUENCE 1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicBookingIcs } from "../../src/lib/publicBooking.js";
import {
  bookerCancelEmail,
  cancelActivityText,
  cancelPublicBooking,
  PUBLIC_CANCEL_SEQUENCE,
  publicBookingCancelIcs,
  toPublicBooking,
  type PublicCancelIo,
} from "../../src/lib/publicBookingCancel.js";
import { HttpError } from "../../src/lib/errors.js";

type Row = Record<string, unknown>;
const COUNSELOR = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const booking = (over: Row = {}): Row => ({
  id: "11111111-1111-4111-8111-111111111111",
  counselor_id: COUNSELOR,
  booking_type_id: "t1",
  type_name: "Intro call",
  mode: "google-meet",
  name: "Maria Lopez",
  email: "maria@example.com",
  phone: "555-0100",
  note: "Junior year",
  starts_at: "2027-01-05T14:00:00Z",
  ends_at: "2027-01-05T14:30:00Z",
  status: "scheduled",
  join_url: "https://meet.google.com/abc-defg-hij",
  calendar_provider: "google",
  calendar_event_id: "evt1",
  contact_id: "c1",
  cancelled_at: null,
  created_at: "2027-01-01T00:00:00Z",
  ...over,
});

function fakeIo(row: Row | null, opts: { cancelReturnsNull?: boolean; removeFails?: boolean } = {}) {
  const calls: string[] = [];
  const io: PublicCancelIo = {
    async load(id) {
      calls.push(`load:${id}`);
      return row;
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
      if (opts.cancelReturnsNull || !row) return null;
      return { ...row, status: "cancelled", cancelled_at: "2027-01-02T00:00:00Z" };
    },
    async removeEvent(provider, eventId) {
      calls.push(`remove:${provider}:${eventId}`);
      if (opts.removeFails) throw new Error("provider down");
    },
    eventLeft(provider, eventId) {
      calls.push(`left:${provider}:${eventId}`);
    },
    afterCancel(b) {
      calls.push(`after:${String(b.status)}`);
    },
  };
  return { io, calls };
}

const code = (err: unknown) => (err instanceof HttpError ? `${err.statusCode} ${err.code}` : String(err));

test("the owner's scheduled booking: cancelled, the event deleted, then the follow-ups", async () => {
  const { io, calls } = fakeIo(booking());
  const out = await cancelPublicBooking(io, { id: "11111111-1111-4111-8111-111111111111", counselorId: COUNSELOR });
  assert.equal(out.booking.status, "cancelled");
  assert.equal(out.calendarRemoved, true);
  assert.deepEqual(calls, [
    "load:11111111-1111-4111-8111-111111111111",
    "cancel:11111111-1111-4111-8111-111111111111",
    "remove:google:evt1",
    "after:cancelled",
  ]);
});

test("someone else's booking or no booking is 404 booking_not_found, and nothing is written", async () => {
  for (const row of [null, booking({ counselor_id: OTHER })]) {
    const { io, calls } = fakeIo(row);
    await assert.rejects(cancelPublicBooking(io, { id: "x", counselorId: COUNSELOR }), (e) => code(e) === "404 booking_not_found");
    assert.deepEqual(calls, ["load:x"]);
  }
});

test("already cancelled, or losing a race, is 409 already_cancelled and emails nobody", async () => {
  const done = fakeIo(booking({ status: "cancelled" }));
  await assert.rejects(cancelPublicBooking(done.io, { id: "x", counselorId: COUNSELOR }), (e) => code(e) === "409 already_cancelled");
  assert.deepEqual(done.calls, ["load:x"]);
  const race = fakeIo(booking(), { cancelReturnsNull: true });
  await assert.rejects(cancelPublicBooking(race.io, { id: "x", counselorId: COUNSELOR }), (e) => code(e) === "409 already_cancelled");
  assert.ok(!race.calls.some((c) => c.startsWith("remove") || c.startsWith("after")));
});

test("a calendar that refuses the delete still cancels (calendarRemoved false, logged); no event means nothing to delete", async () => {
  const failing = fakeIo(booking({ calendar_provider: "microsoft", calendar_event_id: "AAMk" }), { removeFails: true });
  const out = await cancelPublicBooking(failing.io, { id: "x", counselorId: COUNSELOR });
  assert.equal(out.calendarRemoved, false);
  assert.ok(failing.calls.includes("left:microsoft:AAMk"));
  assert.ok(failing.calls.includes("after:cancelled"), "the booker is still told");

  const none = fakeIo(booking({ calendar_provider: null, calendar_event_id: null }));
  const quiet = await cancelPublicBooking(none.io, { id: "x", counselorId: COUNSELOR });
  assert.equal(quiet.calendarRemoved, true);
  assert.ok(!none.calls.some((c) => c.startsWith("remove")));
});

const line = (ics: string, key: string) => ics.split("\r\n").find((l) => l.startsWith(`${key}:`)) ?? "";

test("the CANCEL .ics names the original invite's UID with SEQUENCE 1", () => {
  const b = booking();
  const organizer = { name: "Jane Doe", email: "jane@example.com" };
  const attendee = { name: "Maria Lopez", email: "maria@example.com" };
  const now = new Date("2027-01-02T00:00:00Z");
  const invite = publicBookingIcs(b, organizer, attendee, "REQUEST", "invites@meridiesai.com", now);
  const cancel = publicBookingCancelIcs(b, organizer, attendee, "invites@meridiesai.com", now);
  assert.equal(line(cancel, "UID"), line(invite, "UID"));
  assert.equal(line(cancel, "UID"), "UID:meeting-public-11111111-1111-4111-8111-111111111111@meridiesai.com");
  assert.equal(line(invite, "SEQUENCE"), "SEQUENCE:0");
  assert.equal(line(cancel, "SEQUENCE"), `SEQUENCE:${PUBLIC_CANCEL_SEQUENCE}`);
  assert.equal(PUBLIC_CANCEL_SEQUENCE, 1);
  assert.equal(line(cancel, "METHOD"), "METHOD:CANCEL");
  assert.equal(line(cancel, "STATUS"), "STATUS:CANCELLED");
  assert.equal(line(cancel, "DTSTART"), line(invite, "DTSTART"));
});

test("the booker's email and the timeline entry say what was cancelled and when, in the counselor's zone", () => {
  const b = booking();
  const mail = bookerCancelEmail(b, "Jane Doe", "America/New_York");
  assert.match(mail.subject, /^Cancelled: Intro call with Jane Doe · /);
  assert.match(mail.text, /Hi Maria, Jane Doe cancelled your meeting\./);
  assert.match(mail.text, /9:00/);
  assert.ok(!mail.text.includes("meet.google.com"), "a cancelled meeting's join link isn't repeated");
  assert.equal(cancelActivityText("Intro call", b.starts_at as string, "America/New_York"), "Cancelled Intro call on Tue, Jan 5, 9:00 AM EST");
});

test("the read DTO carries the booker's details and nothing internal", () => {
  const dto = toPublicBooking(booking());
  assert.deepEqual(
    { name: dto.name, email: dto.email, phone: dto.phone, note: dto.note, typeName: dto.typeName, status: dto.status },
    { name: "Maria Lopez", email: "maria@example.com", phone: "555-0100", note: "Junior year", typeName: "Intro call", status: "scheduled" }
  );
  assert.ok(!("calendarEventId" in dto) && !("counselorId" in dto));
  assert.equal(toPublicBooking(booking({ phone: "", note: null })).phone, null);
});
