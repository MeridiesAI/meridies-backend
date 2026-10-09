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
