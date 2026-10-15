// Import pipeline step 2: retention (spec §5.10, §7.6), always on in the
// sweep. Expired drafts leave no staged values and no files; invitations
// never sent expire 14 days after the save; matching that died is returned
// to mapping; objects nobody registered go after 24 hours; and before the
// step-2 migrations the sweep still beats, skipping retention.
import { randomUUID } from "node:crypto";
import { API, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";
import { addImportFile, enc, stagedImport, studentOf, waitStatus } from "./imports-helpers.mjs";

const sweep = async () => {
  const r = await fetch(`${API}/internal/imports/sweep`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  return { status: r.status, body: await r.json() };
};
const tag = Date.now();
const mail = (n) => `${n}-${tag}@test.local`;

const c = await user("imp2-ret");
const s = await studentOf(c, "imp2-ret-student");
await sql(`update public.profiles set full_name = 'Theo Grant', email = '${mail("theo")}' where id = '${s.id}'`);
const csv = ["Email,Name,SAT", `${mail("theo")},Theo Grant,1380`, `${mail("newbie")},New Bie,1200`].join("\n");

// A review nobody saved, past its 7 days.
const old = await stagedImport(c, csv);
check("staged", old.stage.status === 200 && Number(await sql(`select count(*) from public.import_changes where import_id = '${old.id}'`)) > 0);
await sql(`update public.roster_imports set expires_at = now() - interval '1 minute' where id = '${old.id}'`);

// A saved import whose invitation was never sent, 15 days on.
const unsent = await stagedImport(c, ["Email,Name,SAT", `${mail("never")},Never Sent,1250`].join("\n"));
await call(c.token, "POST", `/imports/${unsent.id}/commit`, { invitations: 1 });
await waitStatus(c.token, unsent.id, "committing");
await sql(`update public.roster_imports set committed_at = now() - interval '15 days' where id = '${unsent.id}'`);

// Matching that died mid-way.
const stuck = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
await addImportFile(c, stuck, "s.csv", enc(csv));
await call(c.token, "POST", `/imports/${stuck}/plan`);
await sql(`update public.roster_imports set status = 'staging', job_actor = '${c.id}', job_requested_at = now() - interval '11 minutes' where id = '${stuck}'`);

// An upload nobody registered, a day old.
const draft = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const orphanPath = `${c.id}/${draft}/${randomUUID()}-orphan.csv`;
const up = await rest(c.token, "POST", `/storage/v1/object/imports/${orphanPath}`, enc("a,b\n1,2\n"), { "Content-Type": "text/csv" });
check("an unregistered upload exists", up.status === 200, JSON.stringify(up.body));
await sql(`update storage.objects set created_at = now() - interval '25 hours' where bucket_id = 'imports' and name = '${orphanPath}'`);
const freshPath = `${c.id}/${draft}/${randomUUID()}-fresh.csv`;
await rest(c.token, "POST", `/storage/v1/object/imports/${freshPath}`, enc("a,b\n1,2\n"), { "Content-Type": "text/csv" });

const r = await sweep();
check("the sweep runs retention", r.status === 200 && r.body.retention?.ran === true, JSON.stringify(r.body));
check("the old review expired", (await sql(`select status from public.roster_imports where id = '${old.id}'`)) === "expired");
check("its staged values are gone", (await sql(`select count(*) from public.import_items where import_id = '${old.id}'`)) === "0" && (await sql(`select count(*) from public.import_changes where import_id = '${old.id}'`)) === "0");
check("its file is gone", (await sql(`select count(*) from public.import_files where import_id = '${old.id}' and deleted_at is null`)) === "0" && (await sql(`select count(*) from storage.objects where bucket_id = 'imports' and name like '%/${old.id}/%'`)) === "0");
check("the never-sent invitation's data expired", (await sql(`select match_status from public.import_items where import_id = '${unsent.id}'`)) === "expired" && (await sql(`select count(*) from public.import_changes where import_id = '${unsent.id}' and state = 'staged'`)) === "0");
check("the dead matching went back to mapping, with the reason", (await sql(`select status || '|' || (job_error ->> 'message') from public.roster_imports where id = '${stuck}'`)) === "mapping|Matching didn't finish. Try again.");
check("the day-old unregistered upload is removed", (await sql(`select count(*) from storage.objects where bucket_id = 'imports' and name = '${orphanPath}'`)) === "0");
check("a fresh upload is left alone", (await sql(`select count(*) from storage.objects where bucket_id = 'imports' and name = '${freshPath}'`)) === "1");
check("the heartbeat is clean", (await sql(`select (last_ok_at > now() - interval '1 minute')::text from public.job_heartbeats where job = 'import-sweep'`)) === "true");

// Before the step-2 migrations (simulated by hiding the marker) the sweep still beats.
await sql(`alter function public.imports_step2_ready() rename to imports_step2_ready_hidden`);
try {
  const r2 = await sweep();
  check("without the step-2 migrations retention is skipped, and the sweep still runs", r2.status === 200 && r2.body.retention?.ran === false && r2.body.retention?.reason === "not-migrated", JSON.stringify(r2.body));
  check("and its heartbeat stays clean", (await sql(`select (last_ok_at > now() - interval '1 minute' and coalesce(last_error, '') = '')::text from public.job_heartbeats where job = 'import-sweep'`)) === "true");
} finally {
  await sql(`alter function public.imports_step2_ready_hidden() rename to imports_step2_ready`);
}
