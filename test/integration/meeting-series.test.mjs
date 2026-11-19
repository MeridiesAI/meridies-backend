// Repeating series (routes/meetings.ts /series, routes/calendar.ts /events/series, lib/seriesInvites.ts): real
// accounts on a local Supabase against a running API (see harness.mjs), with migration 20261129000002 applied.
// One series change is one invite round: one email per recipient listing every date (message_deliveries, and
// Mailpit when MAILPIT_URL is set and the API sends there through DEV_MAIL_URL). Sends run after the response,
// so the checks poll. Dates are in 2031, weekly over the New York DST start (Sun Mar 9 2031).
// These dates rot in March 2031 (they must stay in the future): pinned to that DST boundary on purpose, move them then.
import { user, call, check, sql } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const MAILPIT = process.env.MAILPIT_URL?.replace(/\/+$/, "") ?? null;
const TZ = "America/New_York";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nbsp = (s) => String(s ?? "").replace(/[\u202F\u00A0]/g, " ");

const c = await user("ser-counselor");
const other = await user("ser-other");
const s1 = await studentOf(c, "ser-s1");
const s2 = await studentOf(c, "ser-s2");
await sql(`update profiles set full_name='Dana Series' where id='${c.id}'`);
const recipients = [s1.email, s2.email, c.email].map((e) => e.toLowerCase());

/** Delivery rows to `to` with `template`, waiting up to 15 s for at least `min`. */
async function deliveries(template, min, since) {
  const q = `select coalesce(json_agg(json_build_object('to', lower(to_email), 'subject', subject, 'status', status, 'meeting', meeting_id) order by created_at), '[]')
    from message_deliveries where template='${template}' and lower(to_email) in (${recipients.map((e) => `'${e}'`).join(",")}) and created_at > '${since}'`;
  let out = [];
  for (let i = 0; i < 60; i++) {
    out = JSON.parse(await sql(q));
    if (out.length >= min) break;
    await sleep(250);
  }
  await sleep(1500); // anything extra (a second round) would land by now
  return JSON.parse(await sql(q));
}
const perRecipient = (rows) => recipients.map((e) => rows.filter((r) => r.to === e).length);

/** Mailpit messages to `to` whose subject starts with `prefix`. */
async function mails(to, prefix) {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const list = ((await r.json()).messages ?? []).filter((m) => nbsp(m.Subject).startsWith(prefix));
  return Promise.all(list.map(async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()));
}
const icsOf = async (m) => {
  const att = (m.Attachments ?? []).find((a) => /\.ics$/.test(a.FileName ?? ""));
  return att ? (await fetch(`${MAILPIT}/api/v1/message/${m.ID}/part/${att.PartID}`)).text() : null;
};
const rowsOf = async (seriesId) =>
  JSON.parse(await sql(`select coalesce(json_agg(json_build_object('id', id, 'start', to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
    'end', to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), 'seq', ics_sequence, 'title', title, 'status', status) order by starts_at), '[]')
    from meetings where series_id='${seriesId}'`));

// ---- Create ----------------------------------------------------------------------------------------------

const base = { studentId: s1.id, attendeeIds: [s2.id], title: "Weekly check-in", mode: "in-person", location: "Room 4", date: "2031-03-02", startMinutes: 900, durationMins: 60, timeZone: TZ };
let since = await sql("select now()");
const created = await call(c.token, "POST", "/meetings/series", { ...base, sendInvites: true, repeat: { preset: "weekly", count: 4 } });
const seriesId = created.body?.seriesId;
check("a weekly x4 series answers 201 with its series id and 4 meetings", created.status === 201 && /^[0-9a-f-]{36}$/.test(seriesId ?? "") && created.body?.meetings?.length === 4, JSON.stringify(created.body).slice(0, 300));
check("…one round: the two students counted (the counselor's copy isn't)", created.body?.invites?.status === "sending" && created.body?.invites?.recipients === 2, JSON.stringify(created.body?.invites));
// The column answering at all is what seriesReady saw; a missing one is a 503 series_unavailable.
check("the series routes are on (seriesReady saw the column)", created.status !== 503);

let rows = await rowsOf(seriesId);
check("4 rows share the one series_id", rows.length === 4 && (await sql(`select count(distinct series_id) from meetings where id in (${rows.map((r) => `'${r.id}'`).join(",")})`)) === "1");
check("each at 3:00 PM New York, 7 days apart across the DST start (20:00Z, then 19:00Z)",
  JSON.stringify(rows.map((r) => [r.start, r.end])) === JSON.stringify([["2031-03-02T20:00", "2031-03-02T21:00"], ["2031-03-09T19:00", "2031-03-09T20:00"], ["2031-03-16T19:00", "2031-03-16T20:00"], ["2031-03-23T19:00", "2031-03-23T20:00"]]),
  JSON.stringify(rows));
check("every row starts at sequence 0, scheduled, invites on", rows.every((r) => r.seq === 0 && r.status === "scheduled") && (await sql(`select bool_and(send_invites) from meetings where series_id='${seriesId}'`)) === "t");
check("the second student is an attendee of each meeting", (await sql(`select string_agg(student_id::text, ',' order by meeting_id) from meeting_attendees where meeting_id in (select id from meetings where series_id='${seriesId}') and student_id='${s2.id}'`)).split(",").length === 4);

let sent = await deliveries("meeting-invite", 3, since);
check("exactly one invite email per recipient for the whole series (not four)", JSON.stringify(perRecipient(sent)) === "[1,1,1]", JSON.stringify(sent));
const createSubject = "Invitation: Weekly check-in · 4 dates from Sun, Mar 2, 3:00 PM EST";
check("…its subject names the first date and the count", sent.every((r) => nbsp(r.subject) === createSubject), JSON.stringify(sent.map((r) => r.subject)));
check("…linked to the first meeting", sent.every((r) => r.meeting === rows[0].id));
check("…and sent to Mailpit (dev mail)", sent.every((r) => r.status === "sent"), JSON.stringify(sent.map((r) => r.status)));

const createWhen = [
  "When: Sunday, March 2, 2031 at 3:00 PM EST, until 4:00 PM EST",
  "When: Sunday, March 9, 2031 at 3:00 PM EDT, until 4:00 PM EDT",
  "When: Sunday, March 16, 2031 at 3:00 PM EDT, until 4:00 PM EDT",
  "When: Sunday, March 23, 2031 at 3:00 PM EDT, until 4:00 PM EDT",
];
if (MAILPIT) {
  for (const to of recipients) {
    const got = await mails(to, "Invitation: Weekly check-in");
    check(`Mailpit: one invitation to ${to.split("-")[1]}`, got.length === 1, String(got.length));
    const m = got[0];
    const text = nbsp(m?.Text);
    check("…its body lists all four dates", createWhen.every((w) => text.includes(w)), text.slice(0, 600));
    const ics = m ? await icsOf(m) : null;
    const uids = [...String(ics).matchAll(/UID:meeting-([0-9a-f-]{36})@/g)].map((x) => x[1]);
    check("…one .ics attached, METHOD:PUBLISH, a VEVENT per meeting with its own UID and SEQUENCE:0",
      (m?.Attachments ?? []).length === 1 && /METHOD:PUBLISH/.test(ics) && (String(ics).match(/BEGIN:VEVENT/g) ?? []).length === 4 &&
        JSON.stringify(uids) === JSON.stringify(rows.map((r) => r.id)) && (String(ics).match(/SEQUENCE:0\r?\n/g) ?? []).length === 4 && !/ATTENDEE/.test(ics),
      String(ics).slice(0, 200));
  }
} else console.log("SKIP  Mailpit checks (no MAILPIT_URL)");

// ---- The feed carries the series ---------------------------------------------------------------------------

const window = `from=2031-02-25&to=2031-04-30&tz=${encodeURIComponent(TZ)}`;
let feed = await call(c.token, "GET", `/calendar/feed?${window}`);
const feedMeetings = (feed.body?.items ?? []).filter((i) => rows.some((r) => i.id === `meeting:${r.id}`));
check("the counselor's feed has the 4 meetings, each with seriesId", feed.status === 200 && feedMeetings.length === 4 && feedMeetings.every((i) => i.seriesId === seriesId), JSON.stringify(feedMeetings.map((i) => [i.id, i.seriesId])));
const oneOff = await call(c.token, "POST", "/meetings", { studentId: s1.id, title: "One-off", startsAt: "2031-03-04T15:00:00Z", endsAt: "2031-03-04T16:00:00Z" });
feed = await call(c.token, "GET", `/calendar/feed?${window}`);
check("…and a one-off meeting carries seriesId null", (feed.body?.items ?? []).find((i) => i.id === `meeting:${oneOff.body?.id}`)?.seriesId === null);
// The meeting modal opens every meeting through GET /meetings/:id, so its seriesId must be there too.
const member = await call(c.token, "GET", `/meetings/${rows[0].id}`);
check("GET /meetings/:id returns the member's seriesId", member.status === 200 && member.body?.seriesId === seriesId, JSON.stringify(member.body).slice(0, 200));
const single = await call(c.token, "GET", `/meetings/${oneOff.body?.id}`);
check("…and a one-off's is null", single.status === 200 && single.body?.seriesId === null, JSON.stringify(single.body).slice(0, 200));

// ---- Scoped update ---------------------------------------------------------------------------------------------

const badMode = await call(c.token, "PATCH", `/meetings/series/${seriesId}`, { anchorId: rows[0].id, scope: "all", timeZone: TZ, patch: { mode: "phone" } });
check("a series patch with mode is a 400", badMode.status === 400, `${badMode.status} ${JSON.stringify(badMode.body)}`);
const badAtt = await call(c.token, "PATCH", `/meetings/series/${seriesId}`, { anchorId: rows[0].id, scope: "all", timeZone: TZ, patch: { attendeeIds: [s1.id] } });
check("…with attendeeIds a 400", badAtt.status === 400, `${badAtt.status}`);
check("…and neither changed a row", JSON.stringify(await rowsOf(seriesId)) === JSON.stringify(rows));

since = await sql("select now()");
const following = await call(c.token, "PATCH", `/meetings/series/${seriesId}`, { anchorId: rows[2].id, scope: "following", timeZone: TZ, patch: { startsAt: "2031-03-17T19:00:00.000Z" } });
check("PATCH following from the 3rd: 2 updated, none skipped or failed, one round", following.status === 200 && following.body?.updated === 2 && following.body?.skipped === 0 && following.body?.failed?.length === 0 && following.body?.invites?.status === "sending", JSON.stringify(following.body));
const afterFollowing = await rowsOf(seriesId);
check("rows 3-4 moved a day (lengths kept), rows 1-2 untouched",
  JSON.stringify(afterFollowing.map((r) => [r.start, r.end])) === JSON.stringify([["2031-03-02T20:00", "2031-03-02T21:00"], ["2031-03-09T19:00", "2031-03-09T20:00"], ["2031-03-17T19:00", "2031-03-17T20:00"], ["2031-03-24T19:00", "2031-03-24T20:00"]]),
  JSON.stringify(afterFollowing));
check("ics_sequence bumped only on rows 3-4", JSON.stringify(afterFollowing.map((r) => r.seq)) === "[0,0,1,1]", JSON.stringify(afterFollowing.map((r) => r.seq)));
sent = await deliveries("meeting-update", 3, since);
check("one update email per recipient", JSON.stringify(perRecipient(sent)) === "[1,1,1]", JSON.stringify(sent));
check("…subject: the 2 changed dates", sent.every((r) => nbsp(r.subject) === "Updated: Weekly check-in · 2 dates from Mon, Mar 17, 3:00 PM EDT"), JSON.stringify(sent.map((r) => r.subject)));
if (MAILPIT) {
  const m = (await mails(s1.email.toLowerCase(), "Updated: Weekly check-in"))[0];
  const text = nbsp(m?.Text);
  check("…body lists exactly the moved dates, no attachment",
    text.includes("When: Monday, March 17, 2031 at 3:00 PM EDT, until 4:00 PM EDT") && text.includes("When: Monday, March 24, 2031 at 3:00 PM EDT, until 4:00 PM EDT") &&
      !text.includes("March 2, 2031") && !text.includes("March 9, 2031") && (m?.Attachments ?? []).length === 0,
    text.slice(0, 600));
}

since = await sql("select now()");
const all = await call(c.token, "PATCH", `/meetings/series/${seriesId}`, { anchorId: rows[1].id, scope: "all", timeZone: TZ, patch: { title: "Weekly essay check-in" } });
check("PATCH all with a title: 4 updated", all.status === 200 && all.body?.updated === 4 && all.body?.skipped === 0 && all.body?.invites?.status === "sending", JSON.stringify(all.body));
const afterAll = await rowsOf(seriesId);
check("every row retitled, every sequence +1, times unchanged",
  afterAll.every((r) => r.title === "Weekly essay check-in") && JSON.stringify(afterAll.map((r) => r.seq)) === "[1,1,2,2]" &&
    JSON.stringify(afterAll.map((r) => r.start)) === JSON.stringify(afterFollowing.map((r) => r.start)),
  JSON.stringify(afterAll));
sent = await deliveries("meeting-update", 3, since);
check("…one update email per recipient listing 4 dates", JSON.stringify(perRecipient(sent)) === "[1,1,1]" && sent.every((r) => nbsp(r.subject) === "Updated: Weekly essay check-in · 4 dates from Sun, Mar 2, 3:00 PM EST"), JSON.stringify(sent));

// ---- Who may change it ------------------------------------------------------------------------------------

const theirs = await call(other.token, "PATCH", `/meetings/series/${seriesId}`, { anchorId: rows[0].id, scope: "all", timeZone: TZ, patch: { title: "Hijacked" } });
check("another counselor can't patch this series (404, as if it weren't there)", theirs.status === 404, `${theirs.status} ${JSON.stringify(theirs.body)}`);
const theirDelete = await call(other.token, "DELETE", `/meetings/series/${seriesId}?anchorId=${rows[0].id}&scope=all&timeZone=${encodeURIComponent(TZ)}`);
check("…or delete it (404)", theirDelete.status === 404, `${theirDelete.status}`);
const asStudent = await call(s1.token, "PATCH", `/meetings/series/${seriesId}`, { anchorId: rows[0].id, scope: "all", timeZone: TZ, patch: { title: "Mine" } });
const studentDelete = await call(s1.token, "DELETE", `/meetings/series/${seriesId}?anchorId=${rows[0].id}&scope=all`);
const studentCreate = await call(s1.token, "POST", "/meetings/series", { ...base, repeat: { preset: "weekly", count: 2 } });
check("a student gets 403 on create, patch and delete", [asStudent.status, studentDelete.status, studentCreate.status].every((s) => s === 403), `${asStudent.status} ${studentDelete.status} ${studentCreate.status}`);
check("…and no row changed", JSON.stringify(await rowsOf(seriesId)) === JSON.stringify(afterAll));

// ---- Scoped delete ------------------------------------------------------------------------------------------

// The first meeting was held: "all" skips it and leaves it, its attendee row too.
await sql(`update meetings set status='held' where id='${rows[0].id}'`);
since = await sql("select now()");
const del = await call(c.token, "DELETE", `/meetings/series/${seriesId}?anchorId=${rows[1].id}&scope=all&timeZone=${encodeURIComponent(TZ)}`);
check("DELETE all: 3 deleted, the held one skipped", del.status === 200 && del.body?.deleted === 3 && del.body?.skipped === 1 && del.body?.failed?.length === 0 && del.body?.invites?.status === "sending", JSON.stringify(del.body));
const left = await rowsOf(seriesId);
check("…only the held meeting is left", left.length === 1 && left[0].id === rows[0].id && left[0].status === "held", JSON.stringify(left));
check("…the deleted meetings' attendee rows went with them", (await sql(`select count(*) from meeting_attendees where meeting_id in (${rows.slice(1).map((r) => `'${r.id}'`).join(",")})`)) === "0" &&
  (await sql(`select count(*) from meeting_attendees where meeting_id='${rows[0].id}' and student_id='${s2.id}'`)) === "1");
sent = await deliveries("meeting-cancel", 3, since);
check("one cancel email per recipient, listing the 3 dates, no meeting link", JSON.stringify(perRecipient(sent)) === "[1,1,1]" &&
  sent.every((r) => nbsp(r.subject) === "Cancelled: Weekly essay check-in · 3 dates from Sun, Mar 9, 3:00 PM EDT" && r.meeting === null), JSON.stringify(sent));
if (MAILPIT) {
  const m = (await mails(s2.email.toLowerCase(), "Cancelled: Weekly essay check-in"))[0];
  const text = nbsp(m?.Text);
  check("…body lists the cancelled dates, not the held one, no attachment",
    ["March 9", "March 17", "March 24"].every((d) => text.includes(`${d}, 2031`)) && !text.includes("March 2, 2031") && (m?.Attachments ?? []).length === 0, text.slice(0, 600));
}

// ---- Limits ------------------------------------------------------------------------------------------------

const before = await sql(`select count(*) from meetings where counselor_id='${c.id}'`);
const links = await call(c.token, "POST", "/meetings/series", { ...base, mode: "google-meet", createConference: true, repeat: { preset: "weekly", count: 13 } });
check("13 meetings with a link each: 400", links.status === 400 && links.body?.error === "A series can have at most 12 meetings.", JSON.stringify(links.body));
const tooMany = await call(c.token, "POST", "/meetings/series", { ...base, repeat: { preset: "weekly", count: 53 } });
check("count 53: 400", tooMany.status === 400 && JSON.stringify(tooMany.body?.details?.fieldErrors?.repeat) === '["Number must be less than or equal to 52"]', JSON.stringify(tooMany.body).slice(0, 200));
const tooManyUntil = await call(c.token, "POST", "/meetings/series", { ...base, repeat: { preset: "daily", until: "2031-04-23" } });
check("an end date that makes 53 daily meetings: 400 in words", tooManyUntil.status === 400 && tooManyUntil.body?.error === "That end date makes 53 meetings; a series can have at most 52.", JSON.stringify(tooManyUntil.body));
const badZone = await call(c.token, "POST", "/meetings/series", { ...base, timeZone: "Mars/Olympus", repeat: { preset: "weekly", count: 2 } });
check("an unknown time zone: 400", badZone.status === 400 && JSON.stringify(badZone.body?.details?.fieldErrors?.timeZone) === '["That isn\'t a time zone we know"]', JSON.stringify(badZone.body).slice(0, 200));
check("…and none of them wrote a row", (await sql(`select count(*) from meetings where counselor_id='${c.id}'`)) === before);

// ---- Practice events --------------------------------------------------------------------------------------

const timed = await call(c.token, "POST", "/calendar/events/series", { title: "Study hall", date: "2031-03-03", startMinutes: 600, durationMins: 45, timeZone: TZ, repeat: { preset: "weekly", count: 3 } });
const tSeries = timed.body?.seriesId;
const tEvents = timed.body?.events ?? [];
check("a timed practice series answers 201 with 3 events sharing its id", timed.status === 201 && tEvents.length === 3 && tEvents.every((e) => e.seriesId === tSeries), JSON.stringify(timed.body).slice(0, 300));
check("…at 10:00 New York each week",
  JSON.stringify(tEvents.map((e) => [e.onDate, e.startsAt, e.endsAt])) === JSON.stringify([
    ["2031-03-03", "2031-03-03T15:00:00+00:00", "2031-03-03T15:45:00+00:00"],
    ["2031-03-10", "2031-03-10T14:00:00+00:00", "2031-03-10T14:45:00+00:00"],
    ["2031-03-17", "2031-03-17T14:00:00+00:00", "2031-03-17T14:45:00+00:00"],
  ]),
  JSON.stringify(tEvents.map((e) => [e.onDate, e.startsAt, e.endsAt])));
const allDay = await call(c.token, "POST", "/calendar/events/series", { title: "Essay day", date: "2031-03-04", startMinutes: null, timeZone: TZ, repeat: { preset: "daily", count: 3 } });
const aSeries = allDay.body?.seriesId;
const aEvents = allDay.body?.events ?? [];
check("an all-day practice series: 3 dated rows, no times", allDay.status === 201 && JSON.stringify(aEvents.map((e) => [e.onDate, e.startsAt, e.endsAt])) === JSON.stringify([["2031-03-04", null, null], ["2031-03-05", null, null], ["2031-03-06", null, null]]), JSON.stringify(allDay.body).slice(0, 300));

feed = await call(c.token, "GET", `/calendar/feed?${window}`);
const practice = (feed.body?.items ?? []).filter((i) => [...tEvents, ...aEvents].some((e) => i.id === `milestone:${e.id}`));
check("the feed marks all 6 practice: true with their seriesId", practice.length === 6 && practice.every((i) => i.practice === true) &&
  practice.filter((i) => i.seriesId === tSeries).length === 3 && practice.filter((i) => i.seriesId === aSeries && i.allDay === true).length === 3,
  JSON.stringify(practice.map((i) => [i.id, i.practice, i.seriesId, i.allDay])));

const pMove = await call(c.token, "PATCH", `/calendar/events/series/${tSeries}`, { anchorId: tEvents[1].id, scope: "following", timeZone: TZ, patch: { startsAt: "2031-03-11T14:00:00.000Z" } });
check("practice PATCH following from the 2nd: 2 updated", pMove.status === 200 && JSON.stringify(pMove.body) === JSON.stringify({ updated: 2, skipped: 0, failed: [] }), JSON.stringify(pMove.body));
const tRows = await sql(`select string_agg(on_date || '@' || to_char(starts_at at time zone 'UTC', 'HH24:MI'), ',' order by on_date) from calendar_events where series_id='${tSeries}'`);
check("…rows 2-3 a day later, row 1 untouched", tRows === "2031-03-03@15:00,2031-03-11@14:00,2031-03-18@14:00", tRows);
const aMove = await call(c.token, "PATCH", `/calendar/events/series/${aSeries}`, { anchorId: aEvents[0].id, scope: "all", timeZone: TZ, patch: { onDate: "2031-03-06", title: "Essay sprint" } });
const aRows = await sql(`select string_agg(on_date || ':' || title || ':' || coalesce(starts_at::text, 'none'), ',' order by on_date) from calendar_events where series_id='${aSeries}'`);
check("all-day PATCH all: every date +2 days and retitled, still all day", aMove.status === 200 && aMove.body?.updated === 3 && aRows === "2031-03-06:Essay sprint:none,2031-03-07:Essay sprint:none,2031-03-08:Essay sprint:none", `${JSON.stringify(aMove.body)} ${aRows}`);

const pOther = await call(other.token, "PATCH", `/calendar/events/series/${tSeries}`, { anchorId: tEvents[0].id, scope: "all", timeZone: TZ, patch: { title: "Hijacked" } });
const pOtherDel = await call(other.token, "DELETE", `/calendar/events/series/${tSeries}?anchorId=${tEvents[0].id}&scope=all&timeZone=${encodeURIComponent(TZ)}`);
const pStudent = await call(s1.token, "DELETE", `/calendar/events/series/${tSeries}?anchorId=${tEvents[0].id}&scope=all`);
check("another counselor gets 404 on a practice series, a student 403", pOther.status === 404 && pOtherDel.status === 404 && pStudent.status === 403, `${pOther.status} ${pOtherDel.status} ${pStudent.status}`);
check("…and nothing changed", (await sql(`select count(*) from calendar_events where series_id='${tSeries}' and title='Study hall'`)) === "3");

const pDel = await call(c.token, "DELETE", `/calendar/events/series/${tSeries}?anchorId=${tEvents[1].id}&scope=following&timeZone=${encodeURIComponent(TZ)}`);
check("practice DELETE following from the 2nd: 2 deleted, the 1st kept", pDel.status === 200 && JSON.stringify(pDel.body) === JSON.stringify({ deleted: 2, skipped: 0, failed: [] }) &&
  (await sql(`select string_agg(id::text, ',') from calendar_events where series_id='${tSeries}'`)) === tEvents[0].id, JSON.stringify(pDel.body));
const aDel = await call(c.token, "DELETE", `/calendar/events/series/${aSeries}?anchorId=${aEvents[0].id}&scope=all&timeZone=${encodeURIComponent(TZ)}`);
check("all-day DELETE all: 3 deleted, none left", aDel.status === 200 && aDel.body?.deleted === 3 && (await sql(`select count(*) from calendar_events where series_id='${aSeries}'`)) === "0", JSON.stringify(aDel.body));
