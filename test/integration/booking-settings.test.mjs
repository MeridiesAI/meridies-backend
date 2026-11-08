// Student booking, part 1 (20261111000001): a counselor's booking settings and meeting types,
// what a student is offered, and public.book_meeting_slot.
//
//   * a counselor writes their own settings and types; another practice's counselor can't read or change them
//     (through the API or PostgREST);
//   * a student sees types and slots for their own counselor only; a student with no counselor, of an unapproved
//     counselor or of one with booking off gets a calm empty answer;
//   * slots leave out a scheduled meeting (and its buffer) and the calendar's busy time;
//   * book_meeting_slot runs for the service role only, books, and refuses an overlapping second booking;
//   * meetings.booked_by_student is not client-writable.
//
// Calendar busy time comes from BOOKING_BUSY_FIXTURE (a JSON file the API reads instead of Google/Microsoft): start
// the API with BOOKING_BUSY_FIXTURE=<path> and run this with the same variable, or that one check is skipped.
import { writeFileSync } from "node:fs";
import { user, call, check, sql, rest, serviceRpc } from "./harness.mjs";

const A = await user("bk-a");                          // counselor with booking on
const B = await user("bk-b");                          // another practice's counselor
const U = await user("bk-u", "counselor", { approved: false });
const sa = await user("bk-sa", "student");
const sb = await user("bk-sb", "student");
const su = await user("bk-su", "student");
const sn = await user("bk-sn", "student");             // no counselor
await sql(`update profiles set counselor_id='${A.id}' where id='${sa.id}'`);
await sql(`update profiles set counselor_id='${B.id}' where id='${sb.id}'`);
await sql(`update profiles set counselor_id='${U.id}' where id='${su.id}'`);

const DAY = 86_400_000;
// Days D1..D3 from now, UTC midnight, far enough out for any notice used here.
const dayStart = (n) => new Date(Math.floor(Date.now() / DAY) * DAY + n * DAY);
const at = (n, h, m = 0) => new Date(dayStart(n).getTime() + (h * 60 + m) * 60_000).toISOString();
const iso = (s) => new Date(s).toISOString();
const allWeek = (ranges) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));

// ---- the counselor's own setup ------------------------------------------------------------------

const before = await call(A.token, "GET", "/booking/settings");
check("a counselor who never saved reads the defaults", before.status === 200 && before.body.saved === false && before.body.enabled === false, JSON.stringify(before.body));

const badZone = await call(A.token, "PUT", "/booking/settings", { timeZone: "Mars/Olympus_Mons" });
check("an unknown time zone is refused", badZone.status === 400, JSON.stringify(badZone.body));
const overlap = await call(A.token, "PUT", "/booking/settings", { weeklyHours: { 1: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] } });
check("overlapping hours are refused", overlap.status === 400, JSON.stringify(overlap.body));
const backwards = await call(A.token, "PUT", "/booking/settings", { weeklyHours: { 1: [{ start: "12:00", end: "09:00" }] } });
check("a range that ends before it starts is refused", backwards.status === 400, JSON.stringify(backwards.body));
const badDay = await call(A.token, "PUT", "/booking/settings", { weeklyHours: { 7: [] } });
check("a weekday past 6 is refused", badDay.status === 400, JSON.stringify(badDay.body));
const badKey = await call(A.token, "PUT", "/booking/settings", { enabled: true, colour: "red" });
check("an unknown field is refused", badKey.status === 400, JSON.stringify(badKey.body));

const saved = await call(A.token, "PUT", "/booking/settings", {
  enabled: true,
  timeZone: "UTC",
  weeklyHours: allWeek([{ start: "09:00", end: "12:00" }]),
  minNoticeHours: 0,
  maxDaysAhead: 30,
  bufferMinutes: 0,
  cancelCutoffHours: 12,
  studentsCanReschedule: false,
});
check("a counselor saves their settings", saved.status === 200 && saved.body.saved && saved.body.enabled && saved.body.timeZone === "UTC" && saved.body.cancelCutoffHours === 12 && saved.body.studentsCanReschedule === false, JSON.stringify(saved.body));

const hourType = await call(A.token, "POST", "/booking/types", { name: "Check-in", durationMinutes: 60, mode: "google-meet" });
check("a counselor adds a meeting type", hourType.status === 201 && hourType.body.durationMinutes === 60 && hourType.body.active === true, JSON.stringify(hourType.body));
const hidden = await call(A.token, "POST", "/booking/types", { name: "Essay deep dive", durationMinutes: 90, mode: "in-person", active: false });
check("…and an inactive one", hidden.status === 201 && hidden.body.active === false, JSON.stringify(hidden.body));
const dupe = await call(A.token, "POST", "/booking/types", { name: "check-in", durationMinutes: 30, mode: "phone" });
check("a second type with the same name is a 409", dupe.status === 409, JSON.stringify(dupe.body));
const zoom = await call(A.token, "POST", "/booking/types", { name: "Zoom", durationMinutes: 30, mode: "zoom" });
check("Zoom isn't a booking mode", zoom.status === 400, JSON.stringify(zoom.body));
const tooShort = await call(A.token, "POST", "/booking/types", { name: "Quick", durationMinutes: 10, mode: "phone" });
const tooLong = await call(A.token, "POST", "/booking/types", { name: "Marathon", durationMinutes: 181, mode: "phone" });
check("a type is 15 to 180 minutes", tooShort.status === 400 && tooLong.status === 400);
const renamed = await call(A.token, "PATCH", `/booking/types/${hidden.body.id}`, { name: "Essay review" });
check("a counselor renames their type", renamed.status === 200 && renamed.body.name === "Essay review", JSON.stringify(renamed.body));
const listA = await call(A.token, "GET", "/booking/types");
check("a counselor lists their types, active or not", listA.status === 200 && listA.body.types.length === 2, JSON.stringify(listA.body));

// ---- another practice's counselor ---------------------------------------------------------------

const listB = await call(B.token, "GET", "/booking/types");
check("another counselor's list doesn't include A's types", listB.status === 200 && listB.body.types.length === 0, JSON.stringify(listB.body));
const settingsB = await call(B.token, "GET", "/booking/settings");
check("…nor A's settings", settingsB.status === 200 && settingsB.body.saved === false && settingsB.body.timeZone !== "UTC", JSON.stringify(settingsB.body));
const patchB = await call(B.token, "PATCH", `/booking/types/${hourType.body.id}`, { name: "Mine now" });
const delB = await call(B.token, "DELETE", `/booking/types/${hourType.body.id}`);
check("another counselor can't change or delete A's type", patchB.status === 404 && delB.status === 404, `${patchB.status} ${delB.status}`);
const restSettings = await rest(B.token, "GET", `/rest/v1/booking_settings?counselor_id=eq.${A.id}`);
const restTypes = await rest(B.token, "GET", `/rest/v1/booking_meeting_types?counselor_id=eq.${A.id}`);
check("PostgREST shows another counselor none of A's rows", Array.isArray(restSettings.body) && restSettings.body.length === 0 && Array.isArray(restTypes.body) && restTypes.body.length === 0);
const forgeType = await rest(B.token, "POST", "/rest/v1/booking_meeting_types", { counselor_id: A.id, name: "Forged", duration_minutes: 30, mode: "phone" });
const forgeSettings = await rest(B.token, "PATCH", `/rest/v1/booking_settings?counselor_id=eq.${A.id}`, { enabled: false }, { Prefer: "return=representation" });
check("…and can't write them", forgeType.status === 403 && Array.isArray(forgeSettings.body) && forgeSettings.body.length === 0, `${forgeType.status} ${JSON.stringify(forgeSettings.body)}`);
check("A's settings are untouched", (await sql(`select enabled from booking_settings where counselor_id='${A.id}'`)) === "t");
const studentRest = await rest(sa.token, "GET", `/rest/v1/booking_settings?counselor_id=eq.${A.id}`);
const studentInsert = await rest(sa.token, "POST", "/rest/v1/booking_settings", { counselor_id: sa.id, enabled: true });
check("a student reads none of their counselor's rows directly and can't make their own", Array.isArray(studentRest.body) && studentRest.body.length === 0 && studentInsert.status === 403, `${JSON.stringify(studentRest.body)} ${studentInsert.status}`);

const studentOnCounselor = await call(sa.token, "GET", "/booking/settings");
const counselorOnStudent = await call(A.token, "GET", "/me/booking/types");
check("the counselor routes are counselor-only and the student routes student-only", studentOnCounselor.status === 403 && counselorOnStudent.status === 403);

// ---- what a student sees ------------------------------------------------------------------------

const typesSa = await call(sa.token, "GET", "/me/booking/types");
check("a student sees their counselor's active types, with the counselor's zone", typesSa.status === 200 && typesSa.body.available === true && typesSa.body.timeZone === "UTC" && typesSa.body.types.length === 1 && typesSa.body.types[0].id === hourType.body.id, JSON.stringify(typesSa.body));
check("…and nothing that identifies the counselor's other settings", typesSa.body.weeklyHours === undefined && typesSa.body.types[0].counselorId === undefined);
check("…but the two change rules, so the app can say why Reschedule/Cancel are off", typesSa.body.cutoffHours === 12 && typesSa.body.studentsCanChange === false, JSON.stringify(typesSa.body));
const SAFE_KEYS = ["available", "reason", "timeZone", "types", "cutoffHours", "studentsCanChange"];
check("…and no other key (no hours, notice, buffer, days ahead or calendar state)", Object.keys(typesSa.body).every((k) => SAFE_KEYS.includes(k)), Object.keys(typesSa.body).join(","));

const slots = (token, typeId, n, extra = "") => call(token, "GET", `/me/booking/slots?typeId=${typeId}&from=${encodeURIComponent(dayStart(n).toISOString())}&to=${encodeURIComponent(dayStart(n + 1).toISOString())}${extra}`);
const starts = (r) => (r.body?.slots ?? []).map((s) => s.startsAt);

const free = await slots(sa.token, hourType.body.id, 3, "&tz=America/Chicago");
check("slots are the counselor's hours on that day", free.status === 200 && JSON.stringify(starts(free)) === JSON.stringify([at(3, 9), at(3, 10), at(3, 11)]) && free.body.timeZone === "UTC", JSON.stringify(free.body));
check("…each with its end", free.body.slots?.[0]?.endsAt === at(3, 10));

await sql(`insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status)
  values ('${sb.id}', '${A.id}', 'Someone else', 'phone', '${at(3, 10)}', '${at(3, 10, 30)}', 'scheduled'),
         ('${sb.id}', '${A.id}', 'Cancelled one', 'phone', '${at(3, 11)}', '${at(3, 12)}', 'cancelled')`);
const withMeeting = await slots(sa.token, hourType.body.id, 3);
check("a scheduled meeting takes its slot; a cancelled one doesn't", JSON.stringify(starts(withMeeting)) === JSON.stringify([at(3, 9), at(3, 11)]), JSON.stringify(withMeeting.body));
check("…and the student isn't told why", JSON.stringify(withMeeting.body).indexOf("Someone else") === -1);

await call(A.token, "PUT", "/booking/settings", { bufferMinutes: 30 });
const withBuffer = await slots(sa.token, hourType.body.id, 3);
check("the buffer widens the meeting", JSON.stringify(starts(withBuffer)) === JSON.stringify([at(3, 11)]), JSON.stringify(withBuffer.body));
await call(A.token, "PUT", "/booking/settings", { bufferMinutes: 0 });

const fixturePath = process.env.BOOKING_BUSY_FIXTURE;
if (fixturePath) {
  writeFileSync(fixturePath, JSON.stringify({ [A.id]: [{ start: at(4, 9, 30), end: at(4, 10, 15) }] }));
  const withCalendar = await slots(sa.token, hourType.body.id, 4);
  check("the connected calendar's busy time takes its slots too", JSON.stringify(starts(withCalendar)) === JSON.stringify([at(4, 11)]), JSON.stringify(withCalendar.body));
  writeFileSync(fixturePath, "{}");
} else {
  console.log("SKIP  calendar busy time (start the API with BOOKING_BUSY_FIXTURE and pass it here)");
}

const far = await call(sa.token, "GET", `/me/booking/slots?typeId=${hourType.body.id}&from=${encodeURIComponent(dayStart(40).toISOString())}&to=${encodeURIComponent(dayStart(41).toISOString())}`);
check("nothing past max days ahead", far.status === 200 && far.body.slots.length === 0, JSON.stringify(far.body));
const wide = await call(sa.token, "GET", `/me/booking/slots?typeId=${hourType.body.id}&from=${encodeURIComponent(dayStart(1).toISOString())}&to=${encodeURIComponent(dayStart(29).toISOString())}`);
check("one request covers at most 14 days", wide.status === 200 && Date.parse(wide.body.to) - Date.parse(wide.body.from) <= 14 * DAY && wide.body.slots.length > 0, JSON.stringify({ from: wide.body.from, to: wide.body.to }));

const inactive = await slots(sa.token, hidden.body.id, 3);
check("an inactive type has no slots", inactive.status === 404 && inactive.body.code === "type_not_found", JSON.stringify(inactive.body));
const bType = await call(B.token, "POST", "/booking/types", { name: "B's", durationMinutes: 30, mode: "phone" });
await call(B.token, "PUT", "/booking/settings", { enabled: true, timeZone: "UTC", weeklyHours: allWeek([{ start: "00:00", end: "24:00" }]), minNoticeHours: 0 });
const crossType = await slots(sa.token, bType.body.id, 3);
check("a student can't ask for another counselor's type", crossType.status === 404 && crossType.body.code === "type_not_found", JSON.stringify(crossType.body));
const typesSb = await call(sb.token, "GET", "/me/booking/types");
check("B's student sees B's types, not A's", typesSb.body.types?.length === 1 && typesSb.body.types[0].id === bType.body.id, JSON.stringify(typesSb.body));
check("…and B's change rules (the defaults), not A's", typesSb.body.cutoffHours === 24 && typesSb.body.studentsCanChange === true, JSON.stringify(typesSb.body));

// ---- students who can't book ---------------------------------------------------------------------

await sql(`insert into booking_settings (counselor_id, enabled, time_zone, weekly_hours) values ('${U.id}', true, 'UTC', '${JSON.stringify(allWeek([{ start: "09:00", end: "12:00" }]))}')`);
await sql(`insert into booking_meeting_types (counselor_id, name, duration_minutes, mode) values ('${U.id}', 'Pending', 30, 'phone')`);
const uType = await sql(`select id from booking_meeting_types where counselor_id='${U.id}'`);
const typesSu = await call(su.token, "GET", "/me/booking/types");
const noSettings = (b) => !("cutoffHours" in b) && !("studentsCanChange" in b) && b.timeZone === null;
check("a student of an unapproved counselor gets nothing: counselor_unavailable, no settings fields", typesSu.status === 200 && typesSu.body.available === false && typesSu.body.reason === "counselor_unavailable" && typesSu.body.types.length === 0 && noSettings(typesSu.body), JSON.stringify(typesSu.body));
const slotsSu = await slots(su.token, uType, 3);
check("…and no slots", slotsSu.status === 404 && slotsSu.body.code === "booking_not_available", JSON.stringify(slotsSu.body));

const typesSn = await call(sn.token, "GET", "/me/booking/types");
check("a student with no counselor gets nothing: counselor_unavailable, no settings fields", typesSn.status === 200 && typesSn.body.available === false && typesSn.body.reason === "counselor_unavailable" && noSettings(typesSn.body), JSON.stringify(typesSn.body));

const N = await user("bk-n");                          // approved, never set booking up
const sNn = await user("bk-snn", "student");
await sql(`update profiles set counselor_id='${N.id}' where id='${sNn.id}'`);
const typesNotSetUp = await call(sNn.token, "GET", "/me/booking/types");
check("a counselor who never set booking up: not_set_up, no settings fields", typesNotSetUp.status === 200 && typesNotSetUp.body.available === false && typesNotSetUp.body.reason === "not_set_up" && noSettings(typesNotSetUp.body), JSON.stringify(typesNotSetUp.body));
await call(N.token, "PUT", "/booking/settings", { enabled: true, timeZone: "UTC", weeklyHours: allWeek([{ start: "09:00", end: "12:00" }]), cancelCutoffHours: 8 });
const typesNoTypes = await call(sNn.token, "GET", "/me/booking/types");
check("booking on but no active type: no_types, with the change rules", typesNoTypes.body.available === false && typesNoTypes.body.reason === "no_types" && typesNoTypes.body.types.length === 0 && typesNoTypes.body.cutoffHours === 8 && typesNoTypes.body.studentsCanChange === true && typesNoTypes.body.timeZone === null, JSON.stringify(typesNoTypes.body));

await call(B.token, "PUT", "/booking/settings", { enabled: false });
const typesOff = await call(sb.token, "GET", "/me/booking/types");
const slotsOff = await slots(sb.token, bType.body.id, 3);
check("booking switched off: paused, the change rules (a cancel still works), no types, no slots", typesOff.body.available === false && typesOff.body.reason === "paused" && typesOff.body.types.length === 0 && typesOff.body.cutoffHours === 24 && typesOff.body.studentsCanChange === true && typesOff.body.timeZone === null && slotsOff.status === 404 && slotsOff.body.code === "booking_not_available", `${JSON.stringify(typesOff.body)} ${JSON.stringify(slotsOff.body)}`);

// ---- book_meeting_slot ------------------------------------------------------------------------------

const args = (s, e, extra = {}) => ({ p_student: sa.id, p_counselor: A.id, p_starts_at: s, p_ends_at: e, p_mode: "google-meet", p_title: "Check-in", p_agenda: null, ...extra });
const booked = await serviceRpc("book_meeting_slot", args(at(5, 9), at(5, 10)));
check("the service role books a slot", booked.status === 200 && booked.body?.booked_by_student === true && booked.body?.counselor_id === A.id && booked.body?.student_id === sa.id && booked.body?.status === "scheduled", JSON.stringify(booked.body));
const again = await serviceRpc("book_meeting_slot", args(at(5, 9, 30), at(5, 10, 30)));
check("an overlapping second booking is slot_taken", again.status !== 200 && /slot_taken/.test(JSON.stringify(again.body)), JSON.stringify(again.body));
const touching = await serviceRpc("book_meeting_slot", args(at(5, 10), at(5, 11)));
check("a booking that only touches is fine", touching.status === 200, JSON.stringify(touching.body));

const racers = await Promise.all([0, 1, 2].map(() => serviceRpc("book_meeting_slot", args(at(6, 9), at(6, 10)))));
check("three at once: exactly one books", racers.filter((r) => r.status === 200).length === 1 && racers.filter((r) => /slot_taken/.test(JSON.stringify(r.body))).length === 2, JSON.stringify(racers.map((r) => r.status)));

const notMine = await serviceRpc("book_meeting_slot", { ...args(at(7, 9), at(7, 10)), p_student: sb.id });
check("a student who isn't the counselor's is not_your_counselor", /not_your_counselor/.test(JSON.stringify(notMine.body)), JSON.stringify(notMine.body));
const offBooking = await serviceRpc("book_meeting_slot", { ...args(at(7, 9), at(7, 10)), p_student: sb.id, p_counselor: B.id });
check("a counselor with booking off is booking_disabled", /booking_disabled/.test(JSON.stringify(offBooking.body)), JSON.stringify(offBooking.body));
const unapproved = await serviceRpc("book_meeting_slot", { ...args(at(7, 9), at(7, 10)), p_student: su.id, p_counselor: U.id });
check("an unapproved counselor can't be booked", /not_your_counselor/.test(JSON.stringify(unapproved.body)), JSON.stringify(unapproved.body));
const zoomSlot = await serviceRpc("book_meeting_slot", args(at(7, 9), at(7, 10), { p_mode: "zoom" }));
const backwardsSlot = await serviceRpc("book_meeting_slot", args(at(7, 10), at(7, 9)));
check("a bad mode or a backwards slot is invalid_slot", /invalid_slot/.test(JSON.stringify(zoomSlot.body)) && /invalid_slot/.test(JSON.stringify(backwardsSlot.body)));
const past = new Date(Date.now() - 60 * 60_000).toISOString();
const pastSlot = await serviceRpc("book_meeting_slot", args(past, new Date(Date.now() - 30 * 60_000).toISOString()));
const startedSlot = await serviceRpc("book_meeting_slot", args(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 30 * 60_000).toISOString()));
check("a slot in the past, or one already started, is invalid_slot", /invalid_slot/.test(JSON.stringify(pastSlot.body)) && /invalid_slot/.test(JSON.stringify(startedSlot.body)), `${JSON.stringify(pastSlot.body)} ${JSON.stringify(startedSlot.body)}`);
check("…and nothing was booked in the past", (await sql(`select count(*) from meetings where counselor_id='${A.id}' and booked_by_student and starts_at < now()`)) === "0");

const asStudent = await rest(sa.token, "POST", "/rest/v1/rpc/book_meeting_slot", args(at(8, 9), at(8, 10)));
const asCounselor = await rest(A.token, "POST", "/rest/v1/rpc/book_meeting_slot", args(at(8, 9), at(8, 10)));
const asAnon = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/book_meeting_slot`, {
  method: "POST",
  headers: { apikey: process.env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify(args(at(8, 9), at(8, 10))),
});
check("authenticated and anon can't execute it", [401, 403, 404].includes(asStudent.status) && [401, 403, 404].includes(asCounselor.status) && [401, 403, 404].includes(asAnon.status), `${asStudent.status} ${asCounselor.status} ${asAnon.status}`);
check("…and nothing was booked by them", (await sql(`select count(*) from meetings where counselor_id='${A.id}' and starts_at='${at(8, 9)}'`)) === "0");

const slotsAfter = await slots(sa.token, hourType.body.id, 5);
check("a booked slot is gone from the list", JSON.stringify(starts(slotsAfter)) === JSON.stringify([at(5, 11)]), JSON.stringify(slotsAfter.body));

// ---- booked_by_student is not client-writable ---------------------------------------------------

const flip = await rest(A.token, "PATCH", `/rest/v1/meetings?id=eq.${booked.body.id}`, { booked_by_student: false }, { Prefer: "return=representation" });
check("the counselor can't unmark a student's booking", flip.status === 403, JSON.stringify(flip.body));
const fake = await rest(A.token, "POST", "/rest/v1/meetings", { student_id: sa.id, counselor_id: A.id, title: "Fake", starts_at: at(9, 9), ends_at: at(9, 10), booked_by_student: true }, { Prefer: "return=representation" });
check("…nor insert a meeting marked booked by the student", fake.status === 403, JSON.stringify(fake.body));
const plain = await rest(A.token, "POST", "/rest/v1/meetings", { student_id: sa.id, counselor_id: A.id, title: "Plain", starts_at: at(9, 9), ends_at: at(9, 10) }, { Prefer: "return=representation" });
check("…while their ordinary meetings still save, unmarked", plain.status === 201 && plain.body?.[0]?.booked_by_student === false, JSON.stringify(plain.body));
const retitle = await rest(A.token, "PATCH", `/rest/v1/meetings?id=eq.${booked.body.id}`, { title: "Renamed" }, { Prefer: "return=representation" });
check("…and they still edit a booked meeting's own fields", retitle.status === 200 && retitle.body?.[0]?.booked_by_student === true, JSON.stringify(retitle.body));

const del = await call(A.token, "DELETE", `/booking/types/${hidden.body.id}`);
check("a counselor deletes their own type", del.status === 200 && (await call(A.token, "GET", "/booking/types")).body.types.length === 1);
