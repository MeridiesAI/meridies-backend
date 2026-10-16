// The wizard's Connect step: a student finds the invitation sent to their own
// address and accepts it, without ever seeing the emailed token. Skipping the
// Profile step puts "Fill out your profile" on their To-Do, and the counselor's
// Building profile card says where they stand.
import { user, call, check, sql } from "./harness.mjs";

const c = await user("counselor-myinv");
const other = await user("counselor-myinv-other");
const s = await user("student-myinv", "student");
const stranger = await user("student-myinv-stranger", "student");

const invite = await call(c.token, "POST", "/invites", {
  email: s.email,
  source: "intake",
  fullName: "Sam Ortiz",
  gradeLevel: "11th",
  intakeRequests: [{ id: "resume", label: "Resume" }],
});
check("counselor invites the student", invite.status === 201, `status ${invite.status}`);
const inviteId = invite.body.id;

const mine = await call(s.token, "GET", "/me/invitations");
check("the student sees the invitation sent to their address", mine.status === 200 && mine.body.invitations?.some((i) => i.id === inviteId), JSON.stringify(mine.body).slice(0, 200));
check("it names the counselor and never carries the token", mine.body.invitations?.[0]?.counselorName && !JSON.stringify(mine.body).includes("token"), JSON.stringify(mine.body).slice(0, 200));
const theirs = await call(stranger.token, "GET", "/me/invitations");
check("another student's address sees none", theirs.status === 200 && theirs.body.invitations?.length === 0);
const counselorCall = await call(c.token, "GET", "/me/invitations");
check("a counselor can't use it", counselorCall.status === 403, `status ${counselorCall.status}`);

const wrong = await call(stranger.token, "POST", `/me/invitations/${inviteId}/accept`);
check("someone else can't accept it", wrong.status === 404, `status ${wrong.status}`);

// Skipped profile: shows on the To-Do and on the counselor's card.
const before = await call(c.token, "GET", "/invites/building");
check("the card says not started before they join", before.body.find?.((b) => b.id === inviteId)?.profileStatus === null);
const skip = await call(s.token, "PATCH", "/auth/me", { profile: { profileSkipped: true } });
check("student skips the Profile step", skip.status === 200, `status ${skip.status}`);
const todoBefore = await call(s.token, "GET", "/me/setup");
check("Fill out your profile is on the To-Do at once", todoBefore.body.steps?.some((x) => x.key === "profile"), JSON.stringify(todoBefore.body));

const accept = await call(s.token, "POST", `/me/invitations/${inviteId}/accept`);
check("student accepts", accept.status === 200 && accept.body.counselorId === c.id, `status ${accept.status} ${JSON.stringify(accept.body).slice(0, 200)}`);
const status = await sql(`select status from invitations where id='${inviteId}'`);
check("the invitation is accepted on the counselor's side too", status === "accepted", status);
const after = await call(s.token, "GET", "/me/invitations");
check("a connected student has none left", after.body.invitations?.length === 0);

let building = await call(c.token, "GET", "/invites/building");
check("the card says Skipped", building.body.find?.((b) => b.id === inviteId)?.profileStatus === "skipped", JSON.stringify(building.body.find?.((b) => b.id === inviteId)?.profileStatus));

const done = await call(s.token, "PATCH", "/auth/me", { profile: { intakeAnswers: { gpa: "3.8" } } });
check("student fills the profile later", done.status === 200);
const todoAfter = await call(s.token, "GET", "/me/setup");
check("the To-Do item clears itself", !todoAfter.body.steps?.some((x) => x.key === "profile"), JSON.stringify(todoAfter.body));
building = await call(c.token, "GET", "/invites/building");
check("the card says Completed", building.body.find?.((b) => b.id === inviteId)?.profileStatus === "completed");

const notMine = await call(other.token, "GET", "/invites/building");
check("another counselor's card list has none of it", !(notMine.body ?? []).some?.((b) => b.id === inviteId));
