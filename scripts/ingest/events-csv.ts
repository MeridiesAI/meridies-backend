/**
 * Load Events Hub listings from a CSV a curator compiled (columns in
 * src/lib/ingest/events.ts). Rows become Meridies-wide `hub_events` (no author,
 * no firm), seen by every approved counselor.
 *
 *   npx tsx --env-file=.env scripts/ingest/events-csv.ts --file ./events-2026-fall.csv
 *   ... --dry-run    check the file (and the colleges it names) without writing
 *
 * Any row with an error stops the load before anything is written. Re-running
 * the same file changes nothing: a listing is matched on (name, host,
 * start_date), trimmed and ignoring case, among Meridies-wide rows only, and
 * updated in place; anything new is inserted. Rows that are not in the file are
 * left alone (nothing is deleted). Needs SUPABASE_SERVICE_ROLE_KEY.
 */

import { readFileSync } from "node:fs";
import { eventKey, mapEventsCsv, type EventRow } from "../../src/lib/ingest/events.js";
import { parseCsv } from "../../src/lib/ingest/ipeds.js";
import { serviceClient } from "../../src/lib/supabase.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const file = arg("file");
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("Usage: --file <csv> [--dry-run]");
  process.exit(1);
}

const { ok, errors } = mapEventsCsv(parseCsv(readFileSync(file, "utf8")));
if (errors.length) {
  console.error(`${errors.length} problem(s); nothing written:\n${errors.slice(0, 50).join("\n")}`);
  process.exit(1);
}
const svc = serviceClient();
if (!svc) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(1);
}

// Colleges named by unitid must already be in the catalog.
const unitids = [...new Set(ok.map((o) => o.collegeUnitid).filter((u): u is number => u !== null))];
const collegeIds = new Map<number, string>();
for (let i = 0; i < unitids.length; i += 500) {
  const { data, error } = await svc.from("colleges").select("id, unitid").in("unitid", unitids.slice(i, i + 500));
  if (error) throw new Error(error.message);
  for (const c of data ?? []) collegeIds.set(Number(c.unitid), String(c.id));
}
const missing = ok.filter((o) => o.collegeUnitid !== null && !collegeIds.has(o.collegeUnitid));
if (missing.length) {
  console.error(
    `college_unitid not in the catalog; nothing written:\n${missing
      .slice(0, 50)
      .map((o) => `line ${o.line}: ${o.collegeUnitid}`)
      .join("\n")}`
  );
  process.exit(1);
}

// Existing Meridies-wide listings on the file's dates, by natural key.
const dates = [...new Set(ok.map((o) => o.row.start_date))];
const existing = new Map<string, string>();
for (let i = 0; i < dates.length; i += 200) {
  const { data, error } = await svc
    .from("hub_events")
    .select("id, name, host, start_date")
    .is("created_by", null)
    .is("firm_id", null)
    .in("start_date", dates.slice(i, i + 200));
  if (error) throw new Error(error.message);
  for (const r of data ?? []) {
    const key = eventKey(String(r.name), String(r.host), String(r.start_date));
    if (existing.has(key)) {
      console.error(`Two Meridies-wide listings already share a key (${r.name}, ${r.start_date}); fix by hand first.`);
      process.exit(1);
    }
    existing.set(key, String(r.id));
  }
}

type Payload = EventRow & { college_id: string | null };
const toInsert: Payload[] = [];
const toUpdate: { id: string; row: Payload }[] = [];
for (const o of ok) {
  const row: Payload = { ...o.row, college_id: o.collegeUnitid !== null ? collegeIds.get(o.collegeUnitid)! : null };
  const id = existing.get(o.key);
  if (id) toUpdate.push({ id, row });
  else toInsert.push(row);
}

if (dryRun) {
  console.log(`OK: ${ok.length} rows (${toInsert.length} new, ${toUpdate.length} to update). Dry run, nothing written.`);
  process.exit(0);
}

for (let i = 0; i < toInsert.length; i += 500) {
  const batch = toInsert.slice(i, i + 500).map((r) => ({ ...r, created_by: null, firm_id: null }));
  const { error } = await svc.from("hub_events").insert(batch);
  if (error) throw new Error(`insert: ${error.message}`);
}
for (const u of toUpdate) {
  const { error } = await svc
    .from("hub_events")
    .update(u.row)
    .eq("id", u.id)
    .is("created_by", null)
    .is("firm_id", null);
  if (error) throw new Error(`update ${u.row.name} (${u.row.start_date}): ${error.message}`);
}
console.log(`Loaded ${ok.length} events: ${toInsert.length} inserted, ${toUpdate.length} updated.`);
process.exit(0);
