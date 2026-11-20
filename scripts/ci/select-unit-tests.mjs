#!/usr/bin/env node
// Which unit test files CI runs, and on which runtime.
//
//   node scripts/ci/select-unit-tests.mjs [--base <git ref>] [--all]
//
// Prints JSON { mode, reason, bun: [...files], node: [...files] } and, under GitHub Actions, writes
// `mode`, `run_bun` and `run_node` to $GITHUB_OUTPUT. scripts/ci/run-unit-tests.mjs imports `selection`.
//
// With --base (a pull request), only the tests the diff can reach run: a test file is picked when
// it, or anything it imports (followed through relative imports, at any depth), changed. Everything
// runs when the diff touches anything outside src/ and test/unit/ (package.json, the lockfile,
// tsconfig, fixtures, migrations, workflows...), when the base can't be diffed, or with --all. Tests
// that read files or start processes by path (node:fs, node:child_process) can depend on files no
// import names, so they always run.
//
// NODE_ONLY files test the Node runtime itself (worker heap caps, child-process limits, the Stripe
// SDK's Node crypto provider, a model download) and run under `node --test`, as production runs Node.
// Everything else runs under `bun test`.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const UNIT = "test/unit";

export const NODE_ONLY = new Set([
  "test/unit/embeddings.test.ts",
  "test/unit/import-parse.test.ts",
  "test/unit/pdf-text.test.ts",
  "test/unit/stripe-connect.test.ts",
  "test/unit/stripe-webhook.test.ts",
]);

// Changed paths that never affect a unit test.
const IGNORED = [/\.md$/, /^docs\//, /^LICENSE$/, /^evals\//, /^test\/integration\//, /^supabase\/\.temp\//];
// Changed paths the import graph covers; anything else runs every test.
const NARROWABLE = [/^src\//, /^test\/unit\/[^/]+\.ts$/];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

function allTests() {
  return readdirSync(join(ROOT, UNIT))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => `${UNIT}/${f}`)
    .sort();
}

// Static `import ... from "x"`, `export ... from "x"`, `import "x"` and `import("x")` with a relative specifier.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

function resolveImport(fromFile, spec) {
  const base = normalize(join(dirname(fromFile), spec));
  const stem = base.replace(/\.(m|c)?js$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.mjs`, `${stem}.js`, join(base, "index.ts"), join(base, "index.js")];
  for (const c of candidates) {
    const abs = join(ROOT, c);
    if (existsSync(abs) && statSync(abs).isFile()) return c;
  }
  return null;
}

const importCache = new Map();
function importsOf(file) {
  if (importCache.has(file)) return importCache.get(file);
  const out = [];
  const src = readFileSync(join(ROOT, file), "utf8");
  for (const m of src.matchAll(SPECIFIER)) {
    const r = resolveImport(file, m[1]);
    if (r) out.push(r);
  }
  importCache.set(file, out);
  return out;
}

function closure(file) {
  const seen = new Set([file]);
  const stack = [file];
  while (stack.length) {
    for (const dep of importsOf(stack.pop())) {
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return seen;
}

const READS_FILES = /\bnode:(fs|child_process)\b|from\s+["'](fs|child_process)(\/promises)?["']/;
function readsFiles(file) {
  return [...closure(file)].filter((f) => f.startsWith(UNIT)).some((f) => READS_FILES.test(readFileSync(join(ROOT, f), "utf8")));
}

function changedFiles(base) {
  // The PR's own changes: base...HEAD diffs against the merge base.
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function select() {
  const tests = allTests();
  const base = flag("--base");
  if (args.includes("--all")) return { mode: "all", reason: "--all", tests };
  if (!base) return { mode: "all", reason: "no base: a push or a manual run", tests };

  let changed;
  try {
    changed = changedFiles(base);
  } catch (e) {
    return { mode: "all", reason: `couldn't diff against ${base}: ${String(e.message).split("\n")[0]}`, tests };
  }
  const relevant = changed.filter((f) => !IGNORED.some((re) => re.test(f)));
  const wide = relevant.filter((f) => !NARROWABLE.some((re) => re.test(f)));
  if (wide.length) return { mode: "all", reason: `changed outside src/ and test/unit/: ${wide.slice(0, 5).join(", ")}${wide.length > 5 ? "…" : ""}`, tests };

  const touched = new Set(relevant);
  const picked = tests.filter((t) => readsFiles(t) || [...closure(t)].some((f) => touched.has(f)));
  return { mode: "affected", reason: `${relevant.length} changed file(s) reach ${picked.length} of ${tests.length} test files`, tests: picked };
}

export function selection(argv = args) {
  args.splice(0, args.length, ...argv);
  const { mode, reason, tests } = select();
  return { mode, reason, bun: tests.filter((t) => !NODE_ONLY.has(t)), node: tests.filter((t) => NODE_ONLY.has(t)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { mode, reason, bun, node } = selection();
  console.log(JSON.stringify({ mode, reason, bun, node }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [`mode=${mode}`, `run_bun=${bun.length > 0}`, `run_node=${node.length > 0}`].join("\n") + "\n",
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unit tests: ${mode}\n\n${reason}. Bun: ${bun.length} files, Node: ${node.length} files.\n`);
  }
}
