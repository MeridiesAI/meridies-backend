// The subscribable calendar feed (routes/calendarIcal.ts, lib/calendarIcal.ts,
// migration 20261111000002): real accounts on a local Supabase against a running
// API (see harness.mjs). The public .ics route runs under the service role, so
// these checks hold it to the token's counselor: their caseload only (a practice
// of more than 250 students included, read in batches), nothing of another
// practice's, nothing past the privacy rules, nothing for an unapproved
// counselor, and nothing once the URL is rotated or revoked.
import { createHash, randomBytes } from "node:crypto";
import { API, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = `calical-${Date.now().toString(36)}`;
const day = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const at = (n, h) => `${day(n)}T${String(h).padStart(2, "0")}:00:00Z`;
const octet = () => 1 + Math.floor(Math.random() * 250);
/** Fetch the feed as a calendar app would: no auth, each call from its own address unless `ip` is given. */
async function fetchFeed(url, ip) {
  const path = new URL(url).pathname;
  const r = await fetch(API + path, { headers: { "X-Forwarded-For": ip ?? `172.${octet()}.${octet()}.${octet()}` } });
  return { status: r.status, headers: r.headers, body: await r.text() };
}
const summaries = (ics) => ics.replace(/\r\n /g, "").split("\r\n").filter((l) => l.startsWith("SUMMARY:")).join("\n");

// ---- Practice A: a small roster plus 260 more students; practice B: its own ----------
const a = await user(`${tag}-a`);
const b = await user(`${tag}-b`);
await sql(`update public.profiles set full_name = 'Dana Counselor', timezone = 'UTC' where id = '${a.id}'`);
const ana = await studentOf(a, `${tag}-ana`);
const ben = await studentOf(b, `${tag}-ben`);
await sql(`update public.profiles set full_name = 'Ana Zyxlastname' where id = '${ana.id}'`);
await sql(`update public.profiles set full_name = 'Ben Qwvothername' where id = '${ben.id}'`);

for (const [s, who] of [[ana, "A"], [ben, "B"]]) {
  await sql(`insert into public.deadlines (student_id, title, type, due_date, description)
    values ('${s.id}', 'Deadline ${who} ${tag}', 'application', '${day(6)}', 'Hidden description ${who} ${tag}')`);
  await sql(`insert into public.student_colleges (student_id, name, deadline, custom_deadline, status)
    values ('${s.id}', 'College ${who} ${tag}', '${day(20)}', '${day(10)}', 'in-progress')`);
  await sql(`insert into public.student_academics (student_id, planned_test_date, test_status, sat_superscore)
    values ('${s.id}', '${day(8)}', 'scheduled', 1590)`);
  const counselor = who === "A" ? a : b;
  await sql(`insert into public.meetings (student_id, counselor_id, title, starts_at, ends_at, agenda, location, join_url, mode)
    values ('${s.id}', '${counselor.id}', 'Zyxlastname family ${who} ${tag}', '${at(5, 15)}', '${at(5, 16)}',
      'Secret agenda ${who} ${tag}', 'Secret room ${who} ${tag}', 'https://meet.google.com/sec-ret${who.toLowerCase()}-xyz', 'google-meet')`);
  await sql(`insert into public.calendar_events (owner_id, title, on_date) values ('${counselor.id}', 'Practice event ${who} ${tag}', '${day(4)}')`);
  await sql(`insert into public.deliverables (student_id, kind, title, status, due_date, source)
    values ('${s.id}', 'custom', 'Task ${who} ${tag}', 'in-progress', '${day(9)}', 'counselor')`);
}
// The student's own events never reach the file.
await sql(`insert into public.student_calendar_events (student_id, title, on_date) values ('${ana.id}', 'Personal ${tag}', '${day(3)}')`);
// A cancelled meeting doesn't either.
await sql(`insert into public.meetings (student_id, counselor_id, title, starts_at, ends_at, status)
  values ('${ana.id}', '${a.id}', 'Cancelled ${tag}', '${at(6, 15)}', '${at(6, 16)}', 'cancelled')`);

// 260 more students on A's roster (past the 250 a query names at once), the last five with a deadline.
await sql(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    '${tag}-big-' || lpad(g::text, 3, '0') || '@test.local', '', now(), jsonb_build_object('full_name', 'Big' || g || ' Student', 'role', 'student'), now(), now()
  from generate_series(1, 260) g`);
await sql(`update public.profiles p set counselor_id = '${a.id}', role = 'student' from auth.users u
  where u.id = p.id and u.email like '${tag}-big-%@test.local'`);
await sql(`insert into public.deadlines (student_id, title, type, due_date)
  select p.id, 'Big deadline ${tag}', 'application', '${day(7)}' from public.profiles p join auth.users u on u.id = p.id
  where u.email like '${tag}-big-%@test.local' order by p.id desc limit 5`);

// ---- Making the URL ---------------------------------------------------------------------
const none = await call(a.token, "GET", "/calendar/ical");
check("status before any URL: none", none.status === 200 && none.body?.exists === false, JSON.stringify(none.body));

const made = await call(a.token, "POST", "/calendar/ical");
const url = made.body?.url ?? "";
const token = /\/calendar\/ical\/([A-Za-z0-9_-]{43})\.ics$/.exec(url)?.[1];
check("POST makes the URL once (201)", made.status === 201 && Boolean(token), JSON.stringify(made.body));
check("…with a webcal:// twin", made.body?.webcalUrl === url.replace(/^https?:\/\//, "webcal://"), made.body?.webcalUrl);

const status = await call(a.token, "GET", "/calendar/ical");
check("the status route says it exists", status.status === 200 && status.body?.exists === true && Boolean(status.body?.createdAt), JSON.stringify(status.body));
check("…and never shows the URL or the token", !JSON.stringify(status.body).includes(token) && !("url" in (status.body ?? {})));
const stored = await sql(`select token_hash from public.calendar_feed_tokens where counselor_id = '${a.id}'`);
check("only the token's sha256 is stored", stored === createHash("sha256").update(token).digest("hex") && !stored.includes(token));

const student = await call(ana.token, "POST", "/calendar/ical");
check("a student can't make one", student.status === 403, String(student.status));
const clientRead = await fetch(`${process.env.SUPABASE_URL}/rest/v1/calendar_feed_tokens?select=*`, {
  headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${a.token}` },
});
const clientRows = await clientRead.text();
check("a client can't read the token table", clientRead.status !== 200 || clientRows === "[]", `${clientRead.status} ${clientRows.slice(0, 80)}`);

// ---- Reading it ---------------------------------------------------------------------------
const feed = await fetchFeed(url);
check("the feed answers 200 as text/calendar", feed.status === 200 && /^text\/calendar; charset=utf-8/.test(feed.headers.get("content-type") ?? ""), `${feed.status} ${feed.headers.get("content-type")}`);
check("Cache-Control: private, max-age=300", feed.headers.get("cache-control") === "private, max-age=300", feed.headers.get("cache-control"));
check("X-Robots-Tag: noindex", feed.headers.get("x-robots-tag") === "noindex");
check("Referrer-Policy: no-referrer", feed.headers.get("referrer-policy") === "no-referrer");
check("it is a PUBLISH calendar named Meridies", feed.body.startsWith("BEGIN:VCALENDAR\r\n") && feed.body.includes("METHOD:PUBLISH\r\n") && feed.body.includes("X-WR-CALNAME:Meridies\r\n"));

const sums = summaries(feed.body);
check("A's deadline, named by first name and initial", sums.includes(`SUMMARY:Ana Z.: Deadline A ${tag}`), sums);
check("A's task", sums.includes(`SUMMARY:Ana Z.: Task A ${tag}`));
check("A's school deadline and own deadline", sums.includes(`SUMMARY:Ana Z.: College A ${tag} application due`) && sums.includes(`SUMMARY:Ana Z.: College A ${tag}: your deadline`));
check("A's planned test date", sums.includes("SUMMARY:Ana Z.: Planned test date"));
check("A's meeting, as who it is with", sums.includes("SUMMARY:Meeting with Ana Z."));
check("A's practice event", sums.includes(`SUMMARY:Practice event A ${tag}`));
check("the students past the first 250 are on it (read in batches)", (sums.match(new RegExp(`Big deadline ${tag}`, "g")) ?? []).length === 5);
check("UIDs are feed-<kind>-<ref>@meridiesai.com", /\r\nUID:feed-meeting-[0-9a-f-]{36}@meridiesai\.com\r\n/.test(feed.body) && /\r\nUID:feed-college-custom-[0-9a-f-]{36}@meridiesai\.com\r\n/.test(feed.body));

// ---- Privacy ----------------------------------------------------------------------------
for (const [label, banned] of [
  ["a last name", "Zyxlastname"],
  ["the meeting's title", `Zyxlastname family`],
  ["the agenda", "Secret agenda"],
  ["the location", "Secret room"],
  ["the join link", "meet.google.com"],
  ["a deadline's description", "Hidden description"],
  ["a student's own event", `Personal ${tag}`],
  ["a cancelled meeting", `Cancelled ${tag}`],
  ["DESCRIPTION / LOCATION / URL / ATTENDEE lines", /\r\n(DESCRIPTION|LOCATION|URL|ATTENDEE|ORGANIZER)[:;]/],
]) {
  check(`privacy: no ${label}`, typeof banned === "string" ? !feed.body.includes(banned) : !banned.test(feed.body));
}
check("privacy: no score in any summary", !sums.includes("1590"));

// ---- Cross-practice leakage ----------------------------------------------------------------
for (const marker of [`Deadline B ${tag}`, `Task B ${tag}`, `College B ${tag}`, `Practice event B ${tag}`, "Ben Q.", "Qwvothername", "Secret agenda B"]) {
  check(`A's feed has nothing of practice B's: ${marker}`, !feed.body.includes(marker));
}
check("…and no UID of B's student", !feed.body.includes(`feed-test-${ben.id}`) && feed.body.includes(`feed-test-${ana.id}`));
const bMade = await call(b.token, "POST", "/calendar/ical");
const bFeed = await fetchFeed(bMade.body?.url ?? "");
check("B's feed has B's and nothing of A's", bFeed.status === 200 && bFeed.body.includes(`Deadline B ${tag}`) && !bFeed.body.includes(`Deadline A ${tag}`) && !bFeed.body.includes(`Big deadline ${tag}`) && !bFeed.body.includes("Ana Z."));

const fetched = await call(a.token, "GET", "/calendar/ical");
check("a fetch records lastFetchedAt", Boolean(fetched.body?.lastFetchedAt), JSON.stringify(fetched.body));

// ---- Refusals: all the same 404 -------------------------------------------------------------
const unknown = await fetchFeed(`${API}/calendar/ical/${randomBytes(32).toString("base64url")}.ics`);
const malformed = await fetchFeed(`${API}/calendar/ical/not-a-token.ics`);
const noExt = await fetchFeed(`${API}/calendar/ical/${token}`);
check("an unknown token is 404", unknown.status === 404, String(unknown.status));
check("…a malformed one the same 404, same body", malformed.status === 404 && malformed.body === unknown.body);
check("…a real token without .ics the same", noExt.status === 404 && noExt.body === unknown.body);

// Rotate: the old URL stops, the new one works.
const rotated = await call(a.token, "POST", "/calendar/ical");
check("POST again rotates (200, rotated)", rotated.status === 200 && rotated.body?.rotated === true && rotated.body?.url !== url, JSON.stringify(rotated.body));
const oldAfter = await fetchFeed(url);
check("the old URL is 404 after rotating, the same body", oldAfter.status === 404 && oldAfter.body === unknown.body, String(oldAfter.status));
const newAfter = await fetchFeed(rotated.body?.url ?? "");
check("the new URL works", newAfter.status === 200);
const afterRotate = await call(a.token, "GET", "/calendar/ical");
check("status shows rotatedAt", Boolean(afterRotate.body?.rotatedAt));

// An unapproved (revoked) counselor's URL is 404.
await sql(`update public.profiles set counselor_approved_at = null where id = '${b.id}'`);
const bUnapproved = await fetchFeed(bMade.body?.url ?? "");
check("an unapproved counselor's URL is 404, the same body", bUnapproved.status === 404 && bUnapproved.body === unknown.body, String(bUnapproved.status));

// Revoke.
const revoked = await call(a.token, "DELETE", "/calendar/ical");
check("DELETE revokes", revoked.status === 200 && revoked.body?.revoked === true, JSON.stringify(revoked.body));
const afterRevoke = await fetchFeed(rotated.body?.url ?? "");
check("a revoked URL is 404, the same body", afterRevoke.status === 404 && afterRevoke.body === unknown.body);
const statusGone = await call(a.token, "GET", "/calendar/ical");
check("status after revoking: none", statusGone.body?.exists === false);

// ---- Rate limit: one URL, many addresses ------------------------------------------------------
const c = await user(`${tag}-c`);
const cMade = await call(c.token, "POST", "/calendar/ical");
let last = 0;
let firstLimited = -1;
for (let i = 0; i < 62; i++) {
  last = (await fetchFeed(cMade.body?.url ?? "")).status;
  if (last === 429 && firstLimited < 0) firstLimited = i;
}
check("one URL fetched past 60 an hour trips the limit (429)", last === 429 && firstLimited === 60, `first 429 at ${firstLimited}`);

// Clean up this suite's accounts (the stack is shared); their rows cascade with their profiles.
await sql(`delete from auth.users where email like '${tag}-%@test.local'`);
