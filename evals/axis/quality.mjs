// AxIS quality evals on the real model (quality-cases.mjs): does it answer correctly, as opposed to safely (run.mjs).
// Runs each case against the local stack and an API started with a real ANTHROPIC_API_KEY, --runs times. Each run
// scores 1 or 0; a run that throws scores 0 with the error as its note.
//
//   npm run eval:axis:quality -- [--runs <n>] [--case <id>] [--baseline <scores.jsonl>] [--store <scores.jsonl>]
//
// Prints one row per case: passes out of runs. Exits 1 when, against --baseline's last line, a score dropped
// (quality-score.mjs). --store appends this run's score as one JSON line.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { say } from "./cases.mjs";
import { QUALITY_CASES as CASES } from "./quality-cases.mjs";
import { compareQuality } from "./quality-score.mjs";
import { runSteps } from "./steps.mjs";

function args(argv) {
  const out = { runs: 3, case: null, baseline: null, store: null };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--runs") out.runs = Math.max(1, Number.parseInt(v, 10) || 3), i++;
    else if (k === "--case") out.case = v, i++;
    else if (k === "--baseline") out.baseline = v, i++;
    else if (k === "--store") out.store = v, i++;
    else throw new Error(`unknown argument ${k}`);
  }
  return out;
}

const opts = args(process.argv.slice(2));
const cases = opts.case ? CASES.filter((c) => c.id === opts.case) : CASES;
if (!cases.length) throw new Error(`no case called ${opts.case}; cases: ${CASES.map((c) => c.id).join(", ")}`);

const { AXIS_MODEL } = await import("../../src/lib/axis/models.ts");
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();

const score = { commit, date: new Date().toISOString(), models: [AXIS_MODEL], suite: "quality", cases: {} };
const rows = [];

for (const c of cases) {
  const results = [];
  for (let r = 1; r <= opts.runs; r++) {
    try {
      const ctx = await c.seed(`${c.id}-${r}`);
      if (c.steps) await runSteps(ctx, c.steps);
      else for (const turn of c.turns) await say(ctx, turn);
      results.push(await c.check(ctx));
    } catch (err) {
      results.push({ score: 0, note: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) });
    }
  }
  const passes = results.filter((x) => x.score === 1).length;
  score.cases[c.id] = { passes, runs: results.length };
  rows.push({
    id: c.id,
    passes: `${passes}/${results.length}`,
    notes: [...new Set(results.map((x) => x.note).filter(Boolean))].join("; "),
  });
}

console.table(rows);

let prev = null;
if (opts.baseline && existsSync(opts.baseline)) {
  const lines = readFileSync(opts.baseline, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length) prev = JSON.parse(lines.at(-1));
  if (prev && prev.suite !== "quality") throw new Error(`${opts.baseline}'s last line is not a quality score (suite: ${prev.suite ?? "none"})`);
}
const { drops, skipped } = compareQuality(prev, score);
if (prev) console.log(`Compared with ${prev.commit} (${prev.date}).`);
if (skipped.length) console.log(`Not compared (different number of runs from the baseline): ${skipped.join(", ")}`);
if (drops.length) console.log(`Drops:\n- ${drops.join("\n- ")}`);
else console.log("No drops.");

if (opts.store) appendFileSync(opts.store, `${JSON.stringify(score)}\n`);
process.exit(drops.length ? 1 : 0);
