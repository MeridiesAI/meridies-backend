// Import pipeline step 2: duplicates against what the student already has
// (spec §4.3) and provenance defaults (§5.6), through real staging. A monthly
// re-import from the same system updates what the last one wrote, before and
// after compaction; a different system, or a value someone edited since,
// defaults to keeping what is there.
import { call, check, sql, user } from "./harness.mjs";
import { stagedImport, studentOf, waitStatus, workerSql } from "./imports-helpers.mjs";

const c = await user("imp2-dedupe");
const s = await studentOf(c, "imp2-dedupe-student");
const tag = Date.now();
const email = `lena-${tag}@test.local`;
await sql(`update public.profiles set full_name = 'Lena Ortiz', email = '${email}' where id = '${s.id}'`);
await sql(`insert into public.test_scores (student_id, exam, kind, score, taken_on) values ('${s.id}', 'SAT', 'sat', '1450', '2025-03-08')`);
await sql(`insert into public.courses (student_id, name, type, school_year) values ('${s.id}', 'AP Chemistry', 'ap', '2024-25'), ('${s.id}', 'Spanish III', 'other', null)`);
await sql(`insert into public.activities (student_id, name) values ('${s.id}', 'Robotics Club')`);

const row = (part) => ({ kind: "row", ...part });
const longPlan = (plan) => {
  const cols = plan.sheets[0].columns.filter((x) => x.target.kind === "key");
  cols.push(
    { index: 2, target: row({ table: "test_scores", group: "t", part: "exam" }), source: "counselor" },
    { index: 3, target: row({ table: "test_scores", group: "t", part: "score" }), source: "counselor" },
    { index: 4, target: row({ table: "test_scores", group: "t", part: "taken_on" }), source: "counselor" },
    { index: 5, target: row({ table: "courses", group: "c", part: "name" }), source: "counselor" },
    { index: 6, target: row({ table: "courses", group: "c", part: "school_year" }), source: "counselor" },
    { index: 7, target: row({ table: "activities", group: "a", part: "name" }), source: "counselor" }
  );
  plan.sheets[0].columns = cols;
};
const csv = [
  "Email,Name,Exam,Exam Score,Exam Date,Course Name,Year,Club",
  `${email},Lena Ortiz,SAT,1450,2025-03-08,AP Chemistry,2024-25,robotics club!`,
  `${email},Lena Ortiz,ACT,33,2025-06-07,Spanish III,2025-26,`,
  `${email},Lena Ortiz,,,,Biology,2025-26,Chess`,
].join("\n");
const { id: imp, stage } = await stagedImport(c, csv, { edit: longPlan });
check("a long-format file stages", stage.status === 200, JSON.stringify(stage.body));
const changes = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('t', target_table, 'v', new_value, 'd', decision, 'f', flags)), '[]') from public.import_changes where import_id = '${imp}' and op = 'insert_row'`));
const find = (t, k, v) => changes.find((x) => x.t === t && x.v?.[k] === v);
check("a test score already on the record is dropped and counted", !find("test_scores", "exam", "SAT") && stage.body.stats.alreadyPresent >= 2, JSON.stringify(stage.body.stats));
check("a new test score fills", find("test_scores", "exam", "ACT")?.d === "auto");
check("a course with the same name and year is already present", !find("courses", "name", "AP Chemistry"));
check("the same course name with a missing year is a possible duplicate, kept back", find("courses", "name", "Spanish III")?.d === "keep_old" && find("courses", "name", "Spanish III").f.includes("possible_duplicate"), JSON.stringify(find("courses", "name", "Spanish III")));
check("a new course fills", find("courses", "name", "Biology")?.d === "auto");
check("an activity with the same name is a possible duplicate", find("activities", "name", "robotics club!")?.d === "keep_old");
check("a new activity fills", find("activities", "name", "Chess")?.d === "auto");
await call(c.token, "DELETE", `/imports/${imp}`);

// ---- provenance -------------------------------------------------------------------------
const satPlan = (system) => (plan) => {
  plan.sourceSystem = system;
};
const satCsv = (score) => ["Email,Name,SAT", `${email},Lena Ortiz,${score}`].join("\n");
const satDecision = async (importId) =>
  sql(`select decision || '|' || coalesce(old_source, '') from public.import_changes where import_id = '${importId}' and field = 'sat_superscore'`);

// The first import from Naviance fills the empty field, and is saved.
const a = await stagedImport(c, satCsv(1400), { edit: satPlan("naviance") });
check("the first import fills", (await satDecision(a.id)) === "auto|empty");
await call(c.token, "POST", `/imports/${a.id}/commit`, { invitations: 0 });
check("it saves", (await waitStatus(c.token, a.id, "committing")).status === "committed");

const b = await stagedImport(c, satCsv(1450), { edit: satPlan("naviance") });
check("next month from the same system: accept, the value is the import's", (await satDecision(b.id)) === "accept|import");
await call(c.token, "DELETE", `/imports/${b.id}`);

const d = await stagedImport(c, satCsv(1450), { edit: satPlan("scoir") });
check("from a different system: keep what is there", (await satDecision(d.id)) === "keep_old|import");
await call(c.token, "DELETE", `/imports/${d.id}`);

// After the undo window the values are compacted; the fingerprint still answers.
await sql(`update public.roster_imports set undo_until = now() - interval '1 day' where id = '${a.id}'`);
await workerSql(`select public.compact_imports()`);
check("the first import is compacted", (await sql(`select count(*) from public.import_changes where import_id = '${a.id}' and new_value is not null`)) === "0");
const e = await stagedImport(c, satCsv(1450), { edit: satPlan("naviance") });
check("after compaction the same system still updates", (await satDecision(e.id)) === "accept|import");
await call(c.token, "DELETE", `/imports/${e.id}`);

// Someone edits the value: it is theirs now.
await sql(`update public.student_academics set sat_superscore = 1420 where student_id = '${s.id}'`);
const f = await stagedImport(c, satCsv(1450), { edit: satPlan("naviance") });
check("a value edited since the import is kept by default", (await satDecision(f.id)) === "keep_old|student");
await call(c.token, "DELETE", `/imports/${f.id}`);

// The same value as stored is no change at all (3.8 = 3.800).
await sql(`update public.student_academics set gpa_weighted = 3.8 where student_id = '${s.id}'`);
const g = await stagedImport(c, ["Email,Name,Weighted GPA", `${email},Lena Ortiz,3.80`].join("\n"));
check("a value equal to what is stored isn't a change", g.stage.body.stats?.changes === 0, JSON.stringify(g.stage.body.stats));
