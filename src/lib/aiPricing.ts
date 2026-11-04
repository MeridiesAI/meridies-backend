/**
 * What a model call costs, as arithmetic only. The prices themselves live in one table,
 * `private.ai_prices` (20261108000002), which the code reads through `public.ai_budget_prices()`
 * (lib/aiBudget.ts) and the SQL reports join. No price figure lives in this file: a price change
 * is a migration that updates rows.
 */

/** USD per million tokens (web search: per use) and the multipliers for one model. */
export type ModelPrice = {
  inputUsd: number;
  outputUsd: number;
  readMult: number;
  write5mMult: number;
  write1hMult: number;
  /** Above this many prompt tokens the whole call is billed at `longMult`; null for no long tier. */
  longAbove: number | null;
  longMult: number;
  webSearchUsd: number;
};

export type PriceTable = ReadonlyMap<string, ModelPrice>;

/** One model call's usage, as the API reports it. Cache writes without a 5m/1h split count as 1-hour writes. */
export type CallUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearches?: number;
};

const num = (v: unknown, field: string, model: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`ai_prices: bad ${field} for ${model}`);
  return n;
};

/** The table from `ai_budget_prices()` rows (snake_case; PostgREST may send numerics as strings). Throws on a malformed row. */
export function priceTableFrom(rows: unknown[]): PriceTable {
  const table = new Map<string, ModelPrice>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") throw new Error("ai_prices: a row is not an object");
    const r = raw as Record<string, unknown>;
    const model = r.model;
    if (typeof model !== "string" || !model) throw new Error("ai_prices: a row has no model");
    const price: ModelPrice = {
      inputUsd: num(r.input_usd, "input_usd", model),
      outputUsd: num(r.output_usd, "output_usd", model),
      readMult: num(r.read_mult, "read_mult", model),
      write5mMult: num(r.write_5m_mult, "write_5m_mult", model),
      write1hMult: num(r.write_1h_mult, "write_1h_mult", model),
      longAbove: r.long_above === null || r.long_above === undefined ? null : num(r.long_above, "long_above", model),
      longMult: num(r.long_mult, "long_mult", model),
      webSearchUsd: num(r.web_search_usd, "web_search_usd", model),
    };
    if (price.inputUsd === 0 || price.outputUsd === 0 || price.readMult === 0 || price.write5mMult === 0 || price.write1hMult === 0 || price.longMult < 1) {
      throw new Error(`ai_prices: bad rates for ${model}`);
    }
    table.set(model, price);
  }
  return table;
}

/** A model's price; one with no row is priced at the table's highest rates (never free), with no long tier. */
export function priceFor(t: PriceTable, model: string): ModelPrice {
  const own = t.get(model);
  if (own) return own;
  if (t.size === 0) throw new Error("ai_prices: the price table is empty");
  const all = [...t.values()];
  const max = (f: (p: ModelPrice) => number) => Math.max(...all.map(f));
  return {
    inputUsd: max((p) => p.inputUsd),
    outputUsd: max((p) => p.outputUsd),
    readMult: max((p) => p.readMult),
    write5mMult: max((p) => p.write5mMult),
    write1hMult: max((p) => p.write1hMult),
    longAbove: null,
    longMult: 1,
    webSearchUsd: max((p) => p.webSearchUsd),
  };
}

function tierOf(p: ModelPrice, u: CallUsage): number {
  return p.longAbove !== null && u.input + u.cacheRead + u.cacheWrite > p.longAbove ? p.longMult : 1;
}

/** Prompt tokens weighted to the model's input rate: reads at their multiplier, writes at theirs, the long tier on top. */
export function weightedInput(t: PriceTable, model: string, u: CallUsage): number {
  const p = priceFor(t, model);
  const w5m = u.cacheWrite5m ?? 0;
  const w1h = u.cacheWrite1h ?? Math.max(0, u.cacheWrite - w5m);
  return (u.input + u.cacheRead * p.readMult + w5m * p.write5mMult + w1h * p.write1hMult) * tierOf(p, u);
}

/** Estimated USD for one call. */
export function spendUsd(t: PriceTable, model: string, u: CallUsage): number {
  const p = priceFor(t, model);
  return (weightedInput(t, model, u) * p.inputUsd + u.output * p.outputUsd * tierOf(p, u)) / 1e6 + (u.webSearches ?? 0) * p.webSearchUsd;
}
