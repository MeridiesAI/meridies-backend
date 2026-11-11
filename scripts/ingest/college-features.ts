/**
 * Read colleges' own websites once and fill college_core_features and college_opportunities
 * (src/lib/ingest/collegeFeatures.ts):
 *
 *   npm run ingest:features -- --limit 20            the 20 colleges most listed across every roster (default 20)
 *   npm run ingest:features -- --college <id,id,...> these catalog ids, in this order
 *   add --dry-run   crawl and extract, print the yield report, write nothing to the catalog
 *   add --force     read every page again, even those whose text hasn't changed since the last run
 *   add --concurrency N   colleges at a time (default 3, at most 8); each site still gets one request a second
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY (from .env), and migrations 20261119000001 and
 * 20261124000001 applied. Model calls spend the "college-features" system budget (1,500 a month) and write ai_runs
 * rows, dry run or not; a run writes one ai_runs summary row (module college-features, input.kind "run-summary").
 * The first run downloads the embedding model (about 130 MB) unless it is a dry run.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = "Usage: npm run ingest:features -- [--limit N | --college <id,...>] [--dry-run] [--force] [--concurrency N]";
const known = new Set(["--limit", "--college", "--dry-run", "--force", "--concurrency"]);
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (!known.has(a)) {
    console.error(`Unknown argument: ${a}\n${usage}`);
    process.exit(1);
  }
  if (a === "--limit" || a === "--college" || a === "--concurrency") i++;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const collegeArg = value("college");
const limitArg = value("limit");
const concurrencyArg = value("concurrency");
if (collegeArg !== undefined && limitArg !== undefined) {
  console.error(`Use --limit or --college, not both.\n${usage}`);
  process.exit(1);
}
const collegeIds = collegeArg === undefined ? undefined : [...new Set(collegeArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
if (collegeIds && (!collegeIds.length || collegeIds.some((id) => !UUID.test(id)))) {
  console.error(`--college takes catalog ids (uuids), comma-separated.\n${usage}`);
  process.exit(1);
}
const limit = limitArg === undefined ? 20 : Number(limitArg);
if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
  console.error(`--limit takes a whole number from 1 to 2000.\n${usage}`);
  process.exit(1);
}
const concurrency = concurrencyArg === undefined ? 3 : Number(concurrencyArg);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  console.error(`--concurrency takes a whole number from 1 to 8.\n${usage}`);
  process.exit(1);
}
const dryRun = flag("dry-run");
const force = flag("force");

// After the arguments: importing the job reads the environment (src/env.ts), which fails loudly when it's incomplete.
const { runCollegeFeaturesJob } = await import("../../src/lib/ingest/collegeFeaturesRun.js");
const { formatReport } = await import("../../src/lib/ingest/collegeFeatures.js");

const log = {
  info: (o: object, m?: string) => console.log(m ?? "", o),
  warn: (o: object, m?: string) => console.warn(m ?? "", o),
  error: (o: object, m?: string) => console.error(m ?? "", o),
};

console.log(
  `${dryRun ? "Dry run: " : ""}reading ${collegeIds ? `${collegeIds.length} college(s)` : `the ${limit} most-listed colleges`}` +
    `${force ? ", every page" : ""}, ${concurrency} at a time.`
);
const outcome = await runCollegeFeaturesJob({ collegeIds, limit, dryRun, force, concurrency }, log, (r) => {
  console.log(`  ${r.status.padEnd(10)} ${r.name}: ${r.pagesFetched} pages, ${r.featuresFound} features, ${r.opportunitiesFound} opportunities${r.note ? ` (${r.note})` : ""}`);
});
if (!outcome.ok) {
  console.error(outcome.message);
  process.exit(1);
}
if (outcome.missing.length) console.warn(`Not in the catalog: ${outcome.missing.join(", ")}`);
console.log("");
console.log(formatReport(outcome.report));
process.exit(outcome.report.stoppedBy ? 2 : 0);
