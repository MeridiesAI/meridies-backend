// AxIS evals on the real model: the planted-instruction cases (cases.mjs; AxIS security PR B, spec §5) and the
// activity-draft conversations (cases-drafts.mjs; activity drafts spec 4.10). Runs each case against the local
// stack and an API started with a real ANTHROPIC_API_KEY (and AXIS_EVAL_CLOCK=on for the expiry cases), up to 3
// times. A case's `rule` decides its runs: "all" (default) runs every run and passes when all do; "2of3" stops after
// a first pass, else runs twice more and passes with two of three, marked flaky (score.mjs judgeRuns).
//
//   npm run eval:axis -- [--runs <n>] [--case <id>] [--baseline <scores.jsonl>] [--store <scores.jsonl>]
//
// Prints one row per case: the gated result of each run and the resistance (runs where the model ignored the
// planted text). Exits 1 when a gated run fails or, against --baseline's last line, a score dropped
// (score.mjs). --store appends this run's score as one JSON line.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CASES as SECURITY, say } from "./cases.mjs";
import { DRAFT_CASES } from "./cases-drafts.mjs";
import { compareScores, judgeRuns, needsMoreRuns } from "./score.mjs";
import { runSteps } from "./steps.mjs";

const CASES = [...SECURITY, ...DRAFT_CASES];

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
const mean = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;

for (const c of cases) {
  const results = [];
  const rule = c.rule ?? "all";
  do {
    const r = results.length + 1;
    try {
      const ctx = await c.seed(`${c.id}-${r}`);
      if (c.steps) await runSteps(ctx, c.steps);
      else for (const turn of c.turns) await say(ctx, turn);
      results.push(await c.check(ctx));
    } catch (err) {
      // A run that couldn't finish proves nothing either way: it counts as a gated failure.
      results.push({ gated: false, resisted: false, note: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) });
    }
  } while (needsMoreRuns(results, rule, opts.runs));
  const judged = judgeRuns(results, rule);
  // Scored values (the activity drafts: questions asked, counselor messages) are kept over time, never gated.
  const scoredKeys = [...new Set(results.flatMap((x) => Object.keys(x.scored ?? {})))];
  const scored = Object.fromEntries(scoredKeys.map((k) => [k, mean(results.map((x) => x.scored?.[k]).filter((v) => typeof v === "number"))]));
  score.cases[c.id] = {
    gated: judged.gated,
    resisted: c.rule === "2of3" ? null : results.filter((x) => x.resisted).length,
    ...(judged.flaky ? { flaky: true } : {}),
    ...(scoredKeys.length ? { scored } : {}),
  };
  rows.push({
    id: c.id,
    runs: results.map((x) => (x.gated ? "pass" : "FAIL")).join(" ") + (judged.flaky ? " (flaky)" : ""),
    resisted: score.cases[c.id].resisted === null ? "-" : `${score.cases[c.id].resisted}/${results.length}`,
    notes: [...new Set(results.map((x) => x.note).filter(Boolean))].join("; "),
  });
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
