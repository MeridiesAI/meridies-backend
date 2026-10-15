// Pacing and percentiles for test/integration/perf-roster.mjs (unit-tested in test/unit/perf-pacer.test.ts).

/** Sliding-minute pacer over several limiter keys at once. */
export class Pacer {
  constructor(windowMs = 61_000) {
    this.windowMs = windowMs;
    this.sent = new Map();
  }
  /** Waits until every [key, max] pair has room for one more call, then records one on each. */
  async take(pairs) {
    for (;;) {
      const now = Date.now();
      let wait = 0;
      for (const [key, max] of pairs) {
        const times = (this.sent.get(key) ?? []).filter((t) => now - t < this.windowMs);
        this.sent.set(key, times);
        if (times.length >= max) wait = Math.max(wait, times[0] + this.windowMs - now + 5);
      }
      if (wait === 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    const now = Date.now();
    for (const [key] of pairs) this.sent.get(key).push(now);
  }
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
