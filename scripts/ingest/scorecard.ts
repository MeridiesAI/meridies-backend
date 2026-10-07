/**
 * One-shot College Scorecard load (the first full catalog, or a manual
 * refresh). Uses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SCORECARD_API_KEY
 * from the environment / .env, like the API.
 *
 *   npx tsx scripts/ingest/scorecard.ts                 # every page
 *   npx tsx scripts/ingest/scorecard.ts --pages 2       # a trial run
 *   npx tsx scripts/ingest/scorecard.ts --fixture <f>   # load a saved API response (tests, offline dev)
 */

import { readFileSync } from "node:fs";
import { runScorecardIngest } from "../../src/lib/ingest/scorecard.js";
import { startScorecardIngest } from "../../src/lib/ingest/run.js";
import { serviceClient } from "../../src/lib/supabase.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const maxPages = arg("pages") ? Number(arg("pages")) : undefined;
const fixture = arg("fixture");
const log = {
  info: (o: object, m?: string) => console.log(m ?? "", JSON.stringify(o)),
  warn: (o: object, m?: string) => console.warn(m ?? "", JSON.stringify(o)),
  error: (o: object, m?: string) => console.error(m ?? "", JSON.stringify(o)),
};

if (fixture) {
  const svc = serviceClient();
  if (!svc) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
    process.exit(1);
  }
  const body = JSON.parse(readFileSync(fixture, "utf8")) as { results: Record<string, unknown>[] };
  const outcome = await runScorecardIngest(svc, async (page) => (page === 0 ? { total: body.results.length, results: body.results } : { total: body.results.length, results: [] }), log, { trigger: "script" });
  console.log(JSON.stringify(outcome));
  process.exit(outcome.status === "failed" ? 1 : 0);
}

const r = await startScorecardIngest(log, "script", { maxPages });
if (!r.started) {
  console.error(`Not started: ${r.reason}`);
  process.exit(1);
}
const outcome = await r.done;
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome && outcome.status !== "failed" ? 0 : 1);
