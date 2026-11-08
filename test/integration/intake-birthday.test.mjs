// The questionnaire's optional date of birth (20261111000007): copied into
// student_personal_details.birthday through the questionnaire sync, under its
// rules (fill only what is empty, update only its own unchanged value, a
// cleared value stays cleared, the save never fails), validated (a real date,
// not in the future, age 10-25), never named by value in the activity trail,
// and never in what AI sees.
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("bday-c");

async function save(s, answers) {
  return call(s.token, "PATCH", "/auth/me", { onboardingComplete: true, profile: { intakeAnswers: answers } });
}
const birthday = async (id) => {
  const v = await sql(`select coalesce(birthday::text, 'null') from public.student_personal_details where student_id = '${id}'`);
  return v === "null" || v === "" ? null : v;
};
const eventsText = async (id) =>
  await sql(`select coalesce(string_agg(metadata::text, ' '), '') from public.progress_events where student_id = '${id}' and entity_type = 'intake'`);

// Dates relative to the database's today, so the ages hold on any day.
const thisYear = Number(await sql(`select extract(year from current_date)::int`));
const dob = (age, md = "03-09") => `${thisYear - age}-${md}`;

// ---- Validation: a real calendar date, not in the future, age 10 to 25 -------------------------
{
  const today = "2026-11-08";
  const want = {
    "2008-02-29": "2008-02-29", // a leap day that exists
    "2009-02-29": null, // one that doesn't
    "2008-02-30": null,
    "2008-13-01": null,
    "2026-11-09": null, // tomorrow
    "2030-01-01": null, // the future
    "2016-11-08": "2016-11-08", // 10 today
    "2016-11-09": null, // 10 tomorrow: 9 today
    "2000-11-09": "2000-11-09", // 25, 26 tomorrow
    "2000-11-08": null, // 26 today
    "1990-01-01": null,
    "2008-3-9": null, // malformed
    "03/09/2008": null,
    "2008-03-09T00:00:00Z": null,
    "20080309": null,
    "": null,
  };
  let all = true;
  for (const [input, expected] of Object.entries(want)) {
    const got = await sql(`select coalesce(private.intake_birthday('${input}', date '${today}')::text, 'null')`);
    if (got !== (expected ?? "null")) { all = false; console.log(`  ${JSON.stringify(input)} -> ${got}`); }
  }
  check("only a real, past date of someone aged 10 to 25 is a birthday", all);
  check("a null answer is no birthday", (await sql(`select coalesce(private.intake_birthday(null, date '2026-11-08')::text, 'null')`)) === "null");
}

// ---- Filled from the questionnaire, marked on the info card ------------------------------------------
{
  const s = await studentOf(c, "bday-s");
  const d = dob(16);
  const r = await save(s, { birthday: ` ${d} `, firstGen: "yes" });
  check("the save answers 200", r.status === 200, `status ${r.status}`);
  check("an answered birthday (whitespace trimmed) fills student_personal_details.birthday", (await birthday(s.id)) === d, await birthday(s.id));
  const info = await call(c.token, "GET", `/student-page/${s.id}/info`);
  check("the counselor's info card shows it, marked as from the questionnaire",
    info.status === 200 && info.body.birthday === d && info.body.fromQuestionnaire?.includes("birthday"), JSON.stringify(info.body.fromQuestionnaire));

  const ev = await eventsText(s.id);
  check("the activity trail names the field", ev.includes("student_personal_details.birthday"), ev);
  check("…and never the value", !ev.includes(d) && !ev.includes(d.replaceAll("-", "/")), ev);

  // AI never sees it, whatever feature asks.
  let leaked = false;
  for (const feature of ["chat", "student-ai", "narrative-coherence", "college-list", "activities"]) {
    const ctx = await call(c.token, "GET", `/students/${s.id}/ai-context?feature=${feature}`);
    if (ctx.status !== 200) { leaked = true; console.log(`  ai-context ${feature}: ${ctx.status}`); continue; }
    if (JSON.stringify(ctx.body).includes(d)) { leaked = true; console.log(`  ai-context ${feature} carries the birthday`); }
  }
  check("no AI context pack for the student carries the birthday", !leaked);

  // A corrected answer updates the questionnaire's own unchanged value.
  const d2 = dob(17, "04-10");
  await save(s, { birthday: d2, firstGen: "yes" });
  check("a re-saved birthday updates the questionnaire's own value", (await birthday(s.id)) === d2, await birthday(s.id));

  // An invalid answer is skipped: the save still works and the value on file stays.
  const r2 = await save(s, { birthday: `${thisYear - 15}-02-30`, firstGen: "no" });
  check("an invalid birthday still saves", r2.status === 200, `status ${r2.status}`);
  check("…leaves the birthday on file alone", (await birthday(s.id)) === d2, await birthday(s.id));
  check("…and the rest of the answers still copy", (await sql(`select first_gen from public.student_personal_details where student_id = '${s.id}'`)) === "f");
  const report = JSON.parse(await sql(`select private.sync_intake_answers('${s.id}', '{"birthday":"2999-01-01"}'::jsonb, null, 'save')`));
  check("the run reports a future birthday as invalid, by field name",
    report.skipped.some((x) => x.field === "student_personal_details.birthday" && x.reason === "invalid") && !JSON.stringify(report).includes("2999"),
    JSON.stringify(report));

  // The answer taken out: the questionnaire takes back its own value.
  await save(s, { firstGen: "no" });
  check("a birthday answer removed takes back the questionnaire's own value", (await birthday(s.id)) === null, await birthday(s.id));
}

// ---- Never overwrite the counselor -----------------------------------------------------------------------
{
  const s = await studentOf(c, "bday-s2");
  const theirs = dob(17, "01-15");
  await sql(`insert into public.student_personal_details (student_id, birthday) values ('${s.id}', '${theirs}')`);
  await save(s, { birthday: dob(16) });
  check("a birthday the counselor entered first is never overwritten", (await birthday(s.id)) === theirs, await birthday(s.id));
  check("…and no fill is recorded for it", (await sql(`select count(*) from public.intake_fills where student_id = '${s.id}' and field = 'birthday'`)) === "0");
}
{
  const s = await studentOf(c, "bday-s3");
  await save(s, { birthday: dob(16) });
  const edited = dob(16, "05-20");
  const p = await call(c.token, "PATCH", `/student-page/${s.id}/info`, { birthday: edited });
  check("the counselor corrects it on the info card", p.status === 200 && (await birthday(s.id)) === edited, `status ${p.status}`);
  await save(s, { birthday: dob(17) });
  check("a counselor-edited birthday is never overwritten by a re-save", (await birthday(s.id)) === edited, await birthday(s.id));
  const info = await call(c.token, "GET", `/student-page/${s.id}/info`);
  check("…and loses the questionnaire mark", info.status === 200 && !info.body.fromQuestionnaire.includes("birthday"), JSON.stringify(info.body.fromQuestionnaire));
}
{
  const s = await studentOf(c, "bday-s4");
  await save(s, { birthday: dob(16) });
  const p = await call(c.token, "PATCH", `/student-page/${s.id}/info`, { birthday: null });
  check("the counselor clears it", p.status === 200 && (await birthday(s.id)) === null, `status ${p.status}`);
  await save(s, { birthday: dob(17) });
  check("a cleared birthday stays cleared", (await birthday(s.id)) === null, await birthday(s.id));
}
