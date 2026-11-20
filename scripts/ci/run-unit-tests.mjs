#!/usr/bin/env node
// Runs the unit tests: `bun test` for most files, `node --test` for the NODE_ONLY ones
// (scripts/ci/select-unit-tests.mjs says which and why). `npm test` runs everything this way.
//
//   node scripts/ci/run-unit-tests.mjs [--base <ref>] [--all] [--runtime bun|node|both] [--shard i/n]
//                                      [--seed <n>] [--timings-out <file>]
//
// Bun runs the files in parallel workers, each file in a fresh global and module registry, in a random
// order (the seed is printed; pass --seed to replay one). A test that passes in one order and fails in
// another has a leak: fix it, never pin the order.
//
// --shard i/n: this job's share of the Bun files, balanced by recorded time (longest first onto the
// least loaded shard). Every shard computes the whole plan and checks that the shards together hold
// each selected file exactly once before it runs its own.
//
// Times come from test/unit/timings.json, then any file in .ci-timings/ (what main's last full run
// recorded, restored by CI), later files winning. --timings-out writes the times this run measured.
// Without bun on PATH, every file runs under Node, as `npm run test:node` does.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { selection } from "./select-unit-tests.mjs";

/** Longest-first onto the least loaded shard. A file with no recorded time counts as the median. */
export function shardPlan(files, times, n) {
  const known = files.map((f) => times[f]).filter((t) => typeof t === "number").sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (f) => (typeof times[f] === "number" ? times[f] : fallback);
  const shards = Array.from({ length: n }, () => ({ files: [], ms: 0 }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const s = shards.reduce((min, x) => (x.ms < min.ms ? x : min));
    s.files.push(f);
    s.ms += weight(f);
  }
  return shards;
}

/** Throws unless the shards hold every file exactly once and nothing else. */
export function assertCovers(shards, files) {
  const seen = new Map();
  for (const s of shards) for (const f of s.files) seen.set(f, (seen.get(f) ?? 0) + 1);
  const missing = files.filter((f) => !seen.has(f));
  const twice = [...seen].filter(([, c]) => c > 1).map(([f]) => f);
  const extra = [...seen.keys()].filter((f) => !files.includes(f));
  if (missing.length || twice.length || extra.length) {
    throw new Error(`shard plan is wrong: missing ${missing.join(", ") || "none"}; twice ${twice.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`);
  }
}

export function loadTimes(root = ".") {
  const sources = [join(root, "test/unit/timings.json")];
  const dir = join(root, ".ci-timings");
  if (existsSync(dir)) for (const f of readdirSync(dir).sort()) if (f.endsWith(".json")) sources.push(join(dir, f));
  const times = {};
  for (const src of sources) {
    try {
      const j = JSON.parse(readFileSync(src, "utf8"));
      Object.assign(times, j.files ?? j);
    } catch {
      // A missing or broken timings file only makes the balance worse, never the run.
    }
  }
  return times;
}

function run(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const runtime = flag("--runtime") ?? "both";
  const shard = flag("--shard");
  const timingsOut = flag("--timings-out");
  const seed = flag("--seed") ?? String(Math.floor(Math.random() * 2 ** 31));
  const passThrough = [];
  if (flag("--base")) passThrough.push("--base", flag("--base"));
  if (argv.includes("--all")) passThrough.push("--all");

  const { mode, reason, bun, node } = selection(passThrough);
  console.log(`unit tests (${mode}): ${reason}`);

  const haveBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  let bunFiles = haveBun ? bun : [];
  const nodeFiles = haveBun ? node : [...bun, ...node];
  if (!haveBun) console.log("bun isn't installed: running every file under node --test");

  if (shard) {
    const [i, n] = shard.split("/").map(Number);
    if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`--shard ${shard}: expected i/n`);
    const plan = shardPlan(bunFiles, loadTimes(), n);
    assertCovers(plan, bunFiles);
    plan.forEach((s, k) => console.log(`shard ${k + 1}/${n}: ${s.files.length} files, ~${Math.round(s.ms / 1000)}s recorded`));
    bunFiles = plan[i - 1].files;
  }

  // One after the other, not side by side: several tests time themselves (linear-text, regex-dos) and
  // fail when two runtimes share the cores. CI runs the two in separate jobs.
  const jobs = [];
  if ((runtime === "bun" || runtime === "both") && bunFiles.length) {
    const args = ["test", "--parallel", "--randomize", `--seed=${seed}`, "--preload", "./test/env.ts"];
    if (timingsOut) {
      mkdirSync(dirname(timingsOut), { recursive: true });
      writeFileSync(timingsOut, JSON.stringify({ version: 1, files: {} }));
      args.push("--timings", timingsOut, "--update-timings");
    }
    console.log(`bun test seed ${seed} (replay: --seed ${seed})`);
    // Bun treats a bare name as a filter; ./ makes each one a path.
    jobs.push(() => run("bun", [...args, ...bunFiles.map((f) => `./${f}`)]));
  }
  // The Node files are few; they are never sharded, so one job owns them.
  if ((runtime === "node" || runtime === "both") && nodeFiles.length && !(shard && runtime === "both")) {
    jobs.push(() => run(process.execPath, ["--import", "tsx", "--import", "./test/env.ts", "--test", ...nodeFiles]));
  }
  if (!jobs.length) console.log("nothing to run");

  let failed = false;
  for (const job of jobs) if ((await job()) !== 0) failed = true;
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
