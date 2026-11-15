// Application rounds and their dates (migration 20261126100002): a school's official date for a round lives in
// college_round_deadlines, and a college list row's date (student_colleges.deadline, the board's "Due") follows
// the round picked on the board: the official date first, then the catalog's curated summary, else typed by hand.
// GET /application/essays carries each school's round, date and status for the Essays section's deadlines.
// Every signed-in user reads the table, a pending counselor reads nothing, no client writes it, and the database
// refuses a date outside its cycle. Real accounts on a local Supabase against a running API (see harness.mjs).
import { user, call, check, sql, rest, SB, ANON } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("counselor-rounds");
const s = await studentOf(c, "student-rounds");
const pending = await user("counselor-rounds-pending", "counselor", { approved: false });

// The cycle the API reads (lib/supplementDocs.ts currentCycle: it turns over August 1).
const now = new Date();
const first = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const CYCLE = `${first}-${first + 1}`;
const ED = `${first}-11-01`;
const RD = `${first + 1}-01-02`;
const CURATED_EA = `${first}-11-15`; // "Early Action": "Nov 15"

const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const college = await sql(
  `with c as (insert into public.colleges (name, slug, deadlines)
     values ('Round Test College ${tag}', 'round-test-${tag}', '{"Regular Decision": "Jan 5", "Early Action": "Nov 15"}'::jsonb)
     returning id) select id from c`
);
await sql(
  `insert into public.college_round_deadlines (college_id, admission_cycle, round, deadline, source_url, evidence) values
     ('${college}', '${CYCLE}', 'ED', '${ED}', 'https://admissions.example.edu/apply', 'Early Decision: November 1'),
     ('${college}', '${CYCLE}', 'RD', '${RD}', 'https://admissions.example.edu/apply', 'Regular Decision: January 2')`
);

// ---- The date follows the round ---------------------------------------------------------------------

let r = await call(s.token, "POST", "/application/college-list", { studentId: s.id, collegeId: college, round: "ED" });
check("a student adds the school in ED: the official ED date fills in", r.status === 201 && r.body.round === "ED" && r.body.deadline === ED, JSON.stringify(r.body).slice(0, 240));
const row = r.body.id;
const patch = (who, body) => call(who.token, "PATCH", `/application/college-list/${row}`, body);

r = await patch(c, { round: "RD" });
check("the counselor moves it to RD: the official RD date, not the curated one", r.status === 200 && r.body.deadline === RD, JSON.stringify(r.body?.deadline));

r = await patch(s, { round: "EA" });
check("EA has no official row: the catalog's curated Nov 15", r.status === 200 && r.body.deadline === CURATED_EA, JSON.stringify(r.body?.deadline));

r = await patch(s, { round: "REA" });
check("REA has no date anywhere: the date filled in for EA goes", r.status === 200 && r.body.round === "REA" && r.body.deadline === null, JSON.stringify(r.body?.deadline));

const typed = `${first}-11-03`;
r = await patch(s, { deadline: typed });
check("the student types the date by hand", r.status === 200 && r.body.deadline === typed);
r = await patch(s, { round: "SCEA" });
check("a typed date stays when the new round has no date on file", r.status === 200 && r.body.round === "SCEA" && r.body.deadline === typed, JSON.stringify(r.body?.deadline));

r = await patch(c, { round: "ED" });
check("a round with an official date replaces the typed one", r.status === 200 && r.body.deadline === ED, JSON.stringify(r.body?.deadline));

const earlier = `${first}-10-30`;
await patch(c, { deadline: earlier });
r = await patch(c, { round: "ED" });
check("picking the same round again keeps a typed date", r.status === 200 && r.body.deadline === earlier, JSON.stringify(r.body?.deadline));

const given = `${first + 1}-01-09`;
r = await patch(c, { round: "RD", deadline: given });
check("a date sent with the round wins", r.status === 200 && r.body.round === "RD" && r.body.deadline === given, JSON.stringify(r.body?.deadline));

r = await call(s.token, "POST", "/application/college-list", { studentId: s.id, name: `Hand Typed College ${tag}`, round: "RD" });
check("a school typed in by hand starts with no date", r.status === 201 && r.body.deadline === null, JSON.stringify(r.body).slice(0, 200));
const typedRow = r.body.id;
await call(s.token, "PATCH", `/application/college-list/${typedRow}`, { deadline: `${first + 1}-01-15` });
r = await call(s.token, "PATCH", `/application/college-list/${typedRow}`, { round: "EA" });
check("…and keeps the date typed for it when its round changes", r.status === 200 && r.body.deadline === `${first + 1}-01-15`, JSON.stringify(r.body?.deadline));

// ---- The Essays section's schools ---------------------------------------------------------------------

await sql(`update public.student_colleges set custom_deadline = '${first}-10-20', notes = 'COUNSELOR NOTE ${tag}' where id = '${row}'`);
r = await call(c.token, "GET", `/application/essays?studentId=${s.id}`);
const school = r.status === 200 ? r.body.colleges.find((x) => x.id === row) : null;
check(
  "GET /application/essays gives each school its round, date and status",
  school && school.round === "RD" && school.deadline === given && school.status === "not-started",
  JSON.stringify(school)
);
check(
  "…and nothing of the counselor's own (their date, notes)",
  school && !("customDeadline" in school) && !JSON.stringify(r.body.colleges).includes(`COUNSELOR NOTE ${tag}`),
  JSON.stringify(school)
);
r = await call(s.token, "GET", `/application/essays?studentId=${s.id}`);
check("the student reads the same", r.status === 200 && r.body.colleges.some((x) => x.id === row && x.deadline === given));

// ---- Who reads and writes the table -------------------------------------------------------------------

const path = `/rest/v1/college_round_deadlines?select=round,deadline&college_id=eq.${college}&order=round`;
let q = await rest(s.token, "GET", path);
check("a student reads the official dates", q.status === 200 && q.body.length === 2, JSON.stringify(q.body));
q = await rest(c.token, "GET", path);
check("an approved counselor reads them", q.status === 200 && q.body.length === 2);
q = await rest(pending.token, "GET", path);
check("a pending counselor reads nothing (the approval gate)", q.status === 200 && q.body.length === 0, JSON.stringify(q.body));
const anon = await fetch(`${SB}${path}`, { headers: { apikey: ANON } });
const anonBody = await anon.json();
check("anon reads nothing", !anon.ok || (Array.isArray(anonBody) && anonBody.length === 0), `${anon.status}`);
check(
  "the approval gate is on the table",
  (await sql(`select count(*) from pg_policy where polrelid = 'public.college_round_deadlines'::regclass and polname = 'approval_gate' and not polpermissive`)) === "1"
);

const row4 = { college_id: college, admission_cycle: CYCLE, round: "EA", deadline: `${first}-11-15`, source_url: "https://example.edu/" };
q = await rest(c.token, "POST", "/rest/v1/college_round_deadlines", row4);
check("a counselor can't add a date", q.status >= 400, `status ${q.status}`);
q = await rest(s.token, "PATCH", `/rest/v1/college_round_deadlines?college_id=eq.${college}`, { deadline: `${first}-12-01` }, { Prefer: "return=representation" });
check("a student can't move one", q.status >= 400 || (Array.isArray(q.body) && q.body.length === 0), `status ${q.status}`);
check("the dates are unchanged", (await sql(`select string_agg(deadline::text, ',' order by round) from public.college_round_deadlines where college_id = '${college}'`)) === `${ED},${RD}`);

// ---- What the database refuses ------------------------------------------------------------------------

const refused = async (label, values) => {
  let ok = false;
  try {
    await sql(`insert into public.college_round_deadlines (college_id, admission_cycle, round, deadline, source_url) values (${values})`);
  } catch {
    ok = true;
  }
  check(label, ok);
};
await refused("a date outside its cycle (last year's page)", `'${college}', '${CYCLE}', 'EA', '${first - 1}-11-01', 'https://example.edu/'`);
await refused("a cycle that isn't two years in a row", `'${college}', '${first}-${first + 2}', 'EA', '${first}-11-01', 'https://example.edu/'`);
await refused("a round that isn't one of the list's", `'${college}', '${CYCLE}', 'Early Action', '${first}-11-01', 'https://example.edu/'`);
await refused("a date with no page it was read on", `'${college}', '${CYCLE}', 'EA', '${first}-11-01', null`);
await refused("a second row for the same school, cycle and round", `'${college}', '${CYCLE}', 'ED', '${first}-11-02', 'https://example.edu/'`);

// Upsert is how a writer replaces a date.
await sql(
  `insert into public.college_round_deadlines (college_id, admission_cycle, round, deadline, source_url)
   values ('${college}', '${CYCLE}', 'ED', '${first}-11-04', 'https://admissions.example.edu/dates')
   on conflict (college_id, admission_cycle, round) do update set deadline = excluded.deadline, source_url = excluded.source_url, checked_at = now()`
);
check("an upsert on (school, cycle, round) replaces the date", (await sql(`select deadline from public.college_round_deadlines where college_id = '${college}' and round = 'ED'`)) === `${first}-11-04`);

// The school leaving the catalog takes its dates with it.
await sql(`delete from public.colleges where id = '${college}'`);
check("deleting the school deletes its dates", (await sql(`select count(*) from public.college_round_deadlines where college_id = '${college}'`)) === "0");
