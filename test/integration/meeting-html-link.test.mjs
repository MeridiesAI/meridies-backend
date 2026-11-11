// "Open in Google Calendar" (lib/calendarLink.ts): /meetings answers carry `htmlLink`, Google's page for the event
// the API made on the owner's primary calendar, computed from the stored event id and the connected account's address.
//
//   * the owner with a Google grant that names an address gets the link (eid = base64url("<eventId> <address>"));
//   * anyone else reading it (here its student) gets null: the eid spells out the owner's address;
//   * an Outlook meeting and a meeting with no event get null; so does the owner with no stored address.
//
// The grant row is a stand-in (no provider is called on a read).
import { user, call, check, sql } from "./harness.mjs";

const A = await user("mhl-a");
const s = await user("mhl-s", "student");
await sql(`update profiles set counselor_id='${A.id}' where id='${s.id}'`);

const starts = new Date(Date.now() + 3 * 86_400_000).toISOString();
const ends = new Date(Date.now() + 3 * 86_400_000 + 1_800_000).toISOString();
const mk = async (provider, eventId) => {
  const [row] = (await sql(
    `insert into meetings (student_id, counselor_id, title, mode, starts_at, ends_at, calendar_provider, calendar_event_id)
     values ('${s.id}', '${A.id}', 'Link check', 'google-meet', '${starts}', '${ends}', ${provider ? `'${provider}'` : "null"}, ${eventId ? `'${eventId}'` : "null"})
     returning id`
  )).trim().split("\n");
  return row.trim();
};
const google = await mk("google", "evtmhl123");
const outlook = await mk("microsoft", "AAMkAGI2");
const none = await mk(null, null);

const decode = (link) => Buffer.from(new URL(link).searchParams.get("eid"), "base64url").toString("utf8");

let r = await call(A.token, "GET", `/meetings/${google}`);
check("no grant row: no link (the app opens that day)", r.status === 200 && r.body.htmlLink === null, JSON.stringify(r.body));

await sql(`insert into integration_tokens (owner_id, provider, account_email, access_token_enc, scopes)
           values ('${A.id}', 'google', 'mhl-owner@school.test', 'x', '{https://www.googleapis.com/auth/calendar.events}')`);
r = await call(A.token, "GET", `/meetings/${google}`);
check("the owner gets Google's event page", typeof r.body.htmlLink === "string" && r.body.htmlLink.startsWith("https://www.google.com/calendar/event?eid="), JSON.stringify(r.body));
check("…whose eid is the event id and the connected address", r.body.htmlLink && decode(r.body.htmlLink) === "evtmhl123 mhl-owner@school.test", r.body.htmlLink);

r = await call(A.token, "GET", `/meetings/${outlook}`);
check("an Outlook meeting: no link (webLink isn't stored)", r.status === 200 && r.body.htmlLink === null, JSON.stringify(r.body));
r = await call(A.token, "GET", `/meetings/${none}`);
check("no event: no link", r.status === 200 && r.body.htmlLink === null, JSON.stringify(r.body));

const list = await call(A.token, "GET", `/meetings?studentId=${s.id}`);
const byId = new Map((list.body ?? []).map((m) => [m.id, m]));
check("the list carries the same links", byId.get(google)?.htmlLink?.includes("eid=") && byId.get(outlook)?.htmlLink === null, JSON.stringify(list.body));

r = await call(s.token, "GET", `/meetings/${google}`);
check("the student reading the meeting gets no link (not their calendar)", r.status === 200 && r.body.htmlLink === null, JSON.stringify(r.body));
