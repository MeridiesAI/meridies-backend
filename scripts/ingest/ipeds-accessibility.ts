/**
 * Import the percent of undergraduates formally registered with the office of disability services from an IPEDS
 * Institutional Characteristics file into college_accessibility (src/lib/ingest/ipedsAccessibility.ts has the rules
 * and the open questions about the variable's name).
 *
 *   npm run ingest:accessibility -- <ic-file.csv> --pct-var <COLUMN> [--bucket-var <COLUMN> --bucket-codes 1,2]
 *                                   [--dry-run]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env) and migration 20261127000003 applied.
 *
 * Each year: download the new IC file (https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx, "Institutional
 * Characteristics", the "Directory information and ..." / IC file for the survey year, as CSV with its data
 * dictionary), read the dictionary for the percent column and the "3 percent or less" code, run with --dry-run and
 * check the counts and a few colleges by hand, then run it again without --dry-run. It is idempotent: a second run
 * changes nothing. Check afterwards:
 *   select count(*) filter (where pct_registered_ds is not null) as exact, count(*) filter (where pct_three_or_less) as bucket
 *   from public.college_accessibility;
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { disabilityColumns, parseCsv, planRow, readRow, type ExistingRow } from "../../src/lib/ingest/ipedsAccessibility.js";

const args = process.argv.slice(2);
const usage = "Usage: npm run ingest:accessibility -- <ic-file.csv> --pct-var <COLUMN> [--bucket-var <COLUMN> --bucket-codes 1,2] [--dry-run]";
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const known = new Set(["--pct-var", "--bucket-var", "--bucket-codes", "--dry-run"]);
let file: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith("--")) {
    if (!known.has(a)) fail(`Unknown argument: ${a}\n${usage}`);
    if (a !== "--dry-run") i++;
  } else file = a;
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const pctVar = value("pct-var");
if (!file || !pctVar) fail(usage);
const dry = args.includes("--dry-run");
const bucketVar = value("bucket-var");
const bucketCodes = (value("bucket-codes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (bucketVar && bucketCodes.length === 0) fail("--bucket-var needs --bucket-codes, the code(s) that mean \"3 percent or less\" (see the data dictionary).");

const rows = parseCsv(readFileSync(file, "utf8"));
if (rows.length === 0) fail("The file has no rows.");
for (const col of [pctVar, ...(bucketVar ? [bucketVar] : []), "UNITID"]) {
  if (!(col.toUpperCase() in rows[0]!)) {
    fail(`Column ${col} is not in ${file}. Columns with DISAB in the name: ${disabilityColumns(rows).join(", ") || "(none)"}. Read the data dictionary for this year.`);
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
const db = createClient(url, key, { auth: { persistSession: false } });

async function paged<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order(table === "colleges" ? "id" : "college_id").range(from, from + 999);
    if (error) fail(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const colleges = await paged<{ id: string; unitid: number | null }>("colleges", "id, unitid");
const byUnitid = new Map(colleges.filter((c) => c.unitid != null).map((c) => [Number(c.unitid), c.id]));
const existing = new Map((await paged<NonNullable<ExistingRow>>("college_accessibility", "college_id, data_source, pct_registered_ds, pct_three_or_less")).map((r) => [r.college_id, r]));

let matched = 0, unmatched = 0, notReported = 0, inserted = 0, updated = 0, same = 0;
const inserts: Record<string, unknown>[] = [];
const updates: { collegeId: string; fields: Record<string, unknown> }[] = [];
const now = new Date();
for (const row of rows) {
  const reading = readRow(row, { pctVar: pctVar!, bucketVar, bucketCodes });
  if (!reading) {
    notReported++;
    continue;
  }
  const collegeId = byUnitid.get(reading.unitid);
  if (!collegeId) {
    unmatched++;
    continue;
  }
  matched++;
  const plan = planRow(reading, collegeId, existing.get(collegeId) as ExistingRow, now);
  if (plan.kind === "insert") inserts.push(plan.row);
  else if (plan.kind === "update") updates.push({ collegeId: plan.collegeId, fields: plan.fields });
  else same++;
}
inserted = inserts.length;
updated = updates.length;

if (!dry) {
  for (let i = 0; i < inserts.length; i += 200) {
    const { error } = await db.from("college_accessibility").upsert(inserts.slice(i, i + 200), { onConflict: "college_id", ignoreDuplicates: true });
    if (error) fail(`insert failed: ${error.message}`);
  }
  for (const u of updates) {
    const { error } = await db.from("college_accessibility").update(u.fields).eq("college_id", u.collegeId);
    if (error) fail(`update failed: ${error.message}`);
  }
}
console.log(`${dry ? "DRY RUN. " : ""}file rows ${rows.length}; with a usable figure ${matched + unmatched}; matched to a college ${matched}; not in the catalog ${unmatched}; not reported ${notReported}`);
console.log(`${dry ? "would insert" : "inserted"} ${inserted}; ${dry ? "would update" : "updated"} ${updated}; already current ${same}`);
