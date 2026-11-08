// Student booking: lib/booking.ts around the pure slot maths. The database is a tiny in-memory stand-in and the
// provider HTTP goes through the __busy seam; nothing reaches a network.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingBusyFixtureRefusal, calendarBusy, slotsFor, toSettings, type MeetingTypeDto } from "../../src/lib/booking.js";
import { busyWindow, computeSlots } from "../../src/lib/bookingSlots.js";
import { HttpError } from "../../src/lib/errors.js";
import { __busy } from "../../src/lib/suiteApi.js";

type Rows = Record<string, Record<string, unknown>[]>;

/** Enough of the Supabase query builder for lib/booking.ts: from().select().eq().gte().lt().limit(), awaited. */
function fakeDb(rows: Rows): SupabaseClient {
  const builder = (table: string) => {
    const result = { data: rows[table] ?? [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt", "limit", "order"]) b[m] = () => b;
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
    return b;
  };
  return { from: builder } as unknown as SupabaseClient;
}

const log = { warn: () => undefined } as unknown as FastifyRequest["log"];
const request = { log } as unknown as FastifyRequest;
let owner = 100;
const nextOwner = () => `00000000-0000-4000-8000-${String(++owner).padStart(12, "0")}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => __busy.reset());

const settings = toSettings({
  enabled: true,
  time_zone: "America/New_York",
  weekly_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "09:00", end: "17:00" }]])),
  min_notice_hours: 2,
  max_days_ahead: 10,
  buffer_minutes: 15,
  cancel_cutoff_hours: 24,
  students_can_reschedule: true,
});
const type: MeetingTypeDto = { id: "t1", name: "Check-in", durationMinutes: 30, mode: "google-meet", active: true, sortOrder: 0 };

test("two slot requests seconds apart share one calendar read and one rate-limit charge", async () => {
  const counselorId = nextOwner();
  const svc = fakeDb({ meetings: [], integration_tokens: [{ provider: "google" }] });
  const ctx = { ok: true as const, svc, counselorId, settings };
  const busy = { start: "2027-01-05T15:00:00Z", end: "2027-01-05T16:00:00Z" };
  let calls = 0;
  let charges = 0;
  __busy.request = async () => {
    calls++;
    return json({ items: [{ start: { dateTime: busy.start }, end: { dateTime: busy.end } }] });
  };
  __busy.rateLimit = async () => {
    charges++;
  };
  const t0 = new Date("2027-01-04T12:00:00.123Z");
  const t1 = new Date(t0.getTime() + 4_567);
  __busy.now = () => t0.getTime();
  // from is in the past each time, so it is clamped to `now`, which differs by a few seconds.
  const window = { from: "2027-01-04T00:00:00Z", to: "2027-01-20T00:00:00Z" };
  const first = await slotsFor(request, ctx, type, window, t0);
  __busy.now = () => t1.getTime();
  const second = await slotsFor(request, ctx, type, window, t1);
  assert.equal(calls, 1, "the second read is the cache's");
  assert.equal(charges, 1, "the cache hit isn't charged");
  assert.notEqual(first.from, second.from, "the clamped windows really differ");

  // The slots are exactly what the pure maths gives for the exact clamped window and the same busy time.
  const expected = computeSlots({
    timeZone: settings.timeZone,
    weeklyHours: settings.weeklyHours,
    durationMinutes: type.durationMinutes,
    bufferMinutes: settings.bufferMinutes,
    minNoticeHours: settings.minNoticeHours,
    maxDaysAhead: settings.maxDaysAhead,
    from: second.from!,
    to: second.to!,
    busy: [busy],
    now: t1,
  });
  assert.deepEqual(second.slots.map((s) => s.startsAt), expected);
  assert.ok(expected.length > 0);
  assert.ok(!second.slots.some((s) => s.startsAt >= "2027-01-05T14:15:00.000Z" && s.startsAt < "2027-01-05T16:15:00.000Z"), "busy time and its buffer are honoured");
});

test("busyWindow widens to whole local days, DST-safe, and is stable within a day", () => {
  const ny = "America/New_York";
  assert.deepEqual(busyWindow("2027-01-04T12:00:00.123Z", "2027-01-06T17:30:00.000Z", 15, ny), {
    from: "2027-01-04T05:00:00.000Z",
    to: "2027-01-07T05:00:00.000Z",
  });
  assert.deepEqual(busyWindow("2027-01-04T12:00:04Z", "2027-01-06T17:30:09Z", 15, ny), busyWindow("2027-01-04T12:00:00Z", "2027-01-06T17:30:00Z", 15, ny));
  // A buffer that crosses midnight takes the day before.
  assert.equal(busyWindow("2027-01-04T05:10:00Z", "2027-01-04T20:00:00Z", 15, ny).from, "2027-01-03T05:00:00.000Z");
  // An end exactly at local midnight doesn't add a day.
  assert.equal(busyWindow("2027-01-04T12:00:00Z", "2027-01-05T05:00:00Z", 0, ny).to, "2027-01-05T05:00:00.000Z");
  // Spring forward: the day is 23 hours long.
  assert.deepEqual(busyWindow("2026-03-08T12:00:00Z", "2026-03-08T13:00:00Z", 0, ny), {
    from: "2026-03-08T05:00:00.000Z",
    to: "2026-03-09T04:00:00.000Z",
  });
});

test("a calendar grant that needs reconnecting is 409 calendar_reconnect_needed", async () => {
  const svc = fakeDb({ integration_tokens: [{ provider: "google" }] });
  __busy.request = async () => {
    throw new HttpError(409, "Google access expired and can't be renewed. Reconnect Google.", "google_reconnect");
  };
  await assert.rejects(calendarBusy(svc, nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "America/New_York", log), (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "calendar_reconnect_needed");
  __busy.request = async () => json({ error: "unauthorized" }, 401);
  await assert.rejects(calendarBusy(svc, nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "America/New_York", log), (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "calendar_reconnect_needed");
  __busy.request = async () => json({ error: "forbidden" }, 403);
  await assert.rejects(calendarBusy(svc, nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "America/New_York", log), (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "calendar_reconnect_needed");
});

test("a provider outage is 503 calendar_busy_unavailable", async () => {
  const svc = fakeDb({ integration_tokens: [{ provider: "microsoft" }] });
  for (const answer of [json({}, 500), json({}, 503), json({}, 429)]) {
    __busy.request = async () => answer;
    await assert.rejects(calendarBusy(svc, nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "America/New_York", log), (e: unknown) => e instanceof HttpError && e.statusCode === 503 && e.code === "calendar_busy_unavailable");
  }
  __busy.request = async () => {
    throw new HttpError(503, "Microsoft didn't answer. Try again shortly.");
  };
  await assert.rejects(calendarBusy(svc, nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "America/New_York", log), (e: unknown) => e instanceof HttpError && e.statusCode === 503 && e.code === "calendar_busy_unavailable");
});

test("no calendar connected (no grant, or a grant without Calendar) is no busy time", async () => {
  let calls = 0;
  __busy.request = async () => {
    calls++;
    throw new HttpError(409, "no scope", "busy_scope_missing");
  };
  assert.deepEqual(await calendarBusy(fakeDb({ integration_tokens: [] }), nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "UTC", log), []);
  assert.equal(calls, 0);
  assert.deepEqual(await calendarBusy(fakeDb({ integration_tokens: [{ provider: "google" }] }), nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "UTC", log), []);
});

test("our own busy rate limit is passed through as a 429", async () => {
  __busy.rateLimit = async () => {
    throw new HttpError(429, "Too many availability checks");
  };
  await assert.rejects(calendarBusy(fakeDb({ integration_tokens: [{ provider: "google" }] }), nextOwner(), "2027-01-04T05:00:00Z", "2027-01-05T05:00:00Z", "UTC", log), (e: unknown) => e instanceof HttpError && e.statusCode === 429);
});

test("BOOKING_BUSY_FIXTURE refuses to boot outside development and test, read raw", () => {
  const prod = bookingBusyFixtureRefusal({ BOOKING_BUSY_FIXTURE: "/tmp/x.json", NODE_ENV: "production" });
  assert.ok(prod && prod.includes("BOOKING_BUSY_FIXTURE") && prod.includes("production"));
  assert.equal(bookingBusyFixtureRefusal({ BOOKING_BUSY_FIXTURE: "/tmp/x.json", NODE_ENV: "development" }), null);
  assert.equal(bookingBusyFixtureRefusal({ BOOKING_BUSY_FIXTURE: "/tmp/x.json", NODE_ENV: "test" }), null);
  for (const NODE_ENV of ["staging", "preview", "prod", "Production", "development ", "", undefined]) {
    const msg = bookingBusyFixtureRefusal({ BOOKING_BUSY_FIXTURE: "/tmp/x.json", NODE_ENV });
    assert.ok(msg && msg.includes("BOOKING_BUSY_FIXTURE"), `NODE_ENV=${String(NODE_ENV)}`);
  }
  for (const NODE_ENV of ["production", "development", undefined]) {
    assert.equal(bookingBusyFixtureRefusal({ NODE_ENV }), null);
    assert.equal(bookingBusyFixtureRefusal({ BOOKING_BUSY_FIXTURE: "", NODE_ENV }), null);
  }
});
