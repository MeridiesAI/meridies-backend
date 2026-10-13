// Events for students: a student reads Meridies-wide listings meant for
// students (their own colleges first) and never a counselor-only or a
// practice's own listing; saves land on their calendar. A counselor still
// sees everything the hub shows them, discovered rows included, and the
// roster's colleges in Filter by college. Real accounts on a local Supabase
// against a running API (see harness.mjs).
import { user, call, check, sql } from "./harness.mjs";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const c = await user("counselor-ev");
const s = await user("student-ev", "student");
const other = await user("student-ev-other", "student");

const stanford = await sql(`select id from colleges where slug = 'stanford' limit 1`);
const mit = await sql(`select id from colleges where slug = 'mit' limit 1`);
check("the catalog has Stanford and MIT", Boolean(stanford && mit), `${stanford} ${mit}`);

// The student is on the counselor's roster, with Stanford on their list.
const token = `ev-${Date.now()}`;
await sql(`insert into invitations (counselor_id, email, token, source) values ('${c.id}', '${s.email}', '${token}', 'single')`);
const accepted = await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_token: token }),
});
check("student joins the roster", accepted.ok, `status ${accepted.status}`);
await sql(`insert into student_colleges (student_id, college_id, name) values ('${s.id}', '${stanford}', 'Stanford University')`);

const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const tag = Date.now();
await sql(`insert into hub_events (name, kind, host, start_date, start_time, end_time, time_zone, place, url, college_id, audience, source, source_url)
  values
  ('Stanford Campus Tour ${tag}', 'campus-tour', 'Stanford University', '${d(10)}', '10:00', '11:30', 'America/Los_Angeles', 'Stanford, CA', 'https://visit.stanford.edu/', '${stanford}', 'everyone', 'discovered', 'https://visit.stanford.edu/'),
  ('MIT Virtual Info Session ${tag}', 'virtual-visit', 'MIT', '${d(12)}', '19:00', '20:00', 'America/New_York', 'Online', 'https://mitadmissions.org/visit/', '${mit}', 'everyone', 'csv', null),
  ('Counselor Conference ${tag}', 'conference', 'IECA', '${d(20)}', null, null, 'America/New_York', 'Chicago, IL', 'https://www.iecaonline.com/', null, 'counselor', 'csv', null),
  ('Past Tour ${tag}', 'campus-tour', 'Stanford University', '${d(-5)}', null, null, 'America/New_York', 'Stanford, CA', 'https://visit.stanford.edu/', '${stanford}', 'everyone', 'discovered', null)`);
// A counselor's own listing, even marked "everyone", is the practice's.
const own = await call(c.token, "POST", "/events", {
  name: `Practice Night ${tag}`, kind: "workshop", host: "Our practice", startDate: d(8), url: "https://example.org", share: "me",
});
check("counselor adds their own listing", own.status === 201, `status ${own.status}`);
await sql(`update hub_events set audience = 'everyone' where id = '${own.body.id}'`);

// Student
const mine = await call(s.token, "GET", "/me/events");
check("student reads the Events tab", mine.status === 200, `status ${mine.status} ${JSON.stringify(mine.body).slice(0, 200)}`);
const names = (list) => (list ?? []).map((e) => e.name);
check("their own college comes first", names(mine.body.forYourColleges).includes(`Stanford Campus Tour ${tag}`), JSON.stringify(names(mine.body.forYourColleges)));
check("…and the rest after", names(mine.body.more).includes(`MIT Virtual Info Session ${tag}`), JSON.stringify(names(mine.body.more)));
const all = [...names(mine.body.forYourColleges), ...names(mine.body.more)];
check("never a counselor-only listing", !all.includes(`Counselor Conference ${tag}`));
check("never a practice's own listing", !all.includes(`Practice Night ${tag}`));
check("never a past event", !all.includes(`Past Tour ${tag}`));
const tourCard = mine.body.forYourColleges.find((e) => e.name === `Stanford Campus Tour ${tag}`);
check("a tour says Plan a visit and links to the college's page", tourCard?.cta === "Plan a visit" && tourCard?.url === "https://visit.stanford.edu/");
check("the student's colleges are counted", mine.body.listedColleges === 1, String(mine.body.listedColleges));
await sql(`update colleges set visit_url = 'https://visit.stanford.edu/', visit_url_checked_at = now() where id = '${stanford}'`);
const withVisit = await call(s.token, "GET", "/me/events");
check("each listed college's visit page is offered", withVisit.body.visitPages?.some((v) => v.college.id === stanford && v.url === "https://visit.stanford.edu/"), JSON.stringify(withVisit.body.visitPages));
check("…only for colleges on their list", !withVisit.body.visitPages?.some((v) => v.college.id === mit));
const filtered = await call(s.token, "GET", "/me/events?kind=virtual-visit");
check("the kind chip filters", [...names(filtered.body.forYourColleges), ...names(filtered.body.more)].every((n) => n.startsWith("MIT")));

const direct = await fetch(`${SB}/rest/v1/hub_events?select=name&name=eq.${encodeURIComponent(`Counselor Conference ${tag}`)}`, {
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}` },
});
check("RLS hides counselor-only rows from a student", direct.ok && (await direct.json()).length === 0);
const refused = await call(s.token, "GET", "/events");
check("the counselor feed stays counselor-only", refused.status === 403, `status ${refused.status}`);

const saved = await call(s.token, "PUT", `/me/events/${tourCard.id}/save`, { targets: ["meridies", "google"], reminder: "1d" });
check("student saves an event", saved.status === 200 && saved.body.targets.includes("meridies"), `status ${saved.status}`);
const cal = await call(s.token, "GET", "/me/events/calendar");
check("…and it is on their calendar", cal.body.some?.((i) => i.ref === tourCard.id && i.kind === "event"));
const otherCal = await call(other.token, "GET", "/me/events/calendar");
check("…and nobody else's", Array.isArray(otherCal.body) && otherCal.body.length === 0);
const confId = await sql(`select id from hub_events where name = 'Counselor Conference ${tag}'`);
const sneaky = await call(s.token, "PUT", `/me/events/${confId}/save`, { targets: ["meridies"] });
check("a student can't save a counselor-only listing", sneaky.status === 404, `status ${sneaky.status}`);
const unsaved = await call(s.token, "DELETE", `/me/events/${tourCard.id}/save`);
check("student removes it", unsaved.status === 200);

// Counselor
const feed = await call(c.token, "GET", "/events");
const feedNames = (feed.body.items ?? []).filter((i) => i.type === "event").map((i) => i.item.name);
check("the counselor sees discovered, curated and own listings", [`Stanford Campus Tour ${tag}`, `MIT Virtual Info Session ${tag}`, `Counselor Conference ${tag}`, `Practice Night ${tag}`].every((n) => feedNames.includes(n)));
const discovered = feed.body.items.find((i) => i.item.name === `Stanford Campus Tour ${tag}`)?.item;
check("a discovered listing says where it came from", discovered?.source === "discovered" && discovered?.sourceUrl === "https://visit.stanford.edu/");
const rec = await call(c.token, "GET", "/events/recommended?count=3");
check("Recommended puts the roster's college first", rec.body[0]?.college?.id === stanford, JSON.stringify(rec.body.map?.((e) => e.name)));
const colleges = await call(c.token, "GET", "/events/colleges");
check("Filter by college marks roster schools", colleges.body.some?.((o) => o.value === stanford && o.onRoster === true));
const noSite = await call(c.token, "POST", "/events/discover", { collegeId: stanford });
check("Refresh events answers (503 without an AI key, otherwise the outcome)", [200, 503].includes(noSite.status), `status ${noSite.status} ${JSON.stringify(noSite.body).slice(0, 160)}`);
const studentDiscover = await call(s.token, "POST", "/events/discover", { collegeId: stanford });
check("a student can't run discovery", studentDiscover.status === 403, `status ${studentDiscover.status}`);

// The weekly job's route is the cron's alone.
const cron = await fetch(`${process.env.API_URL ?? "http://127.0.0.1:4100"}/internal/events/discover`, { method: "POST" });
check("the discovery cron route needs the secret", cron.status === 401 || cron.status === 503, `status ${cron.status}`);
