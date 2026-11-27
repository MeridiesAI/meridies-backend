// AxIS tool-call evals on the real model (tool-call-cases.mjs): for each counselor request, does the model call the
// right tool with the right key input? Sends AxIS's real system prompt, tools and mode for a fixed, made-up student
// and roster straight to the Anthropic API. No database, no API server: nothing is ever executed. A `lookup` or
// `find_student` gets a canned answer and the model goes on (up to 3 rounds), so a change that needs an id is scored
// on the perform_action that follows. Each run scores 1 or 0 (tool-call-score.mjs).
//
//   AXIS_EVAL_ANTHROPIC_API_KEY=... npm run eval:axis:tools -- [--runs <n>] [--case <id>] [--baseline <f>] [--store <f>]
//
// It takes the key ONLY from AXIS_EVAL_ANTHROPIC_API_KEY (the evals' own spend-limited key, never production's) and
// never reads a .env file. A full run is about 40 cases x runs model calls of AxIS's model.
// Prints passes out of runs per case; exits 1 when, against --baseline's last line, a score dropped (the quality
// suite's rule, quality-score.mjs). --store appends this run's score as one JSON line.

// Before anything from src/ loads: src/env.ts runs dotenv, and the main checkout's .env points at production.
process.env.DOTENV_CONFIG_PATH = "/nonexistent/.env";
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_ANON_KEY ??= "eval-anon-key-000000000000";
process.env.APP_URL ??= "http://localhost:3000";

const { execSync } = await import("node:child_process");
const { appendFileSync, existsSync, readFileSync } = await import("node:fs");
const { LOOKUPS, RECORD, ROSTER, ROSTER_TEXT, TOOL_CASES: CASES } = await import("./tool-call-cases.mjs");
const { scoreToolCalls, settled } = await import("./tool-call-score.mjs");
const { compareQuality } = await import("./quality-score.mjs");

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
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { requestBase, systemBlocks } = await import("../../src/lib/axis/engine.ts");
const { toolList } = await import("../../src/lib/axis/tools.ts");
const { AXIS_MODEL, MAX_TOKENS, effortMessage, featureOn, modeMessage } = await import("../../src/lib/axis/models.ts");
const { PROFILES, modeLine } = await import("../../src/lib/axis/profiles.ts");

const apiKey = process.env.AXIS_EVAL_ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set AXIS_EVAL_ANTHROPIC_API_KEY (the evals' own key, never production's). Nothing was run.");
  process.exit(2);
}

const client = new Anthropic({ apiKey, maxRetries: 2 });
const tools = toolList([], true);
const ROUNDS = 3;

/** What a read the model makes is told: canned, never the database. */
function fakeResult(c, name, input) {
  if (name === "lookup") return { ...LOOKUPS, ...(c.lookups ?? {}) }[input?.what] ?? "Nothing found.";
  if (name === "find_student") {
    const q = String(input?.name ?? "").toLowerCase();
    const hits = ROSTER.filter((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.split(" ")[0].toLowerCase()));
    return hits.length ? hits.map((s) => `id ${s.id}: ${s.name}`).join("\n") : "No student matching that name on the roster.";
  }
  if (name === "get_student_record") return "Nothing more on file for those sections.";
  return "No results.";
}

/** One run: the model's tool calls over up to ROUNDS rounds, stopping once the case is settled. */
async function runCase(c) {
  const mode = c.mode ?? "action";
  const effort = PROFILES[mode].effort;
  const system = c.chat === "roster" ? systemBlocks(null, ROSTER_TEXT, null) : systemBlocks(RECORD, null, null);
  const base = requestBase(system, tools, effort);
  const perMessage = featureOn("perMessageEffort");
  const sysMessages = featureOn("systemMessages");
  const messages = [
    ...(perMessage ? [effortMessage(effort)] : []),
    { role: "user", content: sysMessages ? c.say : `(${modeLine(mode)})\n\n${c.say}` },
    ...(sysMessages ? [modeMessage(modeLine(mode))] : []),
  ];
  const calls = [];
  for (let round = 0; round < ROUNDS; round++) {
    const msg = await client.beta.messages.create({ ...base, max_tokens: MAX_TOKENS[effort], tool_choice: { type: "auto" }, messages });
    const uses = msg.content.filter((b) => b.type === "tool_use");
    for (const u of uses) calls.push({ name: u.name, input: u.input ?? {} });
    if (msg.stop_reason !== "tool_use" || !uses.length || settled(c, calls)) break;
    messages.push({ role: "assistant", content: msg.content });
    messages.push({ role: "user", content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: fakeResult(c, u.name, u.input) })) });
  }
  return scoreToolCalls(c, calls);
}

const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();
const score = { commit, date: new Date().toISOString(), models: [AXIS_MODEL], suite: "tools", cases: {} };
const rows = [];

for (const c of cases) {
  const results = [];
  for (let r = 1; r <= opts.runs; r++) {
    try {
      results.push(await runCase(c));
    } catch (err) {
      results.push({ score: 0, note: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) });
    }
  }
  const passes = results.filter((x) => x.score === 1).length;
  score.cases[c.id] = { passes, runs: results.length };
  rows.push({ id: c.id, passes: `${passes}/${results.length}`, notes: [...new Set(results.filter((x) => x.score !== 1).map((x) => x.note))].join("; ").slice(0, 200) });
}

console.table(rows);
const total = Object.values(score.cases).reduce((n, x) => n + x.passes, 0);
console.log(`Total: ${total}/${cases.length * opts.runs}`);

let prev = null;
if (opts.baseline && existsSync(opts.baseline)) {
  const lines = readFileSync(opts.baseline, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length) prev = JSON.parse(lines.at(-1));
  if (prev && prev.suite !== "tools") throw new Error(`${opts.baseline}'s last line is not a tool-call score (suite: ${prev.suite ?? "none"})`);
}
const { drops, skipped } = compareQuality(prev, score);
if (prev) console.log(`Compared with ${prev.commit} (${prev.date}).`);
if (skipped.length) console.log(`Not compared (different number of runs from the baseline): ${skipped.join(", ")}`);
if (drops.length) console.log(`Drops:\n- ${drops.join("\n- ")}`);
else console.log("No drops.");

if (opts.store) appendFileSync(opts.store, `${JSON.stringify(score)}\n`);
process.exit(drops.length ? 1 : 0);
