/**
 * A one-value, per-process cache that remembers a loader's result for `ttlMs`. Concurrent callers share one
 * in-flight load, and a failed load is never kept, so the next caller retries. Meant for small, read-mostly,
 * not-per-user data (the scholarship catalog); no cross-instance invalidation, so keep the TTL short.
 */
export function ttlCache<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now) {
  let value: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;
  return {
    async get(): Promise<T> {
      if (value && now() - value.at < ttlMs) return value.data;
      if (inflight) return inflight;
      inflight = load()
        .then((data) => {
          value = { at: now(), data };
          return data;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    clear() {
      value = null;
    },
  };
}
