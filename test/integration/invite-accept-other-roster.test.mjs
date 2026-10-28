// A student already on one counselor's roster can't be taken by another
// counselor's invitation: accepting is refused, the student stays where they
// were, and the invitation stays pending. (The app's "Log in" path from an
// invitation, added for students who already have an account, ends in this
// same accept call.)
import { user, call, check, sql } from "./harness.mjs";

const first = await user("counselor-roster-first");
const second = await user("counselor-roster-second");
const s = await user("student-on-a-roster", "student");
await sql(`update profiles set counselor_id = '${first.id}' where id = '${s.id}'`);
const email = await sql(`select email from profiles where id = '${s.id}'`);

const token = `other-roster-${Date.now()}-abcdefgh`;
await sql(`insert into invitations (counselor_id, email, token, source) values ('${second.id}', '${email}', '${token}', 'single')`);

const preview = await call(s.token, "GET", `/invites/preview?token=${encodeURIComponent(token)}`);
check("the invitation can still be previewed", preview.status === 200, `status ${preview.status}`);

const accept = await call(s.token, "POST", "/invites/accept", { token });
check("accepting it is refused", accept.status >= 400 && accept.status < 500, `status ${accept.status} ${JSON.stringify(accept.body).slice(0, 160)}`);

const owner = await sql(`select counselor_id from profiles where id = '${s.id}'`);
check("the student stays with their counselor", owner === first.id, owner);
const status = await sql(`select status from invitations where token = '${token}'`);
check("the invitation is not marked accepted", status === "pending", status);
