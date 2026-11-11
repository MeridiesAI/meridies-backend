// Email blast: the financial aid status filter (FAFSA or CSS Profile status,
// include or exclude, "nothing recorded" as its own value). No migration: the
// filter is stored inside `email_blasts.filters` and re-read by the dispatcher.
//
//   C   a counselor with A (FAFSA submitted, CSS in-progress), B (FAFSA
//       in-progress, CSS not-required), N (no aid record), all class of 2027
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now();
const C = await user("blast-aid-c");
const a = await studentOf(C, "aid-a");
const b = await studentOf(C, "aid-b");
const n = await studentOf(C, "aid-n");
await sql(`update public.profiles set grad_year = '2027' where id in ('${a.id}', '${b.id}', '${n.id}')`);
await sql(`insert into public.student_aid_profiles (student_id, fafsa_status, css_status) values
  ('${a.id}', 'submitted', 'in-progress'),
  ('${b.id}', 'in-progress', 'not-required')`);

const preview = (over) => call(C.token, "POST", "/blasts/preview", over);
const names = (r) => (r.body.students ?? []).map((s) => s.id).sort().join(",");
const ids = (...u) => u.map((s) => s.id).sort().join(",");
const fafsa = (mode, statuses) => ({ aid: { form: "fafsa", mode, statuses } });

const aud = await call(C.token, "GET", "/blasts/audiences");
const count = (form, v) => aud.body.aidStatuses?.[form]?.find((o) => o.value === v)?.count;
check("audiences count FAFSA statuses, with nothing recorded apart", count("fafsa", "submitted") === 1 && count("fafsa", "in-progress") === 1 && count("fafsa", "not-started") === 0 && count("fafsa", "none") === 1, JSON.stringify(aud.body.aidStatuses));
check("audiences count CSS Profile statuses", count("css", "not-required") === 1 && count("css", "in-progress") === 1 && count("css", "none") === 1);

check("no aid filter is everyone", names(await preview({})) === ids(a, b, n));
check("FAFSA is any of submitted", names(await preview(fafsa("include", ["submitted"]))) === ids(a));
check("FAFSA is none of submitted keeps the unrecorded", names(await preview(fafsa("exclude", ["submitted"]))) === ids(b, n));
check("nothing recorded is its own value", names(await preview(fafsa("include", ["none"]))) === ids(n));
check("not started is not nothing recorded", names(await preview(fafsa("include", ["not-started"]))) === "");
check("FAFSA is none of submitted or nothing recorded", names(await preview(fafsa("exclude", ["submitted", "none"]))) === ids(b));
check("CSS Profile reads its own column", names(await preview({ aid: { form: "css", mode: "include", statuses: ["not-required"] } })) === ids(b));
check("aid combines with class year", names(await preview({ classYears: ["2028"], ...fafsa("include", ["submitted"]) })) === "");
const p = await preview(fafsa("exclude", ["submitted"]));
check("the preview counts and labels the filtered audience", p.body.count === 2 && /FAFSA: not Submitted/.test(p.body.label), JSON.stringify(p.body));
check("a CSS-only status on the FAFSA is refused", (await preview(fafsa("include", ["not-required"]))).status === 400);
check("an empty aid filter is refused", (await preview(fafsa("include", []))).status === 400);

// Send now, with the filter.
const sent = await call(C.token, "POST", "/blasts", { ...fafsa("exclude", ["submitted"]), subject: `Aid now ${tag}`, body: "Hi {first}, the FAFSA is open." });
const reached = await sql(`select string_agg(student_id::text, ',' order by student_id) from public.email_blast_recipients where blast_id = '${sent.body.id}'`);
check("send now reaches only the filtered students", sent.status === 201 && reached === ids(b, n), `${sent.status} ${reached}`);
check("and stores the aid filter in its filters", (await sql(`select filters->'aid'->>'mode' from public.email_blasts where id = '${sent.body.id}'`)) === "exclude");

// Scheduled: stored, then re-resolved at send time.
const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
const queued = await call(C.token, "POST", "/blasts", { ...fafsa("include", ["in-progress"]), subject: `Aid later ${tag}`, body: "Hi {first}.", scheduledFor: when });
check("a scheduled blast keeps the aid filter", queued.status === 201 && (await sql(`select filters->'aid'->'statuses'->>0 from public.email_blasts where id = '${queued.body.id}'`)) === "in-progress", JSON.stringify(queued.body));
// N starts the FAFSA after it was queued: the run picks that up.
await sql(`insert into public.student_aid_profiles (student_id, fafsa_status) values ('${n.id}', 'in-progress')`);
await sql(`update public.email_blasts set scheduled_for = now() - interval '1 minute', claimed_at = null where id = '${queued.body.id}'`);
const run = await fetch(`${API}/internal/blasts/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
check("the dispatcher runs", run.status === 200, `${run.status}`);
const later = await sql(`select string_agg(student_id::text, ',' order by student_id) from public.email_blast_recipients where blast_id = '${queued.body.id}'`);
check("the scheduled blast re-resolved the aid filter at send time", later === ids(b, n), later);

// A stored aid filter that doesn't read fails the run instead of reaching everyone.
const broken = await call(C.token, "POST", "/blasts", { ...fafsa("include", ["submitted"]), subject: `Aid broken ${tag}`, body: "x", scheduledFor: when });
await sql(`update public.email_blasts set filters = jsonb_set(filters, '{aid,statuses}', '["verified"]'), scheduled_for = now() - interval '1 minute', claimed_at = null where id = '${broken.body.id}'`);
await fetch(`${API}/internal/blasts/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
const brokenRow = await sql(`select status || ':' || (select count(*) from public.email_blast_recipients where blast_id = '${broken.body.id}') from public.email_blasts where id = '${broken.body.id}'`);
check("an unreadable stored aid filter fails closed", brokenRow === "failed:0", brokenRow);
