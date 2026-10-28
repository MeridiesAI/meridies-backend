// The old roster import (Files → CSV): each invitation it sends carries the
// row's name, grade and class year, so the roster card names the student; a
// file that lists one address twice, or a student already on the roster, is
// skipped with the reason instead of cancelling or repeating an invitation.
import { user, call, check, sql, rest } from "./harness.mjs";

const c = await user("counselor-roster-import");
const tag = Date.now();
const a = `roster-a-${tag}@test.local`;
const b = `roster-b-${tag}@test.local`;

// A student already on this counselor's roster.
const joined = await user(`student-roster-joined-${tag}`, "student");
await sql(`update profiles set counselor_id = '${c.id}' where id = '${joined.id}'`);
const joinedEmail = (await sql(`select email from profiles where id = '${joined.id}'`)).trim();

const staged = await call(c.token, "POST", "/roster/imports", {
  filename: `roster-${tag}.csv`,
  source: "csv",
  mapping: { Name: "fullName", Email: "email", Grade: "gradeLevel", Class: "gradYear" },
  rows: [
    { rowNumber: 1, fullName: "Ada Lane", email: a, gradeLevel: "11", gradYear: 2028 },
    { rowNumber: 2, fullName: "Ada Lane again", email: a.toUpperCase(), gradeLevel: "11", gradYear: 2028 },
    { rowNumber: 3, fullName: "Ben Ito", email: b, gradeLevel: "12", gradYear: 2027 },
    { rowNumber: 4, fullName: "Already Here", email: joinedEmail },
  ],
});
check("the file is staged", staged.status === 201, `status ${staged.status} ${JSON.stringify(staged.body).slice(0, 200)}`);
const byRow = new Map((staged.body?.rows ?? []).map((r) => [r.rowNumber, r]));
check("the first row for an address is pending", byRow.get(1)?.status === "pending", JSON.stringify(byRow.get(1)));
check(
  "the repeated address is skipped with the row it repeats",
  byRow.get(2)?.status === "skipped" && /row 1/.test(byRow.get(2)?.skipReason ?? ""),
  JSON.stringify(byRow.get(2))
);
check(
  "a student already on the roster is skipped",
  byRow.get(4)?.status === "skipped" && /roster/i.test(byRow.get(4)?.skipReason ?? ""),
  JSON.stringify(byRow.get(4))
);
check("two rows are counted skipped", staged.body?.rowsSkipped === 2, JSON.stringify(staged.body?.rowsSkipped));

const sent = await call(c.token, "POST", `/roster/imports/${staged.body.id}/send`);
if (sent.status === 409 && sent.body?.code === "use_import") {
  // Step 2 is on for this practice (CI runs with IMPORTS_ROLLOUT=all): the old
  // send path is closed and rosters go through Import, which names its
  // invitations itself (lib/imports/invitations.ts). Nothing went out here.
  const out = await sql(`select count(*) from invitations where email in ('${a}', '${b}')`);
  check("with Import on, the old path sends nothing", out === "0", out);
  console.log("SKIP  send checks: step 2 is on, so the old roster send path is closed");
  process.exit();
}
check("the import sends", sent.status === 200, `status ${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);
check("two invitations went out", sent.body?.rowsImported === 2, JSON.stringify(sent.body));

const invites = await rest(
  c.token,
  "GET",
  `/rest/v1/invitations?email=in.(${a},${b})&status=eq.pending&select=email,full_name,grade_level,grad_year,source`
);
const ada = (invites.body ?? []).find((r) => r.email === a);
check("one live invitation per address", (invites.body ?? []).filter((r) => r.email === a).length === 1, JSON.stringify(invites.body));
check(
  "the invitation keeps the row's name, grade and class year",
  ada?.full_name === "Ada Lane" && ada?.grade_level === "11" && ada?.grad_year === 2028 && ada?.source === "roster",
  JSON.stringify(ada)
);
const revoked = await rest(c.token, "GET", `/rest/v1/invitations?email=eq.${encodeURIComponent(joinedEmail)}&select=id`);
check("nobody on the roster was invited again", Array.isArray(revoked.body) && revoked.body.length === 0, JSON.stringify(revoked.body));
