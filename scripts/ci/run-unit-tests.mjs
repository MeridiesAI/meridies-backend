#!/usr/bin/env node
// Runs the unit tests: `bun test` for most files, `node --test` for the NODE_ONLY ones
// (scripts/ci/select-unit-tests.mjs says which and why). `npm test` runs everything this way.
//
//   node scripts/ci/run-unit-tests.mjs [--base <ref>] [--all] [--runtime bun|node|both] [--shard i/n]
//                                      [--update-timings]
//
// --base narrows to the tests a PR's diff can reach. --shard splits the Bun files across CI jobs,
// balanced by the per-file times recorded in test/unit/timings.json (refresh it with
// `npm run test:timings` when files are added or get much slower; a file with no time still runs).
// Without bun on PATH, every file runs under Node, as `npm run test:node` does.

import { spawn, spawnSync } from "node:child_process";
import { selection } from "./select-unit-tests.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const runtime = flag("--runtime") ?? "both";
const shard = flag("--shard");
const passThrough = [];
if (flag("--base")) passThrough.push("--base", flag("--base"));
if (argv.includes("--all")) passThrough.push("--all");

const { mode, reason, bun, node } = selection(passThrough);
console.log(`unit tests (${mode}): ${reason}`);

const haveBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const bunFiles = haveBun ? bun : [];
const nodeFiles = haveBun ? node : [...bun, ...node];
if (!haveBun) console.log("bun isn't installed: running every file under node --test");

function run(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

// One after the other, not side by side: several tests time themselves (linear-text, regex-dos) and
// fail when two runtimes share the cores. CI runs the two in separate jobs.
const jobs = [];
if ((runtime === "bun" || runtime === "both") && bunFiles.length) {
  const args = ["test", "--parallel", "--preload", "./test/env.ts", "--timeout", "60000", "--timings", "test/unit/timings.json"];
  if (shard) args.push(`--shard=${shard}`);
  if (argv.includes("--update-timings")) args.push("--update-timings");
  // Bun treats a bare name as a filter; ./ makes each one a path.
  jobs.push(() => run("bun", [...args, ...bunFiles.map((f) => `./${f}`)]));
}
// The Node files are few and slow; they are never sharded, so one job owns them.
if ((runtime === "node" || runtime === "both") && nodeFiles.length && !(shard && runtime === "both")) {
  jobs.push(() => run(process.execPath, ["--import", "tsx", "--import", "./test/env.ts", "--test", ...nodeFiles]));
}
if (!jobs.length) console.log("nothing to run");

let failed = false;
for (const job of jobs) if ((await job()) !== 0) failed = true;
process.exit(failed ? 1 : 0);
