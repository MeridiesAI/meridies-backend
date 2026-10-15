// Emailed calendar invites (lib/meetingInvites.ts): real accounts on a local
// Supabase against a running API (see harness.mjs). CI has no Resend key, so
// every send is recorded `failed` ("RESEND_API_KEY unset"); the delivery row
// is what these checks read. Sends run after the response, so each check
// polls for its rows.
import { user, call, check, sql, rest } from "./harness.mjs";

const c = await user("inv-counselor");
const s1 = await user("inv-s1", "student");
const s2 = await user("inv-s2", "student");
const s3 = await user("inv-s3", "student");
const outsider = await user("inv-out", "student");
await sql(`update profiles set counselor_id='${c.id}' where id in ('${s1.id}','${s2.id}','${s3.id}')`);
await sql(`update profiles set full_name='Dana Counselor' where id='${c.id}'`);
await sql(`update profiles set archived_at=now() where id='${s3.id}'`);
const tag = Math.random().toString(36).slice(2, 8);
const parentOn = `parent-on-${tag}@test.local`;
const parentOff = `parent-off-${tag}@test.local`;
await sql(`insert into guardians (student_id, full_name, email, alerts_enabled) values
  ('${s1.id}', 'Pat Parent', '${parentOn}', true),
  ('${s1.id}', 'Sam Selfadded', '${parentOff}', false)`);

const day = (n, h = 15) => new Date(Date.UTC(2030, 0, n, h, 0, 0)).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Delivery rows matching `where`, waiting up to 10 s for at least `min` of them. */
async function rows(where, min) {
  const q = `select coalesce(json_agg(json_build_object('to', lower(to_email), 'kind', recipient_kind, 'template', template, 'meeting', meeting_id, 'student', student_id)), '[]') from message_deliveries where ${where}`;
  let out = [];
  for (let i = 0; i < 40; i++) {
    out = JSON.parse(await sql(q));
    if (out.length >= min) break;
    await sleep(250);
  }
  return out;
}
const has = (list, to, template, kind) => list.some((r) => r.to === to.toLowerCase() && r.template === template && (!kind || r.kind === kind));

// ---- Booking ---------------------------------------------------------------------------

const noEnd = await call(c.token, "POST", "/meetings", { studentId: s1.id, title: "No end", startsAt: day(10), sendInvites: true });
check("an invite without an end time is refused", noEnd.status === 400 && /end time/.test(noEnd.body?.message ?? noEnd.body?.error ?? ""), JSON.stringify(noEnd.body));

const booked = await call(c.token, "POST", "/meetings", {
  studentId: s1.id,
  title: "Essay check-in",
  mode: "in-person",
  location: "Room 4",
  startsAt: day(10),
  endsAt: day(10, 16),
  guardiansInvited: true,
  sendInvites: true,
});
const mid = booked.body?.id;
check("booking with invites answers 201 and says who is being emailed", booked.status === 201 && booked.body?.invites?.status === "sending" && booked.body?.sendInvites === true, JSON.stringify(booked.body?.invites));
check("…the student and the guardian with alerts on (the counselor's copy isn't counted)", booked.body?.invites?.recipients === 2, JSON.stringify(booked.body?.invites));

let sent = await rows(`meeting_id='${mid}'`, 3);
check("a meeting-invite row for the student", has(sent, s1.email, "meeting-invite", "student"), JSON.stringify(sent));
check("…for the guardian with alerts on", has(sent, parentOn, "meeting-invite", "guardian"));
check("…the counselor's copy", has(sent, c.email, "meeting-invite", "counselor"));
check("…and none for a guardian a student added (alerts off)", !sent.some((r) => r.to === parentOff));
check("every row is linked to the meeting and to the student", sent.every((r) => r.meeting === mid && r.student === s1.id));
check("the sequence starts at 0", (await sql(`select ics_sequence from meetings where id='${mid}'`)) === "0");

const plain = await call(c.token, "POST", "/meetings", { studentId: s1.id, title: "No invites", startsAt: day(11), endsAt: day(11, 16) });
check("a booking without sendInvites sends nothing", plain.status === 201 && plain.body?.invites?.status === "none" && plain.body?.sendInvites === false);
await sleep(600);
check("…and writes no delivery row", (await sql(`select count(*) from message_deliveries where meeting_id='${plain.body?.id}'`)) === "0");

// ---- Changes -------------------------------------------------------------------------------

const moved = await call(c.token, "PATCH", `/meetings/${mid}`, { startsAt: day(12), endsAt: day(12, 16) });
check("a move answers with the round", moved.status === 200 && moved.body?.invites?.status === "sending", JSON.stringify(moved.body?.invites));
check("the move raised the sequence to 1", (await sql(`select ics_sequence from meetings where id='${mid}'`)) === "1");
sent = await rows(`meeting_id='${mid}' and template='meeting-update'`, 3);
check("meeting-update rows to the student, guardian and counselor", has(sent, s1.email, "meeting-update") && has(sent, parentOn, "meeting-update") && has(sent, c.email, "meeting-update"), JSON.stringify(sent));

const quiet = await call(c.token, "PATCH", `/meetings/${mid}`, { title: "Essay check-in (quiet)", notifyAttendees: false });
check("notifyAttendees false: saved, nobody emailed", quiet.status === 200 && quiet.body?.invites?.status === "none", JSON.stringify(quiet.body?.invites));
await sleep(600);
check("…no new update rows", (await sql(`select count(*) from message_deliveries where meeting_id='${mid}' and template='meeting-update'`)) === "3");

const added = await call(c.token, "PATCH", `/meetings/${mid}`, { attendeeIds: [s1.id, s2.id, s3.id] });
check("adding students answers with the round", added.status === 200 && added.body?.invites?.status === "sending", JSON.stringify(added.body?.invites));
check("…an archived student is skipped", added.body?.invites?.skipped >= 1, JSON.stringify(added.body?.invites));
sent = await rows(`meeting_id='${mid}' and template='meeting-invite' and student_id='${s2.id}'`, 1);
check("only the added student gets an invite", has(sent, s2.email, "meeting-invite", "student"), JSON.stringify(sent));
await sleep(600);
check("…the archived one gets nothing", (await sql(`select count(*) from message_deliveries where student_id='${s3.id}'`)) === "0");
check("…and nobody already invited is emailed again", (await sql(`select count(*) from message_deliveries where meeting_id='${mid}' and template='meeting-invite' and lower(to_email)=lower('${s1.email}')`)) === "1");

// Parents switched off for s1: the next update reaches s1 but not their guardian.
await sql(`insert into student_alert_prefs (student_id, copy_parents, copy_student) values ('${s1.id}', false, false)
  on conflict (student_id) do update set copy_parents = false`);
const retitled = await call(c.token, "PATCH", `/meetings/${mid}`, { agenda: "Bring your drafts" });
check("a change with parents switched off still goes", retitled.status === 200 && retitled.body?.invites?.status === "sending");
sent = await rows(`meeting_id='${mid}' and template='meeting-update'`, 6);
check("…to the students", sent.filter((r) => r.to === s1.email.toLowerCase()).length === 2 && has(sent, s2.email, "meeting-update"), JSON.stringify(sent));
check("…but not to the guardian (copy_parents off)", sent.filter((r) => r.to === parentOn).length === 1, JSON.stringify(sent.filter((r) => r.to === parentOn)));
await sql(`update student_alert_prefs set copy_parents = true where student_id='${s1.id}'`);

// ---- Who sees what ----------------------------------------------------------------------------

const list = await call(c.token, "GET", `/meetings/${mid}/invites`);
check("the counselor reads the newest send per address", list.status === 200 && Array.isArray(list.body) && list.body.some((d) => d.email === parentOn && d.recipientKind === "guardian"), JSON.stringify(list.body));
check("…each with a delivery status and a safe reason", list.body.every((d) => typeof d.status === "string" && (d.reason === null || !/RESEND|_KEY/.test(d.reason))));
const studentList = await call(s1.token, "GET", `/meetings/${mid}/invites`);
check("a student can't read the invites list", studentList.status === 403, `status ${studentList.status}`);
const mine = await call(s1.token, "GET", "/me/messages");
check("the student's messages list their own invite", mine.status === 200 && mine.body.some((x) => /^Invitation: Essay check-in/.test(x.subject ?? "")), JSON.stringify(mine.body?.map((x) => x.subject)));
const theirs = await rest(s1.token, "GET", `/rest/v1/message_deliveries?select=id&to_email=eq.${parentOn}`);
check("…and never their guardian's", theirs.status === 200 && theirs.body.length === 0, JSON.stringify(theirs.body));
const strangers = await rest(outsider.token, "GET", `/rest/v1/message_deliveries?select=id&meeting_id=eq.${mid}`);
check("a student off the meeting reads none of its rows", strangers.status === 200 && strangers.body.length === 0);

// ---- The sequence is the database's -------------------------------------------------------------

const seqBefore = await sql(`select ics_sequence from meetings where id='${mid}'`);
const studentWrite = await rest(s1.token, "PATCH", `/rest/v1/meetings?id=eq.${mid}`, { ics_sequence: 0, title: "Hacked" }, { Prefer: "return=representation" });
check("a student's write to the meeting changes nothing", (studentWrite.body?.length ?? 0) === 0 && (await sql(`select ics_sequence || ':' || title from meetings where id='${mid}'`)) === `${seqBefore}:Essay check-in (quiet)`, JSON.stringify(studentWrite.body));
await rest(c.token, "PATCH", `/rest/v1/meetings?id=eq.${mid}`, { ics_sequence: 99 });
check("a counselor can't set the sequence by hand", (await sql(`select ics_sequence from meetings where id='${mid}'`)) === seqBefore);
const noEndDirect = await rest(c.token, "PATCH", `/rest/v1/meetings?id=eq.${plain.body?.id}`, { send_invites: true, ends_at: null });
check("the database refuses invites without an end time", noEndDirect.status >= 400 && /meetings_invites_need_end/.test(JSON.stringify(noEndDirect.body)), JSON.stringify(noEndDirect.body));
const clearEnd = await call(c.token, "PATCH", `/meetings/${mid}`, { endsAt: null });
check("clearing the end of an invites-on meeting is a 400", clearEnd.status === 400, `status ${clearEnd.status}`);

// ---- Cancel, switch off, delete ----------------------------------------------------------------------

const cancelled = await call(c.token, "PATCH", `/meetings/${mid}`, { status: "cancelled" });
check("cancelling answers with the round", cancelled.status === 200 && cancelled.body?.invites?.status === "sending", JSON.stringify(cancelled.body?.invites));
sent = await rows(`meeting_id='${mid}' and template='meeting-cancel'`, 4);
check("meeting-cancel rows to both students, the guardian and the counselor", has(sent, s1.email, "meeting-cancel") && has(sent, s2.email, "meeting-cancel") && has(sent, parentOn, "meeting-cancel") && has(sent, c.email, "meeting-cancel"), JSON.stringify(sent));

const second = await call(c.token, "POST", "/meetings", { studentId: s2.id, title: "Aid review", startsAt: day(14), endsAt: day(14, 16), sendInvites: true });
await rows(`meeting_id='${second.body?.id}'`, 2);
const off = await call(c.token, "PATCH", `/meetings/${second.body?.id}`, { sendInvites: false, notifyAttendees: false });
check("switching invites off after they went out answers with the round", off.status === 200 && off.body?.invites?.status === "sending" && off.body?.sendInvites === false, JSON.stringify(off.body?.invites));
sent = await rows(`meeting_id='${second.body?.id}' and template='meeting-cancel'`, 1);
check("…and cancels the invite already sent", has(sent, s2.email, "meeting-cancel", "student"), JSON.stringify(sent));

const third = await call(c.token, "POST", "/meetings", { studentId: s2.id, title: "Deleted soon", startsAt: day(15), endsAt: day(15, 16), sendInvites: true });
await rows(`meeting_id='${third.body?.id}'`, 2);
const since = await sql("select now()");
const gone = await call(c.token, "DELETE", `/meetings/${third.body?.id}`);
check("deleting answers with the round", gone.status === 200 && gone.body?.deleted === true && gone.body?.invites?.status === "sending", JSON.stringify(gone.body));
sent = await rows(`template='meeting-cancel' and student_id='${s2.id}' and created_at > '${since}' and subject like 'Cancelled: Deleted soon%'`, 2);
check("…cancellations go out with no meeting link", has(sent, s2.email, "meeting-cancel") && sent.every((r) => r.meeting === null), JSON.stringify(sent));
check("…and the earlier invite rows lost their link, not their record", (await sql(`select count(*) from message_deliveries where subject like 'Invitation: Deleted soon%' and student_id='${s2.id}' and meeting_id is null`)) === "2");

const past = await call(c.token, "POST", "/meetings", { studentId: s1.id, title: "Already over", startsAt: "2020-01-01T15:00:00Z", endsAt: "2020-01-01T16:00:00Z", sendInvites: true });
check("a meeting that is over sends nothing", past.status === 201 && past.body?.invites?.status === "none", JSON.stringify(past.body?.invites));
