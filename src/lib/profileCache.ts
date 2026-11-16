/**
 * The caller's profile row, shared between requests that would otherwise each
 * read it (plugins/supabaseAuth.ts reads it on every authenticated request).
 *
 * Two things, kept apart:
 *   - De-duplication, always on: requests from one user that arrive while a
 *     read is in flight share that read. Nothing is kept afterwards.
 *   - A short cache, only when `ttlMs` is above 0: the row a read returned is
 *     handed to that user's requests for `ttlMs`.
 *
 * What is never kept: a read that failed, and "no row". `evict` forgets a
 * user's entry and also detaches a read still in flight, so its answer is
 * returned to the requests already waiting on it and cached for nobody.
 *
 * Every caller gets its own shallow copy, so a handler that changes its copy
 * changes nobody else's. Pure: no Fastify, no database, the clock is injected.
 */

type Entry<T> = { pending: Promise<T | null> | null; value: T | null; expiresAt: number };

export type ProfileCacheOptions = {
  /** How long a loaded row is reused, in milliseconds. 0 keeps nothing (de-duplication only). */
  ttlMs: number;
  /** The most users held at once; the oldest entry goes first. */
  maxEntries?: number;
  now?: () => number;
};

export const PROFILE_CACHE_MAX_ENTRIES = 5000;

export class ProfileCache<T extends object> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ProfileCacheOptions) {
    this.ttlMs = Math.max(0, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries ?? PROFILE_CACHE_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The row for `userId`: a fresh cached one, the read already in flight, or a
   * new `load()`. `userId` must be the verified subject of the caller's token.
   * A `load` that throws rejects for every request sharing it and leaves nothing behind.
   */
  async get(userId: string, load: () => Promise<T | null>): Promise<T | null> {
    const existing = this.entries.get(userId);
    if (existing) {
      if (existing.pending) return copy(await existing.pending);
      if (existing.value && this.now() < existing.expiresAt) return copy(existing.value);
    }

    const entry: Entry<T> = { pending: null, value: null, expiresAt: 0 };
    const pending = Promise.resolve().then(load);
    entry.pending = pending;
    // Delete first so the entry moves to the end: the map's order is oldest first.
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    this.trim();

    try {
      const value = await pending;
      // Only when nothing evicted or replaced this entry while the read ran.
      if (this.entries.get(userId) === entry) {
        if (value && this.ttlMs > 0) {
          entry.pending = null;
          entry.value = value;
          entry.expiresAt = this.now() + this.ttlMs;
        } else {
          this.entries.delete(userId);
        }
      }
      return copy(value);
    } catch (err) {
      if (this.entries.get(userId) === entry) this.entries.delete(userId);
      throw err;
    }
  }

  /** Forget this user: the next request reads again, and a read in flight is cached for nobody. */
  evict(userId: string): void {
    this.entries.delete(userId);
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

function copy<T extends object>(value: T | null): T | null {
  return value ? { ...value } : null;
}
