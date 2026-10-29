// Three small student-facing features, as real accounts on a local Supabase
// against a running API (see harness.mjs):
//   20261028000005  the strength profile can be hidden from the student, by the
//                   student and by their counselor
//   20261028000006  the resume builder: save, read, who can, and drafting
//   (no migration)  the activity alignment on Narrative Coherence
//
//   S   a counselor, Stu their student; X a counselor elsewhere
import { call, check, rest, sql, user } from "./harness.mjs";

const S = await user("sv-counselor");
const X = await user("sv-outsider");
const Stu = await user("sv-student", "student");
await sql(`update public.profiles set counselor_id = '${S.id}', full_name = 'Sam Student' where id = '${Stu.id}'`);

// ---------------------------------------------------------------------------
// Strength profile: hide and show
// ---------------------------------------------------------------------------
const overview = async () => (await call(Stu.token, "GET", "/me/overview")).body;
let o = await overview();
check("the strength profile shows by default", o.strengthProfile?.visible === true && o.strengthProfile.hiddenBy === null && o.preferences.showStrengthProfile === true, JSON.stringify(o.strengthProfile));

const hide = await call(Stu.token, "PATCH", "/me/preferences", { showStrengthProfile: false });
check("a student hides their own strength profile", hide.status === 200 && hide.body.showStrengthProfile === false, `${hide.status} ${JSON.stringify(hide.body)}`);
o = await overview();
check("the overview says the student hid it", o.strengthProfile.visible === false && o.strengthProfile.hiddenBy === "student", JSON.stringify(o.strengthProfile));
check("their own hiding doesn't block their data", (await call(Stu.token, "GET", "/me/polygon")).status === 200);

const cGet = await call(S.token, "GET", `/student-page/${Stu.id}/polygon`);
check("the counselor's polygon is untouched and says the flag is off", cGet.status === 200 && cGet.body.hiddenFromStudent === false, `${cGet.status}`);

const put = await call(S.token, "PUT", `/student-page/${Stu.id}/polygon/visibility`, { hidden: true });
check("a counselor hides it from the student", put.status === 200 && put.body.hiddenFromStudent === true, `${put.status} ${JSON.stringify(put.body)}`);
o = await overview();
check("the counselor's switch wins", o.strengthProfile.visible === false && o.strengthProfile.hiddenBy === "counselor", JSON.stringify(o.strengthProfile));
const blocked = await call(Stu.token, "GET", "/me/polygon");
check("a hidden profile's data is refused to the student", blocked.status === 403 && blocked.body.code === "polygon_hidden", `${blocked.status} ${JSON.stringify(blocked.body)}`);
check("so are its years", (await call(Stu.token, "GET", "/me/polygon/years")).status === 403);
check("and the student-page route", (await call(Stu.token, "GET", `/student-page/${Stu.id}/polygon`)).status === 403);
check("the counselor still reads it", (await call(S.token, "GET", `/student-page/${Stu.id}/polygon`)).body.hiddenFromStudent === true);

const forgeInsert = await rest(Stu.token, "POST", "/rest/v1/student_polygon_settings", { student_id: Stu.id, hidden_by_counselor: false });
const forgeUpdate = await rest(Stu.token, "PATCH", `/rest/v1/student_polygon_settings?student_id=eq.${Stu.id}`, { hidden_by_counselor: false });
const stillHidden = await sql(`select hidden_by_counselor from public.student_polygon_settings where student_id = '${Stu.id}'`);
check("a student can't undo their counselor's switch", forgeInsert.status >= 400 && stillHidden === "t", `${forgeInsert.status} ${forgeUpdate.status} ${stillHidden}`);
check("a student can't set it through the route", (await call(Stu.token, "PUT", `/student-page/${Stu.id}/polygon/visibility`, { hidden: false })).status === 403);
check("another practice can't either", [403, 404].includes((await call(X.token, "PUT", `/student-page/${Stu.id}/polygon/visibility`, { hidden: false })).status));

await call(S.token, "PUT", `/student-page/${Stu.id}/polygon/visibility`, { hidden: false });
o = await overview();
check("showing it again leaves the student's own choice", o.strengthProfile.visible === false && o.strengthProfile.hiddenBy === "student");
await call(Stu.token, "PATCH", "/me/preferences", { showStrengthProfile: true });
check("both on, it shows", (await overview()).strengthProfile.visible === true && (await call(Stu.token, "GET", "/me/polygon")).status === 200);

// ---------------------------------------------------------------------------
// Resume builder
// ---------------------------------------------------------------------------
const content = {
  header: { name: "Sam Student", contact: "sam@example.com", location: "Ithaca, NY" },
  education: [{ school: "Ithaca High School", detail: "GPA 3.9", dates: "2023-2027" }],
  activities: [{ sourceId: null, title: "Robotics Team", role: "Captain", dates: "2023-now", bullets: ["Led a team of 12 to the regional finals"] }],
  honors: [{ text: "State Science Olympiad, 2nd place" }],
  skills: ["Python", "CAD"],
};
const empty = await call(Stu.token, "GET", "/resume");
check("no resume yet reads as null", empty.status === 200 && empty.body.resume === null, `${empty.status} ${JSON.stringify(empty.body)}`);
const saved = await call(Stu.token, "PUT", "/resume", { template: "classic", content });
check("a student saves their resume", saved.status === 200 && saved.body.resume.content.skills.length === 2, `${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
const back = await call(Stu.token, "GET", "/resume");
check("and reads it back", back.body.resume?.template === "classic" && back.body.resume.content.header.name === "Sam Student");
const cRead = await call(S.token, "GET", `/resume?studentId=${Stu.id}`);
check("their counselor reads it", cRead.status === 200 && cRead.body.resume?.content.header.name === "Sam Student", `${cRead.status}`);
check("another practice can't", [403, 404].includes((await call(X.token, "GET", `/resume?studentId=${Stu.id}`)).status));
check("a counselor can't save a student's resume", (await call(S.token, "PUT", "/resume", { template: "classic", content })).status === 403);
const tooLong = await call(Stu.token, "PUT", "/resume", { template: "classic", content: { ...content, skills: ["x".repeat(80)] } });
check("an over-long line is refused", tooLong.status === 400, `${tooLong.status}`);
check("an unknown template is refused", (await call(Stu.token, "PUT", "/resume", { template: "fancy", content })).status === 400);
check("an unknown field is refused", (await call(Stu.token, "PUT", "/resume", { template: "classic", content: { ...content, secret: 1 } })).status === 400);
const forged = await rest(Stu.token, "PATCH", `/rest/v1/student_resumes?student_id=eq.${Stu.id}`, { student_id: X.id });
check("a resume can't be handed to someone else", forged.status >= 400, `${forged.status}`);
const draft = await call(Stu.token, "POST", "/resume/draft", { activityIds: ["00000000-0000-0000-0000-000000000000"] });
check("drafting answers 503 without a model key, 400 for an unknown entry, never a 500", [400, 503].includes(draft.status), `${draft.status} ${JSON.stringify(draft.body)}`);
check("a counselor can't draft a student's resume", (await call(S.token, "POST", "/resume/draft", { activityIds: ["00000000-0000-0000-0000-000000000000"] })).status === 403);
check("drafting needs at least one entry", (await call(Stu.token, "POST", "/resume/draft", { activityIds: [] })).status === 400);

// ---------------------------------------------------------------------------
// Activity alignment on Narrative Coherence
// ---------------------------------------------------------------------------
await sql(`insert into public.student_personal_details (student_id, intended_majors) values ('${Stu.id}', array['Computer Science']) on conflict (student_id) do update set intended_majors = excluded.intended_majors`);
await sql(`insert into public.activities (student_id, organization, position, category, description, hours_per_week, weeks_per_year, sort_order) values
  ('${Stu.id}', 'Cornell Bio Lab', 'Research assistant', 'Research', 'Ran assays', 10, 20, 0),
  ('${Stu.id}', 'Food Bank', 'Volunteer', 'Community Service (Volunteer)', 'Packed boxes', 2, 40, 1),
  ('${Stu.id}', 'Coding Club', 'Member', 'Computer/Technology', 'Built a mobile app', 3, 30, 2)`);
const co = await call(S.token, "GET", `/application/coherence?studentId=${Stu.id}`);
const al = co.body.alignment;
const by = Object.fromEntries((al?.buckets ?? []).map((b) => [b.id, b]));
check("coherence carries the activity alignment", co.status === 200 && al?.total === 3 && by.research?.count === 1 && by.service?.count === 1, `${co.status} ${JSON.stringify(al).slice(0, 300)}`);
check("hours come from the sheet", by.research?.hoursPerYear === 200 && by.service?.hoursPerYear === 80, JSON.stringify(by));
check("a bucket with nothing says so", by.competitions?.count === 0 && /competitions/.test(al.notes[0]), JSON.stringify(al.notes));
check("rows are tied to the declared major", al.majors[0] === "Computer Science" && al.majorLinks.some((l) => l.activity === "Coding Club"), JSON.stringify(al.majorLinks));
check("a student still can't open Coherence", (await call(Stu.token, "GET", `/application/coherence?studentId=${Stu.id}`)).status === 403);
check("another practice can't read the alignment", [403, 404].includes((await call(X.token, "GET", `/application/coherence?studentId=${Stu.id}`)).status));

console.log(process.exitCode ? "\nSome checks FAILED" : "\nAll checks passed");
