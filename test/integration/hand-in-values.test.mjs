// Hand-in values (20261108000005, AxIS security PR B; spec section 4): the values AxIS copies off a handed-in file
// are a list on the check, unverified until a counselor who can edit the student confirms them. Confirm writes each
// one to the profile only where the profile still holds what the card showed, under the info card's rules.
// Checks are seeded the way the review records them; no model is called.
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const one = (q) => sql(q).then((o) => o.split("\n")[0]);
const c = await user("hiv-c");
const outsider = await user("hiv-outsider");

const unverified = (key, label, printed) => ({ key, label, printed, confirmedAt: null, confirmedBy: null, confirmedByName: null });
const VALUES = [
  unverified("weightedGpa", "Weighted GPA", "4.05"),
  unverified("unweightedGpa", "Unweighted GPA", "3.8"),
  unverified("classRank", "Class rank", "31 of 388"),
  unverified("testScore", "Test score", "SAT 1450"),
];

async function handIn(tag, values = VALUES, academics = null) {
  const s = await studentOf(c, tag);
  if (academics) await sql(`insert into public.student_academics (student_id, ${Object.keys(academics).join(", ")}) values ('${s.id}', ${Object.values(academics).map((v) => (typeof v === "string" ? `'${v}'` : v)).join(", ")})`);
  const task = await call(c.token, "POST", "/tasks", { studentId: s.id, title: "Transcript", dueDate: "2026-12-01" });
  const checkId = await one(`insert into public.deliverable_tracker_checks (student_id, deliverable_id, verdict, note, findings, documents_checked, source, extracted_values)
                             values ('${s.id}', '${task.body.id}', 'on-track', 'Official transcript.', '["All pages present"]', 1, 'ai', '${JSON.stringify(values)}'::jsonb) returning id`);
  return { s, taskId: task.body.id, checkId };
}
const confirm = (token, h, values) => call(token, "POST", `/tasks/${h.taskId}/checks/${h.checkId}/values/confirm`, { values });
const stored = async (h) => JSON.parse(await one(`select extracted_values::text from public.deliverable_tracker_checks where id = '${h.checkId}'`));
const profile = (h) => one(`select coalesce(gpa_weighted::float8::text, '-') || '|' || coalesce(gpa_unweighted::float8::text, '-') || '|' || coalesce(class_rank, '-') || '|' || coalesce(sat_superscore::text, '-') || '|' || coalesce(act_composite::text, '-') from public.student_academics where student_id = '${h.s.id}'`);
const tracker = async (h) => (await call(c.token, "GET", `/tasks/${h.taskId}/tracker`)).body?.find?.((x) => x.id === h.checkId);

// The card's read: each value with the profile's value now.
{
  const h = await handIn("hiv-read", VALUES, { gpa_weighted: 3.9, sat_superscore: 1400 });
  const read = await tracker(h);
  const current = Object.fromEntries((read?.values ?? []).map((v) => [v.key, v.current]));
  check("the card reads each value unverified, with the profile's value now", read?.values?.length === 4 && read.values.every((v) => v.confirmedAt === null) && current.weightedGpa === 3.9 && current.testScore === 1400 && current.classRank === null,
    JSON.stringify(read?.values ?? null).slice(0, 300));
  check("and findings keep only AxIS's observations", JSON.stringify(read?.findings) === '["All pages present"]', JSON.stringify(read?.findings));
}

// Who may confirm.
{
  const h = await handIn("hiv-who");
  const body = [{ key: "weightedGpa", printed: "4.05", profileWas: null }];
  const student = await confirm(h.s.token, h, body);
  check("a student can't confirm values", student.status === 403, `${student.status} ${JSON.stringify(student.body)}`);
  const other = await confirm(outsider.token, h, body);
  check("a counselor who can't edit the student can't confirm", (other.status === 403 || other.status === 404) && (await stored(h)).every((v) => v.confirmedAt === null), `${other.status} ${JSON.stringify(other.body)}`);
}

// Confirm writes the profile and marks what it saved.
{
  const h = await handIn("hiv-confirm");
  const r = await confirm(c.token, h, [
    { key: "weightedGpa", printed: "4.05", profileWas: null },
    { key: "classRank", printed: "31 of 388", profileWas: null },
    { key: "testScore", printed: "SAT 1450", profileWas: null },
  ]);
  const values = await stored(h);
  const marked = values.filter((v) => v.confirmedAt).map((v) => v.key).sort();
  const by = values.find((v) => v.key === "weightedGpa");
  check("confirm adds the values to the profile and marks them",
    r.status === 200 && JSON.stringify([...(r.body?.saved ?? [])].sort()) === JSON.stringify(["classRank", "testScore", "weightedGpa"]) && (await profile(h)) === "4.05|-|31 of 388|1450|-" &&
      JSON.stringify(marked) === JSON.stringify(["classRank", "testScore", "weightedGpa"]) && by?.confirmedBy === c.id && typeof by?.confirmedByName === "string",
    `${r.status} ${JSON.stringify(r.body).slice(0, 300)} profile=${await profile(h)}`);
  check("a value not confirmed stays unverified", values.find((v) => v.key === "unweightedGpa")?.confirmedAt === null);
}

// A profile edit made after the card appeared wins.
{
  const h = await handIn("hiv-race", VALUES, { gpa_weighted: 3.9 });
  const seen = (await tracker(h))?.values?.find((v) => v.key === "weightedGpa")?.current;
  await call(c.token, "PATCH", `/student-page/${h.s.id}/info`, { gpaWeighted: 4.0 });
  const r = await confirm(c.token, h, [{ key: "weightedGpa", printed: "4.05", profileWas: seen }]);
  const kept = r.body?.kept ?? [];
  check("a profile edit after the card appears survives Confirm",
    r.status === 200 && seen === 3.9 && kept.length === 1 && kept[0].key === "weightedGpa" && Number(kept[0].current) === 4 && (r.body?.saved ?? []).length === 0 &&
      Number((await profile(h)).split("|")[0]) === 4 && (await stored(h)).find((v) => v.key === "weightedGpa")?.confirmedAt === null,
    `${r.status} ${JSON.stringify(r.body).slice(0, 300)} profile=${await profile(h)}`);
}

// What Confirm refuses.
{
  const h = await handIn("hiv-printed");
  const r = await confirm(c.token, h, [{ key: "weightedGpa", printed: "4.5", profileWas: null }]);
  check("a printed value that isn't the stored one is refused", r.status === 409 && String(r.body?.error).includes("This hand-in changed. Reload to see it.") &&
    (await profile(h)) === "" && (await stored(h)).every((v) => v.confirmedAt === null), `${r.status} ${JSON.stringify(r.body)}`);

  const scaled = await handIn("hiv-scale", [unverified("unweightedGpa", "Unweighted GPA", "4.6")], { gpa_scale: "4.0" });
  const over = await confirm(c.token, scaled, [{ key: "unweightedGpa", printed: "4.6", profileWas: null }]);
  check("a GPA over the student's scale is refused and nothing is marked", over.status === 400 && String(over.body?.error).includes("at most 4 on a 4.0 scale") &&
    (await profile(scaled)) === "-|-|-|-|-" && (await stored(scaled)).every((v) => v.confirmedAt === null), `${over.status} ${JSON.stringify(over.body)}`);

  const dupe = await confirm(c.token, h, [{ key: "weightedGpa", printed: "4.05", profileWas: null }, { key: "weightedGpa", printed: "4.05", profileWas: null }]);
  check("a key named twice is refused", dupe.status === 400, `${dupe.status}`);
}

// A value the profile can't take is confirmed, not saved.
{
  const h = await handIn("hiv-unreadable", [unverified("testScore", "Test score", "AP Biology 5")]);
  const r = await confirm(c.token, h, [{ key: "testScore", printed: "AP Biology 5", profileWas: null }]);
  check("a value the profile can't take is confirmed without being saved", r.status === 200 && (r.body?.saved ?? []).length === 0 && (r.body?.kept ?? []).length === 0 &&
    (await stored(h))[0].confirmedAt !== null && (await profile(h)) === "", `${r.status} ${JSON.stringify(r.body)} profile=${await profile(h)}`);
}

// Accepted only completes the task: a planted GPA changes nothing on the record.
{
  const { recordReview } = await import("../../src/lib/submissionReview.ts");
  const { cleanReview } = await import("../../src/lib/submissionReview.ts");
  const { serviceClient } = await import("../../src/lib/supabase.ts");
  const s = await studentOf(c, "hiv-planted");
  await sql(`insert into public.student_academics (student_id, gpa_weighted) values ('${s.id}', 3.2)`);
  const task = (await call(c.token, "POST", "/tasks", { studentId: s.id, title: "Transcript", dueDate: "2026-12-01" })).body;
  const before = await one(`select (select coalesce(gpa_weighted::text, '-') || '|' || coalesce(sat_superscore::text, '-') from public.student_academics where student_id = '${s.id}') || '|' || (select count(*) from public.test_scores where student_id = '${s.id}')`);
  await recordReview(serviceClient(), { ...task, id: task.id, student_id: s.id, status: "review" }, null, cleanReview({
    verdict: "accepted", note: "Transcript.", findings: [], weightedGpa: "4.99", unweightedGpa: null, classRank: null, testScores: ["SAT 1600"],
  }));
  const after = await one(`select (select coalesce(gpa_weighted::text, '-') || '|' || coalesce(sat_superscore::text, '-') from public.student_academics where student_id = '${s.id}') || '|' || (select count(*) from public.test_scores where student_id = '${s.id}')`);
  const status = await one(`select status from public.deliverables where id = '${task.id}'`);
  const values = JSON.parse(await one(`select extracted_values::text from public.deliverable_tracker_checks where deliverable_id = '${task.id}' order by checked_at desc limit 1`));
  check("an accepted hand-in with a planted GPA leaves the record unchanged", before === after && status === "complete" && values.length === 2 && values.every((v) => v.confirmedAt === null),
    `${before} -> ${after} status=${status} ${JSON.stringify(values)}`);
}

// The column isn't the client's to write.
{
  const h = await handIn("hiv-grant");
  const { rest } = await import("./harness.mjs");
  const forged = await rest(c.token, "PATCH", `/rest/v1/deliverable_tracker_checks?id=eq.${h.checkId}`, { extracted_values: [] });
  check("a client can't write the values column", forged.status === 401 || forged.status === 403, `${forged.status} ${JSON.stringify(forged.body)}`);
}
