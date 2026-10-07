/**
 * Load a curated dataset from a CSV the team compiled (see src/lib/ingest/curated.ts
 * for the columns of each).
 *
 *   npx tsx scripts/ingest/curated-csv.ts --dataset policies --file ./policies.csv
 *   npx tsx scripts/ingest/curated-csv.ts --dataset requirements --file ./common-app-2026-27.csv
 *   npx tsx scripts/ingest/curated-csv.ts --dataset major-admit-rates --file ./uc-fall-2025.csv
 *   ... --dry-run    check the file and report errors without writing
 *
 * Any row with an error stops the load before anything is written: a curated
 * dataset is all checked or not loaded. Schools are matched by unitid and must
 * already be in the catalog.
 */

import { readFileSync } from "node:fs";
import { mapCuratedCsv, type Dataset } from "../../src/lib/ingest/curated.js";
import { parseCsv } from "../../src/lib/ingest/ipeds.js";
import { serviceClient } from "../../src/lib/supabase.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dataset = arg("dataset") as Dataset | undefined;
const file = arg("file");
const dryRun = process.argv.includes("--dry-run");
if (!dataset || !["policies", "requirements", "major-admit-rates"].includes(dataset) || !file) {
  console.error("Usage: --dataset policies|requirements|major-admit-rates --file <csv> [--dry-run]");
  process.exit(1);
}

const { ok, errors } = mapCuratedCsv(dataset, parseCsv(readFileSync(file, "utf8")));
if (errors.length) {
  console.error(`${errors.length} problem(s); nothing written:\n${errors.slice(0, 50).join("\n")}`);
  process.exit(1);
}
const svc = serviceClient();
if (!svc) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(1);
}

const unitids = [...new Set(ok.map((o) => o.unitid))];
const ids = new Map<number, string>();
for (let i = 0; i < unitids.length; i += 500) {
  const { data, error } = await svc.from("colleges").select("id, unitid").in("unitid", unitids.slice(i, i + 500));
  if (error) throw new Error(error.message);
  for (const c of data ?? []) ids.set(Number(c.unitid), String(c.id));
}
const missing = unitids.filter((u) => !ids.has(u));
if (missing.length) {
  console.error(`Not in the catalog (run the Scorecard ingest first?): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "..." : ""}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`OK: ${ok.length} rows for ${unitids.length} schools. Dry run, nothing written.`);
  process.exit(0);
}

if (dataset === "policies") {
  // Merge field by field: a row answers only the fields it has, and keeps
  // whatever earlier rows said about the others.
  for (const o of ok) {
    const college_id = ids.get(o.unitid)!;
    const { data: current } = await svc.from("college_policies").select("sources").eq("college_id", college_id).maybeSingle();
    const { __sources, ...fields } = o.row as Record<string, unknown> & { __sources: Record<string, unknown> };
    const sources = { ...((current?.sources as Record<string, unknown>) ?? {}), ...__sources };
    const { error } = await svc
      .from("college_policies")
      .upsert({ college_id, ...fields, sources, updated_at: new Date().toISOString() }, { onConflict: "college_id" });
    if (error) throw new Error(`${o.unitid}: ${error.message}`);
  }
} else if (dataset === "requirements") {
  const rows = ok.map((o) => ({ college_id: ids.get(o.unitid)!, ...o.row }));
  const { error } = await svc.from("college_application_requirements").upsert(rows, { onConflict: "college_id,cycle" });
  if (error) throw new Error(error.message);
} else {
  // Replace a school's rows for the entry years in this file.
  const years = [...new Set(ok.map((o) => Number(o.row.entry_year)))];
  const colleges = [...new Set(ok.map((o) => ids.get(o.unitid)!))];
  const { error: delErr } = await svc.from("college_major_admit_rates").delete().in("college_id", colleges).in("entry_year", years);
  if (delErr) throw new Error(delErr.message);
  const rows = ok.map((o) => ({ college_id: ids.get(o.unitid)!, ...o.row }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await svc.from("college_major_admit_rates").insert(rows.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
}
console.log(`Loaded ${ok.length} ${dataset} rows for ${unitids.length} schools.`);
process.exit(0);
