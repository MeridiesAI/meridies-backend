/**
 * The free-text rule (AxIS security PR B, spec §3.2). Text someone other than the counselor wrote flags an AxIS
 * turn (every change it proposes waits for Confirm) only when it is free text: a document, an essay body, a chat
 * file, email, a connected file, a web page, or any other student-written value over SHORT_FIELD_MAX characters
 * (an activity description, a long intake answer). Short structured fields (names, titles, dates, statuses, a
 * college list, deadlines) don't, because an 80-character field can't carry much of an instruction.
 *
 * The rule is judged on what was sent: each untrusted block says whether it is free (`Section.untrusted[].free`,
 * set by the loaders from the values they joined), and a short block is rendered with `length="short"` so
 * `freeBlocks` can tell them apart in a built prompt. A block that says nothing counts as free.
 */
import type { Section } from "./pack.js";

/** The longest student-written value that is still a short field. */
export const SHORT_FIELD_MAX = 80;

/** Source prefixes (before any ":") whose text is free whatever its length. */
export const FREE_SOURCES: ReadonlySet<string> = new Set([
  "document",
  "essay",
  "attachment",
  "file",
  "email",
  "mail",
  "connected-file",
  "drive",
  "onedrive",
  "web",
  "page",
  "link",
]);

const prefixOf = (source: string) => source.split(":")[0]!.trim().toLowerCase();

/** Whether one untrusted entry is free text: a free source, or longer than a short field. */
export function isFree(source: string, text: string): boolean {
  return FREE_SOURCES.has(prefixOf(source)) || text.trim().length > SHORT_FIELD_MAX;
}

/**
 * Whether any of the values a loader joined is longer than a short field. Arrays and objects are searched, their
 * keys too (a key is printed like a value); anything nested deeper than the search goes counts as long.
 */
export function anyLong(values: unknown[]): boolean {
  const long = (v: unknown, depth: number): boolean => {
    if (typeof v === "string") return v.trim().length > SHORT_FIELD_MAX;
    if (v === null || typeof v !== "object") return false;
    if (depth > 8) return true;
    if (Array.isArray(v)) return v.some((x) => long(x, depth + 1));
    return Object.entries(v).some(([k, x]) => k.trim().length > SHORT_FIELD_MAX || long(x, depth + 1));
  };
  return values.some((v) => long(v, 0));
}

const BLOCK = /<data source="([^"]*)" kind="untrusted"( length="short")?>([\s\S]*?)<\/data>/g;
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The free untrusted blocks in a built prompt, unescaped. (Block text escapes `<`, so a block can't end early.) */
export function freeBlocks(rendered: string): { source: string; text: string }[] {
  const out: { source: string; text: string }[] = [];
  for (const m of rendered.matchAll(BLOCK)) {
    if (m[2]) continue;
    out.push({ source: unescape(m[1] ?? ""), text: unescape(m[3] ?? "") });
  }
  return out;
}

export function hasFreeText(rendered: string): boolean {
  return freeBlocks(rendered).length > 0;
}

/** Whether an entry counts as free: what its loader said, else the rule. */
export const entryFree = (u: { source: string; text: string; free?: boolean }) => u.free ?? isFree(u.source, u.text);

// ---- shortOnly: a question turn's record without the free text ----

const NOUNS: Record<string, [string, string]> = {
  activity: ["activity description", "activity descriptions"],
  "activity-details": ["activity entry", "activity entries"],
  headline: ["headline", "headlines"],
  intake: ["intake answer", "intake answers"],
  essay: ["essay body", "essay bodies"],
  "essay-details": ["essay list", "essay lists"],
  document: ["document", "documents"],
};

/**
 * "6 activity descriptions, 1 document (named below)" for what was left out of one section: counts only, because
 * the body is server text. A left-out document's name was written by a student, an import or Drive, so the
 * names go in a short data block of their own.
 */
function leftOutLine(section: Section, dropped: { source: string }[]): { line: string; names: string[] } {
  const groups = new Map<string, { nouns: [string, string]; n: number }>();
  const names: string[] = [];
  for (const d of dropped) {
    const prefix = prefixOf(d.source);
    const nouns = NOUNS[prefix] ?? ([`${section.label.toLowerCase()} entry`, `${section.label.toLowerCase()} entries`] as [string, string]);
    const g = groups.get(prefix) ?? { nouns, n: 0 };
    g.n += 1;
    if (prefix === "document") names.push(d.source.slice(d.source.indexOf(":") + 1));
    groups.set(prefix, g);
  }
  const parts = [...groups.entries()].map(([prefix, g]) => `${g.n} ${g.n === 1 ? g.nouns[0] : g.nouns[1]}${prefix === "document" ? " (named below)" : ""}`);
  return { line: `Left out, read with get_student_record: ${parts.join(", ")}`, names };
}

/** A document name as its entry's source label carries it (lib/context/sections.ts tag): one line, at most 80. */
const asTagged = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * A question turn's record (spec §3.2): each section keeps its short fields inline and leaves out its free
 * entries, with a line in its body saying what exists so AxIS can fetch it with a lookup (which flags the turn).
 * Judged on every section, whatever its outside mark (a Research task's title is the counselor's section but a
 * web page's words); what the counselor wrote is never free (the loaders mark it short), so it stays.
 */
export function leaveOutFree(sections: Section[]): Section[] {
  return sections.map((s) => {
    if (!s.untrusted?.length) return s;
    const kept = s.untrusted.filter((u) => !entryFree(u));
    const dropped = s.untrusted.filter((u) => entryFree(u));
    if (dropped.length === 0) return s;
    const { line, names } = leftOutLine(s, dropped);
    const droppedDocs = new Set(names);
    return {
      ...s,
      body: [s.body, line].filter(Boolean).join("\n"),
      untrusted: [...kept, ...(names.length ? [{ source: "left-out", text: names.join("\n"), free: false }] : [])],
      ...(s.items ? { items: s.items.filter((i) => !droppedDocs.has(asTagged(i))) } : {}),
    };
  });
}
