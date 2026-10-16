/**
 * Campus photos for the catalog, from Wikimedia Commons through Wikidata
 * (src/lib/ingest/collegePhotos.ts has the rules). Uses SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY from the environment / .env, like the API.
 *
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts                 # every college, under the job's lease
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts --limit 50      # a trial run
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts --only 166683,243744
 *   npx tsx --env-file=.env scripts/ingest/college-photos.ts --dry-run       # writes nothing; prints a CSV of what it would attach and what it holds
 *   npx tsx scripts/ingest/college-photos.ts --fixture-dir test/fixtures/college-photos [--picks <csv>] [--now <ISO time>]
 *                                                                           # recorded answers, no network (tests, offline dev)
 *
 * Look the new photos over: run with --dry-run, open each title's Commons
 * page from the CSV (https://commons.wikimedia.org/wiki/<title>), and put any
 * wrong building, aerial blur or close-up of people in
 * scripts/ingest/data/college-photo-picks.csv, either as a better
 * `File:...` title or as `none` to suppress the college. The next run applies it.
 *
 * The CSV's action column: `add` / `replace` go live on the next run;
 * `held-new` / `held-replace` are waiting for a week without edits on
 * Wikidata and Commons (the reasons column says which clock is running; see
 * reviewDecision in src/lib/ingest/collegePhotos.ts), or for a later run to
 * see them unchanged; `held-text` keeps the photo and holds a changed credit
 * or license for it. `pick-redirected` and `pick-changed` wait for the team:
 * update the title, or the pin. To publish a held photo now, put its title in
 * the picks file, with the version you looked at in the commons_sha1 column
 * (the file's SHA1 on its Commons page) when it is a new version of the file
 * already shown; to keep it off, put `none` or a better title. A real run
 * keeps the same list in the college_photo_candidates table and its counts on
 * its ingest_runs row (held-new, held-replace, text-held, hold:<reason>).
 *
 * Run it once by hand right after applying 20261023070001_college_photos.sql:
 * /internal/status reads the job overdue until its first clean run.
 *
 * A dry run and a fixture run don't take the lease and don't mark the job
 * healthy; a dry run writes no ingest_runs row.
 */

import { existsSync, readFileSync } from "node:fs";
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
const nowArg = arg("now");
if (nowArg !== undefined && (!fixtureDir || !Number.isFinite(Date.parse(nowArg)))) {
  console.error("--now takes an ISO time, and only with --fixture-dir (the fixtures' timestamps are read against it)");
  process.exit(1);
}
const now = nowArg !== undefined ? () => new Date(Date.parse(nowArg)) : undefined;
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
    console.log("\naction,unitid,name,title,license,credit,source,current_title,reasons");
    for (const a of [...outcome.attach, ...outcome.review]) {
      console.log([a.action, a.unitid, a.name, a.title, a.license, a.credit, a.source, a.current ?? "", a.reasons.join(";")].map(csvCell).join(","));
    }
  }
  const { attach: _attach, review: _review, ...summary } = outcome;
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
    // A fixture directory may hold commons-imageinfo-500-recheck.json: the 500 px
    // answer from the second call on, i.e. what the run sees when it asks again
    // after downloading (a file changed during the run).
    const recheck = existsSync(join(fixtureDir, "commons-imageinfo-500-recheck.json"));
    let thumbCalls = 0;
    deps = {
      sparql: async () => read("wdqs-p1771.json"),
      imageinfo: async (_titles, width) => {
        if (width !== 500) return read("commons-imageinfo-1280.json");
        return read(recheck && thumbCalls++ > 0 ? "commons-imageinfo-500-recheck.json" : "commons-imageinfo-500.json");
      },
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
  report(await runCollegePhotoIngest(supabasePhotoStore(svc), deps, log, { trigger: "script", limit, only: onlyIds, dryRun, now }));
}

const r = await startCollegePhotoIngest(log, "script", { limit, only: onlyIds });
if (!r.started) {
  console.error(r.reason === "no-schema" ? NO_SCHEMA : `Not started: ${r.reason}`);
  process.exit(1);
}
report(await r.done);
