/**
 * How the Application page lays out a student's supplements: per school (a
 * header per college, a compact row per prompt) or combined (one read-only,
 * document-style page with every school's prompts in order and the student's
 * own text under each).
 *
 * Two inputs decide it, both deterministic:
 *  - the counselor's choice, stored per student as `supplementsLayout` in
 *    `profiles.profile` (no migration; `PUT /application/supplements-layout`);
 *  - when there is no choice, `detectOneDocument`: every supplement row that has
 *    something behind it (an upload, a Drive / OneDrive import, a pasted link, a
 *    supplement Doc) points at the same document, so the student writes their
 *    supplements in one place and the combined page reads like it.
 *
 * Nothing here writes or rewrites essay text. `combinedSections` only cuts a
 * shared document's own text at the lines holding its prompts' wording
 * (`splitAtPrompts`, the same line-based split a supplement Doc's sync uses in
 * `splitAnswers`, loosened to a prompt that follows a label like "Stanford:";
 * found in code, never a model's offsets), for display; the stored body and its
 * word count are untouched.
 */

type Row = Record<string, unknown>;

export const SUPPLEMENT_LAYOUTS = ["per-school", "combined"] as const;
export type SupplementLayout = (typeof SUPPLEMENT_LAYOUTS)[number];

/** The key in `profiles.profile` that holds the counselor's choice. */
export const LAYOUT_PROFILE_KEY = "supplementsLayout";

export function readLayoutPreference(profile: unknown): SupplementLayout | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const v = (profile as Row)[LAYOUT_PROFILE_KEY];
  return v === "per-school" || v === "combined" ? v : null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** A Google Doc's file id from any of its URLs (/edit, /view, ?usp=sharing, /u/1/...). */
const GDOC_ID = /docs\.google\.com\/(?:[^/]+\/)*document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/;

/** A link with its fragment dropped and its host lowercased; the query stays (OneDrive and SharePoint need it). */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * What an essay row's text comes from, as one comparable key; null when the
 * row has nothing behind it yet. A link wins over the document row, so two
 * imports of the same Drive file (two `documents` rows) are the same source.
 */
export function sourceKeyOf(row: Row): string | null {
  const doc = (row.document ?? null) as Row | null;
  const sdoc = (row.supplement_doc ?? null) as Row | null;
  const url = (sdoc ? s(sdoc.web_url) : null) ?? (doc ? s(doc.external_web_url) : null) ?? s(row.external_url);
  if (url) {
    const gdoc = url.match(GDOC_ID);
    if (gdoc) return `gdoc:${gdoc[1]}`;
    const norm = normalizeUrl(url);
    if (norm) return `url:${norm}`;
  }
  const sdocId = s(row.supplement_doc_id);
  if (sdocId) return `sdoc:${sdocId}`;
  const docId = s(row.document_id);
  if (docId) return `doc:${docId}`;
  return null;
}

export type OneDocument = {
  /** The supplement rows filed from it, in the order given. */
  essayIds: string[];
  /** How many schools on the list those rows belong to. */
  schoolCount: number;
  /** The file's name when it is an upload or import, else null (a link). */
  name: string | null;
};

const isSupplement = (r: Row) => (r.essay_kind ?? "supplement") === "supplement";

/**
 * "All of the student's supplements are in one document": at least two
 * supplement rows have a source, and every one of them is the same source.
 * Rows with nothing behind them yet (a prompt not started) don't count either
 * way; a personal statement or a material (`other`) is never a supplement.
 */
export function detectOneDocument(rows: Row[]): OneDocument | null {
  const sourced = rows.filter(isSupplement).map((r) => ({ r, key: sourceKeyOf(r) })).filter((x) => x.key !== null);
  if (sourced.length < 2) return null;
  const key = sourced[0]!.key;
  if (!sourced.every((x) => x.key === key)) return null;
  const schools = new Set(sourced.map((x) => s(x.r.student_college_id) ?? "none"));
  const named = sourced.map((x) => s(((x.r.document ?? null) as Row | null)?.filename)).find((n) => n !== null) ?? null;
  return { essayIds: sourced.map((x) => String(x.r.id)), schoolCount: schools.size, name: named };
}

/** The layout the page opens in: the counselor's choice, else Combined when it's all one document. */
export function effectiveLayout(preferred: SupplementLayout | null, oneDocument: OneDocument | null): SupplementLayout {
  return preferred ?? (oneDocument ? "combined" : "per-school");
}

// ---- The combined page's text -----------------------------------------------------

/** How much of one row's text the combined page carries. */
export const COMBINED_TEXT_CAP = 20_000;

export type CombinedSection = {
  essayId: string;
  /** The text shown under the prompt; null when there is none to show. */
  text: string | null;
  /**
   * `row`: the row's own text. `split`: this prompt's part of a document the
   * rows share. `shared`: the whole shared document (its prompts couldn't be
   * found in it); the page shows it once and points back to it.
   */
  from: "row" | "split" | "shared";
  truncated: boolean;
};

/** The shortest prompt wording looked for in a shared document: shorter ones ("Why us?") match ordinary lines. */
const MIN_PROMPT_CHARS = 30;
/** How much of a prompt is matched, so a pasted prompt cut short at the end still matches. */
const PROMPT_KEY_CHARS = 80;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Each prompt's answer in one shared document: the lines after the one holding
 * the prompt's wording, up to the next such line (a rule of underscores or
 * dashes dropped). Null for a prompt too short to look for, not in the text, or
 * on more than one line. The answer is the document's own lines, trimmed.
 */
export function splitAtPrompts(text: string, prompts: string[]): (string | null)[] {
  const lines = text.split("\n");
  const keys = lines.map(squash);
  const starts = prompts.map((p) => {
    const key = squash(p).slice(0, PROMPT_KEY_CHARS).trim();
    if (key.length < MIN_PROMPT_CHARS) return -1;
    const at = keys.findIndex((k) => k.includes(key));
    if (at < 0 || keys.findIndex((k, i) => i > at && k.includes(key)) >= 0) return -1;
    return at;
  });
  return prompts.map((_, i) => {
    const start = starts[i]!;
    if (start < 0) return null;
    const later = starts.filter((s) => s > start);
    const end = later.length > 0 ? Math.min(...later) : lines.length;
    return lines
      .slice(start + 1, end)
      .filter((l) => !/^\s*[_\-\u2014\u2013=*]{3,}\s*$/.test(l))
      .join("\n")
      .trim();
  });
}

const clip = (t: string): { text: string; truncated: boolean } =>
  t.length > COMBINED_TEXT_CAP ? { text: t.slice(0, COMBINED_TEXT_CAP), truncated: true } : { text: t, truncated: false };

/**
 * The text under each supplement row on the combined page. Rows that share a
 * source and carry the same text (one document filed on several prompts) are
 * split at their prompts when every one is found; otherwise each row shows its
 * own text. Only ever the student's text, cut, never written.
 */
export function combinedSections(rows: Row[]): CombinedSection[] {
  const supplements = rows.filter(isSupplement);
  const byKey = new Map<string, Row[]>();
  for (const r of supplements) {
    const key = sourceKeyOf(r);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const split = new Map<string, { text: string | null; from: CombinedSection["from"] }>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const bodies = group.map((r) => (typeof r.body === "string" ? r.body.trim() : ""));
    if (!bodies[0] || !bodies.every((b) => b === bodies[0])) continue;
    const parts = splitAtPrompts(String(group[0]!.body), group.map((r) => (typeof r.prompt === "string" ? r.prompt : "")));
    const whole = parts.every((p) => p !== null);
    group.forEach((r, i) => split.set(String(r.id), whole ? { text: parts[i]!.trim() || null, from: "split" } : { text: bodies[0]!, from: "shared" }));
  }
  return supplements.map((r) => {
    const id = String(r.id);
    const hit = split.get(id);
    const raw = hit ? hit.text : typeof r.body === "string" && r.body.trim() ? r.body.trim() : null;
    if (raw === null) return { essayId: id, text: null, from: hit?.from ?? "row", truncated: false };
    const c = clip(raw);
    return { essayId: id, text: c.text, from: hit?.from ?? "row", truncated: c.truncated };
  });
}
