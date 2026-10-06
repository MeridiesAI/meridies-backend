// Read-only check that the Demo v10 migrations are applied to the Supabase
// project in .env, for when they were pasted into the SQL editor and
// supabase_migrations.schema_migrations has no rows to count.
//
//   node --env-file=.env scripts/verify-v10.mjs [api-url]
//
// Checks every table the 20261005* migrations create, the FAFSA column change
// in 20261005030002, and GET /health. Prints names and statuses only, never
// keys or row data. Exits 1 on any failure.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const API_URL = (process.argv[2] ?? "https://meridies-backend-production.up.railway.app").replace(/\/+$/, "");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run with --env-file=.env).");
  process.exit(1);
}
const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

/** The tables the v10 files create, read from the files so the list can't drift. */
const tables = [
  ...new Set(
    readdirSync(MIGRATIONS)
      .filter((f) => f.startsWith("20261005") && f.endsWith(".sql"))
      .flatMap((f) =>
        [...readFileSync(join(MIGRATIONS, f), "utf8").matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map(
          (m) => m[1]
        )
      )
  ),
].sort();

let failures = 0;
function report(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

/** HTTP status of a zero-row select; 200 means the table and columns exist. */
async function selectStatus(table, columns = "*") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${columns}&limit=0`, { headers });
  return res.status;
}

console.log(`Project ${new URL(SUPABASE_URL).host.split(".")[0]}: ${tables.length} tables from 20261005* migrations\n`);

for (const table of tables) {
  const status = await selectStatus(table);
  report(status === 200, `table ${table}`, status === 200 ? "" : `HTTP ${status}`);
}

console.log("");
report((await selectStatus("student_aid_profiles", "fafsa_due_date")) === 200, "student_aid_profiles.fafsa_due_date exists");
report((await selectStatus("student_aid_profiles", "efc_estimate")) !== 200, "student_aid_profiles.efc_estimate is dropped");

console.log("");
try {
  const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  report(res.status === 200 && body.database === true, `GET ${API_URL}/health`, `HTTP ${res.status}`);
} catch (err) {
  report(false, `GET ${API_URL}/health`, err.name);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
