// What counts as a drop between two quality eval runs (quality.mjs). One run's wobble is noise: a drop is a case's
// passes falling by 2 or more, or the total passes over the cases both runs have falling by 3 or more. A new case,
// or one this run left out, is never a drop. Cases run a different number of times are not compared at all.

/**
 * @typedef {{ passes: number, runs: number }} QualityCase
 * @typedef {{ commit: string, date: string, models: string[], suite: "quality", cases: Record<string, QualityCase> }} QualityScore
 */

/**
 * @param {QualityScore | null} prev the baseline's last line, or null
 * @param {QualityScore} next this run
 * @returns {{ drops: string[], skipped: string[] }} skipped: cases in both runs with a different number of runs
 */
export function compareQuality(prev, next) {
  if (!prev) return { drops: [], skipped: [] };
  const both = Object.keys(next.cases).filter((id) => id in prev.cases);
  const shared = both.filter((id) => prev.cases[id].runs === next.cases[id].runs);
  const skipped = both.filter((id) => !shared.includes(id));
  const drops = [];
  for (const id of shared) {
    const before = prev.cases[id];
    const after = next.cases[id];
    if (before.passes - after.passes >= 2) drops.push(`${id}: passes ${before.passes}/${before.runs} -> ${after.passes}/${after.runs}`);
  }
  const sum = (/** @type {QualityScore} */ s) => shared.reduce((n, id) => n + s.cases[id].passes, 0);
  const runs = shared.reduce((n, id) => n + next.cases[id].runs, 0);
  if (sum(prev) - sum(next) >= 3) drops.push(`total passes ${sum(prev)}/${runs} -> ${sum(next)}/${runs}`);
  return { drops, skipped };
}
