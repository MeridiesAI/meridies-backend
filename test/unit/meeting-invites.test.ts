// lib/meetingInvites.ts: who is emailed what when a meeting is booked,
// changed, cancelled or deleted; the recipient rules (fail closed); the
// throttle; the pre-migration path; the email copy; and delivery.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deliverInviteRound,
  inviteColumns,
  inviteEmail,
  inviteEndError,
  invitesReady,
  latestInvitePerAddress,
  planInviteRound,
  prepareInviteRound,
  resetInvitesReady,
  resolveRound,
  whenLong,
  whenShort,
  type InvitePlan,
  type MeetingState,
  type PlanInput,
  type PlannedMessage,
  type ResolvedRound,
} from "../../src/lib/meetingInvites.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const C = "c0000000-0000-4000-8000-000000000001";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const D = "d0000000-0000-4000-8000-00000000000d";

function m(over: Partial<MeetingState> = {}): MeetingState {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    counselorId: C,
    primaryStudentId: A,
    status: "scheduled",
    sendInvites: true,
    guardiansInvited: false,
    startsAt: "2026-10-20T19:00:00Z",
    endsAt: "2026-10-20T19:45:00Z",
    title: "Essay check-in",
    location: null,
    joinUrl: null,
    mode: "in-person",
    agenda: null,
    sequence: 0,
    onProviderCalendar: false,
    ...over,
  };
}

function plan(over: Partial<PlanInput>): InvitePlan | null {
  return planInviteRound({ before: null, after: m(), attendeesBefore: [A], attendeesAfter: [A], notify: true, now: NOW, ...over });
}

const short = (msgs: PlannedMessage[] | undefined) =>
  (msgs ?? []).map((x) => `${x.audience}:${x.audience === "counselor" ? "-" : x.studentId.slice(0, 1)}:${x.method}:${x.template.replace("meeting-", "")}`).sort();

// ---- The plan -------------------------------------------------------------------

test("create: invites on sends a REQUEST to each student and a copy to the counselor; off sends nothing", () => {
  const on = plan({ attendeesAfter: [A, B] });
  assert.deepEqual(short(on?.messages), ["counselor:-:PUBLISH:invite", "student:a:REQUEST:invite", "student:b:REQUEST:invite"]);
  assert.equal(on?.sequence, 0);
  assert.equal(on?.linkMeeting, true);
  assert.equal(plan({ after: m({ sendInvites: false }) }), null);
});

test("create with guardians invited adds a guardians message per student", () => {
  const p = plan({ after: m({ guardiansInvited: true }), attendeesAfter: [A, B] });
  assert.deepEqual(short(p?.messages), [
    "counselor:-:PUBLISH:invite",
    "guardians:a:REQUEST:invite",
    "guardians:b:REQUEST:invite",
    "student:a:REQUEST:invite",
    "student:b:REQUEST:invite",
  ]);
});

test("the counselor's copy only when the meeting isn't on their connected calendar", () => {
  const p = plan({ after: m({ onProviderCalendar: true }) });
  assert.deepEqual(short(p?.messages), ["student:a:REQUEST:invite"]);
});

test("a move sends an update to everyone kept; an unchanged save sends nothing", () => {
  const before = m();
  const moved = plan({ before, after: m({ startsAt: "2026-10-21T19:00:00Z", endsAt: "2026-10-21T20:00:00Z", sequence: 1 }) });
  assert.deepEqual(short(moved?.messages), ["counselor:-:PUBLISH:update", "student:a:REQUEST:update"]);
  assert.equal(moved?.sequence, 1);
  for (const field of [{ title: "New title" }, { agenda: "Bring drafts" }, { location: "Library" }, { mode: "phone" as const }, { joinUrl: "https://x.test" }]) {
    assert.ok(plan({ before, after: m({ ...field, sequence: 1 }) }), JSON.stringify(field));
  }
  // The same time written differently is not a change.
  assert.equal(plan({ before, after: m({ startsAt: "2026-10-20T15:00:00-04:00" }) }), null);
  assert.equal(plan({ before, after: m() }), null);
});

test("adding and removing students: an invite to the new one, a cancel to the removed one, nobody else", () => {
  const p = plan({ before: m(), after: m(), attendeesBefore: [A, B], attendeesAfter: [A, D] });
  assert.deepEqual(short(p?.messages), ["student:b:CANCEL:cancel", "student:d:REQUEST:invite"]);
  assert.deepEqual(p?.keep.map((k) => k.studentId).sort(), [A, D].sort());
});

test("the guardians flag both ways reaches the kept students' guardians only", () => {
  const on = plan({ before: m(), after: m({ guardiansInvited: true }), attendeesBefore: [A, B], attendeesAfter: [A, B] });
  assert.deepEqual(short(on?.messages), ["guardians:a:REQUEST:invite", "guardians:b:REQUEST:invite"]);
  const off = plan({ before: m({ guardiansInvited: true }), after: m({ guardiansInvited: false }), attendeesBefore: [A], attendeesAfter: [A] });
  assert.deepEqual(short(off?.messages), ["guardians:a:CANCEL:cancel"]);
  // A move with guardians kept updates them too.
  const moved = plan({ before: m({ guardiansInvited: true }), after: m({ guardiansInvited: true, title: "Moved" }) });
  assert.deepEqual(short(moved?.messages), ["counselor:-:PUBLISH:update", "guardians:a:REQUEST:update", "student:a:REQUEST:update"]);
});

test("cancel tells everyone who held it; un-cancel re-invites; held and no-show send nothing", () => {
  const cancelled = plan({ before: m({ guardiansInvited: true }), after: m({ guardiansInvited: true, status: "cancelled", sequence: 1 }), attendeesBefore: [A, B], attendeesAfter: [A, B] });
  assert.deepEqual(short(cancelled?.messages), ["counselor:-:CANCEL:cancel", "guardians:a:CANCEL:cancel", "guardians:b:CANCEL:cancel", "student:a:CANCEL:cancel", "student:b:CANCEL:cancel"]);
  assert.deepEqual(cancelled?.keep, []);
  assert.equal(cancelled?.sequence, 1);

  const back = plan({ before: m({ status: "cancelled" }), after: m({ sequence: 2 }) });
  assert.deepEqual(short(back?.messages), ["counselor:-:PUBLISH:invite", "student:a:REQUEST:invite"]);

  assert.equal(plan({ before: m(), after: m({ status: "held" }) }), null);
  assert.equal(plan({ before: m(), after: m({ status: "no-show" }) }), null);
});

test("delete: a cancel to everyone, one past the last SEQUENCE, not linked to the gone meeting", () => {
  const p = plan({ before: m({ sequence: 4, guardiansInvited: true }), after: null, attendeesBefore: [A, B] });
  assert.deepEqual(short(p?.messages), ["counselor:-:CANCEL:cancel", "guardians:a:CANCEL:cancel", "guardians:b:CANCEL:cancel", "student:a:CANCEL:cancel", "student:b:CANCEL:cancel"]);
  assert.equal(p?.sequence, 5);
  assert.equal(p?.linkMeeting, false);
  assert.equal(plan({ before: m({ sendInvites: false }), after: null }), null);
  assert.equal(plan({ before: m({ status: "held" }), after: null }), null);
});

test("switching invites off after they went out cancels them; switching on invites everyone", () => {
  const off = plan({ before: m({ guardiansInvited: true }), after: m({ sendInvites: false, guardiansInvited: true, sequence: 1 }), attendeesBefore: [A, B], attendeesAfter: [A, B] });
  assert.deepEqual(short(off?.messages), ["counselor:-:CANCEL:cancel", "guardians:a:CANCEL:cancel", "guardians:b:CANCEL:cancel", "student:a:CANCEL:cancel", "student:b:CANCEL:cancel"]);
  assert.deepEqual(off?.keep, []);
  // Explicit either way: "don't email this change" doesn't hold back the switch itself.
  assert.ok(plan({ before: m(), after: m({ sendInvites: false }), notify: false }));
  const on = plan({ before: m({ sendInvites: false }), after: m({ sequence: 1 }), attendeesBefore: [A], attendeesAfter: [A, B], notify: false });
  assert.deepEqual(short(on?.messages), ["counselor:-:PUBLISH:invite", "student:a:REQUEST:invite", "student:b:REQUEST:invite"]);
  assert.equal(plan({ before: m({ sendInvites: false }), after: m({ sendInvites: false, title: "x" }) }), null);
});

test("notify off, or a meeting that is over, sends nothing", () => {
  assert.equal(plan({ before: m(), after: m({ title: "Moved" }), notify: false }), null);
  assert.equal(plan({ before: m(), after: m({ status: "cancelled" }), notify: false }), null);
  const past = { startsAt: "2026-10-01T10:00:00Z", endsAt: "2026-10-01T11:00:00Z" };
  assert.equal(plan({ after: m(past) }), null);
  assert.equal(plan({ before: m(past), after: m({ ...past, title: "x" }) }), null);
  assert.equal(plan({ before: m(past), after: null }), null);
  assert.equal(plan({ before: m(past), after: m({ ...past, sendInvites: false }) }), null, "no cancel for a meeting that is over");
  // Moved from the past into the future: invited afresh.
  assert.ok(plan({ before: m(past), after: m() }));
});

// ---- The pre-migration path ---------------------------------------------------------------

test("invitesReady: a missing column is cached for 30 s, ready for the process, other errors uncached", async () => {
  resetInvitesReady();
  let calls = 0;
  let answer: { code?: string } | null = { code: "42703" };
  const db = { from: () => ({ select: () => ({ limit: async () => (calls++, { error: answer }) }) }) };
  assert.equal(await invitesReady(db, 0), false);
  assert.equal(await invitesReady(db, 10_000), false);
  assert.equal(calls, 1, "the miss is cached");
  answer = null;
  assert.equal(await invitesReady(db, 31_000), true);
  answer = { code: "42703" };
  assert.equal(await invitesReady(db, 99_000_000), true, "ready is kept");
  assert.equal(calls, 2);

  resetInvitesReady();
  calls = 0;
  answer = { code: "57014" };
  assert.equal(await invitesReady(db, 0), false);
  assert.equal(await invitesReady(db, 1), false);
  assert.equal(calls, 2, "a transient error is asked again");
  resetInvitesReady();
});

test("before the migration no write names send_invites, and no end time is demanded", () => {
  assert.deepEqual(inviteColumns(false, true), {});
  assert.deepEqual(inviteColumns(false, undefined), {});
  assert.deepEqual(inviteColumns(true, undefined), {});
  assert.deepEqual(inviteColumns(true, false), { send_invites: false });
  assert.equal(inviteEndError(false, true, null), null);
  assert.equal(inviteEndError(true, true, null), "A calendar invite needs an end time");
  assert.equal(inviteEndError(true, true, "2026-10-20T19:45:00Z"), null);
  assert.equal(inviteEndError(true, false, null), null);
});

// ---- Recipients ------------------------------------------------------------------------

type Tables = Record<string, Record<string, unknown>[] | { error: { code: string; message: string } }>;

/** A PostgREST-shaped fake: eq / in / order / limit / maybeSingle over in-memory rows. */
function fakeDb(tables: Tables, log: string[] = []): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, "eq" | "in", unknown][] = [];
    let single = false;
    const run = () => {
      log.push(table);
      const t = tables[table];
      if (t && !Array.isArray(t)) return { data: null, error: t.error };
      let rows = (t ?? []).filter((r) => filters.every(([k, op, v]) => (op === "eq" ? r[k] === v : (v as unknown[]).includes(r[k]))));
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

function baseTables(over: Partial<Tables> = {}): Tables {
  return {
    profiles: [
      { id: C, full_name: "Dana Counselor", email: "Dana@Practice.test", counselor_id: null, archived_at: null },
      { id: A, full_name: "Avery Student", email: "avery@example.com", counselor_id: C, archived_at: null },
      { id: B, full_name: "Blake Student", email: "blake@example.com", counselor_id: C, archived_at: null },
      { id: D, full_name: "Drew Student", email: "drew@example.com", counselor_id: C, archived_at: null },
    ],
    student_personal_details: [{ student_id: A, contact_email: "avery.personal@example.com" }],
    student_collaborators: [],
    student_alert_prefs: [],
    guardians: [
      { id: "g1", student_id: A, full_name: "Pat Parent", email: "pat@example.com", alerts_enabled: true },
      { id: "g2", student_id: A, full_name: "Sam Self-added", email: "sam@example.com", alerts_enabled: false },
      { id: "g3", student_id: B, full_name: "Pat Parent", email: "PAT@example.com", alerts_enabled: true },
    ],
    accountability_settings: [{ counselor_id: C, student_id: null, timezone: "America/Los_Angeles" }],
    ...over,
  };
}

const emails = (r: Awaited<ReturnType<typeof resolveRound>>) =>
  "skip" in r ? r.skip : r.recipients.map((x) => `${x.kind}:${x.email}:${x.method}`).sort();

test("recipients: the student's contact email, guardians with alerts on, the counselor's copy, deduped", async () => {
  const p = plan({ after: m({ guardiansInvited: true }), attendeesAfter: [A, B] })!;
  const r = await resolveRound(fakeDb(baseTables()), p);
  assert.deepEqual(emails(r), [
    "counselor:dana@practice.test:PUBLISH",
    "guardian:pat@example.com:REQUEST",
    "student:avery.personal@example.com:REQUEST",
    "student:blake@example.com:REQUEST",
  ]);
  assert.ok(!("skip" in r));
  if (!("skip" in r)) {
    assert.equal(r.timeZone, "America/Los_Angeles");
    assert.deepEqual(r.organizer, { name: "Dana Counselor", email: "dana@practice.test" });
  }
});

test("an archived or off-roster student, and their guardians, receive nothing", async () => {
  const t = baseTables();
  const profiles = t.profiles as Record<string, unknown>[];
  profiles[1] = { ...profiles[1], archived_at: "2026-09-01T00:00:00Z" };
  profiles[2] = { ...profiles[2], counselor_id: "someone-else" };
  const p = plan({ after: m({ guardiansInvited: true }), attendeesAfter: [A, B, D] })!;
  const r = await resolveRound(fakeDb(t), p);
  assert.deepEqual(emails(r), ["counselor:dana@practice.test:PUBLISH", "student:drew@example.com:REQUEST"]);
  if (!("skip" in r)) assert.equal(r.skipped, 2);
});

test("a student shared with the meeting's counselor is on their caseload", async () => {
  const t = baseTables({ student_collaborators: [{ student_id: B, counselor_id: C }] });
  (t.profiles as Record<string, unknown>[])[2]!.counselor_id = "primary-elsewhere";
  const r = await resolveRound(fakeDb(t), plan({ attendeesAfter: [B] })!);
  assert.deepEqual(emails(r), ["counselor:dana@practice.test:PUBLISH", "student:blake@example.com:REQUEST"]);
  // An unreadable collaborators list is "not shared".
  const t2 = baseTables({ student_collaborators: { error: { code: "XX000", message: "boom" } } });
  (t2.profiles as Record<string, unknown>[])[2]!.counselor_id = "primary-elsewhere";
  const r2 = await resolveRound(fakeDb(t2), plan({ attendeesAfter: [B] })!);
  assert.deepEqual(emails(r2), ["counselor:dana@practice.test:PUBLISH"]);
});

test("copy_parents off, or its read failing, keeps that student's guardians out (fail closed)", async () => {
  const p = plan({ after: m({ guardiansInvited: true }), attendeesAfter: [A] })!;
  const off = await resolveRound(fakeDb(baseTables({ student_alert_prefs: [{ student_id: A, copy_parents: false, copy_student: false }] })), p);
  assert.deepEqual(emails(off), ["counselor:dana@practice.test:PUBLISH", "student:avery.personal@example.com:REQUEST"]);
  if (!("skip" in off)) assert.match(off.notes.join(" "), /switched off/);

  const broken = await resolveRound(fakeDb(baseTables({ student_alert_prefs: { error: { code: "XX000", message: "boom" } } })), p);
  assert.deepEqual(emails(broken), ["counselor:dana@practice.test:PUBLISH", "student:avery.personal@example.com:REQUEST"]);

  const noGuardians = await resolveRound(fakeDb(baseTables({ guardians: { error: { code: "XX000", message: "boom" } } })), p);
  assert.deepEqual(emails(noGuardians), ["counselor:dana@practice.test:PUBLISH", "student:avery.personal@example.com:REQUEST"]);
});

test("an unreadable roster or organizer skips the whole round", async () => {
  const p = plan({})!;
  assert.equal(emails(await resolveRound(fakeDb(baseTables({ student_personal_details: { error: { code: "XX000", message: "x" } } })), p)), "Couldn't read who to invite");
  const t = baseTables();
  (t.profiles as Record<string, unknown>[])[0]!.email = null;
  assert.match(String(emails(await resolveRound(fakeDb(t), p))), /counselor/);
});

test("a guardian of two siblings is never cancelled while one sibling is still invited", async () => {
  // B leaves; A stays. Pat is a guardian of both.
  const p = plan({ before: m({ guardiansInvited: true }), after: m({ guardiansInvited: true }), attendeesBefore: [A, B], attendeesAfter: [A] })!;
  const r = await resolveRound(fakeDb(baseTables()), p);
  assert.deepEqual(emails(r), ["student:blake@example.com:CANCEL"]);
});

test("the time zone falls back to UTC when settings can't be read", async () => {
  const r = await resolveRound(fakeDb(baseTables({ accountability_settings: { error: { code: "XX000", message: "x" } } })), plan({})!);
  if (!("skip" in r)) assert.equal(r.timeZone, "UTC");
});

// ---- Throttle -----------------------------------------------------------------------------

const req = (db: SupabaseClient) => ({ db, log: { warn() {}, error() {}, info() {} } }) as never;

test("the throttle is spent only on a round that sends an invite, and cancellations bypass it", async () => {
  let spent = 0;
  const allow = async () => (spent++, true);
  const none = await prepareInviteRound(req(fakeDb(baseTables())), { before: m(), after: m({ status: "held" }), attendeesBefore: [A], attendeesAfter: [A], notify: true }, { consume: allow, now: NOW });
  assert.deepEqual(none.summary, { status: "none" });
  assert.equal(spent, 0, "an empty plan costs nothing");

  const deny = async () => (spent++, false);
  const cancel = await prepareInviteRound(req(fakeDb(baseTables())), { before: m(), after: m({ status: "cancelled" }), attendeesBefore: [A], attendeesAfter: [A], notify: true }, { consume: deny, now: NOW });
  assert.equal(spent, 0, "cancellations aren't counted");
  assert.equal(cancel.summary.status, "sending");

  const invite = await prepareInviteRound(req(fakeDb(baseTables())), { before: null, after: m(), attendeesBefore: [], attendeesAfter: [A], notify: true }, { consume: deny, now: NOW });
  assert.equal(spent, 1);
  assert.equal(invite.summary.status, "skipped");
  assert.equal(invite.round, null);

  // Mixed: the cancel still goes, the invite doesn't.
  const mixed = await prepareInviteRound(req(fakeDb(baseTables())), { before: m(), after: m(), attendeesBefore: [A, B], attendeesAfter: [A, D], notify: true }, { consume: deny, now: NOW });
  assert.equal(mixed.summary.status, "sending");
  assert.deepEqual(mixed.round?.recipients.map((r) => `${r.email}:${r.method}`), ["blake@example.com:CANCEL"]);
  if (mixed.summary.status === "sending") assert.match(mixed.summary.note ?? "", /Too many/);
});

test("a round nobody can receive is skipped with a reason", async () => {
  const t = baseTables();
  (t.profiles as Record<string, unknown>[])[1]!.archived_at = "2026-01-01T00:00:00Z";
  const r = await prepareInviteRound(req(fakeDb(t)), { before: null, after: m(), attendeesBefore: [], attendeesAfter: [A], notify: true }, { consume: async () => true, now: NOW });
  assert.equal(r.summary.status, "skipped");
  assert.equal(r.round, null);
});

// ---- The email ---------------------------------------------------------------------------------

test("subject and times in the counselor's zone", () => {
  assert.equal(whenShort("2026-10-20T19:00:00Z", "America/New_York"), "Tue, Oct 20, 3:00 PM EDT");
  assert.equal(whenShort("2026-10-20T19:00:00Z", "UTC"), "Tue, Oct 20, 7:00 PM UTC");
  assert.equal(whenLong("2026-10-20T19:00:00Z", "2026-10-20T19:45:00Z", "America/New_York"), "Tuesday, October 20, 2026 at 3:00 PM EDT, until 3:45 PM EDT");
  const e = inviteEmail({ kind: "student", template: "meeting-invite", studentName: "Avery" }, m({ title: "Essay\r\nBcc: evil@x.test" }), "America/New_York", "Dana");
  assert.equal(e.subject, "Invitation: Essay Bcc: evil@x.test · Tue, Oct 20, 3:00 PM EDT");
  assert.equal(/[\r\n]/.test(e.subject), false);
  assert.match(e.text, /Open your calendar/);
  assert.equal(e.text.includes("\u2014"), false, "no em dash");

  const g = inviteEmail({ kind: "guardian", template: "meeting-update", studentName: "Avery Student" }, m(), "UTC", "Dana");
  assert.match(g.subject, /^Updated: /);
  assert.match(g.text, /for Avery Student/);
  assert.equal(g.text.includes("Open your calendar"), false, "no student link for a guardian");

  const c = inviteEmail({ kind: "student", template: "meeting-cancel", studentName: null }, m({ mode: "teams" }), "UTC", null);
  assert.match(c.subject, /^Cancelled: /);
  assert.match(c.text, /Your counselor booked this/);
  assert.equal(c.text.includes("Where:"), false);
  assert.equal(c.html.includes("<script"), false);
  assert.ok(inviteEmail({ kind: "student", template: "meeting-invite", studentName: null }, m({ title: "<script>x</script>" }), "UTC", null).html.includes("&lt;script&gt;"));
});

// ---- Delivery -------------------------------------------------------------------------------------

test("delivery: one email per recipient with its own .ics, linked to the meeting, never throwing", async () => {
  const sent: Record<string, unknown>[] = [];
  const pauses: number[] = [];
  const round: ResolvedRound = {
    meetingId: m().id,
    linkMeeting: true,
    meeting: m({ sequence: 2 }),
    sequence: 2,
    organizer: { name: "Dana", email: "dana@practice.test" },
    timeZone: "UTC",
    skipped: 0,
    notes: [],
    recipients: [
      { email: "avery@example.com", name: "Avery", kind: "student", recipientId: A, studentId: A, studentName: "Avery", method: "REQUEST", template: "meeting-update" },
      { email: "pat@example.com", name: "Pat", kind: "guardian", recipientId: "g1", studentId: A, studentName: "Avery", method: "CANCEL", template: "meeting-cancel" },
      { email: "dana@practice.test", name: "Dana", kind: "counselor", recipientId: C, studentId: A, studentName: null, method: "PUBLISH", template: "meeting-update" },
      { email: "bad", name: null, kind: "student", recipientId: B, studentId: B, studentName: null, method: "REQUEST", template: "meeting-update" },
    ],
  };
  const out = await deliverInviteRound(round, { warn() {}, error() {} }, {
    send: (async (a: Record<string, unknown>) => {
      sent.push(a);
      return { id: "x", sent: true, deliveryId: "d", error: null };
    }) as never,
    pause: async (ms) => void pauses.push(ms),
    now: () => NOW,
  });
  assert.deepEqual(out, { sent: 3, failed: 1 });
  assert.equal(sent.length, 3);
  assert.deepEqual(pauses, [250, 250, 250]);
  const ics = (i: number) => Buffer.from((sent[i]!.attachments as { content: string }[])[0]!.content, "base64").toString("utf8").replace(/\r\n /g, "");
  assert.match(ics(0), /METHOD:REQUEST\r\n/);
  assert.match(ics(0), /SEQUENCE:2\r\n/);
  assert.match(ics(0), /ATTENDEE;[^\r]*:mailto:avery@example\.com\r\n/);
  assert.equal(ics(0).includes("pat@example.com"), false, "one family's address never in another's file");
  assert.match(ics(1), /METHOD:CANCEL\r\n/);
  assert.match(ics(2), /METHOD:PUBLISH\r\n/);
  assert.equal(/ATTENDEE/.test(ics(2)), false);
  assert.equal((sent[1]!.attachments as { contentType: string }[])[0]!.contentType, "text/calendar; charset=utf-8; method=CANCEL");
  for (const s of sent) {
    assert.equal(s.meeting_id, round.meetingId);
    assert.equal(s.replyTo, "dana@practice.test");
    assert.equal(s.retryOn429, true);
  }
  assert.deepEqual(sent.map((s) => [s.recipient_kind, s.template]), [
    ["student", "meeting-update"],
    ["guardian", "meeting-cancel"],
    ["counselor", "meeting-update"],
  ]);

  // Deleted meeting: rows carry no meeting link.
  sent.length = 0;
  await deliverInviteRound({ ...round, linkMeeting: false, recipients: round.recipients.slice(0, 1) }, { warn() {}, error() {} }, {
    send: (async (a: Record<string, unknown>) => (sent.push(a), { id: null, sent: false, deliveryId: null, error: "x" })) as never,
    pause: async () => undefined,
    now: () => NOW,
  });
  assert.equal(sent[0]!.meeting_id, null);
});

test("the invites list: newest attempt per address, reasons safe to show", () => {
  const rows = [
    { to_email: "Avery@example.com", recipient_kind: "student", template: "meeting-update", status: "sent", channel: "email", sent_at: "2026-10-15T12:05:00Z", created_at: "2026-10-15T12:05:00Z" },
    { to_email: "avery@example.com", recipient_kind: "student", template: "meeting-invite", status: "delivered", channel: "email", sent_at: "2026-10-15T12:00:00Z", delivered_at: "2026-10-15T12:00:05Z", created_at: "2026-10-15T12:00:00Z" },
    { to_email: "pat@example.com", recipient_kind: "guardian", template: "meeting-invite", status: "failed", channel: "email", error: "RESEND_API_KEY unset", created_at: "2026-10-15T12:00:00Z" },
    { to_email: null, status: "sent" },
  ];
  const list = latestInvitePerAddress(rows);
  assert.deepEqual(list.map((d) => [d.email, d.recipientKind, d.template, d.status]), [
    ["avery@example.com", "student", "meeting-update", "sent"],
    ["pat@example.com", "guardian", "meeting-invite", "failed"],
  ]);
  assert.equal(list[1]!.reason, "Email isn't set up on the server yet");
});
