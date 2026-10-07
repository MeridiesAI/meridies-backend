/**
 * Yearly IPEDS Admissions load (see AGENTS.md, "Catalog data: yearly refresh").
 *
 *   npx tsx scripts/ingest/ipeds-admissions.ts --year 2023
 *   npx tsx scripts/ingest/ipeds-admissions.ts --year 2023 --csv ./adm2023.csv
 *
 * Downloads ADM<year>.zip from NCES (or reads a CSV you downloaded) and writes
 * college_admission_factors for schools already in the catalog. Run the
 * Scorecard ingest first so the catalog has every school. Uses SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY from the environment / .env.
 */

import { readFileSync } from "node:fs";
import { serviceClient } from "../../src/lib/supabase.js";
import { IPEDS_DATA_URL, mapAdmissionRow, parseCsv, readZipEntry, writeAdmissionFactors, type AdmissionFactors } from "../../src/lib/ingest/ipeds.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const year = arg("year");
if (!year || !/^\d{4}$/.test(year)) {
  console.error("Pass --year, e.g. --year 2023 (the newest ADM file NCES has published).");
  process.exit(1);
}
const svc = serviceClient();
if (!svc) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(1);
}

let csv: string;
const local = arg("csv");
if (local) {
  csv = readFileSync(local, "utf8");
} else {
  const url = `${IPEDS_DATA_URL}/ADM${year}.zip`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    console.error(`NCES returned ${res.status} for ${url}. Has ADM${year} been published yet?`);
    process.exit(1);
  }
  const entry = readZipEntry(Buffer.from(await res.arrayBuffer()), (n) => /^adm\d{4}(_rv)?\.csv$/i.test(n));
  if (!entry) {
    console.error("The zip had no ADM CSV in it.");
    process.exit(1);
  }
  csv = entry.toString("utf8");
}

const started = Date.now();
const { data: run } = await svc.from("ingest_runs").insert({ source: "ipeds", trigger: "script" }).select("id").single();
const rows = parseCsv(csv).map(mapAdmissionRow).filter((r): r is AdmissionFactors => r !== null);
try {
  const result = await writeAdmissionFactors(svc, rows, year, new Date().toISOString());
  if (run) {
    await svc
      .from("ingest_runs")
      .update({ status: "succeeded", rows_upserted: result.upserted, rows_skipped: result.skipped, finished_at: new Date().toISOString(), duration_ms: Date.now() - started })
      .eq("id", run.id);
  }
  console.log(JSON.stringify({ year, rows: rows.length, ...result }));
} catch (err) {
  const message = err instanceof Error ? err.message : "unknown error";
  if (run) {
    await svc
      .from("ingest_runs")
      .update({ status: "failed", errors: [message], finished_at: new Date().toISOString(), duration_ms: Date.now() - started })
      .eq("id", run.id);
  }
  console.error(message);
  process.exit(1);
}
process.exit(0);
