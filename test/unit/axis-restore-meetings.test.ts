// A restored meeting sends its invitation again (lib/axisRestoreMeetings.ts, migration 20261113000001). The database
// is a stand-in and the calendar and invite sends are injected stubs; nothing reaches a network. The invite round
// itself, against a real database, is test/integration/axis-trash.test.mjs.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { FastifyRequest } from "fastify";
import { calendarPlan, reinviteRestoredMeetings, restoredMeetingsFrom } from "../../src/lib/axisRestoreMeetings.js";
import { resetInvitesReady } from "../../src/lib/meetingInvites.js";

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
      null,
    ]),
    [
      { id: MEETING, calendarProvider: "google" },
      { id: OTHER, calendarProvider: null },
      { id: STUDENT, calendarProvider: null },
    ]
  );
  assert.deepEqual(restoredMeetingsFrom({ id: MEETING }), []);
});

test("calendarPlan: the caller's own future meeting goes back on the calendar it was on", () => {
  assert.deepEqual(calendarPlan(meeting(), "google", ME, NOW), { put: true, provider: "google" });
  assert.deepEqual(calendarPlan(meeting({ mode: "teams" }), "microsoft", ME, NOW), { put: true, provider: "microsoft" });
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

/** rpc + from().select().eq().maybeSingle() / .update().eq().select().single() / .select().limit() / .eq().limit(). */
function fakeDb(opts: { rpc: unknown; rpcError?: { code: string } | null; row: Row; saveError?: { code: string } | null }) {
  const writes: Row[] = [];
  let row = { ...opts.row };
  const db = {
    rpc: async () => ({ data: opts.rpc, error: opts.rpcError ?? null }),
    from(table: string) {
      let update: Row | null = null;
      const b = {
        select: () => b,
        update: (v: Row) => {
          update = v;
          return b;
        },
        eq: () => b,
        // invitesReady's zero-row probe, and meeting_attendees.
        limit: async () => ({ data: table === "meeting_attendees" ? [{ student_id: STUDENT }] : [], error: null }),
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
  return { db, writes };
}

const quietLog = { warn: () => undefined, info: () => undefined, error: () => undefined };

function request(db: unknown) {
  return { db, log: quietLog, auth: { userId: ME } } as unknown as Pick<FastifyRequest, "db" | "log" | "auth">;
}

function stubs(opts: { createFails?: boolean; round?: boolean } = {}) {
  const calls = { created: [] as unknown[][], dropped: [] as unknown[][], prepared: [] as Row[], started: 0 };
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
      prepare: (async (_req: unknown, input: Row) => {
        calls.prepared.push(input);
        return opts.round === false
          ? { summary: { status: "none" }, round: null }
          : { summary: { status: "sending", recipients: 1, skipped: 0 }, round: {} };
      }) as never,
      start: (() => {
        calls.started++;
      }) as never,
      now: () => NOW,
    },
  };
}

beforeEach(() => resetInvitesReady());

test("a restored future meeting goes back on its calendar with a new link, then gets a new meeting's round", async () => {
  const { db, writes } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting() });
  const s = stubs();
  const out = await reinviteRestoredMeetings(request(db), "action-1", s.deps);
  assert.deepEqual(out, { invited: true });
  assert.equal(s.calls.created.length, 1);
  assert.deepEqual(s.calls.created[0].slice(0, 3), [
    ME,
    "google",
    { title: "Essay review", startsAt: "2026-11-12T15:00:00Z", endsAt: "2026-11-12T15:30:00Z", description: "Draft two" },
  ]);
  assert.deepEqual(writes, [{ calendar_provider: "google", calendar_event_id: "evt-new", join_url: "https://meet.google.com/new-link" }]);
  // The round is a new meeting's: no "before", every attendee, with the new link.
  const input = s.calls.prepared[0] as { before: unknown; after: { joinUrl: string; onProviderCalendar: boolean }; attendeesAfter: string[]; notify: boolean };
  assert.equal(input.before, null);
  assert.deepEqual(input.attendeesAfter, [STUDENT]);
  assert.equal(input.after.joinUrl, "https://meet.google.com/new-link");
  assert.equal(input.after.onProviderCalendar, true);
  assert.equal(input.notify, true);
  assert.equal(s.calls.started, 1);
});

test("a calendar that can't be reached doesn't stop the invitation", async () => {
  const { db, writes } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting() });
  const s = stubs({ createFails: true });
  assert.deepEqual(await reinviteRestoredMeetings(request(db), "action-1", s.deps), { invited: true });
  assert.deepEqual(writes, []);
  assert.equal(s.calls.prepared.length, 1);
});

test("an event the meeting couldn't be pointed at is taken off the calendar again", async () => {
  const { db } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting(), saveError: { code: "42501" } });
  const s = stubs();
  await reinviteRestoredMeetings(request(db), "action-1", s.deps);
  assert.deepEqual(s.calls.dropped.map((a) => a.slice(0, 3)), [[ME, "google", "evt-new"]]);
});

test("another counselor's meeting gets its invitation but no calendar event", async () => {
  const { db, writes } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: "google" }], row: meeting({ counselor_id: OTHER }) });
  const s = stubs();
  assert.deepEqual(await reinviteRestoredMeetings(request(db), "action-1", s.deps), { invited: true });
  assert.equal(s.calls.created.length, 0);
  assert.deepEqual(writes, []);
});

test("invites off, or a round with nobody to email, sends nothing and says so", async () => {
  for (const [row, round] of [
    [meeting({ send_invites: false }), true],
    [meeting(), false],
  ] as const) {
    const { db } = fakeDb({ rpc: [{ id: MEETING, calendarProvider: null }], row });
    const s = stubs({ round });
    assert.deepEqual(await reinviteRestoredMeetings(request(db), "action-1", s.deps), { invited: false });
    assert.equal(s.calls.started, 0);
  }
});

test("before the migration (no function) a restore sends nothing", async () => {
  const { db } = fakeDb({ rpc: null, rpcError: { code: "PGRST202" }, row: meeting() });
  const s = stubs();
  assert.deepEqual(await reinviteRestoredMeetings(request(db), "action-1", s.deps), { invited: false });
  assert.equal(s.calls.prepared.length, 0);
  assert.equal(s.calls.created.length, 0);
});
