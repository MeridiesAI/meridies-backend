/**
 * AI spend per import, in cents (spec §5.3: capped at 200 cents an import).
 * One price table, in US dollars per million tokens; an unknown model is
 * priced as the dearest one we use, so the cap errs on the safe side.
 */

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
};
const FALLBACK = { input: 15, output: 75 };

export function costCents(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? FALLBACK;
  const dollars = (Math.max(0, inputTokens) * p.input + Math.max(0, outputTokens) * p.output) / 1_000_000;
  return Math.ceil(dollars * 100);
}
