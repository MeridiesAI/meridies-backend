/**
 * The per-user limit on read routes (GET and HEAD), decided in process.
 *
 * `limit()` in lib/limits.ts used to wait for the Postgres counter before every
 * handler, reads included: one database round trip per request. For a read the
 * decision is now made from a counter in this process that mirrors the durable
 * one (same key, same limit, same fixed window, and a refused request still
 * counts), while the durable count is sent without being waited for.
 *
 * In one process the 429 lands on exactly the request it did before. What the
 * durable counter knows and this one doesn't (another replica's requests, the
 * count from before a restart) arrives with its answer: once it says "over",
 * the key is strict for the rest of its local window and every request waits
 * for the durable answer again, as all of them used to. So across replicas a
 * read limit can be passed by about one request per replica, once per window.
 *
 * Writes never come through here. Pure: the clock and the durable call are
 * injected.
 */

type Bucket = { windowStart: number; windowMs: number; count: number; strict: boolean };

export const READ_LIMIT_MAX_KEYS = 20_000;

export class ReadLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: { maxKeys?: number; now?: () => number } = {}) {
    this.maxKeys = Math.max(1, options.maxKeys ?? READ_LIMIT_MAX_KEYS);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  /**
   * Count one request. The same arithmetic as the fallback counter in lib/limits.ts and as
   * consume_rate_limit: a new window starts once the old one is `windowSeconds` old, and the
   * request is within the limit while the window's count is at most `limit`.
   */
  hit(key: string, limit: number, windowSeconds: number): { allowed: boolean; strict: boolean } {
    const now = this.now();
    const windowMs = windowSeconds * 1000;
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= bucket.windowMs) {
      this.buckets.delete(key);
      if (this.buckets.size >= this.maxKeys) this.makeRoom(now);
      this.buckets.set(key, { windowStart: now, windowMs, count: 1, strict: false });
      return { allowed: 1 <= limit, strict: false };
    }
    bucket.count += 1;
    return { allowed: bucket.count <= limit, strict: bucket.strict };
  }

  /** The durable counter answered "over" for this key: wait for it on every request until the local window ends. */
  markOver(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) bucket.strict = true;
  }

  /** Drop every window that has ended. Called on a timer and when the map is full. */
  sweep(now: number = this.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= bucket.windowMs) this.buckets.delete(key);
    }
  }

  /**
   * Ended windows first, then the oldest key. Losing a live bucket only restarts its local count:
   * the durable counter still holds the real one and answers "over" on the next request.
   */
  private makeRoom(now: number): void {
    this.sweep(now);
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }
}

/**
 * Decide one read. Resolves true when the request may go ahead.
 *
 * `durable` counts the request in Postgres and resolves false when that count is over the limit
 * (lib/limits.ts consumeRateLimit, which fails open and never throws). It is called exactly once per
 * request, allowed or refused, so the durable count stays what it always was. It is waited for only
 * while the key is strict; otherwise its answer is taken in when it arrives, and a failure is handed
 * to `onError` and never left unhandled.
 */
export async function decideRead(
  limiter: ReadLimiter,
  key: string,
  limit: number,
  windowSeconds: number,
  durable: () => Promise<boolean>,
  onError?: (err: unknown) => void
): Promise<boolean> {
  const local = limiter.hit(key, limit, windowSeconds);

  const counted = Promise.resolve()
    .then(durable)
    .then((under) => {
      if (!under) limiter.markOver(key);
      return under;
    })
    .catch((err: unknown) => {
      try {
        onError?.(err);
      } catch {
        // A logger that throws must not turn into an unhandled rejection.
      }
      // The durable call fails open, and so does a failure to make it.
      return true;
    });

  if (!local.allowed) return false;
  if (local.strict) return counted;
  return true;
}
