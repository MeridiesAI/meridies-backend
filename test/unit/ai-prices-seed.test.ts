import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every model id the code names has a price row in the migration that seeds private.ai_prices. A model added to
// the code without one would be priced at the table's highest rates: caps about 100x too tight, with no other signal.
const src = fileURLToPath(new URL("../../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

test("every model id in the code has a price row", () => {
  const used = new Set<string>();
  for (const f of files(src)) for (const m of readFileSync(f, "utf8").matchAll(/["'`](claude-[a-z0-9]+(?:-[a-z0-9]+)+)["'`]/g)) used.add(m[1]!);
  const migrations = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
  const seed = readdirSync(migrations).filter((f) => f.endsWith("_ai_budget.sql"));
  assert.equal(seed.length, 1, "one migration seeds the prices");
  const sql = readFileSync(join(migrations, seed[0]!), "utf8");
  const priced = new Set([...sql.matchAll(/\('(claude-[a-z0-9-]+)',/g)].map((m) => m[1]!));
  assert.ok(used.size >= 5, [...used].join(", "));
  assert.deepEqual([...used].filter((m) => !priced.has(m)), []);
});
