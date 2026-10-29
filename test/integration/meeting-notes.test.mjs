// Meeting notes: who reads a note, who writes one, and which note a meeting may link.
import { check, call, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("notes-c");
const s = await studentOf(c, "notes-s");
const other = await studentOf(c, "notes-s2");
const outsider = await user("notes-out");
const outsiderStudent = await studentOf(outsider, "notes-os");

// ---- A counselor writes; a student reads only what is shared ------------------------
const priv = await call(c.token, "POST", "/notes", { studentId: s.id, title: "Private read", body: "Only me", visibility: "private" });
check("a counselor creates a private note", priv.status === 201 && priv.body.visibility === "private", `status ${priv.status} ${JSON.stringify(priv.body).slice(0, 160)}`);
check("...and the DTO carries updatedAt", typeof priv.body.updatedAt === "string" && priv.body.updatedAt.length > 0, JSON.stringify(priv.body).slice(0, 160));
const shared = await call(c.token, "POST", "/notes", { studentId: s.id, title: "Plan for fall", summary: "Visit two campuses.", body: "Details", visibility: "shared" });
check("a counselor creates a shared note", shared.status === 201 && shared.body.visibility === "shared", `status ${shared.status}`);

const mine = await call(s.token, "GET", "/notes");
const titles = Array.isArray(mine.body) ? mine.body.map((n) => n.title) : [];
check("a student sees the shared note", mine.status === 200 && titles.includes("Plan for fall"), `status ${mine.status} ${titles}`);
check("...and not the private one", !titles.includes("Private read"), titles.join(","));

const otherView = await call(other.token, "GET", "/notes");
const otherTitles = Array.isArray(otherView.body) ? otherView.body.map((n) => n.title) : [];
check("another student sees neither", otherView.status === 200 && otherTitles.length === 0, otherTitles.join(","));

// ---- Sharing is a PATCH, and the student can't write ---------------------------------
const share = await call(c.token, "PATCH", `/notes/${priv.body.id}`, { visibility: "shared" });
check("a counselor shares a note with a PATCH", share.status === 200 && share.body.visibility === "shared", `status ${share.status}`);
const after = await call(s.token, "GET", "/notes");
check("...and the student now sees it", (after.body ?? []).some((n) => n.title === "Private read"), "");
const unshare = await call(c.token, "PATCH", `/notes/${priv.body.id}`, { visibility: "private" });
check("...and unsharing hides it again", unshare.status === 200 && !((await call(s.token, "GET", "/notes")).body ?? []).some((n) => n.title === "Private read"), `status ${unshare.status}`);

const sw = await call(s.token, "POST", "/notes", { title: "Mine" });
check("a student can't write a note", sw.status === 403, `status ${sw.status}`);
const sp = await call(s.token, "PATCH", `/notes/${shared.body.id}`, { title: "Changed" });
check("a student can't edit a shared note", sp.status === 403 || sp.status === 404, `status ${sp.status}`);
const sd = await call(s.token, "DELETE", `/notes/${shared.body.id}`);
check("a student can't delete a shared note", sd.status === 403 || sd.status === 404, `status ${sd.status}`);
check("...and the note is still there", (await sql(`select count(*) from public.meeting_notes where id='${shared.body.id}'`)) === "1");

// ---- Another counselor gets nothing ----------------------------------------------------
const oc = await call(outsider.token, "GET", `/notes?studentId=${s.id}`);
check("a counselor off the caseload can't list the notes", oc.status === 403 || oc.status === 404 || (oc.status === 200 && oc.body.length === 0), `status ${oc.status}`);
const ow = await call(outsider.token, "POST", "/notes", { studentId: s.id, title: "Planted" });
check("...or write one", ow.status === 403 || ow.status === 404, `status ${ow.status}`);

// ---- A meeting links only a note about its own student ----------------------------------
const meeting = await sql(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at) values ('${s.id}', '${c.id}', 'Fall plan', now() + interval '1 day') returning id) select id from m`);
const own = await call(c.token, "PATCH", `/meetings/${meeting}`, { meetingNoteId: shared.body.id });
check("a meeting links a note about its student", own.status === 200 && own.body.meetingNoteId === shared.body.id, `status ${own.status} ${JSON.stringify(own.body).slice(0, 160)}`);

const aboutOther = await call(c.token, "POST", "/notes", { studentId: other.id, title: "About the other student" });
const wrongStudent = await call(c.token, "PATCH", `/meetings/${meeting}`, { meetingNoteId: aboutOther.body.id });
check("a note about a different student is refused", wrongStudent.status === 400, `status ${wrongStudent.status}`);

const foreign = await call(outsider.token, "POST", "/notes", { studentId: outsiderStudent.id, title: "Someone else's" });
const foreignLink = await call(c.token, "PATCH", `/meetings/${meeting}`, { meetingNoteId: foreign.body?.id ?? "00000000-0000-0000-0000-000000000000" });
check("another counselor's note is refused", foreignLink.status === 400, `status ${foreignLink.status}`);

const missing = await call(c.token, "PATCH", `/meetings/${meeting}`, { meetingNoteId: "00000000-0000-0000-0000-000000000000" });
check("a note that doesn't exist is refused", missing.status === 400, `status ${missing.status}`);

const unlink = await call(c.token, "PATCH", `/meetings/${meeting}`, { meetingNoteId: null });
check("a meeting can be unlinked", unlink.status === 200 && unlink.body.meetingNoteId === null, `status ${unlink.status}`);
