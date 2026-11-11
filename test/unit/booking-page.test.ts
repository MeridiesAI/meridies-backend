// The counselor's Google Calendar booking page (lib/bookingPage.ts): which links are accepted, how a stored one
// is read back, what a student is told (bookingTypesAnswer), and the readiness probe. Pure; nothing reaches a network.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingTypesAnswer, meridiesBookingOn, settingsColumns, SETTINGS_COLUMNS, toSettings, type MeetingTypeDto } from "../../src/lib/booking.js";
import { bookingPageReady, parseBookingPageUrl, resetBookingPageReady, storedBookingPage } from "../../src/lib/bookingPage.js";

afterEach(() => resetBookingPageReady());

test("accepts Google's booking-page hosts over https only", () => {
  for (const ok of [
    "https://calendar.app.google/AbC123xyz",
    "https://calendar.google.com/calendar/appointments/schedules/AcZssZ1abc?gv=true",
    "https://calendar.google.com/calendar/u/0/appointments/AcZssZ2",
    "  https://CALENDAR.APP.GOOGLE/xyz  ",
  ]) {
    const r = parseBookingPageUrl(ok);
    assert.equal(r.ok, true, ok);
  }
  assert.deepEqual(parseBookingPageUrl("  https://CALENDAR.APP.GOOGLE/xyz "), { ok: true, value: "https://calendar.app.google/xyz" });
});

test("refuses every other host, scheme, credential, port or shape", () => {
  for (const bad of [
    "http://calendar.app.google/abc",
    "https://calendar.app.google/",
    "https://calendar.app.google",
    "https://calendar.google.com/",
    "https://calendar.google.com/calendar/",
    "https://calendar.google.com/maps/abc",
    "https://evil.calendar.app.google/abc",
    "https://calendar.app.google.evil.com/abc",
    "https://calendar.google.com.evil.com/calendar/x",
    "https://evil.com/?https://calendar.app.google/abc",
    "https://user:pw@calendar.app.google/abc",
    "https://calendar.app.google:8443/abc",
    "javascript:alert(1)",
    "calendar.app.google/abc",
    "https://calendar.app.google/a b",
    'https://calendar.app.google/a"onmouseover=x',
    `https://calendar.app.google/${"a".repeat(600)}`,
    "",
    null,
    42,
  ]) {
    assert.equal(parseBookingPageUrl(bad).ok, false, String(bad));
  }
});

test("a stored value is kept only when it still passes; the mode defaults to alongside", () => {
  assert.deepEqual(storedBookingPage("https://calendar.app.google/x", "instead"), { url: "https://calendar.app.google/x", mode: "instead" });
  assert.deepEqual(storedBookingPage("https://calendar.app.google/x", "weird"), { url: "https://calendar.app.google/x", mode: "alongside" });
  assert.equal(storedBookingPage("https://evil.example/x", "instead"), null);
  assert.equal(storedBookingPage(null, "instead"), null);
});

test("settings: the page fields, and readiness, in the counselor's answer", () => {
  const before = toSettings({ enabled: true });
  assert.equal(before.bookingPageReady, false);
  assert.equal(before.bookingPageUrl, null);
  assert.equal(before.bookingPageMode, "alongside");
  const after = toSettings({ enabled: true, booking_page_url: "https://calendar.app.google/x", booking_page_mode: "instead" }, true);
  assert.deepEqual([after.bookingPageReady, after.bookingPageUrl, after.bookingPageMode], [true, "https://calendar.app.google/x", "instead"]);
  assert.equal(settingsColumns(false), SETTINGS_COLUMNS, "never names the new columns before the migration");
  assert.match(settingsColumns(true), /booking_page_url, booking_page_mode$/);
});

const type: MeetingTypeDto = { id: "t1", name: "Check-in", durationMinutes: 30, mode: "phone", active: true, sortOrder: 0 };
const row = { enabled: true, time_zone: "America/Chicago", weekly_hours: {}, cancel_cutoff_hours: 6, students_can_reschedule: true };
const page = { booking_page_url: "https://calendar.app.google/x" };

test("students: alongside keeps Meridies booking and adds the link with the counselor's name", () => {
  const a = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: { ...row, ...page, booking_page_mode: "alongside" }, types: [type], counselorName: "  Casey Counselor " });
  assert.equal(a.available, true);
  assert.deepEqual(a.bookingPage, { url: "https://calendar.app.google/x", counselorName: "Casey Counselor" });
});

test("students: instead is the link only, and reads as paused so a booked meeting can still be cancelled", () => {
  const a = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: { ...row, ...page, booking_page_mode: "instead" }, types: [type], counselorName: "Casey" });
  assert.equal(a.available, false);
  assert.equal(a.reason, "paused");
  assert.deepEqual(a.types, []);
  assert.equal(a.bookingPage?.url, "https://calendar.app.google/x");
  assert.equal(meridiesBookingOn({ ...row, ...page, booking_page_mode: "instead" }), false);
});

test("students: Meridies booking paused still shows a linked page; no page, no field; unapproved, nothing", () => {
  const paused = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: { ...row, enabled: false, ...page }, types: [], counselorName: null });
  assert.equal(paused.reason, "paused");
  assert.deepEqual(paused.bookingPage, { url: "https://calendar.app.google/x", counselorName: null });
  const plain = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: row, types: [type] });
  assert.equal("bookingPage" in plain, false);
  const evil = bookingTypesAnswer({ hasCounselor: true, approved: true, settingsRow: { ...row, booking_page_url: "https://evil.example/x" }, types: [type] });
  assert.equal("bookingPage" in evil, false, "a stored link off Google's hosts is never handed to a student");
  const unapproved = bookingTypesAnswer({ hasCounselor: true, approved: false, settingsRow: { ...row, ...page }, types: [type] });
  assert.equal("bookingPage" in unapproved, false);
});

function probeDb(error: { code?: string } | null): { db: SupabaseClient; calls: () => number } {
  let n = 0;
  const db = { from: () => ({ select: () => ({ limit: async () => (n++, { error }) }) }) } as unknown as SupabaseClient;
  return { db, calls: () => n };
}

test("readiness: ready is kept; missing is rechecked after 30 s; any other error isn't cached", async () => {
  const ok = probeDb(null);
  assert.equal(await bookingPageReady(ok.db), true);
  assert.equal(await bookingPageReady(ok.db), true);
  assert.equal(ok.calls(), 1);

  resetBookingPageReady();
  const missing = probeDb({ code: "42703" });
  assert.equal(await bookingPageReady(missing.db, 1_000_000), false);
  assert.equal(await bookingPageReady(missing.db, 1_010_000), false);
  assert.equal(missing.calls(), 1, "inside 30 s: no second probe");
  assert.equal(await bookingPageReady(missing.db, 1_031_000), false);
  assert.equal(missing.calls(), 2);

  resetBookingPageReady();
  const other = probeDb({ code: "08006" });
  assert.equal(await bookingPageReady(other.db, 5), false);
  assert.equal(await bookingPageReady(other.db, 6), false);
  assert.equal(other.calls(), 2);
});
