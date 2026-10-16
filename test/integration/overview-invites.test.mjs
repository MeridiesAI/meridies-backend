// Overview's "Building profile" cards list every student a counselor invited:
// from New student, from the onboarding invite step and from Mass invite. A
// family invitation (a parent's link) is not a student and stays off.
import { user, call, check, sql, rest } from "./harness.mjs";

const c = await user("counselor-overview");
const tag = Date.now();
const single = await call(c.token, "POST", "/invites", { email: `single-${tag}@test.local` });
check("onboarding-style invite is recorded", single.status === 201 || single.status === 200, `status ${single.status}`);
const intake = await call(c.token, "POST", "/invites", { email: `intake-${tag}@test.local`, fullName: "New Student", source: "intake" });
check("New student invite is recorded", intake.status === 201 || intake.status === 200, `status ${intake.status} ${JSON.stringify(intake.body).slice(0, 120)}`);
const bulk = await call(c.token, "POST", "/invites/bulk", { recipients: [{ email: `mass-${tag}@test.local`, name: "Mass Student" }] });
check("Mass invite is recorded", bulk.status === 200 && bulk.body.results?.length === 1, `status ${bulk.status}`);
// New student, several at once: each row keeps its grade and time zone, and the
// shared request list lands on every invitation.
const reqs = [
  { id: "transcript", label: "Transcript", provided: false },
  { id: "resume", label: "Resume", provided: false },
];
const many = await call(c.token, "POST", "/invites/bulk", {
  recipients: [
    { email: `bulk-a-${tag}@test.local`, name: "Ada Lane", gradeLevel: "11th", gradYear: 2028, timezone: "PT · Pacific" },
    { email: `bulk-b-${tag}@test.local`, name: "Ben Ito", gradeLevel: "12th", gradYear: 2027, timezone: "ET · Eastern" },
  ],
  intakeRequests: reqs,
  sendRequests: true,
});
check("bulk with basics sends both", many.status === 200 && many.body.results?.length === 2, `status ${many.status} ${JSON.stringify(many.body).slice(0, 160)}`);
const manyRows = await rest(c.token, "GET", `/rest/v1/invitations?email=in.(bulk-a-${tag}@test.local,bulk-b-${tag}@test.local)&select=email,full_name,grade_level,grad_year,timezone,note,intake_requests,source`);
const rowA = (manyRows.body ?? []).find((r) => r.email === `bulk-a-${tag}@test.local`);
check("bulk row keeps grade, year and time zone", rowA?.grade_level === "11th" && rowA?.grad_year === 2028 && rowA?.timezone === "PT · Pacific", JSON.stringify(rowA));
check("bulk row carries the shared requests", rowA?.intake_requests?.length === 2 && rowA?.source === "mass", JSON.stringify(rowA));
check("bulk note lists what to send", String(rowA?.note ?? "").includes("transcript, resume"), JSON.stringify(rowA?.note));
const again = await call(c.token, "POST", "/invites/bulk", { recipients: [{ email: `bulk-a-${tag}@test.local`, name: "Ada Lane" }] });
check("a pending address is skipped, not resent", again.body?.skipped === 1 && again.body?.sent + again.body?.queued === 0, JSON.stringify(again.body).slice(0, 160));

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

// B5: each invitation carries its email's delivery status, read through RLS.
const invId = single.body?.id;
await sql(`insert into message_deliveries (invitation_id, recipient_kind, to_email, channel, template, status, sent_at, delivered_at, created_at)
  values ('${invId}', 'student', 'single-${tag}@test.local', 'email', 'invite', 'delivered', now(), now(), now() + interval '1 second')`);
const listed = await call(c.token, "GET", "/invites");
const row = (listed.body ?? []).find((i) => i.id === invId);
check("the invitation list reports the delivery", row?.delivery?.status === "delivered", JSON.stringify(row?.delivery));
const card = (await call(c.token, "GET", "/invites/building")).body?.find((i) => i.id === invId);
check("the Building profile card reports it too", card?.delivery?.status === "delivered");
const peek = await rest(other.token, "GET", `/rest/v1/message_deliveries?invitation_id=eq.${invId}&select=id`);
check("another counselor can't read that delivery row", Array.isArray(peek.body) && peek.body.length === 0, JSON.stringify(peek.body));
