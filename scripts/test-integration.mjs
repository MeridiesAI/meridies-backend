// `npm run test:integration`: every integration suite against the one running API and database.
//
// Node runs test files in parallel, and these suites share the API's single global lease on the accountability
// sweep (POST /internal/accountability/sweep, lib/sweepSchedule.ts). A sweep walks EVERY approved counselor, so
// two suites that call it collide twice over: the second gets 409 "A sweep is already running", and a sweep fired
// by one suite acts on another suite's half-built counselors (alerts.test.mjs expects its failing-notice student to
// have no alert row until its own sweep). So the suites that call the cron sweep run one at a time, after the
// parallel rest. A new suite that POSTs /internal/accountability/sweep belongs in this list.
//
// CI splits it across jobs, each with its own throwaway Supabase and API:
//   --part parallel --shard i/n   the i-th of n slices of the parallel suites (every slice checks that the
//                                 slices together hold each parallel suite exactly once)
//   --part serial                 the serial suites
// With neither flag it runs everything, as before. --list prints the suites instead of running them.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";

// The invoice crons (POST /internal/invoice-drafts/dispatch, /internal/invoice-reminders/dispatch) walk EVERY counselor's due
// drafts and reminders, so two suites that call them would send each other's drafts and miscount; they run one at a time too.
// The weekly digest rides the dispatch cron (POST /communication/internal/dispatch) and walks EVERY counselor:
// weekly-digest.test.mjs asserts on one run's counts while a trigger fails one of its students, so another suite's
// dispatch in between runs the digest into that trigger and the counts are someone else's. It runs alone too.
const SERIAL = ["alerts", "approval-jobs", "axis-trash-purge", "invoice-drafts", "invoice-dispatch-queue", "weekly-digest"].map((n) => `${n}.test.mjs`);

const dir = "test/integration";
const all = readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));
const missing = SERIAL.filter((f) => !all.includes(f));
if (missing.length) {
  console.error(`test-integration: serial suite(s) not found: ${missing.join(", ")}`);
  process.exit(1);
}
let parallel = all.filter((f) => !SERIAL.includes(f)).sort();

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const part = flag("--part");
const shard = flag("--shard");
if (shard) {
  const [i, n] = shard.split("/").map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`--shard ${shard}: expected i/n`);
  // Largest first onto the lightest slice, by file size (a stand-in for run time: bigger suites do more).
  const size = (f) => statSync(`${dir}/${f}`).size;
  const slices = Array.from({ length: n }, () => ({ files: [], weight: 0 }));
  for (const f of [...parallel].sort((a, b) => size(b) - size(a) || a.localeCompare(b))) {
    const light = slices.reduce((m, x) => (x.weight < m.weight ? x : m));
    light.files.push(f);
    light.weight += size(f);
  }
  const held = slices.flatMap((x) => x.files);
  if (held.length !== parallel.length || new Set(held).size !== held.length || held.some((f) => !parallel.includes(f))) {
    console.error("test-integration: the shard plan doesn't hold every parallel suite exactly once");
    process.exit(1);
  }
  slices.forEach((x, k) => console.log(`slice ${k + 1}/${n}: ${x.files.length} suites`));
  parallel = slices[i - 1].files.sort();
}

const run = (files, extra = []) =>
  spawnSync(process.execPath, ["--import", "tsx", "--test", ...extra, ...files.map((f) => `${dir}/${f}`)], { stdio: "inherit" }).status ?? 1;

if (argv.includes("--list")) {
  if (part !== "serial") console.log(parallel.join("\n"));
  if (part !== "parallel") console.log(SERIAL.join("\n"));
  process.exit(0);
}

// Run both groups even if the first fails, so one red suite doesn't hide the other.
const first = part === "serial" ? 0 : run(parallel);
const second = part === "parallel" ? 0 : run(SERIAL, ["--test-concurrency=1"]);
process.exit(first || second ? 1 : 0);
