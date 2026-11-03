/**
 * Fill in campus photos and logos for every catalog school that is missing
 * one, the way "Look up info & photo" does for one school
 * (src/lib/collegeMediaLookup.ts): the school's own site for its icon, and for
 * a school with no photo, Wikimedia Commons by name, else the site's share
 * image. Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment
 * / .env, like the API. Needs 20261105000001_college_logos.sql for logos (photos
 * are still filled without it).
 *
 *   npx tsx --env-file=.env scripts/ingest/college-media.ts --dry-run        # count what's missing, write nothing
 *   npx tsx --env-file=.env scripts/ingest/college-media.ts --limit 200      # the first 200 missing, most-listed first
 *   npx tsx --env-file=.env scripts/ingest/college-media.ts --only <id,id>   # these college ids
 *   npx tsx --env-file=.env scripts/ingest/college-media.ts --retry          # also schools tried in the past week
 *
 * One school at a time, a second apart (polite to the schools' sites and to
 * Commons). A school tried in the past week is skipped unless --retry. Run the
 * monthly College photos job first: it publishes the reviewed Wikidata photos,
 * which this never replaces.
 */

import { lookUpMedia, RETRY_AFTER_MS, type MediaCollege } from "../../src/lib/collegeMediaLookup.js";
import { serviceClient } from "../../src/lib/supabase.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const limit = arg("limit") !== undefined ? Number(arg("limit")) : Infinity;
if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
  console.error("--limit takes a whole number");
  process.exit(2);
}
const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const dryRun = flag("dry-run");
const retry = flag("retry");

const svc = serviceClient();
if (!svc) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

type Row = Record<string, unknown>;

async function readAll(table: string, columns: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc!.from(table).select(columns).range(from, from + 999);
    if (error) {
      if (["42P01", "PGRST205"].includes(error.code ?? "")) return [];
      throw new Error(`${table}: ${error.code ?? "error"}`);
    }
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) return out;
  }
}

const log = {
  info: () => undefined,
  warn: (o: object, m?: string) => console.warn(m ?? "", JSON.stringify(o)),
  error: (o: object, m?: string) => console.error(m ?? "", JSON.stringify(o)),
};

const [colleges, photos, logos, listed] = await Promise.all([
  readAll("colleges", "id, name, unitid, website"),
  readAll("college_photos", "college_id"),
  readAll("college_logos", "college_id, storage_path, checked_at"),
  readAll("student_colleges", "college_id"),
]);
const hasPhoto = new Set(photos.map((r) => String(r.college_id)));
const logoById = new Map(logos.map((r) => [String(r.college_id), r]));
const listCount = new Map<string, number>();
for (const r of listed) if (r.college_id) listCount.set(String(r.college_id), (listCount.get(String(r.college_id)) ?? 0) + 1);

const now = Date.now();
const todo: MediaCollege[] = colleges
  .filter((c) => c.website && (!only || only.includes(String(c.id))))
  .filter((c) => {
    const logo = logoById.get(String(c.id));
    const missing = !hasPhoto.has(String(c.id)) || !logo?.storage_path;
    if (!missing) return false;
    if (retry || only || !logo?.checked_at) return true;
    return now - Date.parse(String(logo.checked_at)) >= RETRY_AFTER_MS;
  })
  .sort((a, b) => (listCount.get(String(b.id)) ?? 0) - (listCount.get(String(a.id)) ?? 0))
  .slice(0, limit)
  .map((c) => ({ id: String(c.id), name: String(c.name), unitid: c.unitid == null ? null : Number(c.unitid), website: String(c.website) }));

console.log(
  `${colleges.length} schools; ${colleges.length - hasPhoto.size} without a photo; ` +
    `${colleges.filter((c) => !logoById.get(String(c.id))?.storage_path).length} without a logo; ${todo.length} to look up.`
);
if (dryRun) process.exit(0);

let photosAdded = 0;
let logosAdded = 0;
for (const [i, c] of todo.entries()) {
  try {
    const o = await lookUpMedia(svc, c, log);
    if (o.photo) photosAdded += 1;
    if (o.logoUrl && !logoById.get(c.id)?.storage_path) logosAdded += 1;
    console.log(`${i + 1}/${todo.length} ${c.name}: photo ${o.photo ? "added" : hasPhoto.has(c.id) ? "had one" : "none"}, logo ${o.logoUrl ? "yes" : "none"}`);
  } catch (err) {
    console.warn(`${i + 1}/${todo.length} ${c.name}: failed (${err instanceof Error ? err.message : "error"})`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`Done: ${photosAdded} photos and ${logosAdded} logos added.`);
