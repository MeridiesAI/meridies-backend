// Overview's "Building profile" cards list every student a counselor invited:
// from New student, from the onboarding invite step and from Mass invite. A
// family invitation (a parent's link) is not a student and stays off.
import { user, call, check, sql } from "./harness.mjs";

const c = await user("counselor-overview");
const tag = Date.now();
const single = await call(c.token, "POST", "/invites", { email: `single-${tag}@test.local` });
check("onboarding-style invite is recorded", single.status === 201 || single.status === 200, `status ${single.status}`);
const intake = await call(c.token, "POST", "/invites", { email: `intake-${tag}@test.local`, fullName: "New Student", source: "intake" });
check("New student invite is recorded", intake.status === 201 || intake.status === 200, `status ${intake.status} ${JSON.stringify(intake.body).slice(0, 120)}`);
const bulk = await call(c.token, "POST", "/invites/bulk", { recipients: [{ email: `mass-${tag}@test.local`, name: "Mass Student" }] });
check("Mass invite is recorded", bulk.status === 200 && bulk.body.results?.length === 1, `status ${bulk.status}`);
await sql(`insert into invitations (counselor_id, email, token, source, audience) values ('${c.id}', 'parent-${tag}@test.local', 'fam-${tag}', 'single', 'family')`);

const building = await call(c.token, "GET", "/invites/building");
const emails = (building.body ?? []).map((b) => b.email);
check("Overview shows the onboarding invite", emails.includes(`single-${tag}@test.local`), JSON.stringify(emails));
check("Overview shows the New student invite", emails.includes(`intake-${tag}@test.local`));
check("Overview shows the Mass invite", emails.includes(`mass-${tag}@test.local`));
check("Overview leaves out a family invitation", !emails.includes(`parent-${tag}@test.local`));

const other = await user("counselor-other");
const theirs = await call(other.token, "GET", "/invites/building");
check("another counselor sees none of them", !(theirs.body ?? []).some((b) => String(b.email).endsWith(`${tag}@test.local`)));
