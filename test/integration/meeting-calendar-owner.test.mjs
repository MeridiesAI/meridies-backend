// A meeting's calendar pointer (calendar_provider, calendar_event_id) names an
// event on its owner's Google or Outlook calendar, and the API acts on it with
// stored OAuth tokens. These checks are the attacks on that pointer:
//
//   * through PostgREST, a counselor forging a meeting whose counselor_id is
//     another counselor (so the API would edit or delete that counselor's
//     event with that counselor's token), or re-pointing a colleague's meeting;
//   * through the API, editing a meeting someone else owns, which must never
//     call that person's calendar;
//   * a read-only collaborator writing meetings at all.
//
// The local API has no Google client configured, so any calendar call answers
// 503 ("Google isn't set up"): a 503 on a PATCH means the API asked a
// provider, a 200 means it didn't.
import { user, call, check, sql, rest } from "./harness.mjs";

const A = await user("mco-owner");          // the victim: owns the meeting and the calendar event
const M = await user("mco-attacker");       // another counselor with their own student
const B = await user("mco-writer");         // write collaborator on A's student
const R = await user("mco-reader");         // read-only collaborator on A's student
const sa = await user("mco-sa", "student");
const sm = await user("mco-sm", "student");
await sql(`update profiles set counselor_id='${A.id}' where id='${sa.id}'`);
await sql(`update profiles set counselor_id='${M.id}' where id='${sm.id}'`);
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values
  ('${sa.id}', '${B.id}', 'write'), ('${sa.id}', '${R.id}', 'read')`);

const day = (n, h = 15) => new Date(Date.UTC(2030, 2, n, h, 0, 0)).toISOString();
const guardReady = (await sql(`select count(*) from pg_trigger where tgname = 'meetings_owner_guard'`)) === "1";

/** A meeting written as postgres (the API's own booking, with a real event behind it). */
async function seed(student, owner, { pointer = true, title = "Seeded" } = {}) {
  return sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, calendar_provider, calendar_event_id, join_url)
    values ('${student}', '${owner}', '${title.replace(/'/g, "''")}', 'google-meet', '${day(3)}', '${day(3, 16)}',
            ${pointer ? "'google', 'evt" + Math.random().toString(36).slice(2, 10) + "'" : "null, null"},
            ${pointer ? "'https://meet.google.com/abc-defg-hij'" : "null"}) returning id`).then((out) => out.split("\n")[0]);
}
const row = async (id) => JSON.parse((await sql(`select row_to_json(m) from meetings m where id='${id}'`)) || "null");

// ---- Through PostgREST -------------------------------------------------------------------

const forged = await rest(M.token, "POST", "/rest/v1/meetings", {
  student_id: sm.id, counselor_id: A.id, title: "Forged", starts_at: day(4), ends_at: day(4, 16),
  calendar_provider: "google", calendar_event_id: "victimEvent123",
}, { Prefer: "return=representation" });
check("a counselor can't insert a meeting owned by another counselor", forged.status === 403, JSON.stringify(forged.body));

const forgedNoPointer = await rest(M.token, "POST", "/rest/v1/meetings", {
  student_id: sm.id, counselor_id: A.id, title: "Forged, no pointer", starts_at: day(4), ends_at: day(4, 16),
}, { Prefer: "return=representation" });
check("…not even without a calendar pointer", forgedNoPointer.status === 403, JSON.stringify(forgedNoPointer.body));

const own = await rest(M.token, "POST", "/rest/v1/meetings", {
  student_id: sm.id, counselor_id: M.id, title: "Mine", starts_at: day(5), ends_at: day(5, 16),
}, { Prefer: "return=representation" });
const ownId = own.body?.[0]?.id;
check("a counselor still inserts their own meeting", own.status === 201 && Boolean(ownId), JSON.stringify(own.body));

const handOver = await rest(M.token, "PATCH", `/rest/v1/meetings?id=eq.${ownId}`,
  { counselor_id: A.id, calendar_provider: "google", calendar_event_id: "victimEvent123" }, { Prefer: "return=representation" });
check("…and can't hand it, pointer and all, to another counselor", handOver.status === 403, JSON.stringify(handOver.body));
check("…so the row still belongs to them, with no pointer", (await row(ownId))?.counselor_id === M.id && (await row(ownId))?.calendar_event_id === null);

const aMeeting = await seed(sa.id, A.id, { title: "A's real meeting" });
const aBefore = await row(aMeeting);

const repoint = await rest(B.token, "PATCH", `/rest/v1/meetings?id=eq.${aMeeting}`,
  { calendar_event_id: "someOtherEvent99" }, { Prefer: "return=representation" });
check("a write collaborator can't re-point the owner's calendar event", repoint.status === 403, JSON.stringify(repoint.body));
const clear = await rest(B.token, "PATCH", `/rest/v1/meetings?id=eq.${aMeeting}`,
  { calendar_provider: null, calendar_event_id: null }, { Prefer: "return=representation" });
check("…nor clear it", clear.status === 403, JSON.stringify(clear.body));
const take = await rest(B.token, "PATCH", `/rest/v1/meetings?id=eq.${aMeeting}`,
  { counselor_id: B.id }, { Prefer: "return=representation" });
check("…nor take the meeting over", take.status === 403, JSON.stringify(take.body));
check("the pointer and the owner are unchanged", (await row(aMeeting))?.calendar_event_id === aBefore.calendar_event_id && (await row(aMeeting))?.counselor_id === A.id);

const retitle = await rest(B.token, "PATCH", `/rest/v1/meetings?id=eq.${aMeeting}`,
  { title: "Renamed by the write collaborator" }, { Prefer: "return=representation" });
check("a write collaborator still edits the meeting's own fields", retitle.status === 200 && retitle.body?.[0]?.title === "Renamed by the write collaborator", JSON.stringify(retitle.body));

const readerEdit = await rest(R.token, "PATCH", `/rest/v1/meetings?id=eq.${aMeeting}`,
  { title: "Renamed by the reader" }, { Prefer: "return=representation" });
check("a read-only collaborator can't edit a meeting", (await row(aMeeting))?.title === "Renamed by the write collaborator", JSON.stringify(readerEdit.body));
const readerInsert = await rest(R.token, "POST", "/rest/v1/meetings", {
  student_id: sa.id, counselor_id: R.id, title: "Reader's meeting", starts_at: day(6),
}, { Prefer: "return=representation" });
check("…nor book one about the student", readerInsert.status === 403, JSON.stringify(readerInsert.body));
await rest(R.token, "DELETE", `/rest/v1/meetings?id=eq.${aMeeting}`);
check("…nor delete one", (await row(aMeeting)) !== null);
const readerSees = await rest(R.token, "GET", `/rest/v1/meetings?id=eq.${aMeeting}&select=id`);
check("…but still reads it", readerSees.status === 200 && readerSees.body?.length === 1, JSON.stringify(readerSees.body));

const studentInsert = await rest(sa.token, "POST", "/rest/v1/meetings", {
  student_id: sa.id, counselor_id: sa.id, title: "Self-booked", starts_at: day(6),
}, { Prefer: "return=representation" });
check("a student can't book their own meeting", studentInsert.status === 403, JSON.stringify(studentInsert.body));

const writerOwn = await rest(B.token, "POST", "/rest/v1/meetings", {
  student_id: sa.id, counselor_id: B.id, title: "Writer's own", starts_at: day(6), ends_at: day(6, 16),
}, { Prefer: "return=representation" });
check("a write collaborator still books a meeting of their own about the student", writerOwn.status === 201, JSON.stringify(writerOwn.body));

// ---- Through the API ---------------------------------------------------------------------

// A row that names another counselor while the caller passes the student
// check (forged before the guard existed, or on a database without it):
// nothing the caller does with it may reach that counselor's calendar.
const legacyForged = await seed(sm.id, A.id, { title: "Forged before the guard" });
const forgedPatch = await call(M.token, "PATCH", `/meetings/${legacyForged}`, { title: "Phishing title", agenda: "Join here instead", startsAt: day(9), endsAt: day(9, 16) });
check("PATCH on a meeting owned by someone else never calls the owner's calendar", forgedPatch.status === 200 && forgedPatch.body?.title === "Phishing title", JSON.stringify(forgedPatch.body));
check("…and leaves the pointer alone", (await row(legacyForged))?.calendar_provider === "google");

const forgedMode = await call(M.token, "PATCH", `/meetings/${legacyForged}`, { mode: "in-person" });
check("a mode change on it saves without the owner's calendar", forgedMode.status === 200, JSON.stringify(forgedMode.body));
check("…and the pointer stays for the owner", (await row(legacyForged))?.calendar_event_id !== null);

const forgedCancel = await call(M.token, "PATCH", `/meetings/${legacyForged}`, { status: "cancelled" });
check("cancelling it saves in Meridies only", forgedCancel.status === 200 && forgedCancel.body?.status === "cancelled", JSON.stringify(forgedCancel.body));
check("…and doesn't clear the owner's pointer", (await row(legacyForged))?.calendar_event_id !== null);

const forgedDelete = await call(M.token, "DELETE", `/meetings/${legacyForged}`);
check("DELETE of it goes through in Meridies without the owner's calendar", forgedDelete.status === 200, JSON.stringify(forgedDelete.body));
check("…and the meeting is gone", (await row(legacyForged)) === null);

const noPointer = await seed(sm.id, A.id, { pointer: false, title: "Owned by A, no event" });
const forgedConf = await call(M.token, "PATCH", `/meetings/${noPointer}`, { createConference: true });
check("putting someone else's meeting on a calendar is refused", forgedConf.status === 403, JSON.stringify(forgedConf.body));
check("…and nothing changes", (await row(noPointer))?.calendar_event_id === null);

// A collaborator on the owner's student: whatever the roster check answers,
// the owner's calendar is never called (a 503 here would mean it was).
const bPatch = await call(B.token, "PATCH", `/meetings/${aMeeting}`, { title: "Moved by B", startsAt: day(7), endsAt: day(7, 16) });
check("a write collaborator's PATCH never reaches the owner's calendar", bPatch.status !== 503, JSON.stringify(bPatch.body));
const bDelete = await call(B.token, "DELETE", `/meetings/${aMeeting}`);
check("…nor does their DELETE", bDelete.status !== 503, JSON.stringify(bDelete.body));
check("the owner's event is still named on the row", (await row(aMeeting))?.calendar_event_id === aBefore.calendar_event_id || (await row(aMeeting)) === null);

const rPatch = await call(R.token, "PATCH", `/meetings/${aMeeting}`, { title: "Reader" });
check("a read-only collaborator's PATCH is refused by the API", rPatch.status === 403 || rPatch.status === 404, JSON.stringify(rPatch.body));

const aOwn = await seed(sa.id, A.id, { title: "A's second meeting" });
const aPatch = await call(A.token, "PATCH", `/meetings/${aOwn}`, { title: "Renamed by the owner" });
check("the owner's PATCH still syncs their own calendar (503 here: no Google client)", aPatch.status === 503, JSON.stringify(aPatch.body));
check("…and nothing is saved when the calendar refuses", (await row(aOwn))?.title === "A's second meeting");
const aCancel = await call(A.token, "PATCH", `/meetings/${aOwn}`, { status: "cancelled" });
check("the owner's cancel clears their own pointer (the delete is best effort)", aCancel.status === 200 && (await row(aOwn))?.calendar_event_id === null, JSON.stringify(aCancel.body));
const aPlain = await call(A.token, "POST", "/meetings", { studentId: sa.id, title: "A's booking", startsAt: day(8), endsAt: day(8, 16) });
check("the owner still books through the API", aPlain.status === 201 && aPlain.body?.counselorId === A.id, JSON.stringify(aPlain.body));

// ---- The owner's invite throttle ---------------------------------------------------------

// A row forged before the guard, naming A as its owner, about M's own student:
// M passes every edit check on it. Switching emailed invites on (or changing
// the meeting while they are on) must not spend A's 60 rounds an hour.
const invitesReady = (await sql(`select count(*) from information_schema.columns where table_name='meetings' and column_name='send_invites'`)) === "1";
const bucket = async (owner) => Number((await sql(`select coalesce((select count from private.rate_limit_buckets where key='meeting-invites:${owner}'), 0)`)) || 0);
if (invitesReady) {
  await sql(`delete from private.rate_limit_buckets where key in ('meeting-invites:${A.id}', 'meeting-invites:${M.id}')`);
  const burn = await seed(sm.id, A.id, { pointer: false, title: "Forged for the throttle" });
  const on = await call(M.token, "PATCH", `/meetings/${burn}`, { sendInvites: true, endsAt: day(3, 16) });
  check("switching invites on for someone else's forged meeting saves", on.status === 200, JSON.stringify(on.body));
  check("…but sends nothing", on.body?.invites?.status === "skipped", JSON.stringify(on.body?.invites));
  for (let i = 0; i < 3; i++) await call(M.token, "PATCH", `/meetings/${burn}`, { title: `Burn ${i}`, startsAt: day(10 + i), endsAt: day(10 + i, 16) });
  check("…and none of those rounds spends the named owner's invite throttle", (await bucket(A.id)) === 0, `count=${await bucket(A.id)}`);
  check("…nor the caller's", (await bucket(M.id)) === 0);

  const real = await seed(sa.id, A.id, { pointer: false, title: "A's invite meeting" });
  const realOn = await call(A.token, "PATCH", `/meetings/${real}`, { sendInvites: true, endsAt: day(3, 16) });
  check("the real owner's invite round still goes out", realOn.status === 200 && realOn.body?.invites?.status === "sending", JSON.stringify(realOn.body?.invites));
  check("…and is charged once, to the owner", (await bucket(A.id)) === 1, `count=${await bucket(A.id)}`);
  const bRound = await call(B.token, "PATCH", `/meetings/${real}`, { title: "Moved by the writer", startsAt: day(12), endsAt: day(12, 16) });
  // Whether B's change is accepted, and whether B may read A's address, decide
  // whether an update goes; either way the owner is charged exactly when it does.
  const sent = bRound.status === 200 && bRound.body?.invites?.status === "sending";
  check(`…and charges the owner's throttle only if it is sent (${sent ? "sent" : bRound.body?.invites?.reason ?? bRound.status})`, (await bucket(A.id)) === (sent ? 2 : 1), `count=${await bucket(A.id)}`);
} else {
  console.log("(meeting invites migration absent: throttle checks skipped)");
}

// ---- 20261024000012: rows forged before the guard lose their pointer ---------------------

const fs = await import("node:fs");
const backfill = fs.readFileSync(new URL("../../supabase/migrations/20261024000012_meeting_calendar_forged_rows.sql", import.meta.url), "utf8");
const fForged = await seed(sm.id, A.id, { title: "Forged, pointer" });
const fOwn = await seed(sa.id, A.id, { title: "A's, pointer" });
const fWriter = await seed(sa.id, B.id, { title: "Writer's, pointer" });
const fReader = await seed(sa.id, R.id, { title: "Reader's, pointer" });
// Run in a transaction that is rolled back, so parallel suites' rows keep theirs.
const after = await sql(`begin;
${backfill}
select json_object_agg(id, calendar_event_id is not null) from meetings where id in ('${fForged}','${fOwn}','${fWriter}','${fReader}');
rollback;`);
const kept = JSON.parse(after.split("\n").find((l) => l.startsWith("{")) ?? "{}");
check("the backfill clears the pointer on a meeting whose owner has no hold on the student", kept[fForged] === false, after);
check("…and keeps the owner's own", kept[fOwn] === true);
check("…a write collaborator's", kept[fWriter] === true);
check("…and a read collaborator's (any access counts)", kept[fReader] === true);

console.log(guardReady ? "(meetings_owner_guard present)" : "(meetings_owner_guard absent)");
