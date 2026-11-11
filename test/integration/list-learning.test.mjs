// List-builder learning (20261119000001): what Build College Lists showed and what people then did with each school,
// logged on the service client (lib/listLearning.ts), ids only, readable by no client, skipped for an excluded firm,
// and gone with the student's account. Needs the API as ci.yml starts it. The logging is never awaited by the
// routes, so every read here waits for the row to land.
import { API, CLIENT, call, check, rest, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `query` until `ok(value)` or about 5 s pass; returns the last value. */
async function eventually(query, ok) {
  let v;
  for (let i = 0; i < 50; i++) {
    v = await sql(query);
    if (ok(v)) return v;
    await pause(100);
  }
  return v;
}
const count = (table, where) => sql(`select count(*) from public.${table} where ${where}`).then(Number);
const choices = (studentId) =>
  sql(`select coalesce(json_agg(json_build_object('college', college_id, 'action', action, 'source', source, 'run', run_id,
         'position', position, 'actor', actor_id, 'role', actor_role, 'firm', firm_id) order by created_at, id), '[]'::json)
       from public.list_builder_choices where student_id = '${studentId}'`).then(JSON.parse);
const waitChoices = async (studentId, n) => {
  await eventually(`select count(*) from public.list_builder_choices where student_id = '${studentId}'`, (v) => Number(v) >= n);
  return choices(studentId);
};

// Free text in the request that must never reach a row: a typed major and the origin's place.
const CRITERIA = {
  majors: ["Mechanical Engineering for my robot club"],
  sizes: [],
  settings: [],
  testOptional: null,
  miles: 3000,
  origin: { lat: 40.71, lng: -74.0, label: "12 Elm Street, Brooklyn" },
  aid: "No preference",
  diversity: "No preference",
};
const shownOf = (body) => (body?.tiers ?? []).flatMap((t) => t.schools.map((s, i) => ({ collegeId: s.collegeId, band: t.fit, position: i + 1 })));

const owner = await user("ll-owner");
const firmId = await firmWith(owner);
const kid = await studentOf(owner, "ll-student");

// ---- The tables: no client reads or writes the logs; the catalog tables are read-only ----
{
  for (const t of ["list_builder_impressions", "list_builder_choices"]) {
    const read = await rest(owner.token, "GET", `/rest/v1/${t}?select=id&limit=1`);
    check(`a counselor can't read ${t}`, read.status >= 400, `${read.status}`);
    const write = await rest(owner.token, "POST", `/rest/v1/${t}`, { student_id: kid.id });
    check(`a counselor can't write ${t}`, write.status >= 400, `${write.status}`);
    const mine = await rest(kid.token, "GET", `/rest/v1/${t}?select=id&student_id=eq.${kid.id}`);
    check(`a student can't read their own ${t}`, mine.status >= 400, `${mine.status}`);
  }
  const anyCollege = await sql(`select id from public.colleges limit 1`);
  for (const t of ["college_core_features", "college_opportunities"]) {
    const read = await rest(owner.token, "GET", `/rest/v1/${t}?select=*&limit=1`);
    check(`a signed-in user reads ${t}`, read.status === 200 && Array.isArray(read.body), `${read.status}`);
    const body = t === "college_core_features" ? { college_id: anyCollege, feature_key: "x", value: 0.5 } : { college_id: anyCollege, name: "X" };
    const write = await rest(owner.token, "POST", `/rest/v1/${t}`, body);
    check(`a signed-in user can't write ${t}`, write.status >= 400, `${write.status}`);
  }
  const flag = await rest(owner.token, "PATCH", `/rest/v1/firms?id=eq.${firmId}`, { exclude_from_learning: true });
  check("a firm owner can't set exclude_from_learning", flag.status >= 400 && (await sql(`select exclude_from_learning from public.firms where id = '${firmId}'`)) === "f", `${flag.status}`);
}

// ---- Impressions: one row per school shown ----
let shown;
let runId;
{
  const r = await call(owner.token, "POST", "/colleges/list-builder", { studentId: kid.id, criteria: CRITERIA, perTier: 3 });
  check("the list builder answers as before", r.status === 200 && r.body?.tiers?.length === 3, `${r.status}`);
  shown = shownOf(r.body);
  check("it showed schools", shown.length > 0, `${shown.length}`);
  await eventually(`select count(*) from public.list_builder_impressions where student_id = '${kid.id}'`, (v) => Number(v) >= shown.length);
  const rows = JSON.parse(
    await sql(`select json_agg(json_build_object('college', college_id, 'band', band, 'position', position, 'run', run_id, 'actor', actor_id,
                 'role', actor_role, 'firm', firm_id, 'odds', odds, 'criteria', criteria, 'features', features) order by band, position)
               from public.list_builder_impressions where student_id = '${kid.id}'`)
  );
  check("one row per school shown", rows.length === shown.length, `${rows.length} vs ${shown.length}`);
  runId = rows[0]?.run;
  check("one run id for the whole answer", new Set(rows.map((x) => x.run)).size === 1);
  const key = (x) => `${x.band}:${x.position}:${x.college ?? x.collegeId}`;
  check("band and position are what the answer showed", JSON.stringify(rows.map(key).sort()) === JSON.stringify(shown.map(key).sort()));
  check("actor, role and firm", rows.every((x) => x.actor === owner.id && x.role === "counselor" && x.firm === firmId));
  const text = JSON.stringify(rows);
  check("no free text from the request is stored", !/Elm|Brooklyn|robot|Mechanical|40\.71/.test(text));
  check("the criteria keep what the ranking used", rows[0].criteria.originSet === true && rows[0].criteria.majorFields.includes("Engineering"));
  check("features carry the school's numbers and its place in the band", typeof rows[0].features.bandRank === "number" && "admit" in rows[0].features);
}

// ---- Choices: recommend, accept, remove, add by hand ----
{
  const first = shown[0];
  let r = await call(owner.token, "POST", "/application/college-list/recommendations", { studentId: kid.id, collegeId: first.collegeId });
  check("recommend answers as before", r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  const recId = r.body?.id;
  let c = await waitChoices(kid.id, 1);
  check(
    "a recommendation is logged, linked to the run and the school's position in it",
    c[0]?.action === "recommended" && c[0]?.source === "manual" && c[0]?.run === runId && c[0]?.position === first.position && c[0]?.college === first.collegeId,
    JSON.stringify(c[0])
  );

  r = await call(owner.token, "POST", `/application/college-list/recommendations/${recId}/accept`, {});
  check("accepting answers as before", r.status === 200, `${r.status}`);
  const rowId = r.body?.id;
  c = await waitChoices(kid.id, 2);
  check("accepting it onto the board is an add, same run", c[1]?.action === "added" && c[1]?.run === runId, JSON.stringify(c[1]));

  r = await call(owner.token, "DELETE", `/application/college-list/${rowId}`);
  check("removing answers as before", r.status === 200 && r.body?.deleted === true, `${r.status}`);
  c = await waitChoices(kid.id, 3);
  check("removing is logged", c[2]?.action === "removed" && c[2]?.college === first.collegeId, JSON.stringify(c[2]));

  const unseen = await sql(`select id from public.colleges where id not in (${shown.map((s) => `'${s.collegeId}'`).join(",")}) order by name limit 1`);
  r = await call(owner.token, "POST", "/application/college-list", { studentId: kid.id, collegeId: unseen });
  check("adding by hand answers as before", r.status === 201, `${r.status}`);
  c = await waitChoices(kid.id, 4);
  check("a school the builder never showed has no run", c[3]?.action === "added" && c[3]?.run === null && c[3]?.position === null, JSON.stringify(c[3]));

  r = await call(owner.token, "POST", "/application/college-list", { studentId: kid.id, name: "A school typed by hand" });
  check("a typed-in school is added as before", r.status === 201, `${r.status}`);
  await pause(600);
  check("…and not logged (no catalog id)", (await count("list_builder_choices", `student_id = '${kid.id}'`)) === 4);

  // AxIS's in-process requests carry x-meridies-axis: the label follows it.
  const another = await sql(`select id from public.colleges where id not in (${[...shown.map((s) => s.collegeId), unseen].map((id) => `'${id}'`).join(",")}) order by name limit 1`);
  const ax = await fetch(`${API}/application/college-list`, {
    method: "POST",
    headers: { ...CLIENT, Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json", "x-meridies-axis": "1" },
    body: JSON.stringify({ studentId: kid.id, collegeId: another }),
  });
  check("an AxIS-marked add answers as before", ax.status === 201, `${ax.status}`);
  c = await waitChoices(kid.id, 5);
  check("…and is labelled axis", c[4]?.source === "axis", JSON.stringify(c[4]));
}

// ---- The student's own Build College Lists: impressions as a student, adds as list_builder ----
{
  await call(owner.token, "PATCH", "/settings/privacy", { studentAiTools: true });
  const r = await call(kid.token, "POST", "/colleges/list-builder", { studentId: kid.id, criteria: CRITERIA, perTier: 3 });
  check("a student builds a list", r.status === 200, `${r.status}`);
  // Schools already on the list are skipped by the route; the check counts what it says it added.
  const theirs = shownOf(r.body).slice(-2);
  await eventually(`select count(*) from public.list_builder_impressions where student_id = '${kid.id}' and actor_role = 'student'`, (v) => Number(v) > 0);
  check("their run is logged as the student's", (await count("list_builder_impressions", `student_id = '${kid.id}' and actor_role = 'student' and actor_id = '${kid.id}'`)) > 0);
  const before = (await choices(kid.id)).length;
  const add = await call(kid.token, "POST", "/colleges/list-builder/add", { collegeIds: theirs.map((s) => s.collegeId) });
  check("Add to my list answers as before", add.status === 200, `${add.status} ${JSON.stringify(add.body).slice(0, 160)}`);
  const added = add.body?.added?.length ?? 0;
  const c = await waitChoices(kid.id, before + added);
  const fresh = c.slice(before);
  check(
    "each school the student added is one list_builder row, linked to their newest run",
    added > 0 && fresh.length === added && fresh.every((x) => x.source === "list_builder" && x.role === "student" && x.run !== null && x.run !== runId),
    JSON.stringify(fresh)
  );
}

// ---- An excluded firm logs nothing, and the tools work the same ----
{
  await sql(`update public.firms set exclude_from_learning = true where id = '${firmId}'`);
  const imps = await count("list_builder_impressions", `student_id = '${kid.id}'`);
  const chs = await count("list_builder_choices", `student_id = '${kid.id}'`);
  const r = await call(owner.token, "POST", "/colleges/list-builder", { studentId: kid.id, criteria: CRITERIA });
  check("excluded: the list builder still answers", r.status === 200 && r.body?.tiers?.length === 3, `${r.status}`);
  const pick = shownOf(r.body)[0];
  const rec = await call(owner.token, "POST", "/application/college-list/recommendations", { studentId: kid.id, collegeId: pick.collegeId });
  check("excluded: recommending still works", rec.status === 200 || rec.status === 201 || rec.status === 409, `${rec.status}`);
  await pause(800);
  check("excluded: no new impressions", (await count("list_builder_impressions", `student_id = '${kid.id}'`)) === imps);
  check("excluded: no new choices", (await count("list_builder_choices", `student_id = '${kid.id}'`)) === chs);
  await sql(`update public.firms set exclude_from_learning = false where id = '${firmId}'`);
}

// ---- A flagged counselor (solo, no firm: production's usual case) logs nothing; nobody flags themselves ----
{
  const c = await user("ll-flagged");
  const s = await studentOf(c, "ll-flagged-s");
  const self = await rest(c.token, "PATCH", `/rest/v1/profiles?id=eq.${c.id}`, { exclude_from_learning: true });
  check(
    "a counselor can't set their own exclude_from_learning",
    self.status >= 400 && (await sql(`select exclude_from_learning from public.profiles where id = '${c.id}'`)) === "f",
    `${self.status}`
  );
  await sql(`update public.profiles set exclude_from_learning = true where id = '${c.id}'`);
  const r = await call(c.token, "POST", "/colleges/list-builder", { studentId: s.id, criteria: CRITERIA });
  check("flagged: the list builder still answers", r.status === 200 && r.body?.tiers?.length === 3, `${r.status}`);
  const add = await call(c.token, "POST", "/application/college-list", { studentId: s.id, collegeId: shownOf(r.body)[0].collegeId });
  check("flagged: adding still works", add.status === 201, `${add.status}`);
  await pause(800);
  check(
    "flagged: nothing logged for their student",
    (await count("list_builder_impressions", `student_id = '${s.id}'`)) === 0 && (await count("list_builder_choices", `student_id = '${s.id}'`)) === 0
  );
}

// ---- Deletion: the student's rows go with their account; the acting account's rows stay, unnamed ----
{
  const solo = await user("ll-solo");
  const s2 = await studentOf(solo, "ll-solo-s");
  const r = await call(solo.token, "POST", "/colleges/list-builder", { studentId: s2.id, criteria: CRITERIA });
  check("a solo counselor's run", r.status === 200, `${r.status}`);
  await eventually(`select count(*) from public.list_builder_impressions where student_id = '${s2.id}'`, (v) => Number(v) > 0);
  check("a solo counselor's rows have no firm", (await count("list_builder_impressions", `student_id = '${s2.id}' and firm_id is not null`)) === 0);
  const rows = await count("list_builder_impressions", `student_id = '${s2.id}'`);
  await sql(`delete from auth.users where id = '${solo.id}'`);
  check(
    "deleting the acting account keeps the rows about the student, without who acted",
    (await count("list_builder_impressions", `student_id = '${s2.id}'`)) === rows && (await count("list_builder_impressions", `actor_id = '${solo.id}'`)) === 0
  );

  check("the student has rows before", (await count("list_builder_impressions", `student_id = '${kid.id}'`)) > 0 && (await count("list_builder_choices", `student_id = '${kid.id}'`)) > 0);
  await sql(`delete from auth.users where id = '${kid.id}'`);
  check(
    "deleting the student's account deletes their impressions and choices",
    (await count("list_builder_impressions", `student_id = '${kid.id}'`)) === 0 && (await count("list_builder_choices", `student_id = '${kid.id}'`)) === 0
  );
}
