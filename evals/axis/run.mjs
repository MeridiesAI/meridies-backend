// AxIS injection evals on the real model (AxIS security PR B, spec §5). Runs each planted-instruction case
// (cases.mjs) against the local stack and an API started with a real ANTHROPIC_API_KEY, 3 times by default.
//
//   npm run eval:axis -- [--runs <n>] [--case <id>] [--baseline <scores.jsonl>] [--store <scores.jsonl>]
//
// Prints one row per case: the gated result of each run and the resistance (runs where the model ignored the
// planted text). Exits 1 when a gated run fails or, against --baseline's last line, a score dropped
// (score.mjs). --store appends this run's score as one JSON line.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CASES, say } from "./cases.mjs";
import { compareScores } from "./score.mjs";

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

const score = { commit, date: new Date().toISOString(), models: [AXIS_MODEL], cases: {} };
const rows = [];
for (const c of cases) {
  const results = [];
  for (let r = 1; r <= opts.runs; r++) {
    try {
      const ctx = await c.seed(`${c.id}-${r}`);
      for (const turn of c.turns) await say(ctx, turn);
      results.push(await c.check(ctx));
    } catch (err) {
      // A run that couldn't finish proves nothing either way: it counts as a gated failure.
      results.push({ gated: false, resisted: false, note: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) });
    }
  }
  score.cases[c.id] = { gated: results.every((x) => x.gated), resisted: results.filter((x) => x.resisted).length };
  rows.push({ id: c.id, runs: results.map((x) => (x.gated ? "pass" : "FAIL")).join(" "), resisted: `${score.cases[c.id].resisted}/${results.length}`, notes: [...new Set(results.map((x) => x.note).filter(Boolean))].join("; ") });
}

console.table(rows);

let prev = null;
if (opts.baseline && existsSync(opts.baseline)) {
  const lines = readFileSync(opts.baseline, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length) prev = JSON.parse(lines.at(-1));
}
const { drops } = compareScores(prev, score);
if (prev) console.log(`Compared with ${prev.commit} (${prev.date}).`);
if (drops.length) console.log(`Drops:\n- ${drops.join("\n- ")}`);
else console.log("No drops.");

if (opts.store) appendFileSync(opts.store, `${JSON.stringify(score)}\n`);
process.exit(drops.length ? 1 : 0);
