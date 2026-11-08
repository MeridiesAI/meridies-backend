// Student booking, part 2 (routes/studentBooking.ts, lib/bookingWrite.ts, 20261111000012): a student books,
// moves and cancels time with their own counselor.
//
//   * POST /me/booking books only a start GET /me/booking/slots offers for that type (duration and mode from the
//     type), marks it booked_by_student, queues the emailed invite (with its ICS) and tells the counselor with the
//     student's first name, the type and the time only;
//   * two at once: one books, the other is refused; off the grid, inside the notice, past max days ahead, an
//     unknown or another counselor's type, an unapproved counselor or booking off are refused;
//   * PATCH /me/booking/:id moves the student's own meeting (SEQUENCE goes up, the old slot frees up), DELETE
//     cancels it once; both refuse inside the cutoff, with students_can_reschedule off, someone else's meeting
//     and a meeting with other people on it;
//   * a calendar write that fails leaves nothing behind (the local API has no Google client, so a counselor with a
//     calendar grant on file is a provider that always fails);
//   * the per-student rate limit and the cap on upcoming bookings.
//
// Needs the API started with BOOKING_BUSY_FIXTURE=<path> (the same path passed here): with a calendar grant on file
// and no fixture, slots would ask Google for busy time. This suite never writes the file (booking-settings does, in
// parallel; it is keyed by counselor, and these counselors have no entry). MAILPIT_URL (optional) checks the ICS.
import { existsSync } from "node:fs";
import { user, call, check, sql, rest } from "./harness.mjs";

const fixturePath = process.env.BOOKING_BUSY_FIXTURE;
if (!fixturePath || !existsSync(fixturePath)) {
  console.log("SKIP  booking-write needs BOOKING_BUSY_FIXTURE (start the API with it and pass the same path here)");
  process.exit(0);
}
const MAILPIT = process.env.MAILPIT_URL?.replace(/\/+$/, "") ?? null;

const A = await user("bkw-a");                                  // counselor, booking on
const B = await user("bkw-b");                                  // another practice
const U = await user("bkw-u", "counselor", { approved: false });
const sa = await user("bkw-sa", "student");
const s2 = await user("bkw-s2", "student");                     // A's other student
const sb = await user("bkw-sb", "student");
const su = await user("bkw-su", "student");
const sc = await user("bkw-sc", "student");                     // the cap
const sr = await user("bkw-sr", "student");                     // the rate limit
const everyone = [A, B, U, sa, s2, sb, su, sc, sr];
await sql(`update profiles set counselor_id='${A.id}' where id in ('${sa.id}','${s2.id}','${sc.id}','${sr.id}')`);
await sql(`update profiles set counselor_id='${B.id}' where id='${sb.id}'`);
await sql(`update profiles set counselor_id='${U.id}' where id='${su.id}'`);
await sql(`update profiles set full_name='Ana Zebulon-Smith' where id='${sa.id}'`);
await sql(`update profiles set full_name='Dana Counselor' where id='${A.id}'`);

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayStart = (n) => new Date(Math.floor(Date.now() / DAY) * DAY + n * DAY);
const at = (n, h, m = 0) => new Date(dayStart(n).getTime() + (h * 60 + m) * 60_000).toISOString();
const allWeek = (ranges) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));
const row = async (id) => JSON.parse((await sql(`select row_to_json(m) from meetings m where id='${id}'`)) || "null");
const same = (a, b) => Date.parse(a) === Date.parse(b);

async function deliveries(where, min) {
  const q = `select coalesce(json_agg(json_build_object('to', lower(to_email), 'kind', recipient_kind, 'template', template, 'status', status) order by created_at), '[]') from message_deliveries where ${where}`;
  let out = [];
  for (let i = 0; i < 40; i++) {
    out = JSON.parse(await sql(q));
    if (out.length >= min) break;
    await sleep(250);
  }
  return out;
}

/** The ICS attached to the newest Mailpit message to `to` whose subject starts with `prefix`, or null. */
async function icsFor(to, prefix) {
  if (!MAILPIT) return null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await r.json()).messages ?? [];
    const msg = list.find((m) => String(m.Subject).startsWith(prefix));
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const att = (full.Attachments ?? []).find((a) => /\.ics$/.test(a.FileName));
      if (att) return (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}/part/${att.PartID}`)).text();
    }
    await sleep(250);
  }
  return null;
}
/** The student's hourly booking-action allowance, reset between sections (the rate limit has its own check below). */
const resetLimit = (s) => sql(`delete from private.rate_limit_buckets where key = 'booking-actions:${s.id}'`);
const seq = (ics) => Number(/SEQUENCE:(\d+)/.exec(ics ?? "")?.[1] ?? NaN);

// ---- setup --------------------------------------------------------------------------------------

const put = await call(A.token, "PUT", "/booking/settings", {
  enabled: true, timeZone: "UTC", weeklyHours: allWeek([{ start: "09:00", end: "12:00" }]),
  minNoticeHours: 24, maxDaysAhead: 20, bufferMinutes: 0, cancelCutoffHours: 12, studentsCanReschedule: true,
});
check("setup: A's booking settings saved", put.status === 200, JSON.stringify(put.body));
const checkIn = (await call(A.token, "POST", "/booking/types", { name: "Check-in", durationMinutes: 60, mode: "in-person" })).body;
const video = (await call(A.token, "POST", "/booking/types", { name: "Video chat", durationMinutes: 30, mode: "google-meet" })).body;
const retired = (await call(A.token, "POST", "/booking/types", { name: "Retired", durationMinutes: 30, mode: "phone", active: false })).body;
await call(B.token, "PUT", "/booking/settings", { enabled: true, timeZone: "UTC", weeklyHours: allWeek([{ start: "00:00", end: "24:00" }]), minNoticeHours: 0 });
const bType = (await call(B.token, "POST", "/booking/types", { name: "B's", durationMinutes: 30, mode: "phone" })).body;
await sql(`insert into booking_settings (counselor_id, enabled, time_zone, weekly_hours, min_notice_hours) values ('${U.id}', true, 'UTC', '${JSON.stringify(allWeek([{ start: "00:00", end: "24:00" }]))}', 0)`);
await sql(`insert into booking_meeting_types (counselor_id, name, duration_minutes, mode) values ('${U.id}', 'Pending', 30, 'phone')`);
const uType = await sql(`select id from booking_meeting_types where counselor_id='${U.id}'`);

const book = (s, typeId, startsAt) => call(s.token, "POST", "/me/booking", { typeId, startsAt });
const slots = (s, typeId, n) => call(s.token, "GET", `/me/booking/slots?typeId=${typeId}&from=${encodeURIComponent(dayStart(n).toISOString())}&to=${encodeURIComponent(dayStart(n + 1).toISOString())}`);
const starts = (r) => (r.body?.slots ?? []).map((x) => x.startsAt);

// ---- book: the happy path -----------------------------------------------------------------------

const booked = await book(sa, checkIn.id, at(3, 9));
const bid = booked.body?.id;
check("a student books an offered slot", booked.status === 201 && Boolean(bid), JSON.stringify(booked.body));
check("…duration and mode come from the type", same(booked.body?.startsAt, at(3, 9)) && same(booked.body?.endsAt, at(3, 10)) && booked.body?.mode === "in-person" && booked.body?.typeName === "Check-in", JSON.stringify(booked.body));
check("…in person needs no link", booked.body?.joinUrl === null && booked.body?.conference === "not-needed", JSON.stringify(booked.body));
check("…the response is the meeting DTO", booked.body?.studentId === sa.id && booked.body?.counselorId === A.id && booked.body?.status === "scheduled" && Array.isArray(booked.body?.attendeeIds), JSON.stringify(booked.body));
const bRow = await row(bid);
check("the row is booked_by_student, titled with the type and first name, invites on", bRow?.booked_by_student === true && bRow?.title === "Check-in - Ana" && bRow?.send_invites === true && bRow?.created_by === sa.id, JSON.stringify(bRow));
const inv = await deliveries(`meeting_id='${bid}'`, 2);
check("the invite is queued to the student and the counselor's copy", inv.some((d) => d.to === sa.email.toLowerCase() && d.template === "meeting-invite" && d.kind === "student") && inv.some((d) => d.kind === "counselor" && d.template === "meeting-invite"), JSON.stringify(inv));
check("…and to nobody else", inv.every((d) => [sa.email.toLowerCase(), A.email.toLowerCase()].includes(d.to)), JSON.stringify(inv));
const ics1 = await icsFor(sa.email, "Invitation:");
if (MAILPIT) check("…with an ICS REQUEST attached", Boolean(ics1) && /METHOD:REQUEST/.test(ics1) && Number.isInteger(seq(ics1)), String(ics1).slice(0, 200));
else console.log("SKIP  the ICS attachment (no MAILPIT_URL)");

const notes = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('kind', kind, 'title', title, 'body', body, 'href', href)), '[]') from notifications where recipient_id='${A.id}' and student_id='${sa.id}'`));
check("the counselor gets a notification", notes.length === 1 && notes[0].kind === "system" && /^Ana booked Check-in on /.test(notes[0].title), JSON.stringify(notes));
const noticeText = JSON.stringify(notes);
check("…with nothing beyond the first name, type and time", !/Zebulon|Smith/.test(noticeText) && !noticeText.includes(sa.email) && !noticeText.includes("bkw-sa"), noticeText);
const noticeMail = await deliveries(`student_id='${sa.id}' and template='student-booking-counselor'`, 1);
check("…and an email", noticeMail.length === 1 && noticeMail[0].to === A.email.toLowerCase() && noticeMail[0].kind === "counselor", JSON.stringify(noticeMail));

const bucket = async (key) => (await sql(`select coalesce(sum(count), 0) from private.rate_limit_buckets where key = '${key}'`)) || "0";
check("the student's invite round spends the booking bucket, not the counselor's own allowance", (await bucket(`meeting-invites:booking:${A.id}`)) === "1" && (await bucket(`meeting-invites:${A.id}`)) === "0", `${await bucket(`meeting-invites:booking:${A.id}`)} / ${await bucket(`meeting-invites:${A.id}`)}`);

const meetType = await book(sa, video.id, at(3, 11));
check("a Meet type with no calendar connected books without a link, and says so", meetType.status === 201 && meetType.body.joinUrl === null && meetType.body.conference === "not-connected" && meetType.body.mode === "google-meet", JSON.stringify(meetType.body));

// ---- book: refusals -----------------------------------------------------------------------------

const again = await book(sa, checkIn.id, at(3, 9));
check("the same slot again is no longer offered: slot_unavailable", again.status === 409 && again.body.code === "slot_unavailable", JSON.stringify(again.body));
const racers = await Promise.all([sa, s2, s2].map((s) => book(s, checkIn.id, at(4, 9))));
const won = racers.filter((r) => r.status === 201);
check("two (three) at once: exactly one books, the rest are slot_taken or slot_unavailable", won.length === 1 && racers.filter((r) => r.status === 409 && ["slot_taken", "slot_unavailable"].includes(r.body.code)).length === 2, JSON.stringify(racers.map((r) => [r.status, r.body.code])));
console.log(`INFO  race codes: ${racers.map((r) => r.body.code ?? r.status).join(", ")}`);
check("…and one meeting exists at that time", (await sql(`select count(*) from meetings where counselor_id='${A.id}' and starts_at='${at(4, 9)}' and status='scheduled'`)) === "1");

const offGrid = await book(sa, checkIn.id, at(5, 9, 15));
check("a start off the type's grid is slot_unavailable", offGrid.status === 409 && offGrid.body.code === "slot_unavailable", JSON.stringify(offGrid.body));
const outside = await book(sa, checkIn.id, at(5, 14));
check("a start outside the hours is slot_unavailable", outside.status === 409 && outside.body.code === "slot_unavailable", JSON.stringify(outside.body));
await call(A.token, "PUT", "/booking/settings", { minNoticeHours: 48 });
const tooSoon = await book(sa, checkIn.id, at(1, 11));
await call(A.token, "PUT", "/booking/settings", { minNoticeHours: 24 });
check("a start inside the minimum notice is slot_unavailable", Date.parse(at(1, 11)) - Date.now() < 48 * 3_600_000 && tooSoon.status === 409 && tooSoon.body.code === "slot_unavailable", JSON.stringify(tooSoon.body));
const tooFar = await book(sa, checkIn.id, at(25, 9));
check("a start past max days ahead is slot_unavailable", tooFar.status === 409 && tooFar.body.code === "slot_unavailable", JSON.stringify(tooFar.body));
const noType = await book(sa, "00000000-0000-4000-8000-000000000000", at(5, 9));
const offType = await book(sa, retired.id, at(5, 9));
const theirType = await book(sa, bType.id, at(5, 9));
check("an unknown, inactive or another counselor's type is 404 type_not_found", [noType, offType, theirType].every((r) => r.status === 404 && r.body.code === "type_not_found"), JSON.stringify([noType.body, offType.body, theirType.body]));
const strict = await call(sa.token, "POST", "/me/booking", { typeId: checkIn.id, startsAt: at(5, 9), endsAt: at(5, 12) });
const naive = await call(sa.token, "POST", "/me/booking", { typeId: checkIn.id, startsAt: "2030-01-01T09:00:00" });
check("the body is strict: no endsAt, an offset required", strict.status === 400 && naive.status === 400, `${strict.status} ${naive.status}`);
const asCounselor = await call(A.token, "POST", "/me/booking", { typeId: checkIn.id, startsAt: at(5, 9) });
check("a counselor can't use the student route", asCounselor.status === 403);
const unapproved = await book(su, uType, at(5, 9));
check("a student of an unapproved counselor can't book", unapproved.status === 404 && unapproved.body.code === "booking_not_available", JSON.stringify(unapproved.body));
await call(B.token, "PUT", "/booking/settings", { enabled: false });
const off = await book(sb, bType.id, at(5, 9));
check("booking switched off can't be booked", off.status === 404 && off.body.code === "booking_not_available", JSON.stringify(off.body));
check("…and none of the refusals left a meeting", (await sql(`select count(*) from meetings where booked_by_student and student_id in ('${sb.id}','${su.id}')`)) === "0" && (await sql(`select count(*) from meetings where student_id='${sa.id}' and starts_at in ('${at(5, 9, 15)}','${at(5, 14)}','${at(1, 11)}','${at(25, 9)}','${at(5, 9)}')`)) === "0");

await resetLimit(sa);
// ---- reschedule ---------------------------------------------------------------------------------

const seqBefore = (await row(bid)).ics_sequence;
const moved = await call(sa.token, "PATCH", `/me/booking/${bid}`, { startsAt: at(6, 10) });
check("the student moves their booking to an offered slot", moved.status === 200 && same(moved.body.startsAt, at(6, 10)) && same(moved.body.endsAt, at(6, 11)), JSON.stringify(moved.body));
const movedRow = await row(bid);
check("…the SEQUENCE goes up by one", movedRow.ics_sequence === seqBefore + 1 && movedRow.booked_by_student === true, `${seqBefore} -> ${movedRow.ics_sequence}`);
check("…the old slot is free again", starts(await slots(s2, checkIn.id, 3)).some((s) => same(s, at(3, 9))));
check("…and the new one is taken", !starts(await slots(s2, checkIn.id, 6)).some((s) => same(s, at(6, 10))));
const upd = await deliveries(`meeting_id='${bid}' and template='meeting-update'`, 1);
check("…the student is sent the update", upd.some((d) => d.to === sa.email.toLowerCase()), JSON.stringify(upd));
const ics2 = await icsFor(sa.email, "Updated:");
if (MAILPIT) check("…whose ICS carries the new SEQUENCE", seq(ics2) === movedRow.ics_sequence, `${seq(ics2)} vs ${movedRow.ics_sequence}`);
const movedNote = await sql(`select title from notifications where recipient_id='${A.id}' and student_id='${sa.id}' and title like 'Ana moved%'`);
check("…and the counselor is told", movedNote.startsWith("Ana moved a meeting to "), movedNote);

const overSelf = await call(sa.token, "PATCH", `/me/booking/${bid}`, { startsAt: at(6, 9) });
check("a move that overlaps its own old time is fine (it never blocks itself)", overSelf.status === 200 && same(overSelf.body.startsAt, at(6, 9)), JSON.stringify(overSelf.body));
const onto = await call(sa.token, "PATCH", `/me/booking/${bid}`, { startsAt: at(4, 9) });
check("a move onto a taken slot is slot_unavailable", onto.status === 409 && onto.body.code === "slot_unavailable", JSON.stringify(onto.body));
const offGridMove = await call(sa.token, "PATCH", `/me/booking/${bid}`, { startsAt: at(7, 9, 20) });
check("a move off the grid is slot_unavailable", offGridMove.status === 409 && offGridMove.body.code === "slot_unavailable", JSON.stringify(offGridMove.body));

const byCounselor = await sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status, created_by)
  values ('${sa.id}', '${A.id}', 'Essay review', 'phone', '${at(8, 9)}', '${at(8, 9, 30)}', 'scheduled', '${A.id}') returning id`).then((o) => o.split("\n")[0]);
const movedTheirs = await call(sa.token, "PATCH", `/me/booking/${byCounselor}`, { startsAt: at(8, 11) });
check("the student may move a meeting the counselor set up, keeping its length", movedTheirs.status === 200 && same(movedTheirs.body.endsAt, at(8, 11, 30)) && (await row(byCounselor)).booked_by_student === false, JSON.stringify(movedTheirs.body));
const theirNote = await sql(`select body from notifications where recipient_id='${A.id}' and student_id='${sa.id}' and body like 'Moved from%' order by created_at desc limit 1`);
check("…and the notice says who set it up", /You set this meeting up; Ana changed it/.test(theirNote), theirNote);

const soon = await sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status)
  values ('${sa.id}', '${A.id}', 'Soon', 'phone', '${new Date(Date.now() + 6 * 3_600_000).toISOString()}', '${new Date(Date.now() + 7 * 3_600_000).toISOString()}', 'scheduled') returning id`).then((o) => o.split("\n")[0]);
const lateMove = await call(sa.token, "PATCH", `/me/booking/${soon}`, { startsAt: at(9, 9) });
const lateCancel = await call(sa.token, "DELETE", `/me/booking/${soon}`);
check("inside the cancel cutoff, moving and cancelling are refused", lateMove.status === 409 && lateMove.body.code === "inside_cutoff" && lateCancel.status === 409 && lateCancel.body.code === "inside_cutoff", JSON.stringify([lateMove.body, lateCancel.body]));

await call(A.token, "PUT", "/booking/settings", { studentsCanReschedule: false });
const offMove = await call(sa.token, "PATCH", `/me/booking/${bid}`, { startsAt: at(9, 10) });
const offCancel = await call(sa.token, "DELETE", `/me/booking/${bid}`);
check("with students_can_reschedule off, both are 403 student_changes_off", offMove.status === 403 && offMove.body.code === "student_changes_off" && offCancel.status === 403 && offCancel.body.code === "student_changes_off", JSON.stringify([offMove.body, offCancel.body]));
check("…and the meeting is where it was", same((await row(bid)).starts_at, at(6, 9)) && (await row(bid)).status === "scheduled");
await call(A.token, "PUT", "/booking/settings", { studentsCanReschedule: true });

await resetLimit(sa);
await resetLimit(s2);
const othersMeeting = won[0]?.body?.id;
const iAmS2 = othersMeeting && (await row(othersMeeting)).student_id === s2.id;
const foreignId = iAmS2 ? othersMeeting : (await book(s2, checkIn.id, at(9, 11))).body.id;
const foreignMove = await call(sa.token, "PATCH", `/me/booking/${foreignId}`, { startsAt: at(10, 9) });
const foreignCancel = await call(sa.token, "DELETE", `/me/booking/${foreignId}`);
const missing = await call(sa.token, "DELETE", "/me/booking/00000000-0000-4000-8000-000000000000");
check("another student's meeting (or none) is 404 meeting_not_found", [foreignMove, foreignCancel, missing].every((r) => r.status === 404 && r.body.code === "meeting_not_found"), JSON.stringify([foreignMove.body, foreignCancel.body, missing.body]));
check("…and it wasn't touched", (await row(foreignId)).status === "scheduled");

const shared = await sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status)
  values ('${s2.id}', '${A.id}', 'Group', 'phone', '${at(10, 10)}', '${at(10, 11)}', 'scheduled') returning id`).then((o) => o.split("\n")[0]);
await sql(`insert into meeting_attendees (meeting_id, student_id) values ('${shared}', '${sa.id}')`);
const asAttendee = await call(sa.token, "DELETE", `/me/booking/${shared}`);
check("an attendee who isn't the primary student can't change it (404)", asAttendee.status === 404 && asAttendee.body.code === "meeting_not_found", JSON.stringify(asAttendee.body));
const asPrimary = await call(s2.token, "DELETE", `/me/booking/${shared}`);
check("…and its primary student is told to ask the counselor, since others are on it", asPrimary.status === 409 && asPrimary.body.code === "ask_your_counselor", JSON.stringify(asPrimary.body));

// ---- cancel -------------------------------------------------------------------------------------

const cancel = await call(sa.token, "DELETE", `/me/booking/${bid}`);
check("the student cancels their booking", cancel.status === 200 && cancel.body.status === "cancelled" && cancel.body.calendarRemoved === true, JSON.stringify(cancel.body));
check("…the row is cancelled, not deleted", (await row(bid))?.status === "cancelled");
const cancels = await deliveries(`meeting_id='${bid}' and template='meeting-cancel'`, 1);
check("…the student is sent the cancellation", cancels.some((d) => d.to === sa.email.toLowerCase()), JSON.stringify(cancels));
const cancelNotes = await sql(`select count(*) from notifications where recipient_id='${A.id}' and student_id='${sa.id}' and title like 'Ana cancelled%'`);
check("…and the counselor is told once", cancelNotes === "1", cancelNotes);
await sleep(1500);
const cancelCount = (await deliveries(`meeting_id='${bid}' and template='meeting-cancel'`, 0)).length;
const twice = await call(sa.token, "DELETE", `/me/booking/${bid}`);
check("cancelling again is 409 already_cancelled", twice.status === 409 && twice.body.code === "already_cancelled", JSON.stringify(twice.body));
await sleep(1500);
check("…and emails nobody a second time", (await deliveries(`meeting_id='${bid}' and template='meeting-cancel'`, 0)).length === cancelCount && (await sql(`select count(*) from notifications where recipient_id='${A.id}' and student_id='${sa.id}' and title like 'Ana cancelled%'`)) === "1");
const moveCancelled = await call(sa.token, "PATCH", `/me/booking/${bid}`, { startsAt: at(11, 9) });
check("a cancelled meeting can't be moved", moveCancelled.status === 409 && moveCancelled.body.code === "already_cancelled", JSON.stringify(moveCancelled.body));
check("the cancelled slot is offered again", starts(await slots(s2, checkIn.id, 6)).some((s) => same(s, at(6, 9))));

await resetLimit(sa);
// ---- a calendar that fails ----------------------------------------------------------------------

// ---- booking paused, counselor unapproved, meetings with others on them ----------------------------

await resetLimit(sa);
const seedMeeting = (student, owner, startsAt, minutes = 30, extra = "") =>
  sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status${extra ? ", guardians_invited" : ""})
    values ('${student}', '${owner}', 'Seeded', 'phone', '${startsAt}', '${new Date(Date.parse(startsAt) + minutes * 60_000).toISOString()}', 'scheduled'${extra ? ", " + extra : ""}) returning id`).then((o) => o.split("\n")[0]);
const p1 = await seedMeeting(sa.id, A.id, at(17, 9));
const p2 = await seedMeeting(sa.id, A.id, at(17, 11));
const pSoon = await seedMeeting(sa.id, A.id, new Date(Date.now() + 5 * 3_600_000).toISOString());
await call(A.token, "PUT", "/booking/settings", { enabled: false });
const pausedMove = await call(sa.token, "PATCH", `/me/booking/${p1}`, { startsAt: at(18, 9) });
check("booking paused: a move is 404 booking_not_available", pausedMove.status === 404 && pausedMove.body.code === "booking_not_available", JSON.stringify(pausedMove.body));
const pausedCancel = await call(sa.token, "DELETE", `/me/booking/${p1}`);
check("booking paused: the student can still cancel", pausedCancel.status === 200 && pausedCancel.body.status === "cancelled" && (await row(p1)).status === "cancelled", JSON.stringify(pausedCancel.body));
const pausedLate = await call(sa.token, "DELETE", `/me/booking/${pSoon}`);
check("booking paused: the cancel cutoff still applies", pausedLate.status === 409 && pausedLate.body.code === "inside_cutoff", JSON.stringify(pausedLate.body));
await call(A.token, "PUT", "/booking/settings", { studentsCanReschedule: false });
const pausedOff = await call(sa.token, "DELETE", `/me/booking/${p2}`);
check("booking paused with students_can_reschedule off: the cancel is 403 student_changes_off", pausedOff.status === 403 && pausedOff.body.code === "student_changes_off" && (await row(p2)).status === "scheduled", JSON.stringify(pausedOff.body));
await call(A.token, "PUT", "/booking/settings", { enabled: true, studentsCanReschedule: true });

const uMeeting = await seedMeeting(su.id, U.id, at(17, 9));
const uMove = await call(su.token, "PATCH", `/me/booking/${uMeeting}`, { startsAt: at(18, 9) });
const uCancel = await call(su.token, "DELETE", `/me/booking/${uMeeting}`);
check("a student of an unapproved counselor can't move or cancel: 404 booking_not_available", [uMove, uCancel].every((r) => r.status === 404 && r.body.code === "booking_not_available") && (await row(uMeeting)).status === "scheduled", JSON.stringify([uMove.body, uCancel.body]));

const withGuardians = await seedMeeting(sa.id, A.id, at(17, 10), 30, "true");
const gMove = await call(sa.token, "PATCH", `/me/booking/${withGuardians}`, { startsAt: at(18, 10) });
const gCancel = await call(sa.token, "DELETE", `/me/booking/${withGuardians}`);
check("a meeting with guardians invited: ask_your_counselor", [gMove, gCancel].every((r) => r.status === 409 && r.body.code === "ask_your_counselor"), JSON.stringify([gMove.body, gCancel.body]));
const bOwned = await seedMeeting(sa.id, B.id, at(17, 10, 30));
const oMove = await call(sa.token, "PATCH", `/me/booking/${bOwned}`, { startsAt: at(18, 10) });
const oCancel = await call(sa.token, "DELETE", `/me/booking/${bOwned}`);
check("another counselor's meeting with the student: ask_your_counselor", [oMove, oCancel].every((r) => r.status === 409 && r.body.code === "ask_your_counselor"), JSON.stringify([oMove.body, oCancel.body]));
check("…and none of them changed", (await row(withGuardians)).status === "scheduled" && (await row(bOwned)).status === "scheduled");
const longOne = await seedMeeting(sa.id, A.id, at(17, 9, 30), 240);
const longMove = await call(sa.token, "PATCH", `/me/booking/${longOne}`, { startsAt: at(18, 9) });
check("a meeting longer than 180 minutes can't be moved by the student: ask_your_counselor", longMove.status === 409 && longMove.body.code === "ask_your_counselor", JSON.stringify(longMove.body));

await resetLimit(sa);
await sql(`insert into integration_tokens (owner_id, provider, access_token_enc, scopes) values ('${A.id}', 'google', 'not-a-real-token', '{https://www.googleapis.com/auth/calendar.events}')`);
const deliveriesBefore = await sql(`select count(*) from message_deliveries where student_id='${sa.id}' or recipient_id='${A.id}'`);
const failed = await book(sa, video.id, at(12, 9));
check("a calendar write that fails is 503 calendar_write_failed", failed.status === 503 && failed.body.code === "calendar_write_failed", JSON.stringify(failed.body));
check("…and leaves no meeting behind", (await sql(`select count(*) from meetings where counselor_id='${A.id}' and starts_at='${at(12, 9)}'`)) === "0");
check("…nor any invite or notice", (await sql(`select count(*) from notifications where recipient_id='${A.id}' and title like '%booked Video chat on%'`)) === "1");
await sleep(1500);
check("…nor any email", (await sql(`select count(*) from message_deliveries where student_id='${sa.id}' or recipient_id='${A.id}'`)) === deliveriesBefore);
const slotStill = starts(await slots(s2, video.id, 12)).some((s) => same(s, at(12, 9)));
check("…so the slot is still offered", slotStill);

const withEvent = await sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status, calendar_provider, calendar_event_id, join_url)
  values ('${sa.id}', '${A.id}', 'On calendar', 'google-meet', '${at(13, 9)}', '${at(13, 9, 30)}', 'scheduled', 'google', 'evt-bkw-1', 'https://meet.google.com/abc-defg-hij') returning id`).then((o) => o.split("\n")[0]);
const failedMove = await call(sa.token, "PATCH", `/me/booking/${withEvent}`, { startsAt: at(13, 10) });
check("a move whose calendar write fails is 503 and the old time is put back", failedMove.status === 503 && failedMove.body.code === "calendar_write_failed" && same((await row(withEvent)).starts_at, at(13, 9)), JSON.stringify(failedMove.body));
const failedRemove = await call(sa.token, "DELETE", `/me/booking/${withEvent}`);
const orphanNote = await sql(`select body from notifications where recipient_id='${A.id}' and student_id='${sa.id}' and title like 'Ana cancelled%' order by created_at desc limit 1`);
check("…and the counselor is told the event is still on their calendar", orphanNote.endsWith("It is still on your Google calendar; delete it there."), orphanNote);
check("a cancel whose calendar delete fails still cancels, calendarRemoved false", failedRemove.status === 200 && failedRemove.body.calendarRemoved === false && (await row(withEvent)).status === "cancelled", JSON.stringify(failedRemove.body));
await sql(`delete from integration_tokens where owner_id='${A.id}'`);

// ---- caps ---------------------------------------------------------------------------------------

await sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status, booked_by_student)
  select '${sc.id}', '${A.id}', 'Cap ' || g, 'phone', now() + (g || ' days')::interval + interval '1 hour', now() + (g || ' days')::interval + interval '90 minutes', 'scheduled', true
  from generate_series(30, 39) g`);
const capped = await book(sc, checkIn.id, at(14, 9));
check("ten upcoming bookings is the cap: 409 too_many_bookings", capped.status === 409 && capped.body.code === "too_many_bookings", JSON.stringify(capped.body));

const burst = [];
for (let i = 0; i < 21; i++) burst.push(await book(sr, checkIn.id, at(15, 9, 7)));
check("20 booking actions an hour per student, then 429", burst.slice(0, 20).every((r) => r.status === 409) && burst[20].status === 429, JSON.stringify(burst.map((r) => r.status)));

// ---- booked_by_student is still not the student's to write (7a) -----------------------------------

const forge = await rest(s2.token, "PATCH", `/rest/v1/meetings?id=eq.${foreignId}`, { booked_by_student: false }, { Prefer: "return=representation" });
const forgeInsert = await rest(s2.token, "POST", "/rest/v1/meetings", { student_id: s2.id, counselor_id: A.id, title: "Forged", starts_at: at(16, 9), ends_at: at(16, 10), booked_by_student: true }, { Prefer: "return=representation" });
check("a student can't flip or forge booked_by_student through PostgREST", (forge.status >= 400 || (Array.isArray(forge.body) && forge.body.length === 0)) && forgeInsert.status >= 400 && (await row(foreignId)).booked_by_student === true, `${forge.status} ${forgeInsert.status}`);
const rpcAsStudent = await rest(sa.token, "POST", "/rest/v1/rpc/reschedule_meeting_slot", { p_meeting: foreignId, p_student: s2.id, p_counselor: A.id, p_starts_at: at(16, 9), p_ends_at: at(16, 10) });
check("reschedule_meeting_slot is service-role only", [401, 403, 404].includes(rpcAsStudent.status), String(rpcAsStudent.status));

// ---- clean up -----------------------------------------------------------------------------------

const ids = everyone.map((u) => `'${u.id}'`).join(",");
try {
  await sql(`delete from meetings where counselor_id in (${ids}) or student_id in (${ids})`);
  await sql(`delete from notifications where recipient_id in (${ids})`);
  await sql(`delete from booking_meeting_types where counselor_id in (${ids})`);
  await sql(`delete from booking_settings where counselor_id in (${ids})`);
  await sql(`delete from auth.users where id in (${ids})`);
} catch (e) {
  console.log(`INFO  cleanup incomplete: ${String(e.message).split("\n")[0]}`);
}
