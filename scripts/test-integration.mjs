// `npm run test:integration`: every integration suite against the one running API and database.
//
// Node runs test files in parallel, and these suites share the API's single global lease on the accountability
// sweep (POST /internal/accountability/sweep, lib/sweepSchedule.ts). A sweep walks EVERY approved counselor, so
// two suites that call it collide twice over: the second gets 409 "A sweep is already running", and a sweep fired
// by one suite acts on another suite's half-built counselors (alerts.test.mjs expects its failing-notice student to
// have no alert row until its own sweep). So the suites that call the cron sweep run one at a time, after the
// parallel rest. A new suite that POSTs /internal/accountability/sweep belongs in this list.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// The invoice crons (POST /internal/invoice-drafts/dispatch, /internal/invoice-reminders/dispatch) walk EVERY counselor's due
// drafts and reminders, so two suites that call them would send each other's drafts and miscount; they run one at a time too.
const SERIAL = ["alerts", "approval-jobs", "axis-trash-purge", "invoice-drafts", "invoice-dispatch-queue"].map((n) => `${n}.test.mjs`);

const dir = "test/integration";
const all = readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));
const missing = SERIAL.filter((f) => !all.includes(f));
if (missing.length) {
  console.error(`test-integration: serial suite(s) not found: ${missing.join(", ")}`);
  process.exit(1);
}
const parallel = all.filter((f) => !SERIAL.includes(f)).sort();

const run = (files, extra = []) =>
  spawnSync(process.execPath, ["--import", "tsx", "--test", ...extra, ...files.map((f) => `${dir}/${f}`)], { stdio: "inherit" }).status ?? 1;

// Run both groups even if the first fails, so one red suite doesn't hide the other.
const first = run(parallel);
const second = run(SERIAL, ["--test-concurrency=1"]);
process.exit(first || second ? 1 : 0);
