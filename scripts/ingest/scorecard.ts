/**
 * One-shot College Scorecard load (the first full catalog, or a manual
 * refresh). Uses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SCORECARD_API_KEY
 * from the environment / .env, like the API.
 *
 *   npx tsx scripts/ingest/scorecard.ts             # every page
 *   npx tsx scripts/ingest/scorecard.ts --pages 2   # a trial run
 */

import { startScorecardIngest } from "../../src/lib/ingest/run.js";

const i = process.argv.indexOf("--pages");
const maxPages = i > 0 ? Number(process.argv[i + 1]) : undefined;
const log = {
  info: (o: object, m?: string) => console.log(m ?? "", JSON.stringify(o)),
  warn: (o: object, m?: string) => console.warn(m ?? "", JSON.stringify(o)),
  error: (o: object, m?: string) => console.error(m ?? "", JSON.stringify(o)),
};

const r = await startScorecardIngest(log, "script", { maxPages });
if (!r.started) {
  console.error(`Not started: ${r.reason}`);
  process.exit(1);
}
const outcome = await r.done;
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome && outcome.status !== "failed" ? 0 : 1);
