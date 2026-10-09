// Import pipeline step 1, Task 10: the HTTP surface and the sweep, end to end.
import { API, CRON_SECRET, call, check, sql, user, rest } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, academics } from "./imports-helpers.mjs";

async function waitFor(token, id, done) {
  for (let i = 0; i < 60; i++) {
    const r = await call(token, "GET", `/imports/${id}`);
    if (done(r.body)) return r.body;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("timed out waiting for import " + id);
}

const c = await user("imp-api");
const s = await studentOf(c, "imp-api-student");
const imp = await makeImport(c);
const item = await addItem(imp, { studentId: s.id });
await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1420, studentId: s.id });

const other = await user("imp-api-other");
check("another counselor gets 404 for the import", (await call(other.token, "GET", `/imports/${imp}`)).status === 404);

const [first, second] = await Promise.all([
  call(c.token, "POST", `/imports/${imp}/commit`),
  call(c.token, "POST", `/imports/${imp}/commit`),
]);
const codes = [first.status, second.status].sort().join(",");
check("a double-clicked save starts one job and refuses the other", codes === "202,409", codes);
const done = await waitFor(c.token, imp, (b) => b.status !== "committing");
check("the job commits", done.status === "committed", JSON.stringify(done));
check("the value is saved", (await academics(s.id)).sat_superscore === 1420);
check("the import shows a 30-day undo window", typeof done.undoUntil === "string");

const undo = await call(c.token, "POST", `/imports/${imp}/undo`);
check("undo starts", undo.status === 202, `status ${undo.status}`);
const undone = await waitFor(c.token, imp, (b) => b.status !== "undoing");
check("undo finishes", undone.status === "undone" && undone.jobResult.reverted === 1, JSON.stringify(undone));
check("the value is reverted", (await academics(s.id)).sat_superscore === null);

// Held data with a name mismatch needs the typed name.
const tag = Date.now();
const token = `api-held-${tag}`;
const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token) values ('${c.id}', 'apiheld-${tag}@test.local', '${token}') returning id) select id from i`);
const imp2 = await makeImport(c);
const item2 = await addItem(imp2, { status: "new_invite", invitationId: inv, name: "Jane Doe" });
const ch2 = await addChange(imp2, item2, { target: "student_academics", field: "act_composite", value: 32, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp2}'`);
await sql(`select public.commit_import('${imp2}', '${c.id}')`);
const st = await user("imp-api-held-student", "student");
await sql(`update public.profiles set full_name = 'John Roe' where id = '${st.id}'`);
await rest(st.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });

const held = await call(c.token, "GET", "/imports/held");
const entry = (held.body ?? []).find((e) => e.itemId === item2);
check("the queue flags a name mismatch", entry?.nameMismatch === true, JSON.stringify(entry));
const noName = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" } });
check("applying a mismatched item without the typed name is refused", noName.status === 409 && noName.body.code === "name-confirmation-required", JSON.stringify(noName.body));
const blankName = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" }, confirmName: "   " });
check("a blank typed name is refused", blankName.status === 409, `status ${blankName.status}`);
const wrongName = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" }, confirmName: "Jane Doe" });
check("typing the imported name instead of the account's is refused", wrongName.status === 409);
const ok = await call(c.token, "POST", `/imports/held/${item2}/apply`, { decisions: { [ch2]: "accept" }, confirmName: "john roe" });
check("typing the account's name applies", ok.status === 202, `status ${ok.status} ${JSON.stringify(ok.body)}`);
for (let i = 0; i < 60 && (await sql(`select match_status from public.import_items where id = '${item2}'`)) === "applying"; i++) await new Promise((r) => setTimeout(r, 500));
check("the held value is applied", (await academics(st.id))?.act_composite === 32);

// The sweep: requires the cron secret; runs stuck jobs and records a heartbeat.
const noSecret = await fetch(`${API}/internal/imports/sweep`, { method: "POST" });
check("the sweep needs the cron secret", noSecret.status === 401, `status ${noSecret.status}`);
const s3 = await studentOf(c, "imp-api-stuck");
const imp3 = await makeImport(c);
const item3 = await addItem(imp3, { studentId: s3.id });
await addChange(imp3, item3, { target: "student_academics", field: "act_composite", value: 29, studentId: s3.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}', job_requested_at = now() - interval '5 minutes' where id = '${imp3}'`);
const sweep = await fetch(`${API}/internal/imports/sweep`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const sweepBody = await sweep.json();
check("the sweep runs", sweep.status === 200 && sweepBody.ran === true && sweepBody.jobs >= 1, JSON.stringify(sweepBody));
check("the stuck commit was finished by the sweep", (await academics(s3.id))?.act_composite === 29);
check("the sweep recorded its heartbeat", (await sql(`select (last_ok_at > now() - interval '1 minute')::text from public.job_heartbeats where job = 'import-sweep'`)) === "true");
