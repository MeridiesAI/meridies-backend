// A restored meeting comes back quietly (lib/axisRestoreMeetings.ts; Elvin, 11/26): back on its owner's calendar,
// and no invitation is emailed. The database is a stand-in and the calendar calls are injected stubs; nothing reaches
// a network. Against a real database: test/integration/axis-trash.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { calendarPlan, resyncRestoredMeetings, restoredMeetingsFrom } from "../../src/lib/axisRestoreMeetings.js";

type Row = Record<string, unknown>;

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";
const MEETING = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-08T12:00:00Z");

const meeting = (extra: Row = {}): Row => ({
  id: MEETING,
  counselor_id: ME,
  student_id: STUDENT,
  status: "scheduled",
  send_invites: true,
  guardians_invited: false,
  title: "Essay review",
  mode: "google-meet",
  starts_at: "2026-11-12T15:00:00Z",
  ends_at: "2026-11-12T15:30:00Z",
  agenda: "Draft two",
  join_url: "https://meet.google.com/old-link",
  calendar_provider: null,
  calendar_event_id: null,
  ics_sequence: 2,
  ...extra,
});

test("restoredMeetingsFrom keeps well-formed rows only", () => {
  assert.deepEqual(
    restoredMeetingsFrom([
      { id: MEETING, calendarProvider: "google" },
      { id: OTHER, calendarProvider: null },
      { id: "not-a-uuid", calendarProvider: "google" },
      { id: STUDENT, calendarProvider: "zoom" },
      { id: ME, calendarProvider: "skype" },
      null,
    ]),
    [
      { id: MEETING, calendarProvider: "google" },
      { id: OTHER, calendarProvider: null },
      { id: STUDENT, calendarProvider: "zoom" },
      { id: ME, calendarProvider: null },
    ]
  );
  assert.deepEqual(restoredMeetingsFrom({ id: MEETING }), []);
});

test("calendarPlan: the caller's own future meeting goes back on the calendar it was on", () => {
  assert.deepEqual(calendarPlan(meeting(), "google", ME, NOW), { put: true, provider: "google" });
  assert.deepEqual(calendarPlan(meeting({ mode: "teams" }), "microsoft", ME, NOW), { put: true, provider: "microsoft" });
  // A deleted Zoom meeting comes back as a new Zoom meeting, not as a dead link.
  assert.deepEqual(calendarPlan(meeting({ mode: "zoom" }), "zoom", ME, NOW), { put: true, provider: "zoom" });
});

test("calendarPlan: nothing goes on a calendar it wasn't on, someone else's, or for a meeting that's over", () => {
  assert.equal(calendarPlan(meeting(), null, ME, NOW).put, false);
  assert.equal(calendarPlan(meeting(), "google", OTHER, NOW).put, false);
  assert.equal(calendarPlan(meeting({ counselor_id: OTHER }), "google", ME, NOW).put, false);
  assert.equal(calendarPlan(meeting({ ends_at: "2026-11-01T15:30:00Z", starts_at: "2026-11-01T15:00:00Z" }), "google", ME, NOW).put, false);
  assert.equal(calendarPlan(meeting({ ends_at: null }), "google", ME, NOW).put, false);
  assert.equal(calendarPlan(meeting({ status: "cancelled" }), "google", ME, NOW).put, false);
  assert.equal(calendarPlan(meeting({ calendar_event_id: "evt-already" }), "google", ME, NOW).put, false);
});

/** rpc + from().select().eq().maybeSingle() / .update().eq().select().single(). Records every table touched. */
function fakeDb(opts: { rpc: unknown; rpcError?: { code: string } | null; row: Row; saveError?: { code: string } | null }) {
  const writes: Row[] = [];
  const tables: string[] = [];
  let row = { ...opts.row };
  const db = {
    rpc: async (name: string) => {
      tables.push(`rpc:${name}`);
      return { data: opts.rpc, error: opts.rpcError ?? null };
    },
    from(table: string) {
      tables.push(table);
      let update: Row | null = null;
      const b = {
        select: () => b,
        insert: (v: Row) => {
          writes.push({ insert: table, ...v });
          return b;
        },
        update: (v: Row) => {
          update = v;
          return b;
        },
        eq: () => b,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: table === "meetings" ? row : null, error: null }),
        single: async () => {
          if (opts.saveError) return { data: null, error: opts.saveError };
          writes.push(update ?? {});
          row = { ...row, ...(update ?? {}) };
          return { data: row, error: null };
        },
      };
      return b;
    },
  };
  return { db, writes, tables };
}

const quietLog = { warn: () => undefined, info: () => undefined, error: () => undefined };

function request(db: unknown) {
  return { db, log: quietLog, auth: { userId: ME } } as unknown as Pick<FastifyRequest, "db" | "log" | "auth">;
}

function stubs(opts: { createFails?: boolean } = {}) {
  const calls = { created: [] as unknown[][], dropped: [] as unknown[][] };
  return {
    calls,
    deps: {
      createEvent: (async (...args: unknown[]) => {
        calls.created.push(args);
        if (opts.createFails) throw new Error("google: invalid_grant");
        return { eventId: "evt-new", joinUrl: "https://meet.google.com/new-link" };
      }) as never,
      dropEvent: (async (...args: unknown[]) => {
        calls.dropped.push(args);
      }) as never,
      now: () => NOW,
    },
  };
}

/** Only the restore function and the meetings table are touched: no delivery, no invite round, no notification. */
function assertQuiet(tables: string[]) {
  for (const t of tables) assert.ok(t === "rpc:axis_trash_restored_meetings" || t === "meetings", `touched ${t}`);
}

test("a restored future meeting goes back on its calendar with a new link, and no invitation is sent", async () => {
  const { db, writes, tables } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting() });
  const s = stubs();
  const out = await resyncRestoredMeetings(request(db), "action-1", s.deps);
  assert.deepEqual(out, { calendars: 1 });
  assert.equal("invited" in out, false);
  assert.equal(s.calls.created.length, 1);
  assert.deepEqual(s.calls.created[0].slice(0, 3), [
    ME,
    "google",
    { title: "Essay review", startsAt: "2026-11-12T15:00:00Z", endsAt: "2026-11-12T15:30:00Z", description: "Draft two" },
  ]);
  assert.deepEqual(writes, [{ calendar_provider: "google", calendar_event_id: "evt-new", join_url: "https://meet.google.com/new-link" }]);
  assertQuiet(tables);
});

test("a restored meeting with invites on still sends nothing (restore is quiet)", async () => {
  for (const provider of [null, "google", "microsoft", "zoom"] as const) {
    const { db, tables } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: provider }], row: meeting({ send_invites: true, guardians_invited: true }) });
    await resyncRestoredMeetings(request(db), "action-1", stubs().deps);
    assertQuiet(tables);
  }
});

test("a calendar that can't be reached is logged, and the dead link is dropped", async () => {
  // The delete took the owner's event (and its Meet/Teams link) off the calendar: no link beats a dead one.
  const { db, writes, tables } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting() });
  const s = stubs({ createFails: true });
  assert.deepEqual(await resyncRestoredMeetings(request(db), "action-1", s.deps), { calendars: 0 });
  assert.deepEqual(writes, [{ join_url: null }]);
  assertQuiet(tables);
});

test("an event the meeting couldn't be pointed at is taken off the calendar again", async () => {
  const { db } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting(), saveError: { code: "42501" } });
  const s = stubs();
  assert.deepEqual(await resyncRestoredMeetings(request(db), "action-1", s.deps), { calendars: 0 });
  assert.deepEqual(s.calls.dropped.map((a) => a.slice(0, 3)), [[ME, "google", "evt-new"]]);
});

test("another counselor's meeting gets no calendar event and keeps its link", async () => {
  // A collaborator's delete never touched the owner's calendar (routes/meetings.ts dropCalendarEvent skips a
  // meeting the caller doesn't own), so the owner's event and its link are still there.
  const { db, writes } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting({ counselor_id: OTHER }) });
  const s = stubs();
  assert.deepEqual(await resyncRestoredMeetings(request(db), "action-1", s.deps), { calendars: 0 });
  assert.equal(s.calls.created.length, 0);
  assert.deepEqual(writes, []);
});

test("before the migration (no function) a restore touches no calendar", async () => {
  const { db } = fakeDb({ rpc: null, rpcError: { code: "PGRST202" }, row: meeting() });
  const s = stubs();
  assert.deepEqual(await resyncRestoredMeetings(request(db), "action-1", s.deps), { calendars: 0 });
  assert.equal(s.calls.created.length, 0);
});
