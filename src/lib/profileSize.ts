/**
 * The bound on `profiles.profile`, the free-form JSON a user (and their
 * counselor) saves: intake answers and the like.
 *
 * A save merges the patch into what is stored, so bounding the patch alone
 * bounds nothing: a run of 199 KB patches under different keys would grow the
 * column without limit, and every roster read (GET /students selects the
 * whole row) and every questionnaire sync would carry it. So the merged value
 * is what is measured. A value already over the bound may still shrink (a key
 * set to null), never grow, so nobody is stuck unable to save.
 *
 * The database enforces the same rule on every write, PostgREST included
 * (`private.profiles_profile_size`, 20261024000081), on its own text form of
 * the jsonb with a looser number because Postgres prints `", "` and `": "`
 * where JSON.stringify prints `","` and `":"`.
 */

/** The same bound as an intake configuration (routes/intake.ts). */
export const MAX_PROFILE_CHARS = 200_000;

type Json = Record<string, unknown>;

export const profileChars = (p: unknown): number => {
  if (p === null || p === undefined) return 0;
  try {
    return JSON.stringify(p)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * The stored profile with the patch merged over it, or `tooLarge` when the
 * result is over the bound and larger than what is stored now.
 */
export function mergeProfile(current: unknown, patch: Json): { merged: Json; tooLarge: boolean } {
  const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Json) : {};
  const merged = { ...base, ...patch };
  const size = profileChars(merged);
  return { merged, tooLarge: size > MAX_PROFILE_CHARS && size > profileChars(base) };
}
