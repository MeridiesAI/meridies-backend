// Student booking, part 2: book, reschedule, cancel (lib/bookingWrite.ts) and the one provider helper that uses
// the counselor's token for a student's action (lib/bookingCalendar.ts). The database is a stand-in and every
// side effect is an injected stub; nothing reaches a network.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slotsFor, toSettings, type MeetingTypeDto, type StudentBookingContext } from "../../src/lib/booking.js";
import {
  bookSlot,
  cancelBooking,
  firstName,
  insideCutoff,
  noticeText,
  rescheduleBooking,
  slotOpen,
  studentChangeRefusal,
  type BookingIo,
} from "../../src/lib/bookingWrite.js";
import { createBookingProviderEvent, moveBookingProviderEvent, removeBookingProviderEvent } from "../../src/lib/bookingCalendar.js";
import { HttpError } from "../../src/lib/errors.js";
import { __busy } from "../../src/lib/suiteApi.js";

type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;

/** from().select().eq().gte().lt().limit(), awaited; gte/lt on a timestamp column filter like Postgres would. */
function fakeDb(rows: Rows): SupabaseClient {
  const builder = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "limit", "order"]) b[m] = () => b;
    b.gte = (col: string, v: string) => (filters.push((r) => Date.parse(String(r[col])) >= Date.parse(v)), b);
    b.lt = (col: string, v: string) => (filters.push((r) => Date.parse(String(r[col])) < Date.parse(v)), b);
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(ok, bad);
    return b;
  };
  return { from: builder } as unknown as SupabaseClient;
}

const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as FastifyRequest["log"];
const request = { log } as unknown as FastifyRequest;
afterEach(() => __busy.reset());

const COUNSELOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";
const MEETING = "44444444-4444-4444-8444-444444444444";

const settings = toSettings({
  enabled: true,
  time_zone: "America/New_York",
  weekly_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "09:00", end: "12:00" }]])),
  min_notice_hours: 2,
  max_days_ahead: 30,
  buffer_minutes: 0,
  cancel_cutoff_hours: 24,
  students_can_reschedule: true,
});
const type: MeetingTypeDto = { id: "t1", name: "Check-in", durationMinutes: 30, mode: "google-meet", active: true, sortOrder: 0 };
const ctxWith = (rows: Rows): Extract<StudentBookingContext, { ok: true }> => ({ ok: true, svc: fakeDb(rows), counselorId: COUNSELOR, settings });
const now = new Date("2027-01-04T12:00:00Z");
// 2027-01-06 09:00 New York is 14:00Z.
const day6 = (h: number, m = 0) => new Date(Date.UTC(2027, 0, 6, h, m)).toISOString();

// ---- the slot grid -------------------------------------------------------------------------------

test("a booking is accepted exactly at the starts GET /slots offers, and nowhere else", async () => {
  const ctx = ctxWith({ meetings: [{ id: "m-other", starts_at: day6(15), ends_at: day6(15, 30) }] });
  const offered = await slotsFor(request, ctx, type, { from: day6(0), to: day6(23) }, now);
  const starts = offered.slots.map((s) => s.startsAt);
  assert.deepEqual(starts, [day6(14), day6(14, 30), day6(15, 30), day6(16), day6(16, 30)]);
  for (const s of starts) assert.equal(await slotOpen(request, ctx, type, s, now), true, s);
  assert.equal(await slotOpen(request, ctx, type, day6(15), now), false, "taken by a meeting");
  assert.equal(await slotOpen(request, ctx, type, day6(14, 15), now), false, "off the 30-minute grid");
  assert.equal(await slotOpen(request, ctx, type, day6(17), now), false, "outside the hours");
  assert.equal(await slotOpen(request, ctx, type, "2027-01-04T13:00:00.000Z", now), false, "inside the minimum notice");
  assert.equal(await slotOpen(request, ctx, type, "2027-03-04T14:00:00.000Z", now), false, "beyond max days ahead");
});

test("a meeting starting just after the asked start still blocks a long slot", async () => {
  const hour: MeetingTypeDto = { ...type, durationMinutes: 60 };
  const ctx = ctxWith({ meetings: [{ id: "m-late", starts_at: day6(14, 30), ends_at: day6(14, 45) }] });
  assert.equal(await slotOpen(request, ctx, hour, day6(14), now), false);
});

test("rescheduling ignores the meeting being moved, in Meridies and on the calendar", async () => {
  const self = { id: MEETING, starts_at: day6(14), ends_at: day6(14, 30) };
  const ctx = ctxWith({ meetings: [self], integration_tokens: [{ provider: "google" }] });
  __busy.rateLimit = async () => undefined;
  // The provider still lists the meeting's own event.
  __busy.request = async () =>
    new Response(JSON.stringify({ items: [{ start: { dateTime: day6(14) }, end: { dateTime: day6(14, 30) } }] }), { status: 200 });
  __busy.now = () => now.getTime();
  assert.equal(await slotOpen(request, ctx, type, day6(14), now), false, "busy for everyone else");
  const ignore = { id: MEETING, startsAt: day6(14), endsAt: day6(14, 30), onCalendar: true };
  assert.equal(await slotOpen(request, ctx, type, day6(14), now, ignore), true, "free for the meeting itself");
  assert.equal(await slotOpen(request, ctx, { ...type, durationMinutes: 60 }, day6(14), now, ignore), true, "and a longer move over itself");
});

// ---- cutoff and wording, in the counselor's zone ------------------------------------------------

test("the cancel cutoff is real hours, across a DST change", () => {
  // 2026-03-08 is spring forward in New York: 09:00 EDT on the 9th is 13:00Z; 24 real hours earlier is 13:00Z on the 8th.
  const start = "2026-03-09T13:00:00.000Z";
  assert.equal(insideCutoff(start, 24, new Date("2026-03-08T12:59:00Z")), false);
  assert.equal(insideCutoff(start, 24, new Date("2026-03-08T13:00:01Z")), true);
  assert.equal(insideCutoff(start, 0, new Date("2026-03-09T12:59:00Z")), false);
});

test("the counselor's notice says first name, type and local time, nothing more", () => {
  assert.equal(firstName("  Ana María López "), "Ana");
  assert.equal(firstName(null), "Your student");
  assert.equal(firstName("x".repeat(80)).length, 40);
  const booked = noticeText({ action: "booked", first: "Ana", typeName: "Check-in", startsAt: "2026-03-09T13:00:00.000Z", previous: null, timeZone: "America/New_York", byStudent: true });
  assert.equal(booked.title, "Ana booked Check-in on Mon, Mar 9, 9:00 AM EDT");
  const moved = noticeText({ action: "rescheduled", first: "Ana", typeName: null, startsAt: "2026-03-09T13:00:00.000Z", previous: "2026-03-06T14:00:00.000Z", timeZone: "America/New_York", byStudent: false });
  assert.equal(moved.title, "Ana moved a meeting to Mon, Mar 9, 9:00 AM EDT");
  assert.match(moved.body, /from Fri, Mar 6, 9:00 AM EST/);
  assert.match(moved.body, /You set this meeting up/);
  const cancelled = noticeText({ action: "cancelled", first: "Ana", typeName: null, startsAt: "2026-03-09T13:00:00.000Z", previous: null, timeZone: "America/New_York", byStudent: true });
  assert.equal(cancelled.title, "Ana cancelled the meeting on Mon, Mar 9, 9:00 AM EDT");
});

// ---- who may change a meeting -------------------------------------------------------------------

const meetingRow = (over: Row = {}): Row => ({
  id: MEETING,
  student_id: STUDENT,
  counselor_id: COUNSELOR,
  status: "scheduled",
  starts_at: day6(14),
  ends_at: day6(14, 30),
  guardians_invited: false,
  booked_by_student: true,
  ...over,
});

test("refusals: cancelled, past, other owner, shared, switched off, inside the cutoff", () => {
  const code = (m: Row, attendees: string[] = [STUDENT], s = settings, at = now) =>
    studentChangeRefusal({ meeting: m, attendees, studentId: STUDENT, counselorId: COUNSELOR, settings: s, now: at })?.code ?? null;
  assert.equal(code(meetingRow()), null);
  assert.equal(code(meetingRow({ status: "cancelled" })), "already_cancelled");
  assert.equal(code(meetingRow({ status: "held" })), "not_scheduled");
  assert.equal(code(meetingRow({ starts_at: "2027-01-04T11:00:00Z" })), "not_scheduled");
  assert.equal(code(meetingRow({ student_id: OTHER })), "meeting_not_found");
  assert.equal(code(meetingRow({ counselor_id: OTHER })), "ask_your_counselor");
  assert.equal(code(meetingRow(), [STUDENT, OTHER]), "ask_your_counselor");
  assert.equal(code(meetingRow({ guardians_invited: true })), "ask_your_counselor");
  assert.equal(code(meetingRow(), [STUDENT], { ...settings, studentsCanReschedule: false }), "student_changes_off");
  assert.equal(code(meetingRow(), [STUDENT], settings, new Date("2027-01-05T15:00:00Z")), "inside_cutoff");
  const off = studentChangeRefusal({ meeting: meetingRow(), attendees: [STUDENT], studentId: STUDENT, counselorId: COUNSELOR, settings: { ...settings, studentsCanReschedule: false }, now });
  assert.equal(off?.statusCode, 403);
});

// ---- the write order and its rollbacks ----------------------------------------------------------

type Calls = string[];
function io(calls: Calls, over: Partial<BookingIo> = {}): BookingIo {
  const reserved = meetingRow({ title: "Check-in - Ana", mode: "google-meet", ics_sequence: 0, send_invites: false });
  return {
    now: () => now,
    slotOpen: async () => true,
    countFutureBookings: async () => 0,
    reserve: async () => (calls.push("reserve"), { ...reserved }),
    move: async (a) => (calls.push("move"), { ...reserved, starts_at: a.startsAt, ends_at: a.endsAt }),
    release: async () => void calls.push("release"),
    restoreTimes: async () => void calls.push("restore"),
    update: async (_id, values) => (calls.push(`update:${Object.keys(values).sort().join(",")}`), { ...reserved, ...values }),
    claimCancel: async () => (calls.push("claim"), { ...reserved, status: "cancelled", calendar_provider: null, calendar_event_id: null }),
    calendar: {
      connected: async () => true,
      create: async () => (calls.push("cal:create"), { provider: "google", eventId: "evt1", joinUrl: "https://meet.google.com/abc" }),
      move: async () => void calls.push("cal:move"),
      remove: async () => void calls.push("cal:remove"),
    },
    invites: async (kind) => (calls.push(`invites:${kind}`), { status: "sending", recipients: 1, skipped: 0 }),
    notify: async (n) => void calls.push(`notify:${n.action}`),
    invitesReady: async () => true,
    ...over,
  };
}
const bookInput = { studentId: STUDENT, studentName: "Ana Lee", counselorId: COUNSELOR, settings, type, startsAt: day6(14) };

test("booking: reserve, then the calendar, then invites and the notice", async () => {
  const calls: Calls = [];
  const out = await bookSlot(io(calls), bookInput);
  assert.deepEqual(calls, ["reserve", "cal:create", "update:calendar_event_id,calendar_provider,join_url,send_invites", "invites:booked", "notify:booked"]);
  assert.equal(out.joinUrl, "https://meet.google.com/abc");
  assert.equal(out.conference, "created");
});

test("booking: a conference type without a connected calendar books with no link and says so", async () => {
  const calls: Calls = [];
  const base = io(calls);
  const out = await bookSlot(io(calls, { calendar: { ...base.calendar, connected: async () => false } }), bookInput);
  assert.ok(!calls.includes("cal:create"));
  assert.equal(out.joinUrl, null);
  assert.equal(out.conference, "not-connected");
  const inPerson = await bookSlot(io([]), { ...bookInput, type: { ...type, mode: "in-person" } });
  assert.equal(inPerson.conference, "not-needed");
});

test("booking: a provider failure after reserving releases the reservation and is 503 calendar_write_failed", async () => {
  const calls: Calls = [];
  const base = io(calls);
  const failing = io(calls, { calendar: { ...base.calendar, create: async () => { throw new HttpError(503, "Google isn't set up"); } } });
  await assert.rejects(bookSlot(failing, bookInput), (e: unknown) => e instanceof HttpError && e.statusCode === 503 && e.code === "calendar_write_failed");
  assert.deepEqual(calls, ["reserve", "release"]);
});

test("booking: off the grid is slot_unavailable and the cap is too_many_bookings, before anything is reserved", async () => {
  const calls: Calls = [];
  await assert.rejects(bookSlot(io(calls, { slotOpen: async () => false }), bookInput), (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "slot_unavailable");
  await assert.rejects(bookSlot(io(calls, { countFutureBookings: async () => 10 }), bookInput), (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "too_many_bookings");
  assert.deepEqual(calls, []);
});

const existing = meetingRow({ title: "Check-in - Ana", mode: "google-meet", calendar_provider: "google", calendar_event_id: "evt1", send_invites: true, ics_sequence: 2 });
const changeInput = { studentId: STUDENT, studentName: "Ana Lee", counselorId: COUNSELOR, settings, meeting: existing, attendees: [STUDENT] };

test("reschedule: validated against the grid ignoring itself, moved, calendar moved, invites and notice", async () => {
  const calls: Calls = [];
  let ignored: unknown = null;
  const out = await rescheduleBooking(io(calls, { slotOpen: async (_t, _s, ignore) => ((ignored = ignore), true) }), { ...changeInput, startsAt: day6(15) });
  assert.deepEqual(ignored, { id: MEETING, startsAt: day6(14), endsAt: day6(14, 30), onCalendar: true });
  assert.deepEqual(calls, ["move", "cal:move", "invites:rescheduled", "notify:rescheduled"]);
  assert.equal(out.calendarUpdated, true);
  assert.equal(out.meeting.starts_at, day6(15));
});

test("reschedule: a provider failure puts the old time back and is 503", async () => {
  const calls: Calls = [];
  const base = io(calls);
  const failing = io(calls, { calendar: { ...base.calendar, move: async () => { throw new HttpError(503, "down"); } } });
  await assert.rejects(rescheduleBooking(failing, { ...changeInput, startsAt: day6(15) }), (e: unknown) => e instanceof HttpError && e.statusCode === 503 && e.code === "calendar_write_failed");
  assert.deepEqual(calls, ["move", "restore"]);
});

test("cancel: claimed once, the calendar event removed best effort, invites and notice", async () => {
  const calls: Calls = [];
  const out = await cancelBooking(io(calls), changeInput);
  assert.deepEqual(calls, ["claim", "cal:remove", "invites:cancelled", "notify:cancelled"]);
  assert.equal(out.calendarRemoved, true);

  const failCalls: Calls = [];
  const base = io(failCalls);
  const failing = await cancelBooking(io(failCalls, { calendar: { ...base.calendar, remove: async () => { throw new Error("down"); } } }), changeInput);
  assert.equal(failing.calendarRemoved, false, "a failed delete doesn't block the cancel");
  assert.ok(failCalls.includes("notify:cancelled"));

  const raced: Calls = [];
  await assert.rejects(cancelBooking(io(raced, { claimCancel: async () => null }), changeInput), (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "already_cancelled");
  assert.deepEqual(raced, [], "a second cancel sends nothing");
});

// ---- the provider helper ------------------------------------------------------------------------

test("the booking provider helper uses the counselor's token, only for that counselor's student's meeting", async () => {
  const used: string[] = [];
  const deps = {
    create: async (owner: string) => (used.push(`create:${owner}`), { eventId: "e", joinUrl: "https://x" }),
    update: async (owner: string) => void used.push(`update:${owner}`),
    remove: async (owner: string) => void used.push(`remove:${owner}`),
  };
  const input = { title: "t", startsAt: day6(14), endsAt: day6(14, 30) };
  const fresh = meetingRow({ calendar_provider: null, calendar_event_id: null });
  await createBookingProviderEvent(fresh, { counselorId: COUNSELOR, studentId: STUDENT }, "google", input, log, deps);
  assert.deepEqual(used, [`create:${COUNSELOR}`]);

  await assert.rejects(createBookingProviderEvent(meetingRow({ counselor_id: OTHER }), { counselorId: COUNSELOR, studentId: STUDENT }, "google", input, log, deps));
  await assert.rejects(createBookingProviderEvent(meetingRow({ student_id: OTHER }), { counselorId: COUNSELOR, studentId: STUDENT }, "google", input, log, deps));
  await assert.rejects(createBookingProviderEvent(meetingRow({ booked_by_student: false }), { counselorId: COUNSELOR, studentId: STUDENT }, "google", input, log, deps), "only a meeting just reserved by the student");
  await assert.rejects(createBookingProviderEvent(existing, { counselorId: COUNSELOR, studentId: STUDENT }, "google", input, log, deps), "never over an existing event");

  await moveBookingProviderEvent(existing, { counselorId: COUNSELOR, studentId: STUDENT }, { startsAt: day6(15) }, log, deps);
  await removeBookingProviderEvent(existing, { counselorId: COUNSELOR, studentId: STUDENT }, log, deps);
  assert.deepEqual(used.slice(1), [`update:${COUNSELOR}`, `remove:${COUNSELOR}`]);
  await assert.rejects(moveBookingProviderEvent({ ...existing, counselor_id: OTHER }, { counselorId: COUNSELOR, studentId: STUDENT }, { startsAt: day6(15) }, log, deps));
  await assert.rejects(removeBookingProviderEvent({ ...existing, student_id: OTHER }, { counselorId: COUNSELOR, studentId: STUDENT }, log, deps));
  assert.equal(used.length, 3, "nothing called for a mismatched meeting");
});
