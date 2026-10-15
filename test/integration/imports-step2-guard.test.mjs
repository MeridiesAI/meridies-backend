// Import pipeline step 2: the browser can't steer a new-pipeline import.
// roster_imports_update_own still lets the old roster flow move its own rows
// between its statuses, but a row start_import created (permission recorded)
// is the API's alone, and the new columns are never client-writable.
import { randomUUID } from "node:crypto";
import { check, rest, sql, user } from "./harness.mjs";

const c = await user("imp2-guard");

// The old roster flow's row: the client inserts and moves it, as before.
const legacyId = randomUUID();
const legacy = await rest(c.token, "POST", "/rest/v1/roster_imports", { id: legacyId, counselor_id: c.id, filename: "old.csv", status: "mapping" });
check("the old roster flow can still create its import", legacy.status === 201, JSON.stringify(legacy.body));
const moved = await rest(c.token, "PATCH", `/rest/v1/roster_imports?id=eq.${legacyId}`, { status: "complete" });
check("the old roster flow can still move its own status", moved.status === 204, `status ${moved.status}`);
for (const [col, val] of [["plan", { version: 1 }], ["stats", { matched: 1 }], ["invites_approved_at", new Date().toISOString()], ["invites_held_reason", "x"], ["staged_at", new Date().toISOString()]]) {
  const r = await rest(c.token, "PATCH", `/rest/v1/roster_imports?id=eq.${legacyId}`, { [col]: val });
  check(`a client write of ${col} is refused`, r.status === 403 && r.body?.code === "42501", `status ${r.status} ${JSON.stringify(r.body)}`);
}
const insertPlan = await rest(c.token, "POST", "/rest/v1/roster_imports", { counselor_id: c.id, filename: "x.csv", status: "draft", plan: { version: 1 } });
check("a client insert carrying a plan is refused", insertPlan.status === 403, `status ${insertPlan.status}`);

// A new-pipeline row (permission recorded): no client update or delete at all.
const v2 = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status, permission_confirmed_by, permission_confirmed_at, expires_at)
  values ('${c.id}', 'Import', 'csv', 'mapping', '${c.id}', now(), now() + interval '7 days') returning id) select id from i`);
for (const [label, patch] of [["status to complete", { status: "complete" }], ["status to importing", { status: "importing" }], ["filename", { filename: "renamed.csv" }], ["mapping", { mapping: { a: "email" } }], ["plan", { plan: {} }]]) {
  const r = await rest(c.token, "PATCH", `/rest/v1/roster_imports?id=eq.${v2}`, patch);
  check(`a new-pipeline import refuses a client change of ${label}`, r.status === 403 && r.body?.code === "42501", `status ${r.status}`);
}
const del = await rest(c.token, "DELETE", `/rest/v1/roster_imports?id=eq.${v2}`);
check("a new-pipeline import can't be deleted by the client", del.status === 403, `status ${del.status}`);
check("it is still there, unchanged", (await sql(`select status from public.roster_imports where id = '${v2}'`)) === "mapping");

// The ai_runs labels landed without dropping anyone else's.
const def = await sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_runs_module_check'`);
check("ai_runs accepts import-mapping and import-cleanup", def.includes("import-mapping") && def.includes("import-cleanup"));
check("ai_runs still accepts earlier labels", def.includes("events-discovery") && def.includes("submission-review"));
