/**
 * The 13-and-older rule (Terms and Privacy Policy: Meridies is not for children under 13).
 *
 * Pure, and it never builds a message from the date: it is a minor's date of birth.
 */

export const MIN_AGE = 13;

/** Whole years between an ISO day (YYYY-MM-DD) and `now`, or null for anything that is not a real day. */
export function ageOn(iso: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const born = new Date(Date.UTC(y, m - 1, d));
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) return null;
  let years = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) years -= 1;
  return years;
}

/** True only for a real date that makes someone younger than 13 today. A future date counts as under 13. */
export function isUnderMinAge(iso: string, now: Date = new Date()): boolean {
  const age = ageOn(iso, now);
  return age !== null && age < MIN_AGE;
}

export const UNDER_AGE_MESSAGE = "Meridies is for people 13 and older.";
