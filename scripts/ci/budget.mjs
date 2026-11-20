#!/usr/bin/env node
// Fails a CI job whose checks took longer than its budget, so CI stays fast by rule, not by hope.
//
//   node scripts/ci/budget.mjs <running budget, seconds> [<setup budget, seconds>]
//
// .github/actions/setup stamps CI_JOB_START (as it starts) and CI_SETUP_DONE (once node_modules is in
// place). Running is from CI_SETUP_DONE to now and is always enforced. Setup is reported; it is enforced
// only when CI_SETUP_ENFORCE=true, because on GitHub's hosted runners restoring node_modules alone can
// take most of the 15 s budget (see AGENTS.md, "CI"). A cold run (CI_COLD=true: a cache that the
// job's own speed depends on missed, e.g. on a lockfile change) reports both and fails neither.
import { appendFileSync } from "node:fs";

const [running, setup] = process.argv.slice(2).map(Number);
const now = Date.now() / 1000;
const start = Number(process.env.CI_JOB_START);
const ready = Number(process.env.CI_SETUP_DONE);
if (!Number.isFinite(running) || !start || !ready) {
  console.log("::error::budget: CI_JOB_START / CI_SETUP_DONE missing (did the job use .github/actions/setup?)");
  process.exit(1);
}
const took = { setup: Math.round(ready - start), running: Math.round(now - ready) };
const cold = process.env.CI_COLD === "true";
const enforceSetup = process.env.CI_SETUP_ENFORCE === "true" && Number.isFinite(setup);
const over = [];
if (!cold && took.running > running) over.push(`running ${took.running}s > ${running}s`);
if (!cold && enforceSetup && took.setup > setup) over.push(`setup ${took.setup}s > ${setup}s`);

const line = `setup ${took.setup}s${Number.isFinite(setup) ? ` (budget ${setup}s${enforceSetup ? "" : ", reported"})` : ""}, running ${took.running}s (budget ${running}s)${cold ? ", cold: not enforced" : ""}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Budget:** ${line}\n`);
if (over.length) {
  console.log(`::error::over budget: ${over.join("; ")}`);
  process.exit(1);
}
