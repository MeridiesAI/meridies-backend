// Import pipeline step 1, Task 3: value checking and current values.
import { check, sql, user } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, lit } from "./imports-helpers.mjs";

const raw = (type, v) => sql(`select private.import_value_ok('${type}', ${lit(v)})`);
const ok = async (type, v) => (await raw(type, v)) === "t";

check("gpa 3.85 is valid", await ok("gpa", 3.85));
check("gpa 92 is a valid number (scale checked later)", await ok("gpa", 92));
check("gpa '3.8' as text is not valid", (await raw("gpa", "3.8")) === "f");
check("gpa 120 is not valid", (await raw("gpa", 120)) === "f");
check("sat_total 1450 is valid", await ok("sat_total", 1450));
check("sat_total 1455.5 is not valid", (await raw("sat_total", 1455.5)) === "f");
check("sat_section 900 is not valid", (await raw("sat_section", 900)) === "f");
check("act_composite 36 is valid", await ok("act_composite", 36));
check("date 2008-02-29 is valid", await ok("date", "2008-02-29"));
check("date 2007-02-29 is not valid", (await raw("date", "2007-02-29")) === "f");
check("email is checked", (await ok("email", "a@b.co")) && (await raw("email", "not-an-email")) === "f");
check("text:20 enforces length", (await ok("text:20", "4.0")) && (await raw("text:20", "x".repeat(21))) === "f");
check("enum:gender", (await ok("enum:gender", "female")) && (await raw("enum:gender", "f")) === "f");
check("text[] majors", (await ok("text[]", ["Biology", "Math"])) && (await raw("text[]", ["", "Math"])) === "f");
check("bool", (await ok("bool", true)) && (await raw("bool", "yes")) === "f");
check("row:test_score valid", await ok("row:test_score", { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" }));
check("row:test_score without a date is valid", await ok("row:test_score", { exam: "SAT", kind: "sat", score: "1450" }));
check("row:test_score with an unknown key is not valid", (await raw("row:test_score", { exam: "SAT", kind: "sat", ssn: "123-45-6789" })) === "f");
check("row:course valid", await ok("row:course", { name: "AP Chemistry", type: "ap", grade: "A-", status: "completed", school_year: "2024-25" }));
check("row:activity valid", await ok("row:activity", { name: "Robotics", position: "Captain", hours_per_week: 6, weeks_per_year: 30 }));
check("row:activity with 200 hours a week is not valid", (await raw("row:activity", { name: "Robotics", hours_per_week: 200 })) === "f");
check("enum:gender with a number is f, not null", (await raw("enum:gender", 5)) === "f");
check("row:test_score without kind is f", (await raw("row:test_score", { exam: "SAT" })) === "f");
check("row:test_score with kind 5 is f", (await raw("row:test_score", { exam: "SAT", kind: 5 })) === "f");
check("row:course with type 5 is f", (await raw("row:course", { name: "x", type: 5 })) === "f");
check("unknown type is never valid", (await raw("anything", "x")) === "f");

const h = await sql(`select private.import_value_hash('3.8'::jsonb)`);
check("hash is 64 hex chars", /^[0-9a-f]{64}$/.test(h), h);

const c = await user("imp-values");
const s = await studentOf(c);
check("current value of an empty record is null", (await sql(`select coalesce(private.import_current_value('student_academics','gpa_weighted','${s.id}')::text, 'null')`)) === "null");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s.id}', 3.8, '4.0')`);
check("current value reads the stored number", (await sql(`select private.import_current_value('student_academics','gpa_weighted','${s.id}')::text`)) === "3.800");
await sql(`insert into public.student_personal_details (student_id) values ('${s.id}')`);
check("empty majors read as null", (await sql(`select coalesce(private.import_current_value('student_personal_details','intended_majors','${s.id}')::text, 'null')`)) === "null");

// The trigger refuses a bad staged value but keeps a flagged one.
const imp = await makeImport(c);
const item = await addItem(imp, { studentId: s.id });
let refused = false;
try { await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1700, studentId: s.id }); } catch { refused = true; }
check("a staged SAT of 1700 is refused", refused);
await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, state) values ('${imp}', '${item}', 'student_academics', 'sat_superscore', 'set_field', '"1450 (superscore)"', 'skipped_invalid')`);
let refusedRow = false;
try { await addChange(imp, item, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "SAT" }, studentId: s.id }); } catch { refusedRow = true; }
check("a staged test score without a kind is refused", refusedRow);
check("a flagged cell waiting for cleanup is kept", (await sql(`select count(*) from public.import_changes where import_id = '${imp}' and state = 'skipped_invalid'`)) === "1");

// import_validate: GPA 92 on a 4.0 scale is reported; with the scale change accepted it isn't.
await addChange(imp, item, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: s.id });
let problems = JSON.parse(await sql(`select private.import_validate('${imp}', null)`));
check("GPA 92 on a 4.0 scale is reported", problems.length === 1 && /100-point/.test(problems[0].message), JSON.stringify(problems));
await addChange(imp, item, { target: "student_academics", field: "gpa_scale", value: "100", studentId: s.id });
problems = JSON.parse(await sql(`select private.import_validate('${imp}', null)`));
check("GPA 92 with the scale changed to 100 passes", problems.length === 0, JSON.stringify(problems));

await addChange(imp, item, { target: "student_personal_details", field: "birthday", value: "1975-01-01", studentId: s.id });
problems = JSON.parse(await sql(`select private.import_validate('${imp}', null)`));
check("a 1975 birthday is reported", problems.some((p) => /birthday/i.test(p.message)), JSON.stringify(problems));

// ---- Task 4: compare-and-set and inserts ------------------------------------
const s2 = await studentOf(c, "imp-apply");
const set = async (field, expected, value, target = "student_academics") =>
  (await sql(`select private.import_set_field('${target}', '${field}', '${s2.id}', ${lit(expected)}, ${lit(value)})`)) === "t";

check("filling an empty field succeeds", await set("sat_superscore", null, 1400));
check("compare-and-set with the right old value succeeds", await set("sat_superscore", 1400, 1450));
check("compare-and-set with a stale old value changes nothing", !(await set("sat_superscore", 1400, 1500)));
check("the value is the last good write", (await sql(`select sat_superscore from public.student_academics where student_id = '${s2.id}'`)) === "1450");
check("3.8 matches a stored 3.800", (await set("gpa_weighted", null, 3.8)) && (await set("gpa_weighted", 3.8, 3.9)));
check("stored gpa_weighted is 3.900", (await sql(`select gpa_weighted from public.student_academics where student_id = '${s2.id}'`)) === "3.900");
check("majors replace as an array", await set("intended_majors", null, ["Biology"], "student_personal_details"));
check("majors compare-and-set", await set("intended_majors", ["Biology"], ["Biology", "Chemistry"], "student_personal_details"));
check("majors with a stale expected value change nothing", !(await set("intended_majors", ["Physics"], ["Math"], "student_personal_details")));
check("a text field round-trips", (await set("gpa_scale", null, "4.0")) && (await set("gpa_scale", "4.0", "5.0")) &&
  (await sql(`select gpa_scale from public.student_academics where student_id = '${s2.id}'`)) === "5.0");
check("a boolean round-trips", (await set("first_gen", null, true, "student_personal_details")) &&
  (await sql(`select first_gen from public.student_personal_details where student_id = '${s2.id}'`)) === "t");
let badField = false;
try { await sql(`select private.import_set_field('student_academics', 'role', '${s2.id}', 'null'::jsonb, '"x"'::jsonb)`); } catch { badField = true; }
check("an unknown field raises", badField);
check("birthday is set as a date", (await set("birthday", null, "2008-04-01", "student_personal_details")) &&
  (await sql(`select birthday from public.student_personal_details where student_id = '${s2.id}'`)) === "2008-04-01");
check("clearing back to empty works (undo path)", (await set("sat_superscore", 1450, null)) &&
  (await sql(`select coalesce(sat_superscore::text, 'null') from public.student_academics where student_id = '${s2.id}'`)) === "null");

const row = { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" };
const rid = await sql(`select private.import_insert_row('test_scores', '${s2.id}', ${lit(row)})`);
check("a test score row is inserted", /^[0-9a-f-]{36}$/.test(rid), rid);
check("it is marked as imported", (await sql(`select source from public.test_scores where id = '${rid}'`)) === "import");
const dup = await sql(`select coalesce(private.import_insert_row('test_scores', '${s2.id}', ${lit(row)})::text, 'null')`);
check("the same exam on the same date is a duplicate", dup === "null");
const undated = await sql(`select coalesce(private.import_insert_row('test_scores', '${s2.id}', ${lit({ exam: "AP Biology", kind: "ap", score: "5" })})::text, 'null')`);
check("an undated row with the same exam and score is a duplicate", undated === "null");
const snap = JSON.parse(await sql(`select private.import_row_snapshot('test_scores', '${rid}')`));
check("snapshot carries the importable columns", snap.exam === "AP Biology" && snap.taken_on === "2025-05-10", JSON.stringify(snap));
const course = await sql(`select private.import_insert_row('courses', '${s2.id}', ${lit({ name: "AP Chemistry", type: "ap", school_year: "2024-25" })})`);
check("a course is inserted", /^[0-9a-f-]{36}$/.test(course));
const courseDup = await sql(`select coalesce(private.import_insert_row('courses', '${s2.id}', ${lit({ name: "ap chemistry", school_year: "2024-25" })})::text, 'null')`);
check("same course name and year (any case) is a duplicate", courseDup === "null");
const act = await sql(`select private.import_insert_row('activities', '${s2.id}', ${lit({ name: "Robotics", grade_levels: ["11", "12"] })})`);
check("an activity is inserted with grade levels", (await sql(`select array_to_string(grade_levels, ',') from public.activities where id = '${act}'`)) === "11,12");
check("a row is deleted by id", (await sql(`select private.import_delete_row('activities', '${act}')`)) === "t");

// ---- Task 4 fix round: exact-only dedupe, snapshot/delete of gone rows ------
const ins = (t, r) => sql(`select coalesce(private.import_insert_row('${t}', '${s2.id}', ${lit(r)})::text, 'null')`);
const isId = (v) => /^[0-9a-f-]{36}$/.test(v);
check("same exam on a different date inserts", isId(await ins("test_scores", { ...row, taken_on: "2024-05-10" })));
check("same course name, no year on either side, inserts", isId(await ins("courses", { name: "Calculus" })) && isId(await ins("courses", { name: "Calculus" })));
check("same course name, different year, inserts", isId(await ins("courses", { name: "AP Chemistry", school_year: "2025-26" })));
check("same activity name, different position, inserts", isId(await ins("activities", { name: "Debate", position: "Captain" })) && isId(await ins("activities", { name: "Debate", position: "Member" })));
const a1 = { name: "Chess", position: "Captain", organization: "School", grade_levels: ["10"] };
check("first Chess row inserts", isId(await ins("activities", a1)));
check("identical activity is a duplicate", (await ins("activities", a1)) === "null");
const gone = await sql(`select private.import_insert_row('activities', '${s2.id}', ${lit({ name: "Temp" })})`);
await sql(`select private.import_delete_row('activities', '${gone}')`);
check("snapshot of a deleted row is null", (await sql(`select coalesce(private.import_row_snapshot('activities', '${gone}')::text, 'null')`)) === "null");
check("deleting an already deleted row returns false", (await sql(`select private.import_delete_row('activities', '${gone}')`)) === "f");

// ---- Questionnaire sync (20261023010001): the targets it added -------------
check("grad_year 2027 is valid", await ok("grad_year", "2027"));
check("grad_year 27 and a number are not valid", (await raw("grad_year", "27")) === "f" && (await raw("grad_year", 2027)) === "f");
check("row:award valid", await ok("row:award", { name: "National Merit Semifinalist", level: "National", year: "2025", recognition_levels: ["national"], uc_level: "national", grade_levels: ["11"] }));
check("row:award with a bad recognition level is not valid", (await raw("row:award", { name: "X", recognition_levels: ["galactic"] })) === "f");
check("row:award with an unknown key is not valid", (await raw("row:award", { name: "X", prize_money: "100" })) === "f");
check("row:award without a name is not valid", (await raw("row:award", { year: "2025" })) === "f");
check("row:activity with timing, continuing and uc_description is valid",
  await ok("row:activity", { name: "Robotics", timing: ["school"], continuing: true, uc_description: "Built a robot." }));
check("row:activity with an unknown timing is not valid", (await raw("row:activity", { name: "Robotics", timing: ["summer"] })) === "f");
check("row:activity with continuing as text is not valid", (await raw("row:activity", { name: "Robotics", continuing: "yes" })) === "f");

const s3 = await studentOf(c, "values-profile");
await sql(`update public.profiles set high_school = '  ' where id = '${s3.id}'`);
check("a blank high school reads as empty", (await sql(`select coalesce(private.import_current_value('profiles','high_school','${s3.id}')::text, 'null')`)) === "null");
check("import_set_field fills an empty high school",
  (await sql(`select private.import_set_field('profiles','high_school','${s3.id}', null, '"Lincoln High"'::jsonb)`)) === "t" &&
  (await sql(`select high_school from public.profiles where id = '${s3.id}'`)) === "Lincoln High");
check("…and doesn't overwrite it the second time",
  (await sql(`select private.import_set_field('profiles','high_school','${s3.id}', null, '"Other High"'::jsonb)`)) === "f" &&
  (await sql(`select high_school from public.profiles where id = '${s3.id}'`)) === "Lincoln High");
check("gpa_band reads and sets with compare-and-set",
  (await sql(`select private.import_set_field('student_academics','gpa_band','${s3.id}', null, '"3.7–3.99 unweighted"'::jsonb)`)) === "t" &&
  (await sql(`select private.import_current_value('student_academics','gpa_band','${s3.id}') #>> '{}'`)) === "3.7–3.99 unweighted");

const imported = await sql(`select private.import_insert_row('awards', '${s3.id}', ${lit({ name: "Honor Roll", year: "2024" })})`);
check("the 3-argument import_insert_row still stamps source = 'import'", (await sql(`select source from public.awards where id = '${imported}'`)) === "import");
check("the same award name in another year inserts", isId(await sql(`select coalesce(private.import_insert_row('awards', '${s3.id}', ${lit({ name: "Honor Roll", year: "2025" })})::text, 'null')`)));
check("the same award name and year is a duplicate", (await sql(`select coalesce(private.import_insert_row('awards', '${s3.id}', ${lit({ name: "honor roll", year: "2024" })})::text, 'null')`)) === "null");
const fromIntake = await sql(`select private.import_insert_row('activities', '${s3.id}', ${lit({ name: "Key Club", timing: ["year"], continuing: false })}, 'intake')`);
check("the 4-argument import_insert_row stamps the source it is given",
  (await sql(`select source || ',' || array_to_string(timing, '|') || ',' || continuing::text from public.activities where id = '${fromIntake}'`)) === "intake,year,false");
const second = await sql(`select private.import_insert_row('activities', '${s3.id}', ${lit({ name: "Band" })}, 'intake')`);
check("inserted activities go to the end of the sheet",
  (await sql(`select (select sort_order from public.activities where id = '${second}') - (select sort_order from public.activities where id = '${fromIntake}')`)) === "1");
let badSource = false;
try { await sql(`select private.import_insert_row('activities', '${s3.id}', ${lit({ name: "Chess" })}, 'manual')`); } catch { badSource = true; }
check("any other source is refused", badSource);
check("an award snapshot carries its columns", JSON.parse(await sql(`select private.import_row_snapshot('awards', '${imported}')`)).year === "2024");
check("an award row is deleted by id", (await sql(`select private.import_delete_row('awards', '${imported}')`)) === "t");
