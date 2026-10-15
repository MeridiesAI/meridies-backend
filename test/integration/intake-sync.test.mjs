// The onboarding questionnaire fills the record (20261023010001-02): every
// mapped field and sheet, fill-only-empty, updates only to its own unchanged
// values, the trigger's scope, the save never failing, intake_fills RLS, the
// read RPC, and what the counselor's info card and sheets show.
import { call, check, rest, sql, user } from "./harness.mjs";
import { q, studentOf } from "./imports-helpers.mjs";

const c = await user("intake-c");
const tag = Date.now();

async function freshStudent(t = "intake-s") {
  return studentOf(c, t);
}
async function save(s, answers, extra = {}) {
  return call(s.token, "PATCH", "/auth/me", { onboardingComplete: true, ...extra, profile: { intakeAnswers: answers } });
}
async function acad(id) {
  const raw = await sql(`select row_to_json(a) from public.student_academics a where student_id = '${id}'`);
  return raw ? JSON.parse(raw) : {};
}
async function details(id) {
  const raw = await sql(`select row_to_json(d) from public.student_personal_details d where student_id = '${id}'`);
  return raw ? JSON.parse(raw) : {};
}
async function rows(table, id, cols) {
  return JSON.parse(await sql(`select coalesce(json_agg(t order by t.sort_order, t.created_at), '[]') from (select ${cols}, sort_order, created_at from public.${table} where student_id = '${id}') t`));
}
async function lastEvent(id) {
  const raw = await sql(`select metadata from public.progress_events where student_id = '${id}' and entity_type = 'intake' order by created_at desc limit 1`);
  return raw ? JSON.parse(raw).questionnaire : null;
}
const eventCount = async (id) => Number(await sql(`select count(*) from public.progress_events where student_id = '${id}' and entity_type = 'intake'`));

// ---- GPA ---------------------------------------------------------------------
{
  const s = await freshStudent();
  const r = await save(s, { gpaType: "unweighted", gpaBandUnweighted: "3.7-3.99", gpaExact: "3.86" });
  check("the save answers 200", r.status === 200, `status ${r.status}`);
  const a = await acad(s.id);
  check("an unweighted exact GPA fills gpa_unweighted on the 4.0 scale", a.gpa_unweighted === 3.86 && a.gpa_scale === "4.0", JSON.stringify(a));
  check("the range is stored as text that names its type", a.gpa_band === "3.7–3.99 unweighted", a.gpa_band);
  check("nothing lands in gpa_weighted", a.gpa_weighted === null);

  // A corrected answer updates the questionnaire's own value...
  await save(s, { gpaType: "unweighted", gpaBandUnweighted: "3.7-3.99", gpaExact: "3.9" });
  check("a re-saved GPA updates the questionnaire's own unchanged value", (await acad(s.id)).gpa_unweighted === 3.9);
  // ...until someone else edits it.
  await sql(`update public.student_academics set gpa_unweighted = 3.95 where student_id = '${s.id}'`);
  await save(s, { gpaType: "unweighted", gpaBandUnweighted: "3.7-3.99", gpaExact: "3.7" });
  check("a GPA the counselor edited is never overwritten", (await acad(s.id)).gpa_unweighted === 3.95);
  const report = JSON.parse(await sql(`select private.sync_intake_answers('${s.id}', '{"gpaType":"unweighted","gpaExact":"3.7"}'::jsonb, null, 'save')`));
  check("…and the run says why", report.skipped.some((x) => x.field === "student_academics.gpa_unweighted" && x.reason === "edited_since"), JSON.stringify(report));
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "weighted", gpaBandWeighted: "4.2-4.49", gpaScale: "5", gpaExact: "4.3" });
  const a = await acad(s.id);
  check("a weighted GPA on a 5.0 scale keeps its scale", a.gpa_weighted === 4.3 && a.gpa_scale === "5.0", JSON.stringify(a));
  check("the weighted range names its scale", a.gpa_band === "4.2–4.49 weighted (5.0 scale)", a.gpa_band);
  // Switching to a 100-point GPA moves the scale and the figure together.
  await save(s, { gpaType: "weighted", gpaBandWeighted: "4.2-4.49", gpaScale: "100", gpaExact: "92" });
  const b = await acad(s.id);
  check("switching to the 100-point scale moves scale and GPA together", b.gpa_weighted === 92 && b.gpa_scale === "100", JSON.stringify(b));
  check("a 4-to-5-point range is not written on a 100-point scale", b.gpa_band === null, b.gpa_band);
  // And back to unweighted: the old weighted figure (still the questionnaire's) goes.
  await save(s, { gpaType: "unweighted", gpaBandWeighted: "4.5+", gpaScale: "100", gpaExact: "3.8" });
  const d = await acad(s.id);
  check("switching type clears the questionnaire's stale column", d.gpa_weighted === null && d.gpa_unweighted === 3.8 && d.gpa_scale === "4.0", JSON.stringify(d));
  check("a stale weighted range after switching to unweighted is ignored", d.gpa_band === null, d.gpa_band);
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "weighted", gpaScale: "100", gpaExact: "92" });
  const a = await acad(s.id);
  check("a 100-point GPA is stored with scale 100", a.gpa_weighted === 92 && a.gpa_scale === "100", JSON.stringify(a));
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "weighted", gpaBandWeighted: "4.5+", gpaScale: "other", gpaExact: "4.6" });
  const a = await acad(s.id);
  check("a GPA on 'something else' fills nothing", !a.gpa_weighted && !a.gpa_scale && !a.gpa_band, JSON.stringify(a));
  // Nothing changed, so there is no event; the scale_unknown skip is in the run's report only.
  check("…and writes no activity row", (await eventCount(s.id)) === 0);
  const report = JSON.parse(await sql(`select private.sync_intake_answers('${s.id}', '{"gpaType":"weighted","gpaScale":"other","gpaExact":"4.6","firstGen":"yes"}'::jsonb, null, 'save')`));
  check("the run reports scale_unknown", report.skipped.some((x) => x.field === "student_academics.gpa_scale" && x.reason === "scale_unknown"), JSON.stringify(report));
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "unweighted", gpaBandUnweighted: "below-2.5" });
  const a = await acad(s.id);
  check("a range alone fills only the band", a.gpa_band === "Below 2.5 unweighted" && a.gpa_unweighted === null && a.gpa_scale === null, JSON.stringify(a));
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "weighted", gpaBandWeighted: "4.5+", gpaScale: "6" });
  check("'4.5+' on a 6.0 scale reads well", (await acad(s.id)).gpa_band === "4.5+ weighted (6.0 scale)");
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "unweighted", gpaExact: "4.5" });
  check("an unweighted GPA above 4 is out of range and fills nothing", (await acad(s.id)).gpa_unweighted == null);
}
{
  const s = await freshStudent();
  await sql(`insert into public.student_academics (student_id, gpa_scale) values ('${s.id}', '4.0')`);
  await save(s, { gpaType: "weighted", gpaScale: "5", gpaExact: "4.3" });
  const a = await acad(s.id);
  check("a GPA on 5.0 is not written under the counselor's 4.0 scale", a.gpa_weighted === null && a.gpa_scale === "4.0", JSON.stringify(a));
  await save(s, { gpaType: "unweighted", gpaExact: "3.7" });
  const b = await acad(s.id);
  check("an unweighted GPA fills under the counselor's matching 4.0 scale", b.gpa_unweighted === 3.7 && b.gpa_scale === "4.0", JSON.stringify(b));
}
{
  const s = await freshStudent();
  await sql(`insert into public.student_academics (student_id, gpa_weighted) values ('${s.id}', 4.1)`);
  await save(s, { gpaType: "unweighted", gpaExact: "3.8" });
  const a = await acad(s.id);
  check("a counselor's GPA with no scale is never re-scaled by the student's", a.gpa_unweighted === null && a.gpa_scale === null && a.gpa_weighted === 4.1, JSON.stringify(a));
}
{
  const s = await freshStudent();
  await save(s, { gpaType: "unweighted", gpaExact: "3.6" });
  await sql(`update public.student_academics set gpa_unweighted = null where student_id = '${s.id}'`);
  await save(s, { gpaType: "unweighted", gpaExact: "3.65" });
  check("a GPA the counselor cleared stays cleared", (await acad(s.id)).gpa_unweighted === null);
}

// ---- Class rank ----------------------------------------------------------------
{
  const s = await freshStudent();
  await save(s, { classRank: "exact", classRankValue: "12 of 480" });
  const a = await acad(s.id);
  check("an exact rank fills class_rank and class_rank_value", a.class_rank === "12 of 480" && a.class_rank_value === "12 of 480", JSON.stringify(a));
  await save(s, { classRank: "top-10" });
  const b = await acad(s.id);
  check("top-10 replaces the questionnaire's own rank as 'Top 10%'", b.class_rank === "Top 10%" && b.class_rank_value === null, JSON.stringify(b));
  await save(s, { classRank: "none" });
  check("'doesn't rank' reads 'Not ranked'", (await acad(s.id)).class_rank === "Not ranked");
  await save(s, { classRank: "unknown" });
  check("'not sure' leaves no rank", (await acad(s.id)).class_rank === null);
}
{
  const s = await freshStudent();
  await sql(`insert into public.student_academics (student_id, class_rank) values ('${s.id}', '5 of 300')`);
  await save(s, { classRank: "exact", classRankValue: "12 of 480" });
  const a = await acad(s.id);
  check("an existing rank is untouched and its value isn't filled beside it", a.class_rank === "5 of 300" && a.class_rank_value === null, JSON.stringify(a));
}

// ---- Testing ---------------------------------------------------------------------
for (const [answers, want] of [
  [{ testStatus: "sat" }, "taken"], [{ testStatus: "act" }, "taken"], [{ testStatus: "both" }, "taken"],
  [{ testStatus: "optional" }, "test-optional"], [{ testStatus: "notyet", testPrepStatus: "course" }, "prepping"],
  [{ testStatus: "notyet", testPrepStatus: "notstarted" }, "not-started"],
]) {
  const s = await freshStudent();
  await save(s, answers);
  check(`test status ${JSON.stringify(answers)} reads ${want}`, (await acad(s.id)).test_status === want);
}
{
  const s = await freshStudent();
  await save(s, { testStatus: "sat", satEbrw: "720", satMath: "760", satSuperscore: "1500" });
  const a = await acad(s.id);
  check("SAT sections and superscore fill", a.sat_ebrw === 720 && a.sat_math === 760 && a.sat_superscore === 1500, JSON.stringify(a));
}
{
  const s = await freshStudent();
  await save(s, { testStatus: "both", satEbrw: "700", satMath: "750", actComposite: "33" });
  const a = await acad(s.id);
  check("two SAT sections and no total: the total is their sum", a.sat_superscore === 1450, JSON.stringify(a));
  check("an ACT composite fills", a.act_composite === 33);
}
{
  const s = await freshStudent();
  await sql(`insert into public.student_academics (student_id, sat_superscore) values ('${s.id}', 1390)`);
  await save(s, { testStatus: "sat", satEbrw: "700", satMath: "750" });
  const a = await acad(s.id);
  check("with the counselor's superscore on file, no SAT section is filled", a.sat_ebrw === null && a.sat_math === null && a.sat_superscore === 1390, JSON.stringify(a));
}
{
  const s = await freshStudent();
  await save(s, { testStatus: "act", satMath: "760", actComposite: "40" });
  const a = await acad(s.id);
  check("a stale SAT answer behind an ACT-only status is ignored", a.sat_math === null);
  check("an ACT of 40 is refused", a.act_composite === null);
}

// ---- AP / IB scores and advanced courses ---------------------------------------------
{
  const s = await freshStudent();
  await sql(`insert into public.test_scores (student_id, exam, kind, score) values ('${s.id}', 'AP Chemistry', 'ap', '4')`);
  const answers = {
    rigorCount: "3-5",
    apScores: [{ exam: "AP Biology", score: "5" }, { exam: "IB Biology HL", score: "5" }, { exam: "AP World History", score: "pending" },
               { exam: "AP Chemistry", score: "5" }, { exam: "", score: "3" }],
    advancedCourses: [{ name: "Calculus III", type: "de", grade: "12", status: "inprogress" }, { name: "AP Biology", type: "ap", grade: "11", status: "completed" }],
  };
  await save(s, answers);
  const ts = await rows("test_scores", s.id, "exam, kind, score, source");
  const ib = ts.find((t) => t.exam === "IB Biology HL");
  check("AP scores land as intake rows of kind ap", ts.some((t) => t.exam === "AP Biology" && t.kind === "ap" && t.score === "5" && t.source === "intake"), JSON.stringify(ts));
  check("an IB exam's 5 / 7 option reads as IB 7", ib?.kind === "ib" && ib?.score === "7", JSON.stringify(ib));
  check("an awaited score has no score", ts.some((t) => t.exam === "AP World History" && t.score === null));
  check("the counselor's row for the same exam is not duplicated", ts.filter((t) => t.exam === "AP Chemistry").length === 1);
  const cs = await rows("courses", s.id, "name, type, status, grade, source");
  check("dual enrollment maps to dual-enrollment and in progress to in-progress",
    cs.some((x) => x.name === "Calculus III" && x.type === "dual-enrollment" && x.status === "in-progress" && x.source === "intake"), JSON.stringify(cs));
  check("the grade level is not copied into the mark column", cs.every((x) => x.grade === null));
  await save(s, { ...answers, gradYear: "2028" });
  check("a re-save adds no rows", (await rows("test_scores", s.id, "exam")).length === 4 && (await rows("courses", s.id, "name")).length === 2);
  await save(s, { ...answers, rigorCount: "0" });
  const after = await rows("test_scores", s.id, "exam, source");
  check("'none' takes back the questionnaire's own unchanged rows and keeps the counselor's",
    after.length === 1 && after[0].exam === "AP Chemistry" && after[0].source === "manual", JSON.stringify(after));
}
{
  const s = await freshStudent();
  await save(s, { rigorCount: "0", apScores: [{ exam: "AP Biology", score: "5" }] });
  check("rigorCount 0 adds no scores", (await rows("test_scores", s.id, "exam")).length === 0);
}

// ---- High school, hometown, class year ---------------------------------------------------
{
  const school = `Intake Test High ${tag}`;
  const hsId = await sql(`with h as (insert into public.high_schools (name) values ('${q(school)}') returning id) select id from h`);
  const s = await freshStudent();
  await sql(`update public.profiles set high_school = '', grad_year = null where id = '${s.id}'`);
  await save(s, { highSchool: school.toLowerCase(), location: "Austin, TX", gradYear: "2028" });
  const p = JSON.parse(await sql(`select row_to_json(x) from (select high_school, high_school_id, hometown, grad_year from public.profiles where id = '${s.id}') x`));
  check("a blank high school counts as empty and fills", p.high_school === school.toLowerCase(), JSON.stringify(p));
  check("a unique catalog match links the school", p.high_school_id === hsId);
  check("hometown and class year fill when empty", p.hometown === "Austin, TX" && p.grad_year === "2028");
}
{
  const s = await freshStudent();
  await sql(`update public.profiles set high_school = 'Counselor High', grad_year = '2027', hometown = 'Ithaca, NY' where id = '${s.id}'`);
  await save(s, { highSchool: "Student High", gradYear: "2029", location: "Austin, TX" });
  const p = JSON.parse(await sql(`select row_to_json(x) from (select high_school, hometown, grad_year from public.profiles where id = '${s.id}') x`));
  check("existing high school, hometown and class year are untouched",
    p.high_school === "Counselor High" && p.grad_year === "2027" && p.hometown === "Ithaca, NY", JSON.stringify(p));
}

// ---- Activities --------------------------------------------------------------------------
{
  const s = await freshStudent();
  const acts = [
    { category: "Work (Paid)", gradeLevels: ["11", "pg", "9"], timing: "year", hoursPerWeek: "10", weeksPerYear: "40", continuing: "yes", position: "Cashier", organization: "Grocery Co", description: "Ran the register.", ucDescription: "UC version." },
    { category: "", gradeLevels: [], timing: "", hoursPerWeek: "", weeksPerYear: "", continuing: "", position: "", organization: "", description: "" },
    { category: "internship", position: "Lab intern", continuing: "no" },
    { category: "Robotics", organization: "X".repeat(140), position: "Builder" },
  ];
  await save(s, { activities: acts, awardCount: "0", applyingUC: "yes" });
  let list = await rows("activities", s.id, "id, name, organization, position, category, grade_levels, timing, continuing, hours_per_week, weeks_per_year, description, uc_description, source");
  check("three activities land (the blank row is skipped)", list.length === 3, JSON.stringify(list.map((x) => x.name)));
  check("they are intake rows in the questionnaire's order", list.every((x) => x.source === "intake") && list.map((x) => x.sort_order).join(",") === "0,1,2");
  const work = list[0];
  check("'Work (Paid)' reads as the sheet's 'Work (paid)'", work.category === "Work (paid)");
  check("grade levels map pg to PG, in order", work.grade_levels.join(",") === "9,11,PG", work.grade_levels.join(","));
  check("timing and continuing carry over", work.timing.join(",") === "year" && work.continuing === true && work.hours_per_week === 10 && work.weeks_per_year === 40);
  check("the UC description needs a UC applicant (and applyingUC is asked only with an award)", work.uc_description === null);
  check("without an organization the position names the row", list[1].name === "Lab intern" && list[1].organization === null);
  check("a type the sheet doesn't list becomes 'Other Club/Activity'", list[1].category === "Other Club/Activity");
  check("a long organization is cut to the sheet's 100 characters, not dropped", list[2].organization.length === 100);

  await save(s, { activities: acts, awardCount: "0", locationX: "x" });
  check("a re-save adds nothing", (await rows("activities", s.id, "id")).length === 3);

  // The student fixes a description: the unchanged row updates in place.
  const edited = acts.map((x, i) => (i === 0 ? { ...x, description: "Ran the register and trained new staff." } : x));
  await save(s, { activities: edited, awardCount: "0" });
  list = await rows("activities", s.id, "id, description");
  check("a corrected description updates the questionnaire's unchanged row", list[0].id === work.id && list[0].description === "Ran the register and trained new staff.");

  // The counselor edits a row: it is theirs now.
  await sql(`update public.activities set description = 'Counselor wording' where id = '${work.id}'`);
  await save(s, { activities: acts, awardCount: "0" });
  check("a row the counselor edited is never overwritten", (await sql(`select description from public.activities where id = '${work.id}'`)) === "Counselor wording");

  // The counselor deletes a row: it never comes back.
  await sql(`delete from public.activities where id = '${list[1].id}'`);
  await save(s, { activities: acts, awardCount: "0", gradYear: "2030" });
  check("a deleted questionnaire row doesn't come back", (await rows("activities", s.id, "id")).length === 2);

  // The student drops an activity from the questionnaire: the unchanged row goes, the edited one stays.
  await save(s, { activities: [acts[3]], awardCount: "0" });
  list = await rows("activities", s.id, "id, name");
  check("an activity removed from the answers is taken back only while unchanged",
    list.length === 2 && list.some((x) => x.id === work.id), JSON.stringify(list));
}
{
  const s = await freshStudent();
  await sql(`insert into public.activities (student_id, name, organization, sort_order) select '${s.id}', 'Row ' || g, 'Org ' || g, g from generate_series(1, 30) g`);
  await save(s, { activities: [{ category: "Art", organization: "Painting Club" }] });
  check("a full sheet (30 rows) takes no more", (await rows("activities", s.id, "id")).length === 30);
}
{
  const s = await freshStudent();
  await save(s, {
    awardCount: "2", applyingUC: "yes",
    activities: [{ category: "Debate/Speech", organization: "Debate", ucDescription: "Long UC text." }],
  });
  check("with an award and UC, the activity's UC description is copied", (await rows("activities", s.id, "uc_description"))[0]?.uc_description === "Long UC text.");
}

// ---- Honors ------------------------------------------------------------------------------
{
  const s = await freshStudent();
  await sql(`insert into public.awards (student_id, name, year) values ('${s.id}', 'AP Scholar', '2025')`);
  await save(s, {
    awardCount: "4", applyingUC: "yes",
    awards: [
      { name: "Honor Roll", level: "school", year: "2024", ucCriteria: "GPA 3.5 or higher", ucEarned: "Kept my grades up" },
      { name: "Honor Roll", level: "school", year: "2025" },
      { name: "National Merit Semifinalist", level: "national", year: "2025" },
      { name: "ap scholar", level: "national", year: "2025" },
      { name: "", level: "state", year: "" },
    ],
  });
  const list = await rows("awards", s.id, "name, year, level, recognition_levels, uc_level, uc_criteria, uc_earned, source");
  check("the same honor in two years is two rows", list.filter((x) => x.name === "Honor Roll").length === 2, JSON.stringify(list));
  check("the same honor and year already on the record is not duplicated", list.filter((x) => x.name.toLowerCase() === "ap scholar").length === 1);
  const nm = list.find((x) => x.name === "National Merit Semifinalist");
  check("the level maps to the label, the recognition level and the UC level",
    nm?.level === "National" && nm?.recognition_levels.join(",") === "national" && nm?.uc_level === "national" && nm?.source === "intake", JSON.stringify(nm));
  const hr = list.find((x) => x.name === "Honor Roll" && x.year === "2024");
  check("UC text is copied for a UC applicant", hr?.uc_criteria === "GPA 3.5 or higher" && hr?.uc_earned === "Kept my grades up");
}
{
  const s = await freshStudent();
  await save(s, { awardCount: "1", applyingUC: "no", awards: [{ name: "Science Olympiad", level: "state", year: "2025", ucCriteria: "x", ucEarned: "y" }] });
  const w = (await rows("awards", s.id, "level, recognition_levels, uc_criteria"))[0];
  check("without UC, no UC text; State / Regional maps to state-regional", w?.uc_criteria === null && w?.recognition_levels.join(",") === "state-regional" && w?.level === "State / Regional", JSON.stringify(w));
  await save(s, { awardCount: "0", awards: [{ name: "Science Olympiad", level: "state", year: "2025" }] });
  check("awardCount 0 takes the questionnaire's honor back", (await rows("awards", s.id, "name")).length === 0);
}

// ---- Background and majors -------------------------------------------------------------------
{
  const s = await freshStudent();
  await save(s, {
    firstGen: "yes", international: "yes", citizenship: "pr", currentCountry: "Canada",
    backgroundContext: "Grew up on a farm.", aidNeed: "essential", fafsaStatus: "inprogress",
    majorCertainty: "narrowed", intendedMajors: ["Biology", " biology", "Chemistry", ""],
  });
  const d = await details(s.id);
  check("first-gen yes fills first_gen", d.first_gen === true);
  check("citizenship is never copied (it is on the AI allowlist)", d.citizenship === null);
  check("intended majors fill, deduplicated", JSON.stringify(d.intended_majors) === '["Biology","Chemistry"]', JSON.stringify(d.intended_majors));
  const prof = JSON.parse(await sql(`select profile -> 'intakeAnswers' from public.profiles where id = '${s.id}'`));
  check("background answers stay only in the questionnaire answers", prof.backgroundContext === "Grew up on a farm." && prof.citizenship === "pr");
  const ev = await lastEvent(s.id);
  check("the activity row names fields only, never values",
    ev && !JSON.stringify(ev).includes("Biology") && !JSON.stringify(ev).includes("farm") && ev.fields.includes("student_personal_details.first_gen"), JSON.stringify(ev));
}
{
  const s = await freshStudent();
  await save(s, { majorCertainty: "exploring", intendedMajors: ["Biology"], firstGen: "no" });
  const d = await details(s.id);
  check("majors behind 'exploring' are ignored", (d.intended_majors ?? []).length === 0);
  check("first-gen no fills false", d.first_gen === false);
}

// ---- Never overwrite: every value the counselor entered survives a full questionnaire -------
{
  const s = await freshStudent();
  await sql(`update public.profiles set high_school = 'Counselor High', hometown = 'Ithaca, NY', grad_year = '2027' where id = '${s.id}'`);
  await sql(`insert into public.student_academics (student_id, gpa_unweighted, gpa_weighted, gpa_scale, gpa_band, class_rank, class_rank_value, test_status, sat_ebrw, sat_math, sat_superscore, act_composite)
             values ('${s.id}', 3.5, 4.0, '5.0', 'Counselor band', '10 of 100', '10 of 100', 'retaking', 650, 650, 1300, 29)`);
  await sql(`insert into public.student_personal_details (student_id, first_gen, intended_majors) values ('${s.id}', false, array['History'])`);
  const before = JSON.stringify([await acad(s.id), await details(s.id)].map((x) => ({ ...x, updated_at: null })));
  const r = await save(s, {
    highSchool: "Student High", location: "Austin, TX", gradYear: "2029",
    gpaType: "unweighted", gpaBandUnweighted: "4.0", gpaExact: "4.0", classRank: "top-1",
    testStatus: "both", satEbrw: "800", satMath: "800", actComposite: "36",
    firstGen: "yes", majorCertainty: "certain", intendedMajors: ["Physics"],
  });
  const after = JSON.stringify([await acad(s.id), await details(s.id)].map((x) => ({ ...x, updated_at: null })));
  const p = JSON.parse(await sql(`select row_to_json(x) from (select high_school, hometown, grad_year from public.profiles where id = '${s.id}') x`));
  check("a full questionnaire overwrites none of the counselor's values", r.status === 200 && before === after, after);
  check("…including the profile columns", p.high_school === "Counselor High" && p.hometown === "Ithaca, NY" && p.grad_year === "2027");
  check("no intake_fills row is written for a value it didn't write", (await sql(`select count(*) from public.intake_fills where student_id = '${s.id}'`)) === "0");
}

// ---- The save never fails ------------------------------------------------------------------------
{
  const s = await freshStudent();
  const r = await save(s, { activities: "x", gpaType: "unweighted", gpaExact: { a: 1 }, awards: [{ name: 5 }], awardCount: "1", apScores: 7, rigorCount: ["1-2"], intendedMajors: "Biology", majorCertainty: "certain", classRank: 3 });
  check("malformed answers still save", r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  check("…and onboarding is complete", (await sql(`select onboarding_complete from public.profiles where id = '${s.id}'`)) === "t");
  const r2 = await call(s.token, "PATCH", "/auth/me", { profile: { intakeAnswers: "not an object" } });
  check("answers that aren't an object still save", r2.status === 200);
  const big = await call(s.token, "PATCH", "/auth/me", { profile: { intakeAnswers: { note: "x".repeat(210_000) } } });
  check("an oversized profile is refused with 400", big.status === 400, `status ${big.status}`);
}

// ---- Trigger scope ---------------------------------------------------------------------------------
{
  const own = await user("intake-own-c");
  const r = await call(own.token, "PATCH", "/auth/me", { profile: { intakeAnswers: { highSchool: "Counselor's School", firstGen: "yes" } } });
  check("a counselor's own profile save works", r.status === 200);
  check("…and fills nothing for a counselor", (await sql(`select coalesce(high_school, 'null') from public.profiles where id = '${own.id}'`)) === "null" &&
    (await sql(`select count(*) from public.intake_fills where student_id = '${own.id}'`)) === "0");

  const s = await freshStudent();
  await save(s, { firstGen: "yes" });
  const n = await eventCount(s.id);
  await call(s.token, "PATCH", "/auth/me", { onboardingStep: 3 });
  await call(s.token, "PATCH", "/auth/me", { profile: { gradeLevel: "11th" } });
  check("a later save that doesn't change the answers doesn't run the sync", (await eventCount(s.id)) === n && n === 1, `${n}`);

  const arch = await freshStudent();
  await sql(`update public.profiles set archived_at = now() where id = '${arch.id}'`);
  await sql(`update public.profiles set profile = jsonb_build_object('intakeAnswers', '{"firstGen":"yes"}'::jsonb) where id = '${arch.id}'`);
  check("an archived student's answers fill nothing", (await sql(`select count(*) from public.student_personal_details where student_id = '${arch.id}'`)) === "0");
}

// ---- intake_fills: RLS, and the read --------------------------------------------------------------
{
  const s = await freshStudent();
  await save(s, { gpaType: "unweighted", gpaExact: "3.75", activities: [{ category: "Art", organization: "Art Club" }] });
  const mine = await rest(s.token, "GET", `/rest/v1/intake_fills?student_id=eq.${s.id}&select=field`);
  check("the student reads their own fills", Array.isArray(mine.body) && mine.body.length >= 3, JSON.stringify(mine.body));
  const theirs = await rest(c.token, "GET", `/rest/v1/intake_fills?student_id=eq.${s.id}&select=field`);
  check("their counselor reads them", Array.isArray(theirs.body) && theirs.body.length === mine.body.length);
  const stranger = await user("intake-stranger");
  const no = await rest(stranger.token, "GET", `/rest/v1/intake_fills?student_id=eq.${s.id}&select=field`);
  check("another counselor reads none", Array.isArray(no.body) && no.body.length === 0);
  const pending = await user("intake-pending", "counselor", { approved: false });
  const ps = await studentOf(pending, "intake-pending-s");
  await sql(`select private.sync_intake_answers('${ps.id}', '{"firstGen":"yes"}'::jsonb, null, 'save')`);
  const pend = await rest(pending.token, "GET", `/rest/v1/intake_fills?student_id=eq.${ps.id}&select=field`);
  check("a pending counselor reads none", Array.isArray(pend.body) && pend.body.length === 0, JSON.stringify(pend.body));
  const ins = await rest(s.token, "POST", "/rest/v1/intake_fills", { student_id: s.id, target_table: "student_academics", field: "gpa_weighted", value_hash: "0".repeat(64), run: "save" });
  check("a client can't insert a fill", ins.status >= 400, `status ${ins.status}`);
  await rest(c.token, "PATCH", `/rest/v1/intake_fills?student_id=eq.${s.id}`, { value_hash: "0".repeat(64) });
  await rest(c.token, "DELETE", `/rest/v1/intake_fills?student_id=eq.${s.id}`);
  check("a client can't change or delete fills", (await sql(`select count(*) from public.intake_fills where student_id = '${s.id}' and value_hash = '${"0".repeat(64)}'`)) === "0" &&
    Number(await sql(`select count(*) from public.intake_fills where student_id = '${s.id}'`)) === mine.body.length);
  const direct = await rest(s.token, "POST", "/rest/v1/rpc/sync_intake_answers", { p_student: s.id, p_answers: {}, p_actor: s.id, p_run: "save" });
  check("a client can't call the sync directly", direct.status >= 400, `status ${direct.status}`);

  const rpc = await rest(c.token, "POST", "/rest/v1/rpc/intake_filled_fields", { p_student: s.id });
  const gpa = (rpc.body ?? []).find((f) => f.field === "gpa_unweighted");
  check("intake_filled_fields marks the GPA as still the questionnaire's", gpa?.matchesCurrent === true, JSON.stringify(rpc.body));
  const forStranger = await rest(stranger.token, "POST", "/rest/v1/rpc/intake_filled_fields", { p_student: s.id });
  check("…and answers a stranger with nothing", Array.isArray(forStranger.body) && forStranger.body.length === 0);

  // What the counselor's screens show.
  let info = await call(c.token, "GET", `/student-page/${s.id}/info`);
  check("the info card lists the GPA as from the questionnaire", info.status === 200 && info.body.fromQuestionnaire?.includes("gpaUnweighted"), JSON.stringify(info.body.fromQuestionnaire));
  const me = await call(s.token, "GET", "/me/overview");
  check("so does the student's own overview", me.status === 200 && JSON.stringify(me.body).includes("gpaUnweighted"));
  const sheets = await call(c.token, "GET", `/application/sheets?studentId=${s.id}`);
  const art = sheets.body.activities?.find((x) => x.organization === "Art Club");
  check("the sheets carry source and fromQuestionnaire", art?.source === "intake" && art?.fromQuestionnaire === true, JSON.stringify(art));

  await call(c.token, "PATCH", `/student-page/${s.id}/info`, { gpaUnweighted: 3.8 });
  await sql(`update public.activities set description = 'Edited' where student_id = '${s.id}'`);
  const rpc2 = await rest(c.token, "POST", "/rest/v1/rpc/intake_filled_fields", { p_student: s.id });
  check("after the counselor's edit the GPA is no longer marked", (rpc2.body ?? []).find((f) => f.field === "gpa_unweighted")?.matchesCurrent === false);
  info = await call(c.token, "GET", `/student-page/${s.id}/info`);
  check("…and the info card drops it", info.status === 200 && !info.body.fromQuestionnaire.includes("gpaUnweighted") && info.body.gpaUnweighted === 3.8, JSON.stringify(info.body.fromQuestionnaire));
  const sheets2 = await call(c.token, "GET", `/application/sheets?studentId=${s.id}`);
  const art2 = sheets2.body.activities?.find((x) => x.organization === "Art Club");
  check("an edited row keeps source intake but loses fromQuestionnaire", art2?.source === "intake" && art2?.fromQuestionnaire === false, JSON.stringify(art2));
}
