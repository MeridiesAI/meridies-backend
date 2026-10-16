/**
 * Shared by the regular-expression denial-of-service tests: a seeded random
 * generator (so a failure reproduces) and a timer.
 */

/** mulberry32: a small seeded generator, the same one the demo uses. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string of `count` pieces drawn from `alphabet`. */
export function randomText(rand: () => number, alphabet: readonly string[], count: number): string {
  let s = "";
  for (let i = 0; i < count; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/** Milliseconds `fn` took. */
export function elapsed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

/**
 * The budget a worst-case input must finish in. The regular expressions these
 * replace took seconds to hours on the same inputs; linear code takes a few
 * milliseconds, so 100 ms leaves room for a slow CI machine.
 */
export const BUDGET_MS = 100;

/**
 * The budget for an input at a feature's own cap (a 2 MB page, a 10 MB
 * document): linear code reads it in tens of milliseconds, a busy test runner
 * can stretch that, and the old expressions took minutes to days.
 */
export const CAP_BUDGET_MS = 1000;
