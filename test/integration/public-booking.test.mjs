// The public booking link (20261121000001; routes/publicBooking.ts, lib/publicBooking.ts): anyone books one of a
// counselor's meeting types through /public/book/<slug>, with no account.
//
//   * GET /booking/settings gives the counselor a slug (name + 5 characters) and the switch; a user session can't
//     write the slug through PostgREST; rotate replaces it and the old link stops working;
//   * GET /public/book/:slug and its slots, with no token; an unknown slug, the link off, booking paused and an
//     unapproved counselor are the same 404 booking_link_not_found;
//   * POST books an offered slot (type's length and mode), emails the booker and the counselor, rings the
//     counselor's bell, and puts the booker on the Contact Pipeline (first stage, reused by email);
//   * the same slot again is 409 slot_unavailable, and so is a student's booking over it (book_meeting_slot checks
//     public bookings too), and the student's slots leave it out; a honeypot stores nothing;
//   * RLS: the counselor reads their own public bookings and may only cancel one; nobody else reads them;
//   * the counselor's calendar feed shows it as "<type> with <name>".
//
// No calendar grants: busy time is the counselor's meetings and public bookings only (no BOOKING_BUSY_FIXTURE needed).
import { user, call, check, sql, rest, API } from "./harness.mjs";

const A = await user("pbk-a");                                   // counselor with booking and a link
const B = await user("pbk-b");                                   // another practice
const U = await user("pbk-u", "counselor", { approved: false }); // pending counselor
const sa = await user("pbk-sa", "student");                      // A's student
await sql(`update profiles set counselor_id='${A.id}' where id='${sa.id}'`);
await sql(`update profiles set full_name='Jane Doe' where id='${A.id}'`);

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayStart = (n) => new Date(Math.floor(Date.now() / DAY) * DAY + n * DAY);
const at = (n, h, m = 0) => new Date(dayStart(n).getTime() + (h * 60 + m) * 60_000).toISOString();
const allWeek = (ranges) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));
const same = (a, b) => Date.parse(a) === Date.parse(b);

/**
 * No token at all: a family's browser. Each call from its own address, so the in-process limit (10 bookings a minute
 * per address) and the hourly per-address bucket don't decide this suite's answers; they have their own check below.
 */
const octet = () => 1 + Math.floor(Math.random() * 250);
async function anon(method, path, body, ip = `10.${octet()}.${octet()}.${octet()}`) {
  const r = await fetch(API + path, { method, headers: { "X-Forwarded-For": ip, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const resetLimits = () => sql(`delete from private.rate_limit_buckets where key like 'public-book:%'`);

async function waitFor(q, ok, tries = 40) {
  let out = null;
  for (let i = 0; i < tries; i++) {
    out = await sql(q);
    if (ok(out)) break;
    await sleep(250);
  }
  return out;
}

// ---- setup --------------------------------------------------------------------------------------

const put = await call(A.token, "PUT", "/booking/settings", {
  enabled: true, timeZone: "UTC", weeklyHours: allWeek([{ start: "09:00", end: "12:00" }]),
  minNoticeHours: 24, maxDaysAhead: 20, bufferMinutes: 0, cancelCutoffHours: 12, studentsCanReschedule: true,
});
check("setup: A's booking settings saved", put.status === 200, JSON.stringify(put.body));
const inPerson = (await call(A.token, "POST", "/booking/types", { name: "Intro call", durationMinutes: 30, mode: "in-person" })).body;
const video = (await call(A.token, "POST", "/booking/types", { name: "Video consult", durationMinutes: 60, mode: "google-meet" })).body;
const retired = (await call(A.token, "POST", "/booking/types", { name: "Retired", durationMinutes: 30, mode: "phone", active: false })).body;
// A's pipeline exists (the stages are seeded on first use).
const stages = await rest(A.token, "POST", "/rest/v1/rpc/ensure_pipeline_stages", {});
check("setup: A's pipeline stages", stages.status === 204 || stages.status === 200, JSON.stringify(stages.body));

// ---- the counselor's settings: slug, switch, rotate --------------------------------------------------

const settings = await call(A.token, "GET", "/booking/settings");
const slug = settings.body?.publicSlug;
check("GET /booking/settings gives the link a slug: the name and 5 characters", /^jane-doe-[a-z0-9]{5}$/.test(slug ?? ""), JSON.stringify(settings.body));
check("…and the switch, on by default", settings.body?.publicBookingEnabled === true, JSON.stringify(settings.body));
check("…the slug is stable across reads", (await call(A.token, "GET", "/booking/settings")).body?.publicSlug === slug);
check("the first PUT's answer already carried it", put.body?.publicSlug === slug && put.body?.publicBookingEnabled === true, JSON.stringify(put.body));
const bNever = await call(B.token, "GET", "/booking/settings");
check("a counselor who never saved settings has no slug yet (null), and the switch reads on", bNever.status === 200 && bNever.body.publicSlug === null && bNever.body.publicBookingEnabled === true, JSON.stringify(bNever.body));

const forge = await rest(A.token, "PATCH", `/rest/v1/booking_settings?counselor_id=eq.${A.id}`, { public_slug: "harvard-admissions" }, { Prefer: "return=representation" });
check("a counselor can't choose their own slug through PostgREST", forge.status >= 400 && (await sql(`select public_slug from booking_settings where counselor_id='${A.id}'`)) === slug, JSON.stringify(forge.body));

// ---- the public page --------------------------------------------------------------------------------

const page = await anon("GET", `/public/book/${slug}`);
check("GET /public/book/:slug answers with no token", page.status === 200, JSON.stringify(page.body));
check("…the counselor's name, practice, logo and zone", page.body?.counselor?.name === "Jane Doe" && page.body.counselor.practiceName === null && page.body.counselor.logoUrl === null && page.body.counselor.timezone === "UTC", JSON.stringify(page.body));
check("…the active types only, with id, name, duration and mode", JSON.stringify(page.body?.types?.map((t) => t.name)) === JSON.stringify(["Intro call", "Video consult"]) && Object.keys(page.body.types[0]).sort().join() === "durationMinutes,id,mode,name", JSON.stringify(page.body?.types));
check("…and never the counselor's email", !JSON.stringify(page.body).includes(A.email));
const unknown = await anon("GET", "/public/book/nobody-aaaaa");
check("an unknown slug is 404 booking_link_not_found", unknown.status === 404 && unknown.body.code === "booking_link_not_found", JSON.stringify(unknown.body));
const malformed = await anon("GET", "/public/book/Not%20A%20Slug");
check("a malformed one too", malformed.status === 404 && malformed.body.code === "booking_link_not_found", JSON.stringify(malformed.body));

const slotsPath = (s, typeId, n) => `/public/book/${s}/slots?typeId=${typeId}&from=${encodeURIComponent(dayStart(n).toISOString())}&to=${encodeURIComponent(dayStart(n + 1).toISOString())}`;
const starts = (r) => (r.body?.slots ?? []).map((x) => x.startsAt);
const slots = await anon("GET", slotsPath(slug, inPerson.id, 3));
check("the slots: the student route's shape", slots.status === 200 && slots.body.timeZone === "UTC" && slots.body.typeId === inPerson.id && slots.body.durationMinutes === 30 && starts(slots).length === 6, JSON.stringify(slots.body));
const retiredSlots = await anon("GET", slotsPath(slug, retired.id, 3));
check("an inactive type's slots are 404 type_not_found", retiredSlots.status === 404 && retiredSlots.body.code === "type_not_found", JSON.stringify(retiredSlots.body));

// ---- booking ----------------------------------------------------------------------------------------

await resetLimits();
const booker = { name: "Maria Lopez", email: `maria-${Date.now()}@test.local`, phone: "555-0100", note: "About junior year" };
const booked = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(3, 9), ...booker });
check("POST books an offered slot: 201", booked.status === 201, JSON.stringify(booked.body));
const b = booked.body?.booking;
check("…{ booking: { id, startsAt, endsAt, mode, joinUrl, typeName } }", b && same(b.startsAt, at(3, 9)) && same(b.endsAt, at(3, 9, 30)) && b.mode === "in-person" && b.joinUrl === null && b.typeName === "Intro call" && Object.keys(b).sort().join() === "endsAt,id,joinUrl,mode,startsAt,typeName", JSON.stringify(booked.body));
const row = JSON.parse((await sql(`select row_to_json(p) from public_bookings p where id='${b?.id}'`)) || "null");
check("the row: the counselor, the type, the booker's details, scheduled", row?.counselor_id === A.id && row.booking_type_id === inPerson.id && row.type_name === "Intro call" && row.name === "Maria Lopez" && row.email === booker.email.toLowerCase() && row.phone === "555-0100" && row.note === "About junior year" && row.status === "scheduled", JSON.stringify(row));
check("…and no meeting row (meetings.student_id stays a student)", (await sql(`select count(*) from meetings where counselor_id='${A.id}'`)) === "0");

const again = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(3, 9), name: "Someone Else", email: `else-${Date.now()}@test.local` });
check("the same slot again is 409 slot_unavailable", again.status === 409 && again.body.code === "slot_unavailable", JSON.stringify(again.body));
const overlap = await anon("POST", `/public/book/${slug}`, { typeId: video.id, startsAt: at(3, 9), name: "Someone Else", email: `else2-${Date.now()}@test.local` });
check("an hour-long type over it too", overlap.status === 409 && overlap.body.code === "slot_unavailable", JSON.stringify(overlap.body));
const offGrid = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(3, 9, 10), name: "Off Grid", email: `off-${Date.now()}@test.local` });
check("a start off the grid is 409 slot_unavailable", offGrid.status === 409 && offGrid.body.code === "slot_unavailable", JSON.stringify(offGrid.body));
const racers = await Promise.all([1, 2, 3].map((i) => anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(4, 10), name: `Racer ${i}`, email: `racer${i}-${Date.now()}@test.local` })));
check("three at once: exactly one books, the rest 409 slot_unavailable", racers.filter((r) => r.status === 201).length === 1 && racers.filter((r) => r.status === 409 && r.body.code === "slot_unavailable").length === 2, JSON.stringify(racers.map((r) => [r.status, r.body.code])));
check("…one booking exists at that time", (await sql(`select count(*) from public_bookings where counselor_id='${A.id}' and starts_at='${at(4, 10)}'`)) === "1");

// Busy everywhere: the link's slots, the student's slots, and a student's booking over it.
check("the link's slots leave the booked time out", !starts(await anon("GET", slotsPath(slug, inPerson.id, 3))).some((s) => same(s, at(3, 9))));
const studentSlots = await call(sa.token, "GET", `/me/booking/slots?typeId=${inPerson.id}&from=${encodeURIComponent(dayStart(3).toISOString())}&to=${encodeURIComponent(dayStart(4).toISOString())}`);
check("the student's slots leave it out too", studentSlots.status === 200 && !starts(studentSlots).some((s) => same(s, at(3, 9))) && starts(studentSlots).some((s) => same(s, at(3, 9, 30))), JSON.stringify(studentSlots.body));
await sql(`delete from private.rate_limit_buckets where key = 'booking-actions:${sa.id}'`);
const studentOver = await call(sa.token, "POST", "/me/booking", { typeId: inPerson.id, startsAt: at(3, 9) });
check("a student's booking over it is refused", studentOver.status === 409 && ["slot_unavailable", "slot_taken"].includes(studentOver.body.code), JSON.stringify(studentOver.body));
let rpcError = "";
try {
  await sql(`set role service_role; select public.book_meeting_slot('${sa.id}','${A.id}','${at(3, 9)}','${at(3, 9, 30)}','in-person','x',null)`);
} catch (e) {
  rpcError = String(e?.stderr ?? e?.message ?? e);
}
check("…and book_meeting_slot itself refuses it (the database, not only the slot grid)", /slot_taken/.test(rpcError), rpcError.slice(0, 300));
check("…so the meeting was never written", (await sql(`select count(*) from meetings where counselor_id='${A.id}'`)) === "0");

// The honeypot.
const before = await sql(`select count(*) from public_bookings where counselor_id='${A.id}'`);
const bot = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(5, 11), name: "Bot", email: `bot-${Date.now()}@test.local`, website: "http://spam.example" });
check("a filled-in honeypot answers 201 like a booking", bot.status === 201 && same(bot.body?.booking?.startsAt, at(5, 11)) && bot.body.booking.typeName === "Intro call", JSON.stringify(bot.body));
check("…and stores nothing", (await sql(`select count(*) from public_bookings where counselor_id='${A.id}'`)) === before);
check("…the slot is still offered", starts(await anon("GET", slotsPath(slug, inPerson.id, 5))).some((s) => same(s, at(5, 11))));

// ---- what follows a booking -------------------------------------------------------------------------

const mail = await waitFor(
  `select coalesce(json_agg(json_build_object('to', lower(to_email), 'template', template, 'kind', recipient_kind) order by created_at), '[]') from message_deliveries where template like 'public-booking-%' and (lower(to_email) = '${booker.email.toLowerCase()}' or (recipient_id = '${A.id}' and created_at > now() - interval '5 minutes'))`,
  (out) => JSON.parse(out || "[]").length >= 2
);
const sent = JSON.parse(mail || "[]");
check("the booker is emailed a confirmation", sent.some((d) => d.to === booker.email.toLowerCase() && d.template === "public-booking-confirmation"), mail);
check("the counselor is emailed a notice", sent.some((d) => d.to === A.email.toLowerCase() && d.template === "public-booking-counselor" && d.kind === "counselor"), mail);
const bell = await waitFor(`select coalesce(json_agg(title), '[]') from notifications where recipient_id='${A.id}' and title like 'Maria Lopez booked%'`, (out) => JSON.parse(out || "[]").length >= 1);
check("the counselor's bell: 'Maria Lopez booked Intro call on …'", /Maria Lopez booked Intro call on /.test(bell ?? ""), bell);

const contact = await waitFor(`select row_to_json(c) from pipeline_contacts c where counselor_id='${A.id}' and parent_email='${booker.email.toLowerCase()}'`, (out) => Boolean(out));
const c = JSON.parse(contact || "null");
const firstStage = await sql(`select id from pipeline_stages where counselor_id='${A.id}' and firm_id is null order by position, created_at limit 1`);
check("the booker is on the Contact Pipeline, in the first stage", c?.stage_id === firstStage && c.student_name === "Maria Lopez" && c.parent_phone === "555-0100" && c.owner_id === A.id && c.source === "Booking link", contact);
const acts = JSON.parse((await waitFor(`select coalesce(json_agg(body order by created_at), '[]') from pipeline_activities where contact_id='${c?.id}' and kind='meeting'`, (out) => JSON.parse(out || "[]").length >= 1)) || "[]");
check("…with 'Booked Intro call for <date>' on its timeline", acts.length === 1 && /^Booked Intro call for /.test(acts[0]), JSON.stringify(acts));
check("…and the booking points at it", (await sql(`select contact_id from public_bookings where id='${b?.id}'`)) === c?.id);

await resetLimits();
const second = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(6, 10), ...booker, email: booker.email.toUpperCase() });
check("a second booking by the same address (any case) books", second.status === 201, JSON.stringify(second.body));
await waitFor(`select count(*) from pipeline_activities where contact_id='${c?.id}' and kind='meeting'`, (out) => out === "2");
check("…reuses the contact: one card, two timeline entries", (await sql(`select count(*) from pipeline_contacts where counselor_id='${A.id}' and parent_email='${booker.email.toLowerCase()}'`)) === "1" && (await sql(`select count(*) from pipeline_activities where contact_id='${c?.id}' and kind='meeting'`)) === "2");
const third = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(7, 10), ...booker });
const fourth = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(8, 10), ...booker });
check("one address holds at most 3 upcoming bookings with a counselor", third.status === 201 && fourth.status === 409 && fourth.body.code === "too_many_bookings", JSON.stringify([third.status, fourth.body]));

// ---- the counselor's calendar -----------------------------------------------------------------------

const feedDay = dayStart(3).toISOString().slice(0, 10);
const feed = await call(A.token, "GET", `/calendar/feed?from=${feedDay}&to=${feedDay}&tz=UTC`);
const item = (feed.body?.items ?? []).find((i) => i.ref === b?.id);
check("the counselor's calendar feed shows it as a meeting '<type> with <name>'", item?.kind === "meeting" && item.title === "Intro call with Maria Lopez" && item.publicBooking === true && item.studentId === null && same(item.startsAt, at(3, 9)), JSON.stringify(feed.body?.items));

// ---- RLS ----------------------------------------------------------------------------------------------

const own = await rest(A.token, "GET", `/rest/v1/public_bookings?select=id,name&counselor_id=eq.${A.id}`);
check("the counselor reads their own public bookings", own.status === 200 && own.body.some((r) => r.id === b?.id), JSON.stringify(own.body));
const other = await rest(B.token, "GET", `/rest/v1/public_bookings?select=id&id=eq.${b?.id}`);
check("another counselor reads none of them", other.status === 200 && other.body.length === 0, JSON.stringify(other.body));
const stud = await rest(sa.token, "GET", `/rest/v1/public_bookings?select=id&id=eq.${b?.id}`);
check("a student reads none of them", stud.status === 200 && stud.body.length === 0, JSON.stringify(stud.body));
const anonRead = await fetch(`${process.env.SUPABASE_URL}/rest/v1/public_bookings?select=id`, { headers: { apikey: process.env.SUPABASE_ANON_KEY } });
check("anon reads none of them", anonRead.status >= 400 || (await anonRead.json()).length === 0);
const forgeTime = await rest(A.token, "PATCH", `/rest/v1/public_bookings?id=eq.${b?.id}`, { starts_at: at(9, 9) });
check("the counselor can't move one through PostgREST (status is the only grant)", forgeTime.status >= 400, JSON.stringify(forgeTime.body));
const bInsert = await rest(B.token, "POST", "/rest/v1/public_bookings", { counselor_id: B.id, type_name: "x", mode: "phone", name: "x", email: "x@y.z", starts_at: at(9, 9), ends_at: at(9, 10) });
check("nobody inserts one through PostgREST", bInsert.status >= 400, JSON.stringify(bInsert.body));
const cancel = await rest(A.token, "PATCH", `/rest/v1/public_bookings?id=eq.${second.body?.booking?.id}`, { status: "cancelled" }, { Prefer: "return=representation" });
check("the counselor cancels one: status cancelled, the time stamped", cancel.status === 200 && cancel.body?.[0]?.status === "cancelled" && Boolean(cancel.body[0].cancelled_at), JSON.stringify(cancel.body));
const revive = await rest(A.token, "PATCH", `/rest/v1/public_bookings?id=eq.${second.body?.booking?.id}`, { status: "scheduled" });
check("…and can't put it back (the slot may be gone)", revive.status >= 400, JSON.stringify(revive.body));
check("a cancelled booking frees its slot", starts(await anon("GET", slotsPath(slug, inPerson.id, 6))).some((s) => same(s, at(6, 10))));

// ---- the switch, pause, approval, rotate ---------------------------------------------------------------

const off = await call(A.token, "PUT", "/booking/settings", { publicBookingEnabled: false });
check("PUT { publicBookingEnabled: false }", off.status === 200 && off.body.publicBookingEnabled === false, JSON.stringify(off.body));
const offPage = await anon("GET", `/public/book/${slug}`);
const offBook = await anon("POST", `/public/book/${slug}`, { typeId: inPerson.id, startsAt: at(10, 9), name: "Late", email: `late-${Date.now()}@test.local` });
check("a switched-off link is 404 booking_link_not_found, page and book", offPage.status === 404 && offPage.body.code === "booking_link_not_found" && offBook.status === 404 && offBook.body.code === "booking_link_not_found", JSON.stringify([offPage.body, offBook.body]));
await call(A.token, "PUT", "/booking/settings", { publicBookingEnabled: true, enabled: false });
const paused = await anon("GET", `/public/book/${slug}`);
check("booking paused is the same 404", paused.status === 404 && paused.body.code === "booking_link_not_found", JSON.stringify(paused.body));
await call(A.token, "PUT", "/booking/settings", { enabled: true });
check("on again, the link answers", (await anon("GET", `/public/book/${slug}`)).status === 200);

await sql(`insert into booking_settings (counselor_id, enabled, time_zone, weekly_hours, min_notice_hours) values ('${U.id}', true, 'UTC', '${JSON.stringify(allWeek([{ start: "00:00", end: "24:00" }]))}', 0)`);
await sql(`update booking_settings set public_slug='pending-person-aaaaa' where counselor_id='${U.id}'`);
const pending = await anon("GET", "/public/book/pending-person-aaaaa");
check("an unapproved counselor's link is the same 404", pending.status === 404 && pending.body.code === "booking_link_not_found", JSON.stringify(pending.body));

const rotated = await call(A.token, "POST", "/booking/public-link/rotate");
const newSlug = rotated.body?.publicSlug;
check("POST /booking/public-link/rotate: a new suffix", rotated.status === 200 && /^jane-doe-[a-z0-9]{5}$/.test(newSlug ?? "") && newSlug !== slug, JSON.stringify(rotated.body));
check("…the old link stops working", (await anon("GET", `/public/book/${slug}`)).status === 404);
check("…the new one works", (await anon("GET", `/public/book/${newSlug}`)).status === 200);
check("…and settings say so", (await call(A.token, "GET", "/booking/settings")).body?.publicSlug === newSlug);
const bRotate = await call(B.token, "POST", "/booking/public-link/rotate");
check("rotate with no settings saved is 409 booking_not_set_up", bRotate.status === 409 && bRotate.body.code === "booking_not_set_up", JSON.stringify(bRotate.body));
const studentRotate = await call(sa.token, "POST", "/booking/public-link/rotate");
check("a student can't rotate", studentRotate.status === 403, JSON.stringify(studentRotate.body));

// ---- the per-address limit ----------------------------------------------------------------------------

await resetLimits();
const ip = `10.${octet()}.${octet()}.250`;
const flood = [];
for (let i = 0; i < 11; i++) {
  flood.push(await anon("POST", `/public/book/${newSlug}`, { typeId: inPerson.id, startsAt: at(5, 11), name: "Bot", email: `flood-${i}@test.local`, website: "x" }, ip));
}
check("one address books at most 10 an hour: the 11th is 429", flood.slice(0, 10).every((r) => r.status === 201) && flood[10].status === 429, JSON.stringify(flood.map((r) => r.status)));
await resetLimits();
