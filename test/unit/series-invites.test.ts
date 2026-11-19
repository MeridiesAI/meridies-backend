// lib/seriesInvites.ts: one invite round for a whole repeating series. One
// email per recipient listing every date, charged once; create attaches one
// PUBLISH .ics holding every occurrence, update and cancel attach nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MeetingState } from "../../src/lib/meetingInvites.js";
import { buildSeriesIcs, deliverSeriesRound, prepareSeriesInviteRound, type SeriesRound } from "../../src/lib/seriesInvites.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const C = "c0000000-0000-4000-8000-000000000001";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";

function m(i: number, over: Partial<MeetingState> = {}): MeetingState {
  const day = new Date(Date.UTC(2026, 9, 20 + 7 * i, 19, 0));
  return {
    id: `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    counselorId: C,
    primaryStudentId: A,
    status: "scheduled",
    sendInvites: true,
    guardiansInvited: false,
    startsAt: day.toISOString(),
    endsAt: new Date(day.getTime() + 45 * 60_000).toISOString(),
    title: "Weekly check-in",
    location: null,
    joinUrl: null,
    mode: "in-person",
    agenda: null,
    sequence: i % 3,
    onProviderCalendar: true,
    ...over,
  };
}
const twelve = (over: Partial<MeetingState> = {}) => Array.from({ length: 12 }, (_, i) => m(i, over));

type Tables = Record<string, Record<string, unknown>[] | { error: { code: string; message: string } }>;

/** The same PostgREST-shaped fake as meeting-invites.test.ts. */
function fakeDb(tables: Tables): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, "eq" | "in", unknown][] = [];
    let single = false;
    const run = () => {
      const t = tables[table];
      if (t && !Array.isArray(t)) return { data: null, error: t.error };
      const rows = (t ?? []).filter((r) => filters.every(([k, op, v]) => (op === "eq" ? r[k] === v : (v as unknown[]).includes(r[k]))));
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push([k, "eq", v]), b),
      in: (k: string, v: unknown[]) => (filters.push([k, "in", v]), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => ((single = true), b),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

function baseTables(): Tables {
  return {
    profiles: [
      { id: C, full_name: "Dana Counselor", email: "Dana@Practice.test", counselor_id: null, archived_at: null },
      { id: A, full_name: "Avery Student", email: "avery@example.com", counselor_id: C, archived_at: null },
      { id: B, full_name: "Blake Student", email: "blake@example.com", counselor_id: C, archived_at: null },
    ],
    student_collaborators: [],
    student_alert_prefs: [],
    guardians: [{ id: "g1", student_id: A, full_name: "Pat Parent", email: "pat@example.com", alerts_enabled: true }],
    accountability_settings: [{ counselor_id: C, student_id: null, timezone: "UTC" }],
  };
}

const req = () => ({ db: fakeDb(baseTables()), log: { warn() {}, error() {}, info() {} } }) as never;

function counting(answer = true) {
  const keys: string[] = [];
  return { keys, consume: (async (key: string) => (keys.push(key), answer)) as never };
}

async function deliver(round: SeriesRound | null, failFor?: string) {
  const sent: Record<string, unknown>[] = [];
  const out = await deliverSeriesRound(round!, { warn() {}, error() {} }, {
    send: (async (a: Record<string, unknown>) => {
      if (a.to === failFor) throw new Error("boom");
      sent.push(a);
      return { id: "x", sent: true, deliveryId: "d", error: null };
    }) as never,
    pause: async () => undefined,
    now: () => NOW,
  });
  return { sent, out };
}

const icsOf = (s: Record<string, unknown>) =>
  Buffer.from((s.attachments as { content: string }[])[0]!.content, "base64").toString("utf8").replace(/\r\n /g, "");

const DATES = ["October 20, 2026", "October 27, 2026", "November 3, 2026", "January 5, 2027"];

test("create: one charge, one email per recipient, one PUBLISH .ics holding all twelve", async () => {
  const { keys, consume } = counting();
  const after = twelve();
  const p = await prepareSeriesInviteRound(req(), { kind: "create", before: [], after, attendeeIds: [A, B], notify: true }, { consume, now: NOW });
  assert.deepEqual(keys, [`meeting-invites:${C}`]);
  assert.deepEqual(p.summary, { status: "sending", recipients: 2, skipped: 0 });

  const { sent, out } = await deliver(p.round as SeriesRound);
  assert.deepEqual(out, { sent: 2, failed: 0 });
  assert.equal(sent.length, 2);
  for (const s of sent) {
    const atts = s.attachments as { contentType: string }[];
    assert.equal(atts.length, 1);
    assert.equal(atts[0]!.contentType, "text/calendar; charset=utf-8; method=PUBLISH");
    const ics = icsOf(s);
    assert.equal(ics.match(/^BEGIN:VEVENT$/gm)?.length, 12);
    assert.equal(ics.match(/^METHOD:PUBLISH\r$/gm)?.length, 1);
    const uids = ics.match(/^UID:.*$/gm) ?? [];
    assert.equal(new Set(uids).size, 12);
    assert.deepEqual(ics.match(/^SEQUENCE:\d+/gm), after.map((x) => `SEQUENCE:${x.sequence}`));
    assert.equal(/ATTENDEE|RSVP/.test(ics), false);
    assert.equal(s.template, "meeting-invite");
    assert.equal(s.meeting_id, after[0]!.id);
    for (const d of DATES) assert.ok(String(s.text).includes(d), `${d} in the body`);
  }
  assert.deepEqual(sent.map((s) => s.to).sort(), ["avery@example.com", "blake@example.com"]);
});

test("update: charged once, the changed dates listed, nothing attached", async () => {
  const { keys, consume } = counting();
  const p = await prepareSeriesInviteRound(req(), { kind: "update", before: twelve(), after: twelve({ title: "Moved" }), attendeeIds: [A, B], notify: true }, { consume, now: NOW });
  assert.equal(keys.length, 1);
  const { sent } = await deliver(p.round as SeriesRound);
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.attachments, undefined);
    assert.equal(s.template, "meeting-update");
    for (const d of DATES) assert.ok(String(s.text).includes(d));
  }
});

test("cancel: never charged, even with the hour used up; dates listed, nothing attached, no meeting link", async () => {
  const { keys, consume } = counting(false);
  const p = await prepareSeriesInviteRound(req(), { kind: "cancel", before: twelve(), after: [], attendeeIds: [A, B], notify: true }, { consume, now: NOW });
  assert.deepEqual(keys, []);
  assert.equal(p.summary.status, "sending");
  const { sent } = await deliver(p.round as SeriesRound);
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.attachments, undefined);
    assert.equal(s.template, "meeting-cancel");
    assert.equal(s.meeting_id, null);
    for (const d of DATES) assert.ok(String(s.text).includes(d));
  }
});

test("notify off, or nothing affected, sends nothing and charges nothing", async () => {
  const { keys, consume } = counting();
  for (const input of [
    { kind: "create" as const, before: [], after: twelve(), attendeeIds: [A], notify: false },
    { kind: "cancel" as const, before: twelve(), after: [], attendeeIds: [A], notify: false },
    { kind: "create" as const, before: [], after: [], attendeeIds: [A], notify: true },
    { kind: "update" as const, before: twelve(), after: [], attendeeIds: [A], notify: true },
    { kind: "create" as const, before: [], after: twelve({ sendInvites: false }), attendeeIds: [A], notify: true },
  ]) {
    const p = await prepareSeriesInviteRound(req(), input, { consume, now: NOW });
    assert.deepEqual(p.summary, { status: "none" }, JSON.stringify(input.kind));
    assert.equal(p.round, null);
  }
  assert.deepEqual(keys, []);
});

test("update: nothing a family sees changed sends nothing and charges nothing; only changed rows are listed", async () => {
  const { keys, consume } = counting();
  const same = await prepareSeriesInviteRound(req(), { kind: "update", before: twelve(), after: twelve(), attendeeIds: [A, B], notify: true }, { consume, now: NOW });
  assert.deepEqual(same.summary, { status: "none" });
  assert.deepEqual(keys, []);

  const after = twelve().map((x, i) => (i === 1 ? { ...x, title: "Moved" } : x));
  const one = await prepareSeriesInviteRound(req(), { kind: "update", before: twelve(), after, attendeeIds: [A], notify: true }, { consume, now: NOW });
  assert.deepEqual(keys, [`meeting-invites:${C}`]);
  const { sent } = await deliver(one.round);
  assert.equal(sent.length, 1);
  assert.ok(String(sent[0]!.text).includes("October 27, 2026"));
  assert.equal(String(sent[0]!.text).includes("October 20, 2026"), false);
});

test("update: a row that ends up cancelled is never reported (deletes use kind cancel)", async () => {
  const { keys, consume } = counting();
  const only = await prepareSeriesInviteRound(req(), { kind: "update", before: [m(0)], after: [m(0, { status: "cancelled", title: "Moved" })], attendeeIds: [A], notify: true }, { consume, now: NOW });
  assert.deepEqual(only.summary, { status: "none" });
  assert.deepEqual(keys, []);

  const before = [m(0), m(1)];
  const after = [m(0, { status: "cancelled", title: "Moved" }), m(1, { title: "Moved" })];
  const mixed = await prepareSeriesInviteRound(req(), { kind: "update", before, after, attendeeIds: [A], notify: true }, { consume, now: NOW });
  const { sent } = await deliver(mixed.round);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.template, "meeting-update");
  assert.equal(String(sent[0]!.text).includes("October 20, 2026"), false);
  assert.ok(String(sent[0]!.text).includes("October 27, 2026"));
  assert.equal(/cancel/i.test(String(sent[0]!.text)), false);
});

test("one date reads in the singular for create, update and cancel", async () => {
  const { consume } = counting();
  const inputs = [
    { kind: "create" as const, before: [], after: [m(0)] },
    { kind: "update" as const, before: [m(0)], after: [m(0, { title: "Moved" })] },
    { kind: "cancel" as const, before: [m(0)], after: [] },
  ];
  for (const i of inputs) {
    const p = await prepareSeriesInviteRound(req(), { ...i, attendeeIds: [A], notify: true }, { consume, now: NOW });
    const { sent } = await deliver(p.round);
    const all = `${sent[0]!.subject}\n${sent[0]!.text}`;
    assert.equal(/1 dates|these dates|These 1|\bdates\b/.test(all), false, `${i.kind}: ${all}`);
  }
});

test("the hour used up: create and update are skipped with the single round's reason", async () => {
  for (const kind of ["create", "update"] as const) {
    const { keys, consume } = counting(false);
    const p = await prepareSeriesInviteRound(req(), { kind, before: twelve(), after: twelve({ title: "Moved" }), attendeeIds: [A, B], notify: true }, { consume, now: NOW });
    assert.equal(keys.length, 1);
    assert.deepEqual(p.summary, { status: "skipped", reason: "Too many calendar invites this hour, so invites and updates weren't emailed" });
    assert.equal(p.round, null);
  }
});

test("guardians included when invited; the counselor's copy only for rows not on their calendar, and not counted", async () => {
  const { consume } = counting();
  const after = twelve({ guardiansInvited: true }).map((x, i) => (i < 2 ? { ...x, onProviderCalendar: false } : x));
  const p = await prepareSeriesInviteRound(req(), { kind: "create", before: [], after, attendeeIds: [A], notify: true }, { consume, now: NOW });
  assert.deepEqual(p.summary, { status: "sending", recipients: 2, skipped: 0 });
  const { sent } = await deliver(p.round as SeriesRound);
  assert.deepEqual(sent.map((s) => `${s.recipient_kind}:${s.to}`).sort(), ["counselor:dana@practice.test", "guardian:pat@example.com", "student:avery@example.com"]);
  const copy = sent.find((s) => s.recipient_kind === "counselor")!;
  assert.equal(icsOf(copy).match(/^BEGIN:VEVENT$/gm)?.length, 2);
});

test("a recipient whose send throws doesn't stop the others", async () => {
  const { consume } = counting();
  const p = await prepareSeriesInviteRound(req(), { kind: "create", before: [], after: twelve(), attendeeIds: [A, B], notify: true }, { consume, now: NOW });
  const { sent, out } = await deliver(p.round as SeriesRound, "avery@example.com");
  assert.deepEqual(out, { sent: 1, failed: 1 });
  assert.deepEqual(sent.map((s) => s.to), ["blake@example.com"]);
});

test("buildSeriesIcs: one calendar, one METHOD, an event per row", () => {
  const ev = (i: number) => ({
    meetingId: `m${i}`, sequence: i, method: "PUBLISH" as const, startsAt: m(i).startsAt, endsAt: m(i).endsAt!, title: "T", agenda: null,
    mode: "in-person" as const, location: null, joinUrl: null, organizer: { name: "Dana", email: "dana@practice.test" }, sentBy: null, attendee: null, now: NOW,
  });
  const ics = buildSeriesIcs([ev(0), ev(1), ev(2)], "PUBLISH");
  assert.equal(ics.match(/BEGIN:VCALENDAR/g)?.length, 1);
  assert.equal(ics.match(/METHOD:PUBLISH/g)?.length, 1);
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 3);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});
