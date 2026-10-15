/**
 * Who and which school a question is about, resolved in code.
 *
 * Students: the counselor's roster, matched on full name, first plus last,
 * a unique first or last name, or a close spelling (Jaro-Winkler, for
 * "Sofia" against "Sophia"). A first name two students share is reported as
 * ambiguous rather than guessed.
 *
 * Colleges: the whole catalog compiled once per process into a token trie of
 * official names, curated aliases, well-known abbreviations and unique short
 * forms ("Cornell" for Cornell University). A question is scanned left to
 * right taking the longest match at each position, so "Boston College" is
 * never read as "Boston", in time linear in the question's length.
 */
import type { FastifyRequest } from "fastify";
import { TtlLru, sharedLoad } from "./cache.js";
import { fromPostgrest } from "../errors.js";
import { COLLEGE_ABBREVIATIONS, COMMON_WORDS, MULTIWORD_PLACES, STATE_NAMES } from "./lexicon.js";
import { fold } from "./text.js";

// ---- Tokens with their surface form -------------------------------------------------

export type Tok = {
  norm: string;
  /** Has a capital letter as typed. */
  cap: boolean;
  /** First word of a sentence, where a capital says nothing. */
  sentenceStart: boolean;
  possessive: boolean;
  prev: string | null;
};

const SENTENCE_END = new Set([".", "!", "?", ":", "\n", "•", "*", "-"]);

/**
 * Whether the token at `at` opens a sentence: nothing but whitespace before
 * it, or a sentence mark and then only whitespace. That is
 * `!/\S/.test(before) || /[.!?:\n•*-]\s*$/.test(before)` on the text before
 * the token, read backwards from the token instead, so a message costs time
 * linear in its length (the expressions read the whole prefix for every
 * token, and rescanned a run of newlines from each one).
 */
function startsSentence(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0) {
    const c = text[i]!;
    // A newline is both whitespace and a sentence mark.
    if (c === "\n") return true;
    if (!/\s/.test(c)) return SENTENCE_END.has(c);
    i--;
  }
  return true;
}

export function scanTokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const possessive = /['’]s$/i.test(raw);
    const core = raw.replace(/['’]s$/i, "").replace(/['’]/g, "");
    out.push({
      norm: fold(core),
      cap: /\p{Lu}/u.test(core),
      sentenceStart: startsSentence(text, m.index),
      possessive,
      prev: out.length ? out[out.length - 1]!.norm : null,
    });
  }
  return out;
}

// ---- Jaro-Winkler ---------------------------------------------------------------------

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ---- Students ---------------------------------------------------------------------------

export type RosterRow = { id: string; name: string };

export type StudentMention = {
  id: string;
  name: string;
  /** 1 full name, 0.95 first + last, 0.85 unique first, 0.8 unique last, 0.7 close spelling, 0.6 pronoun. */
  score: number;
  via: "full" | "first+last" | "first" | "last" | "fuzzy" | "pronoun";
};

export type AmbiguousMention = { text: string; candidates: RosterRow[] };

export class RosterIndex {
  private readonly rows: RosterRow[];
  private readonly parts = new Map<string, string[]>();
  private readonly byFirst = new Map<string, string[]>();
  private readonly byLast = new Map<string, string[]>();
  private readonly byId = new Map<string, RosterRow>();

  constructor(rows: RosterRow[]) {
    this.rows = rows.filter((r) => r.name.trim());
    for (const r of this.rows) {
      const p = r.name.split(/[\s-]+/).map((x) => fold(x).replace(/['’.]/g, "")).filter((x) => x.length >= 2);
      if (!p.length) continue;
      this.parts.set(r.id, p);
      this.byId.set(r.id, r);
      const push = (m: Map<string, string[]>, k: string) => m.set(k, [...(m.get(k) ?? []), r.id]);
      push(this.byFirst, p[0]!);
      if (p.length > 1) push(this.byLast, p[p.length - 1]!);
    }
  }

  get size(): number {
    return this.rows.length;
  }

  get(id: string): RosterRow | undefined {
    return this.byId.get(id);
  }

  match(text: string): { students: StudentMention[]; ambiguous: AmbiguousMention[] } {
    const toks = scanTokens(text);
    const found = new Map<string, StudentMention>();
    const ambiguous: AmbiguousMention[] = [];
    const take = (id: string, score: number, via: StudentMention["via"]) => {
      const prev = found.get(id);
      if (!prev || prev.score < score) found.set(id, { id, name: this.byId.get(id)!.name, score, via });
    };
    const lastNamesPresent = new Set(toks.map((t) => t.norm).filter((n) => this.byLast.has(n)));

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      const next = toks[i + 1];
      // A word that is also a common English word counts only when it reads as a name.
      const nameLike = !COMMON_WORDS.has(t.norm) || (t.cap && (!t.sentenceStart || t.possessive));

      if (next) {
        for (const id of this.byFirst.get(t.norm) ?? []) {
          const p = this.parts.get(id)!;
          if (p.length > 1 && p[p.length - 1] === next.norm) take(id, p.length === 2 ? 1 : 0.95, p.length === 2 ? "full" : "first+last");
        }
      }
      if (!nameLike) continue;

      const firsts = this.byFirst.get(t.norm) ?? [];
      if (firsts.length === 1) take(firsts[0]!, 0.85, "first");
      else if (firsts.length > 1) {
        // Two Sophias: a last name elsewhere in the message decides; otherwise it stays ambiguous.
        const narrowed = firsts.filter((id) => {
          const p = this.parts.get(id)!;
          return p.length > 1 && lastNamesPresent.has(p[p.length - 1]!);
        });
        if (narrowed.length === 1) take(narrowed[0]!, 0.95, "first+last");
        else if (!firsts.some((id) => found.has(id))) {
          ambiguous.push({ text: t.norm, candidates: firsts.map((id) => this.byId.get(id)!) });
        }
      }
      const lasts = this.byLast.get(t.norm) ?? [];
      if (lasts.length === 1 && t.norm.length >= 3 && !firsts.length) take(lasts[0]!, 0.8, "last");

      if (!firsts.length && !lasts.length && t.cap && t.norm.length >= 4 && (!t.sentenceStart || t.possessive)) {
        let best: { id: string; s: number } | null = null;
        let second = 0;
        for (const [first, ids] of this.byFirst) {
          if (first[0] !== t.norm[0]) continue;
          const s = jaroWinkler(t.norm, first);
          if (ids.length !== 1) continue;
          if (!best || s > best.s) {
            second = best?.s ?? second;
            best = { id: ids[0]!, s };
          } else if (s > second) second = s;
        }
        if (best && best.s >= 0.9 && best.s - second >= 0.03) take(best.id, 0.7, "fuzzy");
      }
    }
    const resolvedIds = new Set(found.keys());
    return {
      students: [...found.values()].sort((a, b) => b.score - a.score),
      ambiguous: ambiguous.filter((a) => !a.candidates.some((c) => resolvedIds.has(c.id))),
    };
  }
}

// ---- Colleges -----------------------------------------------------------------------------

export type CatalogRow = {
  id: string;
  name: string;
  search_name: string | null;
  search_aka_list: string[] | null;
  catalog_source: string | null;
};

export type CollegeMention = {
  id: string;
  name: string;
  /** 1 official name, 0.95 alias or abbreviation, 0.85 unique short form, 0.8 short form of the curated school. */
  score: number;
  via: "name" | "alias" | "short" | "pronoun";
  span: string;
};

export type AmbiguousCollege = { span: string; candidates: { id: string; name: string }[] };

type TrieNode = { next: Map<string, TrieNode>; hit?: { ids: string[]; score: number; via: CollegeMention["via"] } };

const GENERIC = new Set(["the", "of", "at", "in", "and", "for", "university", "college", "institute", "school", "campus", "main", "inc"]);

export class CollegeIndex {
  private readonly root: TrieNode = { next: new Map() };
  private readonly names = new Map<string, string>();

  constructor(rows: CatalogRow[]) {
    const curated = new Set(rows.filter((r) => r.catalog_source === "meridies").map((r) => r.id));
    const bySearchName = new Map<string, string[]>();
    for (const r of rows) {
      this.names.set(r.id, r.name);
      const sn = (r.search_name ?? "").trim();
      if (sn) {
        bySearchName.set(sn, [...(bySearchName.get(sn) ?? []), r.id]);
        this.insert(sn, r.id, 1, "name");
      }
      for (const aka of r.search_aka_list ?? []) if (aka.trim()) this.insert(aka.trim(), r.id, 0.95, "alias");
    }
    for (const [abbr, targets] of Object.entries(COLLEGE_ABBREVIATIONS)) {
      for (const target of targets) {
        const ids = bySearchName.get(target) ?? bySearchName.get(target.replace(/^the /, ""));
        if (ids?.length === 1) {
          this.insert(abbr, ids[0]!, 0.95, "alias");
          break;
        }
      }
    }
    // Short forms, kept only where they point at one school: the name without
    // its campus ("University of Michigan" from "University of Michigan-Ann
    // Arbor"), and either form without its generic words ("Cornell").
    const norm = (s: string) =>
      s
        .split(/[^\p{L}\p{N}']+/u)
        .map((w) => fold(w).replace(/'/g, ""))
        .filter(Boolean);
    const shortForms = new Map<string, Set<string>>();
    const addShort = (form: string, id: string) => {
      if (!form || STATE_NAMES.has(form) || MULTIWORD_PLACES.has(form)) return;
      shortForms.set(form, (shortForms.get(form) ?? new Set()).add(id));
    };
    for (const r of rows) {
      const own = (r.search_name ?? "").trim();
      const campusless = r.name.split(/\s+-\s+|-(?=\p{Lu})/u)[0] ?? r.name;
      for (const base of new Set([r.name, campusless])) {
        const words = norm(base);
        const whole = words.join(" ");
        if (whole !== own) addShort(whole, r.id);
        const stripped = words.filter((w) => !GENERIC.has(w)).join(" ");
        if (stripped !== own) addShort(stripped, r.id);
      }
    }
    for (const [short, ids] of shortForms) {
      if (ids.size === 1) this.insert(short, [...ids][0]!, 0.85, "short");
      else {
        const cur = [...ids].filter((id) => curated.has(id));
        if (cur.length === 1) this.insert(short, cur[0]!, 0.8, "short");
      }
    }
  }

  private insert(phrase: string, id: string, score: number, via: CollegeMention["via"]): void {
    const parts = phrase.split(" ").filter(Boolean);
    if (!parts.length) return;
    let node = this.root;
    for (const p of parts) {
      let n = node.next.get(p);
      if (!n) {
        n = { next: new Map() };
        node.next.set(p, n);
      }
      node = n;
    }
    if (!node.hit || node.hit.score < score) node.hit = { ids: [id], score, via };
    else if (node.hit.score === score && !node.hit.ids.includes(id)) node.hit.ids.push(id);
  }

  name(id: string): string | undefined {
    return this.names.get(id);
  }

  get size(): number {
    return this.names.size;
  }

  match(text: string): { colleges: CollegeMention[]; ambiguous: AmbiguousCollege[] } {
    const toks = scanTokens(text);
    const colleges = new Map<string, CollegeMention>();
    const ambiguous: AmbiguousCollege[] = [];
    let i = 0;
    while (i < toks.length) {
      let node: TrieNode | undefined = this.root;
      let best: { end: number; hit: NonNullable<TrieNode["hit"]> } | null = null;
      for (let j = i; j < toks.length && node; j++) {
        node = node.next.get(toks[j]!.norm);
        if (node?.hit) best = { end: j, hit: node.hit };
      }
      if (!best || !this.acceptable(toks, i, best.end)) {
        i++;
        continue;
      }
      const span = toks.slice(i, best.end + 1).map((t) => t.norm).join(" ");
      if (best.hit.ids.length === 1) {
        const id = best.hit.ids[0]!;
        const prev = colleges.get(id);
        if (!prev || prev.score < best.hit.score) colleges.set(id, { id, name: this.names.get(id) ?? span, score: best.hit.score, via: best.hit.via, span });
      } else {
        ambiguous.push({ span, candidates: best.hit.ids.slice(0, 5).map((id) => ({ id, name: this.names.get(id) ?? id })) });
      }
      i = best.end + 1;
    }
    return { colleges: [...colleges.values()], ambiguous };
  }

  /**
   * A one-word match has to read as a school: not a place after "in" or
   * "from", and either typed with a capital or distinctive enough lowercase
   * (not an everyday word, not a short token like "bc" or "act").
   */
  private acceptable(toks: Tok[], start: number, end: number): boolean {
    if (end > start) return true;
    const t = toks[start]!;
    if (t.norm.length < 2) return false;
    if (t.prev && LOCATION_PREPOSITIONS.has(t.prev)) return false;
    if (COMMON_WORDS.has(t.norm)) return t.cap && (!t.sentenceStart || t.possessive);
    if (t.norm.length <= 2 || RISKY_SHORT.has(t.norm)) return t.cap;
    return true;
  }
}

const LOCATION_PREPOSITIONS = new Set(["in", "from", "near", "around", "across", "outside", "within"]);
/** Short tokens that are also everyday shorthand ("bc" for because, "ACT" the test): only with capitals. */
const RISKY_SHORT = new Set(["bc", "bu", "uf", "uc", "ed", "ea", "rd", "ap", "ib", "act", "sat", "gpa", "cds", "css", "ps", "us", "it", "art", "ace", "cal", "am", "pm"]);

// ---- Loading ----------------------------------------------------------------------------

const PAGE = 1000;
const collegeIndexCache = new TtlLru<Promise<CollegeIndex>>(1, 6 * 60 * 60 * 1000);

/**
 * The catalog index, built once per process and kept six hours (the catalog
 * changes monthly). Read through the caller's client: the catalog is readable
 * by every signed-in user. Pages of 1,000 because PostgREST caps a response.
 */
export function loadCollegeIndex(request: FastifyRequest): Promise<CollegeIndex> {
  return sharedLoad(collegeIndexCache, "catalog", async () => {
    const head = await request.db.from("colleges").select("id", { count: "exact", head: true });
    if (head.error) throw fromPostgrest(head.error);
    const total = Math.min(head.count ?? 0, 20_000);
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(total / PAGE) || 1 }, (_, p) =>
        request.db
          .from("colleges")
          .select("id, name, search_name, search_aka_list, catalog_source")
          .order("id")
          .range(p * PAGE, p * PAGE + PAGE - 1)
      )
    );
    const rows: CatalogRow[] = [];
    for (const page of pages) {
      if (page.error) throw fromPostgrest(page.error);
      rows.push(...((page.data ?? []) as CatalogRow[]));
    }
    return new CollegeIndex(rows);
  });
}
