// GPA within its scale (migration 20261029000002, bug hunt S2-M2): unweighted up
// to the scale, weighted up to the scale plus one, in the profile editor
// (PATCH /student-page/:id/info), the records route (PUT /academics) and the
// database (PostgREST included). The import's "Needs a fix" is unit tested.
import { call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("gpa-counselor");
const s = await studentOf(c, "gpa-student");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s.id}', 3.8, '4.0') on conflict (student_id) do update set gpa_weighted = 3.8, gpa_scale = '4.0'`);
const stored = () => sql(`select gpa_weighted from public.student_academics where student_id = '${s.id}'`);

let r = await call(c.token, "PATCH", `/student-page/${s.id}/info`, { gpaWeighted: 9.9 });
check("the profile editor refuses 9.9 weighted on a 4.0 scale", r.status === 400 && /at most 5 on a 4.0 scale/.test(r.body.error ?? ""), JSON.stringify(r.body));
check("and nothing changed", (await stored()) === "3.800", await stored());

r = await call(c.token, "PATCH", `/student-page/${s.id}/info`, { gpaWeighted: 4.6 });
check("4.6 weighted on 4.0 is accepted", r.status === 200 && (await stored()) === "4.600", JSON.stringify(r.body));

r = await call(c.token, "PATCH", `/student-page/${s.id}/info`, { gpaUnweighted: 4.1 });
check("4.1 unweighted on 4.0 is refused", r.status === 400, JSON.stringify(r.body));

r = await call(c.token, "PUT", "/academics", { studentId: s.id, gpa_weighted: 9.9 });
check("the records route refuses it too", r.status === 400, JSON.stringify(r.body));
r = await call(c.token, "PUT", "/academics", { studentId: s.id, gpa_weighted: 9.9, gpa_scale: "10" });
check("a 9.9 with a 10-point scale in the same save is fine", r.status === 200, JSON.stringify(r.body));
await sql(`update public.student_academics set gpa_weighted = 3.8, gpa_scale = '4.0' where student_id = '${s.id}'`);

const db = await rest(c.token, "PATCH", `/rest/v1/student_academics?student_id=eq.${s.id}`, { gpa_weighted: 9.9 });
check("the database refuses 9.9 on 4.0, even through PostgREST", db.status >= 400 && /gpa_within_scale/.test(JSON.stringify(db.body)), JSON.stringify(db.body));
const ok = await rest(c.token, "PATCH", `/rest/v1/student_academics?student_id=eq.${s.id}`, { gpa_weighted: 4.6 });
check("and takes 4.6", ok.status < 300, JSON.stringify(ok.body));
