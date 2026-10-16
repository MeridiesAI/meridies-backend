/**
 * The bound on `profiles.profile`, the free-form JSON a user (and their
 * counselor) saves: intake answers and the like.
 *
 * A save merges the patch into what is stored, so bounding the patch alone
 * bounds nothing: a run of 199 KB patches under different keys would grow the
 * column without limit, and every roster read and every questionnaire sync
 * would carry it. So the merged value is what is measured. A value already
 * over the bound may still shrink (a key set to null), never grow, so nobody
 * is stuck unable to save.
 *
 * One measure on both sides. The database enforces the same rule on every
 * write, PostgREST included (`private.profiles_column_bounds`,
 * 20261024000081), as `octet_length(profile::text)`: the UTF-8 bytes of
 * Postgres's own text form of the jsonb, which prints `", "` and `": "`
 * between entries. `profileBytes` computes that same form here, so a profile
 * the database accepted is never one the API then refuses to grow by a byte
 * it would also accept, and the reverse. (Numbers are the one place the two
 * can differ: a number written straight through PostgREST keeps the digits it
 * was written with, "1.50" where JavaScript reads back 1.5, so the API can
 * count a few bytes fewer, never more. A write the API lets through at the
 * very edge may then be refused by the database, which the routes answer
 * with the same 400.)
 */

/** UTF-8 bytes of Postgres's jsonb text form. */
export const MAX_PROFILE_BYTES = 300_000;

type Json = Record<string, unknown>;

const stringBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s), "utf8");

/**
 * A number as Postgres prints it back from jsonb: plain decimal digits,
 * never exponent form (JSON.stringify's "1e-7" is stored and printed as
 * "0.0000001", "1e+21" as twenty-two digits).
 */
export function plainNumber(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const [mantissa, expText] = s.toLowerCase().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const [int, frac = ""] = mantissa.replace("-", "").split(".");
  const digits = int + frac;
  const point = int.length + Number(expText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function bytesOf(v: unknown, depth: number): number {
  if (depth > 200) return Number.POSITIVE_INFINITY;
  if (v === null || v === undefined) return 4; // null
  switch (typeof v) {
    case "string":
      return stringBytes(v);
    case "number":
      return Number.isFinite(v) ? plainNumber(v).length : 4;
    case "boolean":
      return v ? 4 : 5;
    case "object": {
      if (Array.isArray(v)) {
        if (v.length === 0) return 2;
        let n = 2 + 2 * (v.length - 1); // "[" "]" and ", " between
        for (const item of v) n += bytesOf(item, depth + 1);
        return n;
      }
      // JSON drops undefined values; jsonb never sees them.
      const entries = Object.entries(v as Json).filter(([, x]) => x !== undefined && typeof x !== "function");
      if (entries.length === 0) return 2;
      let n = 2 + 2 * (entries.length - 1);
      for (const [k, x] of entries) n += stringBytes(k) + 2 + bytesOf(x, depth + 1); // key ": " value
      return n;
    }
    default:
      return 4;
  }
}

/** The UTF-8 bytes of Postgres's text form of `p` as jsonb; 0 for nothing. */
export const profileBytes = (p: unknown): number => (p === null || p === undefined ? 0 : bytesOf(p, 0));

/**
 * The stored profile with the patch merged over it, or `tooLarge` when the
 * result is over the bound and larger than what is stored now.
 */
export function mergeProfile(current: unknown, patch: Json): { merged: Json; tooLarge: boolean } {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Json) : {};
  const merged = { ...base, ...patch };
  const size = profileBytes(merged);
  return { merged, tooLarge: size > MAX_PROFILE_BYTES && size > profileBytes(base) };
}

/** A database refusal of an oversized profile (the trigger's 23514 and its message). */
export const isProfileTooLarge = (error: { code?: string; message?: string } | null | undefined): boolean =>
  !!error && error.code === "23514" && /profile is too large/i.test(error.message ?? "");
