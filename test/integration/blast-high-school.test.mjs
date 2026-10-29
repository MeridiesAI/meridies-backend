// Email blast by high school (bug hunt S2, "High school" listed colleges): the
// audience comes from each student's own high school (profiles.high_school),
// not the colleges on their list. Mail goes to the local catcher only.
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("blast-hs");
const a = await studentOf(c, "blast-hs-a");
const b = await studentOf(c, "blast-hs-b");
const z = await studentOf(c, "blast-hs-z");
await sql(`update public.profiles set high_school = 'Harbor View High School' where id in ('${a.id}', '${b.id}')`);
await sql(`update public.profiles set high_school = 'Lincoln High' where id = '${z.id}'`);
await sql(`insert into public.student_colleges (student_id, name) values ('${a.id}', 'Brown University')`).catch(() => "");

const aud = await call(c.token, "GET", "/blasts/audiences");
check("audiences list high schools from the students' own field", JSON.stringify(aud.body.highSchools) === JSON.stringify([{ value: "Harbor View High School", count: 2 }, { value: "Lincoln High", count: 1 }]), JSON.stringify(aud.body.highSchools));
check("a college on a list isn't a high school", !(aud.body.highSchools ?? []).some((h) => h.value === "Brown University"));

const prev = await call(c.token, "POST", "/blasts/preview", { audienceKind: "high-school", audienceValue: "harbor view high school" });
check("the preview reaches that school's students, case aside", prev.status === 200 && prev.body.recipients?.length === 2, JSON.stringify(prev.body));
check("labelled by the school", /Harbor View High School/.test(prev.body.label ?? ""), JSON.stringify(prev.body.label));

const empty = await call(c.token, "POST", "/blasts/preview", { audienceKind: "high-school" });
check("a high-school audience needs a school", empty.status === 400, JSON.stringify(empty.body));

const sent = await call(c.token, "POST", "/blasts", { audienceKind: "high-school", audienceValue: "Lincoln High", subject: "HS test", body: "Local test only." });
check("a blast to one high school sends to its students", sent.status === 201 || sent.status === 200, JSON.stringify(sent.body));
const kept = await sql(`select audience_label || '|' || recipient_count from public.email_blasts where subject = 'HS test' and counselor_id = '${c.id}'`);
check("the blast keeps the school in its label", /^Lincoln High \(1\)\|1$/.test(kept), kept);
