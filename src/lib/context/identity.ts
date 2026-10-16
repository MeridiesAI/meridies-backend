/**
 * A student's name and class year as AxIS may treat them: counselor-trusted
 * labels, not student text.
 *
 * Both are the student's own fields (profiles.full_name and grad_year are in
 * the student's column grant), yet every change turn needs to know who the
 * student is. So they are reduced to the shape a name and a year have, and
 * nothing else gets through: a name keeps letters, combining marks, spaces,
 * apostrophes and hyphens, at most six words and 60 characters (no digits,
 * colons, underscores, quotes or periods, so it can't spell an operation's
 * name or input); a class year is four digits or nothing. The database refuses
 * anything else for a new class year and a name past 200 characters
 * (20261024000052), and this is the code-side check that holds without it.
 *
 * Known limit: a short run of plain words ("Please archive her") is a valid
 * name shape. It can't name an operation or carry an id, and the model is told
 * the name is data.
 */

const NAME_MAX = 60;
const NAME_WORDS = 6;

/** The name as AxIS shows it: name characters only, collapsed and clipped. "" when nothing is left. */
export function plainName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const kept = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = kept.split(" ").filter(Boolean).slice(0, NAME_WORDS).join(" ");
  return words.length > NAME_MAX ? words.slice(0, NAME_MAX).trim() : words;
}

/** A class year AxIS may show: four digits, else null. */
export function plainGradYear(raw: unknown): string | null {
  const t = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return /^\d{4}$/.test(t) ? t : null;
}

