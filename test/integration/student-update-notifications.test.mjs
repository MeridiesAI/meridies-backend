// Student updates (migration 20261126100001): a student's own change to their activities, college list or files
// tells their counselor with one bell notice per (student, change type) that sums up the group, its push held until
// 20 minutes after the latest change. A counselor's change tells nobody, and a group the counselor has read is closed,
// so the next change opens a new one. Real accounts on a local Supabase against a running API (see harness.mjs).
import { user, call, check, sql, SB, ANON } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("counselor-upd");
const s = await studentOf(c, "student-upd");
await sql(`update public.profiles set full_name = 'Maya Updater' where id = '${s.id}'`);
const other = await user("counselor-upd-other");

const groups = async (group) =>
  JSON.parse(
    await sql(
      `select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body, 'href', href, 'urgency', urgency,
         'held', push_after > now() + interval '19 minutes', 'read', read_at is not null) order by created_at), '[]')
       from public.notifications
       where recipient_id = '${c.id}' and student_id = '${s.id}' and kind = 'student-update' and group_key = '${group}'`
    )
  );

// ---- colleges ----------------------------------------------------------------

const added = [];
for (const name of ["Duke", "NYU", "Cornell"]) {
  const r = await call(s.token, "POST", "/application/college-list", { studentId: s.id, name });
  check(`the student adds ${name}`, r.status === 201 || r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  added.push(r.body?.id);
}
let rows = await groups("colleges");
check("three adds are one notice", rows.length === 1, JSON.stringify(rows));
check("it names the student and the schools", rows[0]?.title === "Maya added 3 colleges: Duke, NYU, Cornell", rows[0]?.title);
check("it opens the College list", rows[0]?.href === `/dashboard/counselor/students/${s.id}/college-list`, rows[0]?.href);
check("its push waits 20 minutes", rows[0]?.held === true);

let r = await call(s.token, "DELETE", `/application/college-list/${added[1]}`);
check("the student removes NYU", r.status === 200 || r.status === 204, `status ${r.status}`);
rows = await groups("colleges");
check("a removal joins the same notice", rows.length === 1 && rows[0].title === "Maya added 3 colleges and removed 1", JSON.stringify(rows));
check("the body says which", rows[0]?.body === "Added: Duke, NYU, Cornell. Removed: NYU.", rows[0]?.body);

r = await call(c.token, "POST", "/application/college-list", { studentId: s.id, name: "Counselor Pick" });
check("the counselor adds a school for the student", r.status === 201 || r.status === 200, `status ${r.status}`);
rows = await groups("colleges");
check("…and that tells nobody", rows.length === 1 && rows[0].title === "Maya added 3 colleges and removed 1", JSON.stringify(rows));

// ---- activities and awards -----------------------------------------------------

r = await call(s.token, "POST", "/activities", { name: "Debate captain" });
check("the student adds an activity", r.status === 201 || r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
r = await call(s.token, "POST", "/awards", { name: "National Merit Semifinalist" });
check("the student adds an award", r.status === 201 || r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
rows = await groups("activities");
check("an award counts as an activity, in the same notice", rows.length === 1 && rows[0].title === "Maya added 2 activities: Debate captain, National Merit Semifinalist", JSON.stringify(rows));
check("it opens the Application page", rows[0]?.href === `/dashboard/counselor/students/${s.id}/application`, rows[0]?.href);
check("colleges and activities are separate notices", (await groups("colleges")).length === 1);

r = await call(c.token, "POST", `/notifications/${rows[0].id}/read`);
check("the counselor reads it", r.status === 200 || r.status === 204, `status ${r.status}`);
r = await call(s.token, "POST", "/activities", { name: "Robotics" });
check("the student adds another activity", r.status === 201 || r.status === 200, `status ${r.status}`);
rows = await groups("activities");
check("a read group is closed: the next change is a new notice", rows.length === 2 && rows[0].read && !rows[1].read && rows[1].title === "Maya added 1 activity: Robotics", JSON.stringify(rows));

r = await call(c.token, "POST", "/activities", { studentId: s.id, name: "Counselor activity" });
check("the counselor adds an activity", r.status === 201 || r.status === 200, `status ${r.status}`);
rows = await groups("activities");
check("…and that tells nobody", rows.length === 2 && rows[1].title === "Maya added 1 activity: Robotics", JSON.stringify(rows));

// ---- files ---------------------------------------------------------------------

const path = `${s.id}/${Date.now()}-transcript.txt`;
const up = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "text/plain" },
  body: Buffer.from("Transcript. GPA 3.9."),
});
check("the student uploads a file to storage", up.ok, `status ${up.status}`);
r = await call(s.token, "POST", "/files/documents", { storagePath: path, filename: "transcript.txt", mimeType: "text/plain", sizeBytes: 20 });
check("…and files it", r.status === 201 || r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
rows = await groups("files");
check("an upload tells the counselor", rows.length === 1 && rows[0].title === "Maya uploaded 1 file: transcript.txt", JSON.stringify(rows));

// ---- who reads them ------------------------------------------------------------

r = await call(c.token, "GET", "/notifications?kind=student-update");
check(
  "the counselor's bell lists them, filtered by the new kind",
  r.status === 200 && Array.isArray(r.body) && r.body.length >= 4 && r.body.every((n) => n.kind === "student-update"),
  `status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`
);
r = await call(other.token, "GET", "/notifications?kind=student-update");
check("another counselor sees none of them", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body).slice(0, 200));
r = await call(s.token, "GET", "/notifications?kind=student-update");
check("the student sees none of them", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body).slice(0, 200));
