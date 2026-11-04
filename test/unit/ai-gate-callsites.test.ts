import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { researchSubject } from "../../src/lib/anthropic.js";

// Spec 1.1: only two files call the model, and every call there goes through the budget gate (lib/aiBudget.ts).
const src = fileURLToPath(new URL("../../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const rel = (f: string) => relative(src, f).split("\\").join("/");
const MODEL_FILES = ["lib/anthropic.ts", "lib/axis/llm.ts"];
const MODEL_CALL = /\.messages\.(create|stream|countTokens)\b|\.batches\.|new Anthropic\(/;

test("only lib/anthropic.ts and lib/axis/llm.ts call the model", () => {
  const callers = files(src)
    .filter((f) => !MODEL_FILES.includes(rel(f)))
    .filter((f) => MODEL_CALL.test(readFileSync(f, "utf8")))
    .map(rel);
  assert.deepEqual(callers, []);
});

test("each file reserves at least once per model call it makes", () => {
  for (const f of MODEL_FILES) {
    const text = readFileSync(join(src, f), "utf8");
    const calls = (text.match(/\.messages\.(create|stream)\(/g) ?? []).length;
    const reserves = (text.match(/\breserve\(|\baxisGate\(|\breserveTurn\(/g) ?? []).length;
    assert.ok(calls > 0, `${f} makes model calls`);
    assert.ok(reserves >= calls, `${f}: ${calls} model calls, ${reserves} reservations`);
    assert.ok(!/enforceQuota\([^)]*"ai_(calls|output_tokens)"/s.test(text), `${f} no longer charges the old quotas`);
  }
});

test("research with no actor spends the events-discovery system budget", () => {
  assert.deepEqual(researchSubject(null), { system: "events-discovery" });
  assert.deepEqual(researchSubject("11111111-1111-4111-8111-111111111111"), { userId: "11111111-1111-4111-8111-111111111111" });
});

test("events discovery no longer charges a made-up account", () => {
  const text = readFileSync(join(src, "lib/eventsDiscovery.ts"), "utf8");
  assert.ok(!/SYSTEM_SUBJECT/.test(text));
  assert.ok(!/consumeQuota/.test(text));
});
