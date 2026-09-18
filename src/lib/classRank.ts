/**
 * Weighted GPA -> class-rank percentile, against the school's own published
 * bands.
 *
 * The rule that matters here is what this does when it doesn't know. Roughly
 * one high school in six publishes no profile at all, and a national assumption
 * dressed up as that school's number is worse than no number: a counselor would
 * repeat it to a family. So an unknown school, an unweighted scale, or a GPA
 * below every published band returns null, and the caller has to say so.
 */

export type RankBand = {
  label: string;
  minWeightedGpa: number;
  percentile: number;
};

export type RankRead = {
  /** "Top 10%" — the percentile the bands support, never an interpolated guess
   *  outside them. */
  percentile: number;
  band: string;
  summary: string;
};

export function rankPercentile(bands: RankBand[], weightedGpa: number): RankRead | null {
  if (!Number.isFinite(weightedGpa) || bands.length === 0) return null;

  // Strongest band first: the top decile before the top half.
  const sorted = [...bands].sort((a, b) => b.minWeightedGpa - a.minWeightedGpa);

  const exact = sorted.find((b) => weightedGpa >= b.minWeightedGpa);
  if (!exact) {
    // Below every published cut-off. The school has said nothing about where
    // this student sits, and neither should we.
    return null;
  }

  // Interpolate only *between* two published bands, never past the strongest
  // one — a 4.9 at a school whose top band starts at 4.5 is "top 10%", not
  // "top 2%" extrapolated off the end of the curve.
  const stronger = [...sorted].reverse().find((b) => b.minWeightedGpa > weightedGpa);
  let percentile = exact.percentile;

  if (stronger && stronger.minWeightedGpa > exact.minWeightedGpa) {
    const span = stronger.minWeightedGpa - exact.minWeightedGpa;
    const along = (weightedGpa - exact.minWeightedGpa) / span;
    percentile = exact.percentile + (stronger.percentile - exact.percentile) * along;
  }

  const rounded = Math.max(1, Math.round(percentile));
  return {
    percentile: rounded,
    band: exact.label,
    summary: `Top ${rounded}% — ${exact.label} on the school's published scale`,
  };
}
