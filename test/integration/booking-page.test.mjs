// 20261118000001: the counselor's linked Google Calendar booking page (lib/bookingPage.ts), switched on, and
// SEQUENCE rising when only `guardians_invited` changes (private.meetings_ics_sequence).
//
//   * PUT /booking/settings takes only Google's booking-page hosts over https; "" removes the link; the CHECK
//     refuses another host from a direct write too;
//   * the student's /me/booking/types carries bookingPage { url, counselorName }, alongside or instead;
//   * `instead` reads as paused: no slots and no booking through Meridies, but a booked meeting can still be cancelled;
//   * another practice's student never sees the link;
//   * a guardian taken off a meeting and put back is re-invited at a higher SEQUENCE than their cancellation.
import { user, call, check, sql, rest } from "./harness.mjs";

const A = await user("bp-a");
const B = await user("bp-b");
const sa = await user("bp-sa", "student");
const sb = await user("bp-sb", "student");
await sql(`update profiles set counselor_id='${A.id}', full_name='Ana Student' where id='${sa.id}'`);
await sql(`update profiles set counselor_id='${B.id}' where id='${sb.id}'`);
await sql(`update profiles set full_name='Casey Counselor' where id='${A.id}'`);

const DAY = 86_400_000;
const dayStart = (n) => new Date(Math.floor(Date.now() / DAY) * DAY + n * DAY);
const at = (n, h, m = 0) => new Date(dayStart(n).getTime() + (h * 60 + m) * 60_000).toISOString();
const allWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "24:00" }]]));
const PAGE = "https://calendar.app.google/BpTest123";

// ---- the counselor's link ---------------------------------------------------------------------

const fresh = await call(A.token, "GET", "/booking/settings");
check("with the migration in, settings say the link can be saved", fresh.status === 200 && fresh.body.bookingPageReady === true && fresh.body.bookingPageUrl === null && fresh.body.bookingPageMode === "alongside", JSON.stringify(fresh.body));

for (const bad of ["https://evil.example/calendar/x", "http://calendar.app.google/x", "https://calendar.app.google.evil.example/x", "https://u:p@calendar.app.google/x", "javascript:alert(1)"]) {
  const r = await call(A.token, "PUT", "/booking/settings", { bookingPageUrl: bad });
  check(`refuses ${bad}`, r.status === 400, JSON.stringify(r.body));
}

const on = await call(A.token, "PUT", "/booking/settings", {
  enabled: true,
  timeZone: "UTC",
  weeklyHours: allWeek,
  minNoticeHours: 1,
  maxDaysAhead: 30,
  cancelCutoffHours: 1,
  studentsCanReschedule: true,
  bookingPageUrl: `  ${PAGE}  `,
});
check("saves a Google booking page, trimmed, alongside by default", on.status === 200 && on.body.bookingPageUrl === PAGE && on.body.bookingPageMode === "alongside", JSON.stringify(on.body));
const type = (await call(A.token, "POST", "/booking/types", { name: "Chat", durationMinutes: 30, mode: "phone" })).body;

const forged = await rest(A.token, "PATCH", `/rest/v1/booking_settings?counselor_id=eq.${A.id}`, { booking_page_url: "https://evil.example/x" }, { Prefer: "return=representation" });
check("the CHECK refuses another host from a direct write", forged.status === 400 && /booking_page_url_check/.test(JSON.stringify(forged.body)), JSON.stringify(forged.body));
const badMode = await rest(A.token, "PATCH", `/rest/v1/booking_settings?counselor_id=eq.${A.id}`, { booking_page_mode: "only" }, { Prefer: "return=representation" });
check("…and a mode that isn't alongside or instead", badMode.status === 400, JSON.stringify(badMode.body));
check("…so the stored link is still the Google one", (await sql(`select booking_page_url from booking_settings where counselor_id='${A.id}'`)) === PAGE);

// ---- the student's side -----------------------------------------------------------------------

const along = await call(sa.token, "GET", "/me/booking/types");
check("alongside: Meridies booking and the link, with the counselor's name", along.body.available === true && along.body.types.length === 1 && along.body.bookingPage?.url === PAGE && along.body.bookingPage?.counselorName === "Casey Counselor", JSON.stringify(along.body));
const other = await call(sb.token, "GET", "/me/booking/types");
check("another practice's student never sees it", !("bookingPage" in (other.body ?? {})), JSON.stringify(other.body));

const slotsQ = `/me/booking/slots?typeId=${type.id}&from=${encodeURIComponent(dayStart(3).toISOString())}&to=${encodeURIComponent(dayStart(4).toISOString())}`;
const offered = await call(sa.token, "GET", slotsQ);
const start = offered.body?.slots?.[4]?.startsAt;
const booked = await call(sa.token, "POST", "/me/booking", { typeId: type.id, startsAt: start });
check("alongside: a student still books through Meridies", booked.status === 201, JSON.stringify(booked.body));

const instead = await call(A.token, "PUT", "/booking/settings", { bookingPageMode: "instead" });
check("switches to instead", instead.status === 200 && instead.body.bookingPageMode === "instead" && instead.body.enabled === true, JSON.stringify(instead.body));
const only = await call(sa.token, "GET", "/me/booking/types");
check("instead: the link only, read as paused", only.body.available === false && only.body.reason === "paused" && only.body.types.length === 0 && only.body.bookingPage?.url === PAGE, JSON.stringify(only.body));
const noSlots = await call(sa.token, "GET", slotsQ);
check("…no slots through Meridies", noSlots.status === 404 && noSlots.body.code === "booking_not_available", JSON.stringify(noSlots.body));
const noBook = await call(sa.token, "POST", "/me/booking", { typeId: type.id, startsAt: offered.body.slots[6].startsAt });
check("…no booking through Meridies", noBook.status === 404 && noBook.body.code === "booking_not_available", JSON.stringify(noBook.body));
const noMove = await call(sa.token, "PATCH", `/me/booking/${booked.body.id}`, { startsAt: offered.body.slots[8].startsAt });
check("…no moves", noMove.status === 404 && noMove.body.code === "booking_not_available", JSON.stringify(noMove.body));
const cancel = await call(sa.token, "DELETE", `/me/booking/${booked.body.id}`);
check("…but a booked meeting can still be cancelled", cancel.status === 200 && cancel.body.status === "cancelled", JSON.stringify(cancel.body));

const removed = await call(A.token, "PUT", "/booking/settings", { bookingPageUrl: "" });
check("an empty link removes it", removed.status === 200 && removed.body.bookingPageUrl === null, JSON.stringify(removed.body));
const back = await call(sa.token, "GET", "/me/booking/types");
check("…and with no page, instead no longer switches Meridies booking off", back.body.available === true && !("bookingPage" in back.body), JSON.stringify(back.body));

// ---- SEQUENCE when only the guardians change ---------------------------------------------------

const meeting = await call(A.token, "POST", "/meetings", {
  studentId: sa.id,
  title: "Family check-in",
  mode: "in-person",
  startsAt: at(9, 15),
  endsAt: at(9, 16),
  guardiansInvited: true,
  sendInvites: true,
});
const seq = async () => Number(await sql(`select ics_sequence from meetings where id='${meeting.body.id}'`));
const s0 = await seq();
await call(A.token, "PATCH", `/meetings/${meeting.body.id}`, { guardiansInvited: false });
const s1 = await seq();
await call(A.token, "PATCH", `/meetings/${meeting.body.id}`, { guardiansInvited: true });
const s2 = await seq();
check("guardians off raises SEQUENCE (their cancellation outranks the invite)", s1 === s0 + 1, `${s0} -> ${s1}`);
check("…and back on raises it again (the re-invite outranks the cancellation)", s2 === s1 + 1, `${s1} -> ${s2}`);
await call(A.token, "PATCH", `/meetings/${meeting.body.id}`, { guardiansInvited: true });
check("saving the same guardians again leaves it alone", (await seq()) === s2, String(await seq()));
const direct = await rest(A.token, "PATCH", `/rest/v1/meetings?id=eq.${meeting.body.id}`, { ics_sequence: 0 }, { Prefer: "return=representation" });
check("a client can't lower it", direct.status === 200 && Number(direct.body?.[0]?.ics_sequence) >= s2, JSON.stringify(direct.body));
