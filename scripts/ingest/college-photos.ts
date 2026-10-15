/**
 * Campus photos for the catalog, from Wikimedia Commons through Wikidata
 * (src/lib/ingest/collegePhotos.ts has the rules). Uses SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY from the environment / .env, like the API.
 *
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts                 # every college, under the job's lease
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts --limit 50      # a trial run
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts --only 166683,243744
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts --dry-run       # writes nothing; prints a CSV of what it would attach
 *   npx tsx scripts/ingest/college-photos.ts --fixture-dir test/fixtures/college-photos [--picks <csv>]
 *                                                                           # recorded answers, no network (tests, offline dev)
 *
 * Look the new photos over: run with --dry-run, open each title's Commons
 * page from the CSV (https://commons.wikimedia.org/wiki/<title>), and put any
 * wrong building, aerial blur or close-up of people in
 * scripts/ingest/data/college-photo-picks.csv, either as a better
 * `File:...` title or as `none` to suppress the college. The next run applies it.
 *
 * Run it once by hand right after applying 20261023070001_college_photos.sql:
 * /internal/status reads the job overdue until its first clean run.
 *
 * A dry run and a fixture run don't take the lease and don't mark the job
 * healthy; a dry run writes no ingest_runs row.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  csvCell,
  loadPicks,
  runCollegePhotoIngest,
  supabasePhotoStore,
  type PhotoDeps,
  type PhotoOutcome,
} from "../../src/lib/ingest/collegePhotos.js";
import { startCollegePhotoIngest } from "../../src/lib/ingest/run.js";
import { isAllowedDownloadUrl, isJpeg, wikimediaClient } from "../../src/lib/ingest/wikimedia.js";
import { serviceClient } from "../../src/lib/supabase.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const limit = arg("limit") !== undefined ? Number(arg("limit")) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
  console.error("--limit takes a whole number");
  process.exit(1);
}
const only = arg("only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (only?.some((u) => !/^[0-9]{6}$/.test(u))) {
  console.error("--only takes six-digit IPEDS unitids, comma-separated");
  process.exit(1);
}
const onlyIds = only?.map(Number);
const dryRun = flag("dry-run");
const fixtureDir = arg("fixture-dir");
const picksFile = arg("picks");
if (picksFile && !fixtureDir && !dryRun) {
  console.error("--picks is for --fixture-dir and --dry-run; a real run reads scripts/ingest/data/college-photo-picks.csv");
  process.exit(1);
}

const log = {
  info: (o: object, m?: string) => console.log(m ?? "", JSON.stringify(o)),
  warn: (o: object, m?: string) => console.warn(m ?? "", JSON.stringify(o)),
  error: (o: object, m?: string) => console.error(m ?? "", JSON.stringify(o)),
};
const NO_SCHEMA = "Apply supabase/migrations/20261023070001_college_photos.sql first.";

function report(outcome: PhotoOutcome | null): never {
  if (!outcome) {
    console.error("The run crashed; see the log above.");
    process.exit(1);
  }
  if (outcome.reason === "no-schema") {
    console.error(NO_SCHEMA);
    process.exit(1);
  }
  if (outcome.dryRun) {
    console.log("\nunitid,name,title,license,credit,source");
    for (const a of outcome.attach) console.log([a.unitid, a.name, a.title, a.license, a.credit, a.source].map(csvCell).join(","));
  }
  const { attach: _attach, ...summary } = outcome;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(outcome.status === "failed" ? 1 : 0);
}

if (fixtureDir || dryRun) {
  const svc = serviceClient();
  if (!svc) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
    process.exit(1);
  }
  const picks = () => loadPicks(picksFile ?? undefined);
  let deps: PhotoDeps;
  if (fixtureDir) {
    const read = (name: string) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
    const tiny = new Uint8Array(readFileSync(join(fixtureDir, "tiny.jpg")));
    if (!isJpeg(tiny)) throw new Error("tiny.jpg is not a JPEG");
    deps = {
      sparql: async () => read("wdqs-p1771.json"),
      imageinfo: async (_titles, width) => read(width === 500 ? "commons-imageinfo-500.json" : "commons-imageinfo-1280.json"),
      download: async (url) => {
        if (!isAllowedDownloadUrl(url)) throw new Error("refused: not an upload.wikimedia.org URL");
        return tiny;
      },
      picks,
    };
  } else {
    const wm = wikimediaClient();
    deps = { sparql: wm.sparql, imageinfo: wm.imageinfo, download: wm.download, picks };
  }
  report(await runCollegePhotoIngest(supabasePhotoStore(svc), deps, log, { trigger: "script", limit, only: onlyIds, dryRun }));
}

const r = await startCollegePhotoIngest(log, "script", { limit, only: onlyIds });
if (!r.started) {
  console.error(r.reason === "no-schema" ? NO_SCHEMA : `Not started: ${r.reason}`);
  process.exit(1);
}
report(await r.done);
