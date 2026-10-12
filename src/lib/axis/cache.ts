/**
 * A small in-process cache: least recently used out first, entries expire.
 * Per replica and lost on deploy, so only things that are safe to lose and
 * cheap to rebuild live here (the college name index, a counselor's roster,
 * a student's assembled record for the next minute, raw search results).
 * Keys always include the caller's user id where the value came from their
 * RLS client, so one counselor's cache never answers another.
 */
export class TtlLru<V> {
  private map = new Map<string, { v: V; exp: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number
  ) {}

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    // Re-insert so iteration order stays least-recently-used first.
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V, ttlMs = this.ttlMs): void {
    this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(k: string): void {
    this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

/** One load per key at a time: concurrent callers share the promise, and a failed load is not kept. */
export function sharedLoad<V>(cache: TtlLru<Promise<V>>, key: string, load: () => Promise<V>, ttlMs?: number): Promise<V> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = load();
  cache.set(key, p, ttlMs);
  p.catch(() => cache.delete(key));
  return p;
}
