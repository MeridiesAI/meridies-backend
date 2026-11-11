// A counselor cancels a public-link booking (POST /booking/public/:id/cancel; lib/publicBookingCancel.ts):
//
//   * GET /booking/public/:id gives the counselor the booker's details; another counselor gets 404;
//   * another counselor's cancel is 404 booking_not_found, a student's 403, and nothing changes;
//   * the owner's cancel: status cancelled, cancelled_at stamped, the slot offered again; a second cancel is 409;
//   * the booker is emailed (template public-booking-cancellation) an .ics CANCEL with the invite's UID, SEQUENCE 1;
//   * the pipeline contact's timeline gets "Cancelled <type> on <date>";
//   * a calendar that can't be reached (a grant row with no Google client configured) still cancels: calendarRemoved false.
//
// MAILPIT_URL: where the API's DEV_MAIL_URL delivers (the .ics is read from there; skipped without it).
import { user, call, check, sql, rest, API } from "./harness.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? null;
const A = await user("pbc-a");
const B = await user("pbc-b");
const st = await user("pbc-s", "student");
await sql(`update profiles set full_name='Jane Doe' where id='${A.id}'`);

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayStart = (n) => new Date(Math.floor(Date.now() / DAY) * DAY + n * DAY);
const at = (n, h, m = 0) => new Date(dayStart(n).getTime() + (h * 60 + m) * 60_000).toISOString();
const allWeek = (ranges) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ranges]));
const same = (a, b) => Date.parse(a) === Date.parse(b);
const octet = () => 1 + Math.floor(Math.random() * 250);
async function anon(method, path, body) {
  const r = await fetch(API + path, { method, headers: { "X-Forwarded-For": `10.${octet()}.${octet()}.${octet()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
async function waitFor(q, ok, tries = 40) {
  let out = null;
  for (let i = 0; i < tries; i++) {
    out = await sql(q);
    if (ok(out)) break;
    await sleep(250);
  }
  return out;
}

// ---- setup: a link, a booking with a pipeline contact ---------------------------------------------

const put = await call(A.token, "PUT", "/booking/settings", {
  enabled: true, timeZone: "UTC", weeklyHours: allWeek([{ start: "09:00", end: "12:00" }]),
  minNoticeHours: 24, maxDaysAhead: 20, bufferMinutes: 0, cancelCutoffHours: 12, studentsCanReschedule: true,
});
check("setup: settings saved", put.status === 200, JSON.stringify(put.body));
const slug = put.body?.publicSlug;
const type = (await call(A.token, "POST", "/booking/types", { name: "Intro call", durationMinutes: 30, mode: "in-person" })).body;
const stages = await rest(A.token, "POST", "/rest/v1/rpc/ensure_pipeline_stages", {});
check("setup: pipeline stages", stages.status === 204 || stages.status === 200, JSON.stringify(stages.body));

const booker = { name: "Maria Lopez", email: `pbc-booker-${Date.now()}@test.local`, phone: "555-0100", note: "About junior year" };
const booked = await anon("POST", `/public/book/${slug}`, { typeId: type?.id, startsAt: at(3, 9), ...booker });
check("setup: a family books 9:00", booked.status === 201, JSON.stringify(booked.body));
const id = booked.body?.booking?.id;
const contactId = await waitFor(`select coalesce(contact_id::text, '') from public_bookings where id='${id}'`, (out) => Boolean(out));
check("setup: the booking is on the pipeline", Boolean(contactId), contactId);
const slotsPath = (n) => `/public/book/${slug}/slots?typeId=${type?.id}&from=${encodeURIComponent(dayStart(n).toISOString())}&to=${encodeURIComponent(dayStart(n + 1).toISOString())}`;
const starts = (r) => (r.body?.slots ?? []).map((s) => s.startsAt ?? s.start ?? s);
check("setup: 9:00 is no longer offered", !starts(await anon("GET", slotsPath(3))).some((s) => same(s, at(3, 9))));

// ---- reading it ----------------------------------------------------------------------------------

const read = await call(A.token, "GET", `/booking/public/${id}`);
const dto = read.body?.booking;
check("GET /booking/public/:id: the booker's name, email, phone and note", read.status === 200 && dto?.name === "Maria Lopez" && dto.email === booker.email.toLowerCase() && dto.phone === "555-0100" && dto.note === "About junior year" && dto.status === "scheduled" && dto.typeName === "Intro call", JSON.stringify(read.body));
const readB = await call(B.token, "GET", `/booking/public/${id}`);
check("…another counselor: 404 booking_not_found", readB.status === 404 && readB.body.code === "booking_not_found", JSON.stringify(readB.body));

// ---- who may cancel ------------------------------------------------------------------------------

const byB = await call(B.token, "POST", `/booking/public/${id}/cancel`);
check("another counselor's cancel: 404 booking_not_found", byB.status === 404 && byB.body.code === "booking_not_found", JSON.stringify(byB.body));
const byStudent = await call(st.token, "POST", `/booking/public/${id}/cancel`);
check("a student's: 403", byStudent.status === 403, JSON.stringify(byStudent.body));
check("…and it is still scheduled", (await sql(`select status from public_bookings where id='${id}'`)) === "scheduled");

// ---- the owner's cancel --------------------------------------------------------------------------

const cancelled = await call(A.token, "POST", `/booking/public/${id}/cancel`);
check("the owner's cancel: 200, cancelled, nothing left on a calendar", cancelled.status === 200 && cancelled.body?.booking?.status === "cancelled" && cancelled.body.calendarRemoved === true, JSON.stringify(cancelled.body));
const row = JSON.parse((await sql(`select row_to_json(p) from public_bookings p where id='${id}'`)) || "null");
check("…the row: cancelled, cancelled_at stamped", row?.status === "cancelled" && Boolean(row.cancelled_at), JSON.stringify(row));
check("…the slot is offered again", starts(await anon("GET", slotsPath(3))).some((s) => same(s, at(3, 9))));
const twice = await call(A.token, "POST", `/booking/public/${id}/cancel`);
check("a second cancel: 409 already_cancelled", twice.status === 409 && twice.body.code === "already_cancelled", JSON.stringify(twice.body));

const mail = await waitFor(
  `select coalesce(json_agg(template), '[]') from message_deliveries where lower(to_email) = '${booker.email.toLowerCase()}' and template = 'public-booking-cancellation'`,
  (out) => JSON.parse(out || "[]").length >= 1
);
check("the booker is emailed the cancellation, once", JSON.parse(mail || "[]").length === 1, mail);

const acts = JSON.parse((await waitFor(`select coalesce(json_agg(body order by created_at), '[]') from pipeline_activities where contact_id='${contactId}' and kind='meeting'`, (out) => JSON.parse(out || "[]").length >= 2)) || "[]");
check("the timeline: 'Booked Intro call for …' then 'Cancelled Intro call on …'", acts.length === 2 && /^Booked Intro call for /.test(acts[0]) && /^Cancelled Intro call on /.test(acts[1]), JSON.stringify(acts));

if (MAILPIT) {
  let ics = "";
  let confirmIcs = "";
  for (let i = 0; i < 40 && !ics; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${booker.email.toLowerCase()}"`)}`);
    const list = (await r.json()).messages ?? [];
    for (const m of list) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      for (const a of full.Attachments ?? []) {
        const text = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}/part/${a.PartID}`)).text();
        if (/METHOD:CANCEL/.test(text)) ics = text;
        else if (/METHOD:REQUEST/.test(text)) confirmIcs = text;
      }
    }
    if (!ics) await sleep(250);
  }
  const uid = (t) => (t.match(/^UID:(.*)$/m) ?? [])[1]?.trim();
  check("the .ics CANCEL: the invite's UID, SEQUENCE 1, STATUS CANCELLED", uid(ics) === `meeting-public-${id}@meridiesai.com` && uid(ics) === uid(confirmIcs) && /^SEQUENCE:1\r?$/m.test(ics) && /^STATUS:CANCELLED\r?$/m.test(ics) && /^SEQUENCE:0\r?$/m.test(confirmIcs), ics.slice(0, 600));
}

// ---- a calendar event that can't be deleted ------------------------------------------------------

const second = await anon("POST", `/public/book/${slug}`, { typeId: type?.id, startsAt: at(4, 10), ...booker, email: `pbc-two-${Date.now()}@test.local` });
check("setup: a second booking", second.status === 201, JSON.stringify(second.body));
const id2 = second.body?.booking?.id;
await sql(`update public_bookings set calendar_provider='google', calendar_event_id='evt-pbc-1' where id='${id2}'`);
await sql(`insert into integration_tokens (owner_id, provider, account_email, access_token_enc, scopes) values ('${A.id}', 'google', 'pbc@test.local', 'x', '{https://www.googleapis.com/auth/calendar.events}') on conflict do nothing`);
const leftOver = await call(A.token, "POST", `/booking/public/${id2}/cancel`);
check("the provider fails: still cancelled, calendarRemoved false", leftOver.status === 200 && leftOver.body?.booking?.status === "cancelled" && leftOver.body.calendarRemoved === false, JSON.stringify(leftOver.body));
check("…and the row says cancelled", (await sql(`select status from public_bookings where id='${id2}'`)) === "cancelled");
await sql(`delete from integration_tokens where owner_id='${A.id}'`);
