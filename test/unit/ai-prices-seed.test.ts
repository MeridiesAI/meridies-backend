import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every model id the code names has a price row in private.ai_prices. A model added to the code without one would be
// priced at the table's highest rates: caps about 100x too tight, with no other signal. A price row comes from any
// migration that inserts into private.ai_prices (the seed, and the migration that adds a new model, AGENTS.md).
const src = fileURLToPath(new URL("../../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

/** The models priced by these migrations: every row of every insert into private.ai_prices. */
export function pricedModels(migrations: string[]): Set<string> {
  const priced = new Set<string>();
  for (const sql of migrations) {
    for (const insert of sql.matchAll(/insert\s+into\s+private\.ai_prices\b[\s\S]*?;/gi)) {
      for (const m of insert[0].matchAll(/\(\s*'(claude-[a-z0-9-]+)'\s*,/g)) priced.add(m[1]!);
    }
  }
  return priced;
}

test("price rows are read from every migration that adds one", () => {
  const seed = "insert into private.ai_prices (model, input_usd) values ('claude-a-1', 1), ('claude-b-2', 2) on conflict do nothing;";
  const later = "-- a new model\ninsert into private.ai_prices (model, input_usd, output_usd, read_mult) values ('claude-c-3', 1, 5, 0.1);";
  const other = "insert into public.colleges (name) values ('claude-not-a-price');";
  assert.deepEqual([...pricedModels([seed, later, other])].sort(), ["claude-a-1", "claude-b-2", "claude-c-3"]);
});

test("every model id in the code has a price row", () => {
  const used = new Set<string>();
  for (const f of files(src)) for (const m of readFileSync(f, "utf8").matchAll(/["'`](claude-[a-z0-9]+(?:-[a-z0-9]+)+)["'`]/g)) used.add(m[1]!);
  const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
  const priced = pricedModels(readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")));
  assert.ok(used.size >= 5, [...used].join(", "));
  assert.ok(priced.size >= 14, [...priced].join(", "));
  assert.deepEqual([...used].filter((m) => !priced.has(m)), []);
});
