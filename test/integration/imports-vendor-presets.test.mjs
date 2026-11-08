// Import presets for a file that names College Planner Pro or Counselmore, end to
// end through the API: a CSV uploads, the plan is suggested with the tool's
// guesses marked "preset-unverified", the counselor's PUT of that plan is
// accepted as it came, and the import stages and saves. Needs IMPORTS_ROLLOUT=all
// and IMPORTS_AI=off on the API (the mapping must come from presets alone).
//
// SYNTHETIC: not a real College Planner Pro or Counselmore export. We have none.
// The headers below are guesses at how such a tool might label a column (see
// VENDOR_PRESETS in src/lib/imports/presets.ts); the test pins what the pipeline
// does with a guess, not that either tool writes these headers.
//
// Everything it creates is namespaced "imp14a" and removed at the end, pass or fail.
import { SB, call, check, sql, user } from "./harness.mjs";
import { academics, addImportFile, enc, studentOf, waitStatus } from "./imports-helpers.mjs";

const c = await user("imp14a-counselor");
const tag = Date.now();
const mail = (n) => `imp14a-${n}-${tag}@test.local`;
const parentMail = `imp14a-parent-${tag}@test.local`;

const jane = await studentOf(c, "imp14a-jane");
const rob = await studentOf(c, "imp14a-rob");
await sql(`update public.profiles set full_name = 'Jane Doe', email = '${mail("jane")}' where id = '${jane.id}'`);
await sql(`update public.profiles set full_name = 'Robert Smith', email = '${mail("rob")}' where id = '${rob.id}'`);

// Index:  0 id (vendor name)   1 email        2 name           3 class       4 school
//         5 weighted GPA       6 unweighted   7 SAT total      8 parent email 9 parent name
const HEADERS = [
  "College Planner Pro ID", "Student's Email", "Student's Name", "Graduating Class", "Highschool",
  "Cumulative GPA Weighted", "Unweighted GPA", "SAT Total Score", "Parent Email", "Parent Name",
];
const csv = [
  HEADERS.join(","),
  `cpp-1,${mail("jane")},Jane Doe,2027,Lincoln High School,4.1,3.8,1450,${parentMail},Mia Doe`,
  `cpp-2,${mail("rob")},Robert Smith,2027,Lincoln High School,3.6,3.4,1300,${parentMail},Sam Smith`,
].join("\n");

async function register(counselor, text, name) {
  const id = (await call(counselor.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
  const reg = await addImportFile(counselor, id, name, enc(text));
  if (reg.status !== 200 || reg.body.status !== "profiled") throw new Error("register failed " + JSON.stringify(reg.body));
  return id;
}

try {
  // ---- the tool is named in the headers ---------------------------------------------------
  const imp = await register(c, csv, "synthetic cpp.csv");
  const suggested = await call(c.token, "POST", `/imports/${imp}/plan`);
  check("a plan is suggested", suggested.status === 200, JSON.stringify(suggested.body).slice(0, 300));
  check("the answer is still a preset one, as the app expects", suggested.body.source === "preset", String(suggested.body.source));
  const plan = suggested.body.plan;
  check("the tool is read from the headers", plan.sourceSystem === "collegeplannerpro", String(plan.sourceSystem));
  const col = (i) => plan.sheets[0].columns.find((x) => x.index === i);
  const unverified = [1, 2, 3, 4, 5, 7];
  check("every guess from the tool's usual headers is marked preset-unverified", unverified.every((i) => col(i)?.source === "preset-unverified"), JSON.stringify(plan.sheets[0].columns.map((x) => [x.index, x.source])));
  check("the guesses map where the tool's table says", col(1)?.target.key === "email" && col(2)?.target.key === "full_name" && col(3)?.target.key === "grad_year" && col(4)?.target.key === "high_school" && col(5)?.target.field === "gpa_weighted" && col(7)?.target.field === "sat_superscore", JSON.stringify(plan.sheets[0].columns));
  check("a header the generic presets know stays a plain preset", col(6)?.source === "preset" && col(6)?.target.field === "gpa_unweighted");
  check("the tool's own id and the parent's columns are not mapped", [0, 8, 9].every((i) => col(i) === undefined), JSON.stringify(plan.sheets[0].columns.map((x) => x.index)));
  check("the stored import records the tool and the unverified marks", (await sql(`select source_system = 'collegeplannerpro' and plan::text like '%preset-unverified%' from public.roster_imports where id = '${imp}'`)) === "t");

  // The app puts back the plan it was given (every edit autosaves it).
  const put = await call(c.token, "PUT", `/imports/${imp}/plan`, { plan });
  check("the plan, marks and all, saves as it came", put.status === 200 && put.body.problems.length === 0 && put.body.plan.sheets[0].columns.filter((x) => x.source === "preset-unverified").length === unverified.length, JSON.stringify(put.body).slice(0, 300));

  // ---- it stages and saves like any other mapping -------------------------------------------
  const stage = await call(c.token, "POST", `/imports/${imp}/stage`);
  check("Match students stages", stage.status === 200 && stage.body.stats.matched === 2 && stage.body.stats.toInvite === 0, JSON.stringify(stage.body).slice(0, 300));
  const commit = await call(c.token, "POST", `/imports/${imp}/commit`);
  check("the import saves", commit.status === 202, JSON.stringify(commit.body));
  const done = await waitStatus(c.token, imp, "committing");
  check("it finishes", done.status === "committed", JSON.stringify(done).slice(0, 300));
  const ja = await academics(jane.id);
  check("Jane's guessed columns were written", Number(ja.gpa_weighted) === 4.1 && Number(ja.gpa_unweighted) === 3.8 && ja.sat_superscore === 1450, JSON.stringify(ja));
  check("Rob's too", (await academics(rob.id)).sat_superscore === 1300);
  check("the parent's address went nowhere", (await sql(`select count(*) from public.student_personal_details where contact_email = '${parentMail}'`)) === "0" && (await sql(`select count(*) from public.invitations where email = '${parentMail}'`)) === "0");

  // ---- the same headers without the tool's name: nothing is guessed --------------------------
  const plain = await register(c, csv.replace("College Planner Pro ID", "Student ID"), "synthetic plain.csv");
  const plainPlan = (await call(c.token, "POST", `/imports/${plain}/plan`)).body;
  check("no tool named, no tool read", plainPlan.plan?.sourceSystem === "unknown", String(plainPlan.plan?.sourceSystem));
  check("no tool named, nothing marked unverified", !JSON.stringify(plainPlan.plan).includes("preset-unverified"), JSON.stringify(plainPlan.plan?.sheets?.[0]?.columns).slice(0, 300));
  check("only the generic header maps", plainPlan.plan.sheets[0].columns.map((x) => x.index).join() === "6", JSON.stringify(plainPlan.plan.sheets[0].columns.map((x) => x.index)));

  // ---- Counselmore -------------------------------------------------------------------------------
  const cm = await register(c, csv.replace("College Planner Pro ID", "Counselmore ID"), "synthetic cm.csv");
  const cmPlan = (await call(c.token, "POST", `/imports/${cm}/plan`)).body.plan;
  check("counselmore is read from its name", cmPlan?.sourceSystem === "counselmore", String(cmPlan?.sourceSystem));
  check("and gets the same guesses, marked", unverified.every((i) => cmPlan.sheets[0].columns.find((x) => x.index === i)?.source === "preset-unverified"));

  // ---- a remembered layout reads as the counselor's own, not as a guess ------------------------
  const second = await register(c, csv.replace("Jane Doe,2027", "Jane Doe,2028"), "synthetic cpp 2.csv");
  const secondPlan = await call(c.token, "POST", `/imports/${second}/plan`);
  check("a second file with the same headers is guessed the same way", secondPlan.body.plan?.sheets[0].columns.filter((x) => x.source === "preset-unverified").length === unverified.length);
  const saved = await call(c.token, "PUT", `/imports/${second}/plan`, { plan: secondPlan.body.plan, saveTemplate: { name: "imp14a layout" } });
  check("the counselor can remember it", saved.status === 200 && saved.body.templateSaved === true, JSON.stringify(saved.body).slice(0, 200));
  check("the stored layout holds no unverified mark: every build can read it", (await sql(`select (parse_plan::text not like '%preset-unverified%' and parse_plan::text like '%"preset"%')::text from public.import_templates where counselor_id = '${c.id}' and name = 'imp14a layout'`)) === "true");
  const third = await register(c, csv, "synthetic cpp 3.csv");
  const thirdPlan = await call(c.token, "POST", `/imports/${third}/plan`);
  check("the remembered layout is applied as a template", thirdPlan.body.source === "template" && thirdPlan.body.plan.sheets[0].columns.every((x) => x.source === "template"), JSON.stringify(thirdPlan.body).slice(0, 300));
} finally {
  // Everything above is namespaced imp14a. Deleting an account removes its profile, imports and templates with it;
  // the uploaded files are Storage objects, so they go through the Storage API first.
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const files = (await sql(`select name from storage.objects where bucket_id = 'imports' and name like '${c.id}/%'`)).split("\n").filter(Boolean);
  for (const name of files) {
    await fetch(`${SB}/storage/v1/object/imports/${name}`, { method: "DELETE", headers: { apikey: svc, Authorization: `Bearer ${svc}` } }).catch(() => {});
  }
  for (const id of [c.id, jane.id, rob.id]) {
    await fetch(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: svc, Authorization: `Bearer ${svc}` } }).catch(() => {});
  }
}
