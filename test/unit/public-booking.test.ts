// The public booking link (lib/publicBooking.ts, routes/publicBooking.ts, 20261121000001): the slug, which links
// answer, the honeypot, the 409 on a taken slot, the calendar rollback, the follow-ups' words, and a public booking
// counting as busy time for every slot read (the student's slots included). The database is an in-memory
// stand-in; nothing reaches a network.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { meetingBusy, slotsFor, toSettings, type MeetingTypeDto } from "../../src/lib/booking.js";
import { buildCalendarFeed } from "../../src/lib/calendarFeed.js";
import { HttpError } from "../../src/lib/errors.js";
import { feedIcsEvents } from "../../src/lib/ics.js";
import {
  activityText,
  bookerEmail,
  bookPublic,
  counselorNotice,
  decoyAnswer,
  isHoneypot,
  isPublicSlug,
  makeSlug,
  publicBookBody,
  publicBookingIcs,
  publicEventInput,
  publicLinkOpen,
  publicPageAnswer,
  publicRpcError,
  resolvePublicLink,
  SLUG_ALPHABET,
  slugBase,
  slugSuffix,
  writeSlug,
  type PublicBookingIo,
} from "../../src/lib/publicBooking.js";
import { resetPublicBookingReady } from "../../src/lib/publicBookingStore.js";
import publicBookingRoutes from "../../src/routes/publicBooking.js";

type Row = Record<string, unknown>;

// ---- a small stand-in database ----------------------------------------------------------------------

type Result = { data: unknown; error: { code?: string; message?: string } | null; count?: number };

/**
 * Enough of the query builder: select/eq/is/in/not/gte/lt/gt/neq/order/limit/update, then maybeSingle/single or an
 * await. `eq` and `in` filter the table's rows; the rest pass through. `updates` records each update; `onUpdate` may
 * answer one with an error.
 */
function fakeDb(tables: Record<string, Row[]>, opts: { onUpdate?: (table: string, values: Row) => Result | null; missing?: string[] } = {}) {
  const updates: Array<{ table: string; values: Row; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let values: Row | null = null;
    let one = false;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : v === null ? r[k] == null : r[k] === v)));
    const answer = (): Result => {
      if (opts.missing?.includes(table)) return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } };
      if (values) {
        updates.push({ table, values, filters: [...filters] });
        const custom = opts.onUpdate?.(table, values);
        if (custom) return custom;
        const hit = rows();
        for (const r of hit) Object.assign(r, values);
        return { data: one ? hit[0] ?? null : hit, error: null };
      }
      const hit = rows();
      return { data: one ? hit[0] ?? null : hit, error: null, count: hit.length };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "gte", "lt", "gt", "lte", "neq", "order", "limit", "not", "or", "range", "filter"]) b[m] = () => b;
    b.eq = (k: string, v: unknown) => (filters.push([k, v]), b);
    b.is = (k: string, v: unknown) => (filters.push([k, v]), b);
    b.in = (k: string, v: unknown[]) => (filters.push([k, v]), b);
    b.update = (v: Row) => ((values = v), b);
    b.maybeSingle = () => ((one = true), Promise.resolve(answer()));
    b.single = () => ((one = true), Promise.resolve(answer()));
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad);
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, updates };
}

const COUNSELOR = "00000000-0000-4000-8000-000000000001";
const TYPE_ID = "00000000-0000-4000-8000-0000000000aa";
const allWeek = (ranges: Row[]) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));
const settingsRow = (over: Row = {}): Row => ({
  counselor_id: COUNSELOR,
  enabled: true,
  time_zone: "UTC",
  weekly_hours: allWeek([{ start: "09:00", end: "12:00" }]),
  min_notice_hours: 0,
  max_days_ahead: 30,
  buffer_minutes: 0,
  cancel_cutoff_hours: 24,
  students_can_reschedule: true,
  booking_page_url: null,
  booking_page_mode: "alongside",
  public_slug: "jane-doe-4f7km",
  public_booking_enabled: true,
  ...over,
});
const approvedProfile = { id: COUNSELOR, role: "counselor", counselor_approved_at: "2026-01-01T00:00:00Z", full_name: "Jane Doe", firm_id: null, email: "jane@example.com" };
const type: MeetingTypeDto = { id: TYPE_ID, name: "Check-in", durationMinutes: 30, mode: "google-meet", active: true, sortOrder: 0 };
const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as FastifyRequest["log"];
const request = { log } as unknown as FastifyRequest;

// ---- the slug ----------------------------------------------------------------------------------------

test("a slug is the slugified name plus a 5-character suffix from the 32-letter alphabet", () => {
  assert.equal(slugBase("Jane Doe"), "jane-doe");
  assert.equal(slugBase("  José Núñez-García  "), "jose-nunez-garcia");
  assert.equal(slugBase("Søren O'Brien, Ph.D."), "soren-o-brien-ph-d");
  assert.equal(slugBase(""), "counselor");
  assert.equal(slugBase(null), "counselor");
  assert.equal(slugBase("李小龙"), "counselor", "nothing url-safe left");
  const long = slugBase("a".repeat(39) + " bcdef");
  assert.ok(long.length <= 40 && !long.endsWith("-"), long);

  let i = 0;
  assert.equal(slugSuffix(() => i++), "abcde");
  assert.equal(makeSlug("Jane Doe", () => 0), "jane-doe-aaaaa");
  for (let n = 0; n < 50; n++) {
    const s = makeSlug("Jane Doe");
    assert.match(s, /^jane-doe-[a-z0-9]{5}$/);
    assert.ok([...s.slice(-5)].every((c) => SLUG_ALPHABET.includes(c)), s);
    assert.ok(isPublicSlug(s), s);
  }
  assert.ok(!/[lo01]/.test(SLUG_ALPHABET) && SLUG_ALPHABET.length === 32);
});

test("isPublicSlug holds the database CHECK's shape", () => {
  for (const ok of ["jane-doe-4f7km", "abc", "a1-b2"]) assert.ok(isPublicSlug(ok), ok);
  for (const bad of ["Jane-Doe", "ab", "a--b", "-ab", "ab-", "a b", "a_b", "a".repeat(65), "jane%2fdoe", "../x", 5, null]) {
    assert.ok(!isPublicSlug(bad), String(bad));
  }
});

test("writeSlug retries a taken slug with a new suffix, and never overwrites one another request set first", async () => {
  let tries = 0;
  const { db, updates } = fakeDb(
    { booking_settings: [{ counselor_id: COUNSELOR, public_slug: null }] },
    { onUpdate: () => (++tries === 1 ? { data: null, error: { code: "23505", message: "duplicate key" } } : null) }
  );
  let i = 0;
  const slug = await writeSlug(db, COUNSELOR, "Jane Doe", { onlyIfMissing: true }, () => i++ % 32);
  assert.equal(updates.length, 2, "one retry after the unique violation");
  assert.notEqual(updates[0]!.values.public_slug, updates[1]!.values.public_slug);
  assert.equal(slug, updates[1]!.values.public_slug);
  assert.ok(updates.every((u) => u.filters.some(([k, v]) => k === "public_slug" && v === null)), "only a row without one");

  // Someone else set it in between: the lazy path returns theirs.
  const other = fakeDb({ booking_settings: [{ counselor_id: COUNSELOR, public_slug: "jane-doe-zzzzz" }] });
  assert.equal(await writeSlug(other.db, COUNSELOR, "Jane Doe", { onlyIfMissing: true }), "jane-doe-zzzzz");
  // Rotate replaces it; no settings row at all is null.
  const rotated = await writeSlug(other.db, COUNSELOR, "Jane Doe", { onlyIfMissing: false });
  assert.ok(rotated && rotated !== "jane-doe-zzzzz" && /^jane-doe-/.test(rotated));
  assert.equal(await writeSlug(fakeDb({ booking_settings: [] }).db, COUNSELOR, "Jane Doe", { onlyIfMissing: false }), null);
});

// ---- which links answer --------------------------------------------------------------------------------

test("a link is open only while approved, booking on and not replaced by a Google page, and the link on", () => {
  const open = settingsRow();
  assert.equal(publicLinkOpen({ approved: true, row: open }), true);
  assert.equal(publicLinkOpen({ approved: false, row: open }), false, "unapproved");
  assert.equal(publicLinkOpen({ approved: true, row: null }), false, "never set up");
  assert.equal(publicLinkOpen({ approved: true, row: settingsRow({ public_booking_enabled: false }) }), false, "link off");
  assert.equal(publicLinkOpen({ approved: true, row: settingsRow({ enabled: false }) }), false, "booking paused");
  assert.equal(
    publicLinkOpen({ approved: true, row: settingsRow({ booking_page_url: "https://calendar.app.google/abc", booking_page_mode: "instead" }) }),
    false,
    "replaced by the Google booking page"
  );
  assert.equal(publicLinkOpen({ approved: true, row: settingsRow({ public_slug: null }) }), false, "no slug");
});

async function rejectsWith(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof HttpError && e.statusCode === status && e.code === code);
}

test("resolvePublicLink: unknown, malformed, switched-off, paused and unapproved links are the same 404", async () => {
  resetPublicBookingReady();
  const profiles = [approvedProfile];
  const ok = fakeDb({ booking_settings: [settingsRow()], booking_meeting_types: [], public_bookings: [], profiles });
  const ctx = await resolvePublicLink(ok.db, "jane-doe-4f7km");
  assert.equal(ctx.counselorId, COUNSELOR);
  assert.equal(ctx.settings.publicSlug, "jane-doe-4f7km");

  await rejectsWith(resolvePublicLink(ok.db, "nobody-aaaaa"), 404, "booking_link_not_found");
  await rejectsWith(resolvePublicLink(ok.db, "../etc/passwd"), 404, "booking_link_not_found");
  const off = fakeDb({ booking_settings: [settingsRow({ public_booking_enabled: false })], public_bookings: [], profiles });
  await rejectsWith(resolvePublicLink(off.db, "jane-doe-4f7km"), 404, "booking_link_not_found");
  const paused = fakeDb({ booking_settings: [settingsRow({ enabled: false })], public_bookings: [], profiles });
  await rejectsWith(resolvePublicLink(paused.db, "jane-doe-4f7km"), 404, "booking_link_not_found");
  // The stand-in doesn't apply `.not(...)`: an unapproved counselor is simply not among the rows the approval read returns.
  const pending = fakeDb({ booking_settings: [settingsRow()], public_bookings: [], profiles: [] });
  await rejectsWith(resolvePublicLink(pending.db, "jane-doe-4f7km"), 404, "booking_link_not_found");
});

test("before the migration a link answers 503 public_booking_unavailable", async () => {
  resetPublicBookingReady();
  const { db } = fakeDb({ booking_settings: [settingsRow()], profiles: [approvedProfile] }, { missing: ["public_bookings"] });
  await rejectsWith(resolvePublicLink(db, "jane-doe-4f7km"), 503, "public_booking_unavailable");
  resetPublicBookingReady();
});

test("the public routes answer 503 public_booking_unavailable without the service role (the unit environment)", async () => {
  const app = Fastify();
  app.setErrorHandler((err: Error, _r, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    return reply.code(400).send({ error: String(err) });
  });
  app.register(publicBookingRoutes);
  await app.ready();
  const get = await app.inject({ method: "GET", url: "/public/book/jane-doe-4f7km" });
  assert.equal(get.statusCode, 503);
  assert.equal(get.json().code, "public_booking_unavailable");
  const post = await app.inject({
    method: "POST",
    url: "/public/book/jane-doe-4f7km",
    payload: { typeId: TYPE_ID, startsAt: "2027-01-05T09:00:00Z", name: "Maria Lopez", email: "maria@example.com" },
  });
  assert.equal(post.statusCode, 503);
  assert.equal(post.json().code, "public_booking_unavailable");
  await app.close();
});

test("the page answer says who and what, and nothing else about the counselor", () => {
  const settings = toSettings(settingsRow(), true, true);
  const answer = publicPageAnswer({ name: "Jane Doe", practiceName: null, logoUrl: null, email: "jane@example.com" }, settings, [type]);
  assert.deepEqual(answer, {
    counselor: { name: "Jane Doe", practiceName: null, logoUrl: null, timezone: "UTC" },
    types: [{ id: TYPE_ID, name: "Check-in", durationMinutes: 30, mode: "google-meet" }],
  });
  assert.ok(!JSON.stringify(answer).includes("jane@example.com"));
});

test("settings carry publicSlug and publicBookingEnabled only once the migration is in", () => {
  const before = toSettings(settingsRow(), true, false);
  assert.ok(!("publicSlug" in before) && !("publicBookingEnabled" in before));
  const after = toSettings(settingsRow({ public_booking_enabled: false }), true, true);
  assert.equal(after.publicSlug, "jane-doe-4f7km");
  assert.equal(after.publicBookingEnabled, false);
  const never = toSettings(null, true, true);
  assert.equal(never.publicSlug, null);
  assert.equal(never.publicBookingEnabled, true);
});

// ---- booking --------------------------------------------------------------------------------------

const body = (over: Row = {}) =>
  publicBookBody.parse({ typeId: TYPE_ID, startsAt: "2027-01-05T09:00:00Z", name: "Maria Lopez", email: "Maria@Example.com", ...over });

type Calls = string[];
function io(calls: Calls, over: Partial<PublicBookingIo> = {}): PublicBookingIo {
  const reserved = { id: "b1", counselor_id: COUNSELOR, status: "scheduled", calendar_event_id: null, join_url: null };
  return {
    now: () => new Date("2027-01-01T00:00:00Z"),
    slotOpen: async () => (calls.push("slotOpen"), true),
    countUpcomingForEmail: async (email) => (calls.push(`count:${email}`), 0),
    reserve: async (a) => (calls.push(`reserve:${a.startsAt}-${a.endsAt}:${a.email}`), { ...reserved }),
    release: async (id) => void calls.push(`release:${id}`),
    save: async (id, values) => (calls.push(`save:${id}:${JSON.stringify(values)}`), { ...reserved, ...values }),
    calendar: {
      connected: async (p) => (calls.push(`connected:${p}`), true),
      create: async (_b, p, input, conference) => (calls.push(`create:${p}:${conference}:${input.title}`), { provider: p, eventId: "ev1", joinUrl: conference ? "https://meet.google.com/abc-defg-hij" : null }),
      remove: async () => void calls.push("remove"),
    },
    afterBooking: (b) => void calls.push(`after:${String(b.id)}`),
    ...over,
  };
}

test("a filled-in honeypot gets a 201-shaped booking and nothing is read or stored", async () => {
  assert.ok(isHoneypot({ website: "http://spam.example" }));
  assert.ok(!isHoneypot({ website: "   " }) && !isHoneypot({}) && !isHoneypot({ website: null }));
  const boom = async () => {
    throw new Error("touched");
  };
  const untouchable: PublicBookingIo = {
    now: () => new Date(),
    slotOpen: boom,
    countUpcomingForEmail: boom,
    reserve: boom,
    release: boom,
    save: boom,
    calendar: { connected: boom, create: boom, remove: boom },
    afterBooking: () => {
      throw new Error("touched");
    },
  };
  const out = await bookPublic(untouchable, { type, body: body({ website: "http://spam.example" }) });
  assert.equal(out.booking.startsAt, "2027-01-05T09:00:00.000Z");
  assert.equal(out.booking.endsAt, "2027-01-05T09:30:00.000Z");
  assert.equal(out.booking.typeName, "Check-in");
  assert.equal(out.booking.joinUrl, null);
  assert.match(out.booking.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(decoyAnswer(type, "2027-01-05T09:00:00Z").booking).sort(), ["endsAt", "id", "joinUrl", "mode", "startsAt", "typeName"]);
});

test("a happy booking: reserve with the type's length, a Meet event on the counselor's calendar, saved, then the follow-ups", async () => {
  const calls: Calls = [];
  const out = await bookPublic(io(calls), { type, body: body({ note: "  About junior year  ", phone: " 555-0100 " }) });
  assert.deepEqual(calls, [
    "count:maria@example.com",
    "slotOpen",
    "reserve:2027-01-05T09:00:00.000Z-2027-01-05T09:30:00.000Z:maria@example.com",
    "connected:google",
    "create:google:true:Check-in with Maria Lopez",
    `save:b1:${JSON.stringify({ calendar_provider: "google", calendar_event_id: "ev1", join_url: "https://meet.google.com/abc-defg-hij" })}`,
    "after:b1",
  ]);
  assert.deepEqual(out, {
    booking: { id: "b1", startsAt: "2027-01-05T09:00:00.000Z", endsAt: "2027-01-05T09:30:00.000Z", mode: "google-meet", joinUrl: "https://meet.google.com/abc-defg-hij", typeName: "Check-in" },
  });
});

test("an in-person booking goes on the calendar as a plain event; nothing connected books without one", async () => {
  const inPerson = { ...type, mode: "in-person" as const };
  const calls: Calls = [];
  await bookPublic(io(calls), { type: inPerson, body: body() });
  assert.ok(calls.includes("create:google:false:Check-in with Maria Lopez"), calls.join("\n"));

  const none: Calls = [];
  const out = await bookPublic(io(none, { calendar: { connected: async () => false, create: async () => assert.fail("no calendar"), remove: async () => undefined } }), { type, body: body() });
  assert.ok(!none.some((c) => c.startsWith("save:")), "nothing to save");
  assert.equal(out.booking.joinUrl, null);
});

test("a slot that isn't offered any more is 409 slot_unavailable, and nothing is reserved", async () => {
  const calls: Calls = [];
  await rejectsWith(bookPublic(io(calls, { slotOpen: async () => false }), { type, body: body() }), 409, "slot_unavailable");
  assert.ok(!calls.some((c) => c.startsWith("reserve")));
});

test("two at once: the one that loses the lock is 409 slot_unavailable too (book_public_slot's slot_taken)", async () => {
  const taken = publicRpcError({ code: "23P01", message: "slot_taken" });
  assert.equal(taken?.statusCode, 409);
  assert.equal(taken?.code, "slot_unavailable");
  assert.equal(publicRpcError({ message: "booking_disabled" })?.code, "booking_link_not_found");
  assert.equal(publicRpcError({ message: "type_not_found" })?.code, "type_not_found");
  assert.equal(publicRpcError({ message: "invalid_slot" })?.code, "slot_unavailable");
  assert.equal(publicRpcError({ message: "something else" }), null);
  const calls: Calls = [];
  await rejectsWith(
    bookPublic(io(calls, { reserve: async () => { throw taken!; } }), { type, body: body() }),
    409,
    "slot_unavailable"
  );
  assert.ok(!calls.some((c) => c.startsWith("create") || c.startsWith("after")));
});

test("one address holds at most 3 upcoming bookings with a counselor", async () => {
  await rejectsWith(bookPublic(io([], { countUpcomingForEmail: async () => 3 }), { type, body: body() }), 409, "too_many_bookings");
});

test("a calendar write that fails releases the reservation: 503 calendar_write_failed, no follow-ups", async () => {
  const calls: Calls = [];
  const failing = io(calls);
  failing.calendar.create = async () => {
    throw new HttpError(502, "provider down");
  };
  await rejectsWith(bookPublic(failing, { type, body: body() }), 503, "calendar_write_failed");
  assert.ok(calls.includes("release:b1"));
  assert.ok(!calls.some((c) => c.startsWith("after")));

  const saveFails: Calls = [];
  const io2 = io(saveFails, {
    save: async () => {
      throw new HttpError(500, "db");
    },
  });
  await assert.rejects(bookPublic(io2, { type, body: body() }));
  assert.ok(saveFails.includes("remove") && saveFails.includes("release:b1"), saveFails.join("\n"));
});

test("the body: name 1-120, an email, phone 40, note 1000, strict, no control characters", () => {
  assert.ok(publicBookBody.safeParse({ typeId: TYPE_ID, startsAt: "2027-01-05T09:00:00Z", name: "M", email: "m@x.io" }).success);
  const bad = [
    { name: "" },
    { name: "x".repeat(121) },
    { email: "not-an-email" },
    { phone: "1".repeat(41) },
    { note: "x".repeat(1001) },
    { startsAt: "2027-01-05T09:00:00" },
    { extra: true },
    { name: "Maria\u0000" },
    { name: "Maria\nBCC: x" },
  ];
  for (const b of bad) assert.ok(!publicBookBody.safeParse({ typeId: TYPE_ID, startsAt: "2027-01-05T09:00:00Z", name: "Maria", email: "m@x.io", ...b }).success, JSON.stringify(b));
  assert.ok(publicBookBody.safeParse({ typeId: TYPE_ID, startsAt: "2027-01-05T09:00:00Z", name: "Maria", email: "m@x.io", note: "line one\nline two" }).success);
});

// ---- busy time ----------------------------------------------------------------------------------------

test("a public booking is busy time for every slot read: the student's slots and the link's", async () => {
  resetPublicBookingReady();
  const { db } = fakeDb({
    meetings: [],
    integration_tokens: [],
    public_bookings: [{ counselor_id: COUNSELOR, status: "scheduled", starts_at: "2027-01-05T09:30:00Z", ends_at: "2027-01-05T10:00:00Z" }],
  });
  const busy = await meetingBusy(db, COUNSELOR, "2027-01-05T00:00:00Z", "2027-01-06T00:00:00Z", 0);
  assert.deepEqual(busy, [{ start: "2027-01-05T09:30:00.000Z", end: "2027-01-05T10:00:00.000Z" }]);

  const settings = toSettings(settingsRow({ buffer_minutes: 15 }));
  const ctx = { ok: true as const, svc: db, counselorId: COUNSELOR, settings };
  const answer = await slotsFor(request, ctx, type, { from: "2027-01-05T00:00:00Z", to: "2027-01-06T00:00:00Z" }, new Date("2027-01-01T00:00:00Z"));
  const starts = answer.slots.map((s) => s.startsAt);
  // 09:00-12:00, 30-minute slots: 09:00 and 10:00 touch the booking once widened by the 15-minute buffer.
  assert.ok(!starts.includes("2027-01-05T09:00:00.000Z") && !starts.includes("2027-01-05T09:30:00.000Z") && !starts.includes("2027-01-05T10:00:00.000Z"), starts.join(","));
  assert.ok(starts.includes("2027-01-05T10:30:00.000Z") && starts.includes("2027-01-05T11:30:00.000Z"), starts.join(","));
});

test("before the migration the slot read skips public bookings instead of failing", async () => {
  resetPublicBookingReady();
  const { db } = fakeDb(
    { meetings: [{ id: "m1", counselor_id: COUNSELOR, status: "scheduled", starts_at: "2027-01-05T09:00:00Z", ends_at: "2027-01-05T09:30:00Z" }] },
    { missing: ["public_bookings"] }
  );
  const busy = await meetingBusy(db, COUNSELOR, "2027-01-05T00:00:00Z", "2027-01-06T00:00:00Z", 0);
  assert.deepEqual(busy, [{ start: "2027-01-05T09:00:00.000Z", end: "2027-01-05T09:30:00.000Z" }]);
  resetPublicBookingReady();
});

// ---- the counselor's calendar ---------------------------------------------------------------------

test("public bookings show on the counselor's whole calendar as '<type> with <name>', and the subscribed feed names nobody", async () => {
  resetPublicBookingReady();
  const { db } = fakeDb({
    public_bookings: [
      { id: "pb1", counselor_id: COUNSELOR, type_name: "Check-in", name: "Maria Lopez", email: "maria@example.com", phone: "555-0100", note: "Junior year", starts_at: "2027-01-05T09:00:00Z", ends_at: "2027-01-05T09:30:00Z", status: "scheduled" },
    ],
  });
  const q = { from: "2027-01-01", to: "2027-01-31", tz: "UTC", includeDone: true, includeCancelled: false };
  const out = await buildCalendarFeed({ db, ownerId: COUNSELOR, role: "counselor", caseload: [] }, q);
  assert.equal(out.items.length, 1);
  const item = out.items[0]!;
  assert.equal(item.id, "meeting:pb1");
  assert.equal(item.kind, "meeting");
  assert.equal(item.title, "Check-in with Maria Lopez");
  assert.equal(item.studentId, null);
  assert.deepEqual(item.attendeeIds, []);
  assert.equal(item.publicBooking, true);
  assert.equal(item.meetingStatus, "scheduled");
  assert.match(item.detail ?? "", /maria@example\.com · 555-0100\n\nJunior year/);

  const ics = feedIcsEvents(out.items, new Map());
  assert.equal(ics[0]!.summary, "Meeting", "the forwarded feed says neither the booker's name nor the type");

  const scoped = await buildCalendarFeed({ db, ownerId: COUNSELOR, role: "counselor", caseload: [] }, { ...q, studentId: "s1" });
  assert.equal(scoped.items.length, 0, "one student's calendar has no public bookings");
});

test("a public booking on Google carries its event page (htmlLink) in the app's feed only, never another provider's", async () => {
  resetPublicBookingReady();
  const base = { counselor_id: COUNSELOR, type_name: "Check-in", name: "Maria Lopez", email: "maria@example.com", phone: null, note: null, status: "scheduled" };
  const { db } = fakeDb({
    public_bookings: [
      { ...base, id: "pbg", starts_at: "2027-01-05T09:00:00Z", ends_at: "2027-01-05T09:30:00Z", calendar_provider: "google", calendar_event_id: "evt123" },
      { ...base, id: "pbm", starts_at: "2027-01-06T09:00:00Z", ends_at: "2027-01-06T09:30:00Z", calendar_provider: "microsoft", calendar_event_id: "AAMk" },
      { ...base, id: "pbn", starts_at: "2027-01-07T09:00:00Z", ends_at: "2027-01-07T09:30:00Z", calendar_provider: null, calendar_event_id: null },
    ],
  });
  const q = { from: "2027-01-01", to: "2027-01-31", tz: "UTC", includeDone: true, includeCancelled: false };
  let reads = 0;
  const googleAccountEmail = async () => (reads++, "jane@school.org");
  const out = await buildCalendarFeed({ db, ownerId: COUNSELOR, role: "counselor", caseload: [], googleAccountEmail }, q);
  const byRef = new Map(out.items.map((i) => [i.ref, i]));
  const link = byRef.get("pbg")!.htmlLink!;
  assert.ok(link.startsWith("https://www.google.com/calendar/event?eid="));
  assert.equal(Buffer.from(new URL(link).searchParams.get("eid")!, "base64url").toString(), "evt123 jane@school.org");
  assert.equal(byRef.get("pbm")!.htmlLink, null);
  assert.equal(byRef.get("pbn")!.htmlLink, null);
  assert.equal(reads, 1, "the address is read once per feed");

  const ical = await buildCalendarFeed({ db, ownerId: COUNSELOR, role: "counselor", caseload: [] }, q);
  assert.ok(ical.items.every((i) => !("htmlLink" in i)), "without the lookup (the iCal feed) there is no link field");
});

// ---- what is sent ----------------------------------------------------------------------------------

const saved: Row = {
  id: "11111111-1111-4111-8111-111111111111",
  counselor_id: COUNSELOR,
  type_name: "Check-in",
  mode: "google-meet",
  name: "Maria Lopez",
  email: "maria@example.com",
  phone: "555-0100",
  note: "About junior year",
  starts_at: "2027-01-05T14:00:00Z",
  ends_at: "2027-01-05T14:30:00Z",
  join_url: null,
};

test("the pipeline entry and the counselor's notice read as the contract says", () => {
  assert.equal(activityText("Check-in", "2027-01-05T14:00:00Z", "America/New_York"), "Booked Check-in for Tue, Jan 5, 9:00 AM EST");
  const n = counselorNotice(saved, "America/New_York");
  assert.equal(n.title, "Maria Lopez booked Check-in on Tue, Jan 5, 9:00 AM EST");
  assert.match(n.body, /public booking link/);
  assert.match(n.body, /Email: maria@example\.com/);
  assert.match(n.body, /Phone: 555-0100/);
  assert.match(n.body, /Note: About junior year/);
  assert.match(n.body, /no Google Meet link yet/);
  assert.doesNotMatch(counselorNotice({ ...saved, join_url: "https://meet.google.com/x" }, "UTC").body, /no Google Meet link/);
});

test("the booker's invite: REQUEST to them alone, the counselor organizing, its own UID", () => {
  const unfold = (s: string) => s.replace(/\r\n /g, "");
  const ics = unfold(
    publicBookingIcs(saved, { name: "Jane Doe", email: "jane@example.com" }, { name: "Maria Lopez", email: "maria@example.com" }, "REQUEST", "invites@meridiesai.com", new Date("2027-01-01T00:00:00Z"))
  );
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, /UID:meeting-public-11111111-1111-4111-8111-111111111111@meridiesai\.com/);
  assert.match(ics, /SUMMARY:Check-in with Jane Doe/);
  assert.match(ics, /ORGANIZER;CN="Jane Doe";SENT-BY="mailto:invites@meridiesai\.com":mailto:jane@example\.com/);
  assert.match(ics, /ATTENDEE;[^\r\n]*:mailto:maria@example\.com/);
  assert.doesNotMatch(ics, /About junior year/, "the booker's own note isn't echoed into their invite");
  const copy = unfold(publicBookingIcs(saved, { name: "Jane Doe", email: "jane@example.com" }, null, "PUBLISH", null));
  assert.match(copy, /METHOD:PUBLISH/);
  assert.match(copy, /SUMMARY:Check-in with Maria Lopez/);
  assert.doesNotMatch(copy, /ATTENDEE/);

  const mail = bookerEmail(saved, "Jane Doe", "America/New_York");
  assert.match(mail.subject, /^Booked: Check-in with Jane Doe · Tue, Jan 5/);
  assert.match(mail.text, /Hi Maria, your meeting with Jane Doe is booked\./);
  assert.match(mail.text, /reply to this email/);
});

test("the counselor's calendar event carries the booker's details in its description", () => {
  const input = publicEventInput(type, { name: "Maria Lopez", email: "maria@example.com", phone: null, note: "Hi" }, "2027-01-05T09:00:00Z", "2027-01-05T09:30:00Z");
  assert.equal(input.title, "Check-in with Maria Lopez");
  assert.equal(input.description, "Booked through your Meridies booking link.\nEmail: maria@example.com\n\nNote: Hi");
});
