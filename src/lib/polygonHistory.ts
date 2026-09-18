/**
 * Bucketing the polygon's growth history.
 *
 * The demo fabricates the past by decaying today's scores backwards. This does
 * the opposite: it only ever reports what was actually recorded, so a student
 * with two weeks of history gets two weeks of chart rather than a convincing
 * year of one. A bucket with no reading carries the last value recorded before
 * it — the score did not change, which is a fact — and buckets before the first
 * reading are absent rather than zero.
 */

export type HistoryScale = "weeks" | "months" | "years";

export type HistoryRow = {
  axisKey: string;
  label: string;
  score: number;
  maxScore: number;
  recordedAt: string | null;
};

export type HistoryPoint = {
  /** "Week of Oct 6", "September", "2026" — depends on the scale. */
  label: string;
  bucket: string;
  axes: { key: string; label: string; score: number; maxScore: number }[];
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How far back each scale looks, in buckets. */
export const DEFAULT_BUCKETS: Record<HistoryScale, number> = {
  weeks: 12,
  months: 12,
  years: 4,
};

export function bucketHistory(
  rows: HistoryRow[],
  scale: HistoryScale,
  now: Date = new Date()
): HistoryPoint[] {
  const dated = rows
    .filter((r) => r.recordedAt)
    .map((r) => ({ ...r, at: new Date(r.recordedAt as string) }))
    .filter((r) => !Number.isNaN(r.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (dated.length === 0) return [];

  const buckets = bucketKeys(scale, now, dated[0].at);
  // axis key -> the reading in force at the end of each bucket.
  const latest = new Map<string, { label: string; score: number; maxScore: number }>();
  const points: HistoryPoint[] = [];

  let cursor = 0;
  for (const bucket of buckets) {
    while (cursor < dated.length && bucketKeyOf(dated[cursor].at, scale) <= bucket.key) {
      const row = dated[cursor];
      latest.set(row.axisKey, {
        label: row.label,
        score: row.score,
        maxScore: row.maxScore,
      });
      cursor += 1;
    }

    // Nothing recorded yet by the end of this bucket: the chart starts later.
    if (latest.size === 0) continue;

    points.push({
      label: bucket.label,
      bucket: bucket.key,
      axes: [...latest.entries()].map(([key, v]) => ({ key, ...v })),
    });
  }

  return points;
}

function bucketKeyOf(at: Date, scale: HistoryScale): string {
  if (scale === "years") return String(at.getUTCFullYear());
  if (scale === "months") {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return startOfWeek(at).toISOString().slice(0, 10);
}

function bucketKeys(
  scale: HistoryScale,
  now: Date,
  earliest: Date
): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const count = DEFAULT_BUCKETS[scale];

  for (let i = count - 1; i >= 0; i -= 1) {
    if (scale === "years") {
      const year = now.getUTCFullYear() - i;
      out.push({ key: String(year), label: String(year) });
    } else if (scale === "months") {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      out.push({
        key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
        label: MONTHS[d.getUTCMonth()],
      });
    } else {
      const d = new Date(startOfWeek(now).getTime() - i * WEEK_MS);
      out.push({
        key: d.toISOString().slice(0, 10),
        label: `Week of ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`,
      });
    }
  }

  // Never draw buckets that predate the first reading — an empty left-hand side
  // reads as a flat start rather than as "we weren't measuring yet".
  const first = bucketKeyOf(earliest, scale);
  const from = out.findIndex((b) => b.key >= first);
  return from <= 0 ? out : out.slice(from);
}

/** Monday-based, in UTC — the same week boundary wherever the counselor is. */
function startOfWeek(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
