/**
 * Which catalog school a pasted research link (or an added file) is about, for filing it under
 * Files › Policy & research › <School> (POST /colleges/research/folder).
 *
 * Regression: https://mitadmissions.org/apply/firstyear/deadlines-requirements/ (title "MIT First-Year
 * Application Deadlines & Requirements") was filed under General, "We didn't recognize a college in that
 * link": the matcher only looked for a school's name in the address's words or the school's own .edu
 * domain, and MIT's admissions site is neither.
 *
 * In order, the first that answers wins:
 *  1. The link's host: the school's own site or any subdomain of it (admissions.cornell.edu, apply.jhu.edu),
 *     else a known admissions site off the school's domain (ADMISSIONS_DOMAINS, e.g. mitadmissions.org).
 *     Parsed as a host, so a path or a query that merely mentions "mit.edu" doesn't count.
 *  2. A school's name or alias in the address's words (or the file name).
 *  3. A school's name or alias in the page's title (the route fetches it only when 1 and 2 found nothing).
 *
 * False positives are worse than General (a link filed under the wrong school is research AxIS then reads for
 * that school), so the name match is careful: whole words only, the longest match wins ("Penn State" over
 * "Penn"), a tie between two schools is no match, aliases that are ordinary words ("Cal", "Union", "State")
 * never match alone, and in a title an acronym or one-word alias matches only as written ("MIT", not "mit").
 */

export type CatalogSchool = { id: string; name: string; aka: string[]; website: string | null };
export type SchoolMatch = { id: string; name: string; by: "domain" | "admissions-domain" | "address" | "title" | "filename" };

/**
 * Official admissions sites that are not on the school's own domain, by host, mapped to the school's main
 * domain (the catalog's `website`, without "www."), so the entry finds the same school in every environment
 * whatever its catalog id. Keep it to sites the school itself runs; a shared system portal (one site for
 * several campuses) or an independent blog doesn't belong here. Subdomains of a listed host count too.
 */
export const ADMISSIONS_DOMAINS: Readonly<Record<string, string>> = {
  // MIT Admissions: the deadlines, requirements and the student blogs.
  "mitadmissions.org": "mit.edu",
};

/** Aliases that are ordinary words, or name a kind of school rather than one: never a match on their own. */
const GENERIC_ALIASES = new Set([
  "admission", "admissions", "american", "apply", "art", "arts", "cal", "campus", "central", "college", "community",
  "design", "general", "global", "institute", "international", "music", "national", "online", "school", "state",
  "tech", "union", "university",
]);

const MIN_ALIAS_CHARS = 3;

/** "www.mit.edu" / "https://www.mit.edu/x" -> "mit.edu"; null when it isn't a host. */
export function siteHost(website: string | null | undefined): string | null {
  if (!website) return null;
  const s = website.trim();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/\.$/, "");
    return host.includes(".") ? host.replace(/^www\d*\./, "") : null;
  } catch {
    return null;
  }
}

/** `host` is `site` or a subdomain of it, by whole labels ("mit.edu.example.com" is neither). */
export function hostWithin(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/** The school whose site (or a known admissions site of it) serves this host. Longest site wins; a tie is no match. */
export function schoolFromHost(host: string, colleges: CatalogSchool[]): SchoolMatch | null {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^www\d*\./, "");
  if (!h) return null;
  const pick = (site: string, by: SchoolMatch["by"]): SchoolMatch | null => {
    const hits = colleges.filter((c) => siteHost(c.website) === site);
    return hits.length === 1 ? { id: hits[0]!.id, name: hits[0]!.name, by } : null;
  };
  // The school's own site or a subdomain: the most specific site that contains the host.
  let best: { c: CatalogSchool; site: string } | null = null;
  let tie = false;
  for (const c of colleges) {
    const site = siteHost(c.website);
    if (!site || !hostWithin(h, site)) continue;
    if (!best || site.length > best.site.length) {
      best = { c, site };
      tie = false;
    } else if (site.length === best.site.length && best.c.id !== c.id) {
      tie = true;
    }
  }
  if (best && !tie) return { id: best.c.id, name: best.c.name, by: "domain" };
  if (best && tie) return null;
  for (const [admissions, site] of Object.entries(ADMISSIONS_DOMAINS)) {
    if (hostWithin(h, admissions)) return pick(site, "admissions-domain");
  }
  return null;
}

const isAcronym = (s: string) => /^[A-Z][A-Z0-9&]{1,7}$/.test(s);

/** Lower-cased words separated by single spaces, padded, for whole-word `includes`. */
function wordsOf(text: string, keepCase = false): string {
  const t = text
    .normalize("NFKC")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .trim();
  return ` ${keepCase ? t : t.toLowerCase()} `;
}

/**
 * A school named in free text: an address's words, a file name or a page title. `title` mode matches an
 * acronym alias only in capitals, since a title keeps its case and "mit" is a word in other languages.
 */
export function schoolInText(text: string, colleges: CatalogSchool[], mode: "address" | "filename" | "title"): SchoolMatch | null {
  const lower = wordsOf(text);
  const cased = wordsOf(text, true);
  let best: { c: CatalogSchool; len: number } | null = null;
  let tie = false;
  for (const c of colleges) {
    for (const raw of [c.name, ...c.aka]) {
      const n = raw.trim();
      const key = wordsOf(n).trim();
      if (key.length < MIN_ALIAS_CHARS) continue;
      // An alias that is one ordinary word names no school by itself; a school's full name always may.
      if (n !== c.name && !key.includes(" ") && GENERIC_ALIASES.has(key)) continue;
      // In a title an acronym ("MIT") or a one-word alias ("Brown", "Penn") must keep its capitals: "brown" or
      // "mit" in running text is a word, not a school.
      const exactCase = mode === "title" && (isAcronym(n) || (n !== c.name && !key.includes(" ")));
      const hit = exactCase ? cased.includes(` ${wordsOf(n, true).trim()} `) : lower.includes(` ${key} `);
      if (!hit) continue;
      if (!best || key.length > best.len) {
        best = { c, len: key.length };
        tie = false;
      } else if (key.length === best.len && best.c.id !== c.id) {
        tie = true;
      }
    }
  }
  if (!best || tie) return null;
  return { id: best.c.id, name: best.c.name, by: mode };
}

/** The host of an http(s) address, or null. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The address's path as words: "/apply/firstyear/deadlines" -> "apply firstyear deadlines". Not the host (it is
 * matched as a host above, and "mit" as a label of someone else's host is not MIT) and not the query.
 */
function addressWords(url: string): string {
  try {
    const path = new URL(url).pathname;
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  } catch {
    return "";
  }
}

/** The school a link is about, from its address alone (no fetch). */
export function schoolForAddress(url: string, colleges: CatalogSchool[]): SchoolMatch | null {
  const host = hostOf(url);
  return (host ? schoolFromHost(host, colleges) : null) ?? schoolInText(addressWords(url), colleges, "address");
}

/**
 * The school a research link or file is about. `pageTitle` is asked for only when the address names no school
 * (it fetches the page); a failed or slow fetch is no title, never an error.
 */
export async function schoolForResearch(
  input: { url: string | null; filename?: string | null; pageTitle?: () => Promise<string | null> },
  colleges: CatalogSchool[]
): Promise<SchoolMatch | null> {
  if (input.url) {
    const fromAddress = schoolForAddress(input.url, colleges);
    if (fromAddress) return fromAddress;
    if (!input.pageTitle) return null;
    let title: string | null = null;
    try {
      title = await input.pageTitle();
    } catch {
      title = null;
    }
    return title ? schoolInText(title.slice(0, 300), colleges, "title") : null;
  }
  return input.filename ? schoolInText(input.filename, colleges, "filename") : null;
}
