/**
 * Live grounding: every figure in the answer is checked against what AxIS
 * read, sentence by sentence, while the answer streams.
 *
 * Numbers are where a fluent answer goes wrong without anyone noticing: a GPA
 * one hundredth off, last year's admit rate, a deadline on the wrong day. So
 * the evidence (the student record, the roster, every numbered passage, the
 * counselor's own question) is indexed once per turn into numbers, calendar
 * days and stated counts, each with the line, passage and text it sits in. As each sentence of the answer completes, its figures
 * are extracted and looked up:
 *
 *   found     the value is in the evidence at the precision written (3.874 on
 *             file supports "3.87"; 12.3% supports "12%"; never "4" for 3.874),
 *             with the year when both sides state one, and, when the sentence
 *             names a school or student, next to that name (Cornell's 7.3%
 *             does not support "Brown admits 7.3%")
 *   derived   it is the sum or difference of two figures in the same
 *             sentence that were found ("30 points above the 1490 median"
 *             next to a found 1520)
 *   missing   neither
 *
 * Each cited sentence also gets a support score: the share of its content
 * words that appear in the passages it cites. The client marks what's
 * missing or weakly cited as it arrives; only that residue is sent to the
 * model adjudicator after the answer (lib/axis/verify.ts), not the whole
 * answer.
 */
import { MONTHS } from "./dates.js";
import type { SourceLedger } from "./ledger.js";
import { contentStems, fold, SentenceStream, stem, STOPWORDS, tokens } from "./text.js";

export type FigureKind = "number" | "percent" | "money" | "date" | "count";
export type Figure = {
  text: string;
  kind: FigureKind;
  value: number;
  /** Precision written, as decimal places: "3.87" 2, "$31k" -3, "$12.5k" -2. */
  decimals: number;
  day?: string;
  /** A date's year, when the sentence states one. */
  year?: number;
  /** Where the figure starts in the sentence (citation markers count as spaces). */
  at?: number;
  /** Significant digits written: "4" 1, "3.9" 2, "$31k" 2. */
  sig?: number;
  /** Written as a scale ("4.0 scale", "out of 4.0"), not a score. */
  scale?: boolean;
  /** Marked approximate ("about 7%"). */
  hedged?: boolean;
  /** count: the thing counted, stemmed ("2 overdue tasks" -> "task"). */
  noun?: string;
};
export type FigureStatus = "found" | "derived" | "missing";

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const SCORE_WORDS = /\b(sat|act|psat|score|scores|scored|rank|ranked|gpa|ap|ib|composite|superscore|percentile)\b/i;
const MONEY_WORDS = /\$|\b(price|cost|costs|tuition|aid|scholarship|scholarships|budget|fee|fees|income|loan|loans|grant|grants|dollars?|usd)\b/i;
const HEDGE = /\b(?:about|around|roughly|approximately|approx\.?|nearly|almost|close to|just (?:under|over|below|above))\s*$|~\s*$/i;
const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})/g;
/** Spans of time and units are measured, not counted things on file. */
const NOT_COUNTED = new Set(["day", "week", "month", "year", "hour", "minute", "second", "point", "time", "percent", "am", "pm", "of"]);
const pad = (n: number) => String(n).padStart(2, "0");
const decimalsOf = (s: string) => (s.includes(".") ? s.split(".")[1]!.length : 0);
const sigOf = (s: string) => s.replace(/[^\d]/g, "").replace(/^0+/, "").length || 1;
const roundTo = (v: number, d: number) => (d >= 0 ? Math.round(v * 10 ** d) / 10 ** d : Math.round(v / 10 ** -d) * 10 ** -d);
const isScale = (before: string, after: string) => /^\s*(?:-?\s*point\s+)?scale\b/i.test(after) || /(?:out of|\/)\s*$/i.test(before);

/**
 * The thing a small number counts: up to three words after it, stopping at a stopword or punctuation
 * ("3 overdue tasks;" -> task). Null when nothing countable follows.
 */
function countHead(text: string, from: number): { noun: string; end: number } | null {
  const re = /\s+([A-Za-z][A-Za-z-]*)/y;
  re.lastIndex = from;
  let last: string | null = null;
  let end = from;
  for (let i = 0; i < 3; i++) {
    const m = re.exec(text);
    if (!m) break;
    const w = m[1]!.toLowerCase();
    if (STOPWORDS.has(w) && w !== "most" && w !== "more") break;
    last = w;
    end = re.lastIndex;
  }
  if (!last) return null;
  const noun = stem(last);
  return NOT_COUNTED.has(noun) || MONTHS[last] !== undefined ? null : { noun, end };
}

/**
 * Pulls the figures out of one sentence, longest patterns first so "$12,000" isn't also read as "12" and "000".
 * With `counts`, a small number followed by what it counts ("2 overdue tasks") comes back as a count; the
 * check keeps it only when the evidence states a count of the same thing.
 */
export function extractFigures(sentence: string, opts: { counts?: boolean } = {}): Figure[] {
  // Citation markers become spaces of the same length, so positions match the sentence's own.
  const base = sentence.replace(/\[S\d{1,3}\]/g, (m) => " ".repeat(m.length));
  let s = base;
  const out: Figure[] = [];
  // Each pattern blanks what it matched (same length, so offsets stay valid) before the next one runs.
  const take = (re: RegExp, fn: (m: string[], at: number) => Figure | Figure[] | null) => {
    s = s.replace(re, (...args: unknown[]) => {
      const hasGroups = typeof args[args.length - 1] === "object";
      const at = Number(args[args.length - (hasGroups ? 3 : 2)]);
      const m = args.slice(0, args.length - (hasGroups ? 3 : 2)).map((x) => (x === undefined ? "" : String(x)));
      const f = fn(m, at);
      if (f) out.push(...(Array.isArray(f) ? f : [f]));
      return " ".repeat(m[0]!.length);
    });
  };
  const ctx = (at: number, len: number) => ({
    hedged: HEDGE.test(base.slice(Math.max(0, at - 24), at)),
    scale: isScale(base.slice(Math.max(0, at - 10), at), base.slice(at + len, at + len + 16)),
  });
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, at) => ({ text: m[0], kind: "date", value: 0, decimals: 0, day: `${m[2]}-${m[3]}`, year: Number(m[1]), at }));
  take(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m, at) => {
    const month = MONTHS[m[1]!.toLowerCase()];
    const day = Number(m[2]);
    if (month === undefined || day < 1 || day > 31) return null;
    return { text: m[0], kind: "date", value: 0, decimals: 0, day: `${pad(month + 1)}-${pad(day)}`, ...(m[3] ? { year: Number(m[3]) } : {}), at };
  });
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (m, at) => {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    return { text: m[0], kind: "date", value: 0, decimals: 0, day: `${pad(mo)}-${pad(d)}`, ...(year ? { year } : {}), at };
  });
  take(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|K|thousand|million|M)\b)?/g, (m, at) => {
    const digits = `${m[1]!.replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`;
    const exp = m[3] ? (/^m/i.test(m[3]) ? 6 : 3) : 0;
    return { text: m[0], kind: "money", value: Number(digits) * 10 ** exp, decimals: decimalsOf(digits) - exp, sig: sigOf(digits), at, ...ctx(at, m[0].length) };
  });
  take(/\b(\d+(?:\.\d+)?)\s?(%|percent\b)/g, (m, at) => ({ text: m[0], kind: "percent", value: Number(m[1]), decimals: decimalsOf(m[1]!), sig: sigOf(m[1]!), at, ...ctx(at, m[0].length) }));
  take(/\b(\d{2,4})\s?[–-]\s?(\d{2,4})\b/g, (m, at) => [
    { text: m[1]!, kind: "number", value: Number(m[1]), decimals: 0, sig: sigOf(m[1]!), at },
    { text: m[2]!, kind: "number", value: Number(m[2]), decimals: 0, sig: sigOf(m[2]!), at: at + m[0].lastIndexOf(m[2]!) },
  ]);
  take(/\b\d+\.\d+\b/g, (m, at) => ({ text: m[0], kind: "number", value: Number(m[0]), decimals: decimalsOf(m[0]), sig: sigOf(m[0]), at, ...ctx(at, m[0].length) }));
  // Whole numbers: 100 and up (scores, prices, enrollments), or smaller ones next to a score word ("ACT 34").
  // Bare years are left alone. A small number before what it counts ("2 overdue tasks") is a count.
  take(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (m, at) => {
    const value = Number(m[0]!.replace(/,/g, ""));
    const near = base.slice(Math.max(0, at - 24), at + m[0]!.length + 12);
    if (value >= 1900 && value <= 2100 && !SCORE_WORDS.test(near)) return null;
    if (value < 100 && !(value >= 1 && SCORE_WORDS.test(near))) {
      if (!opts.counts || /[\d.,/:$-]$/.test(base.slice(0, at))) return null;
      const head = countHead(base, at + m[0]!.length);
      return head ? { text: base.slice(at, head.end), kind: "count", value, decimals: 0, sig: 2, noun: head.noun, at } : null;
    }
    return { text: m[0], kind: "number", value, decimals: 0, sig: sigOf(m[0]!), at, ...ctx(at, m[0]!.length) };
  });
  return out;
}

type Scope = { line: Set<string>; passage: Set<string>; text: Set<string>; counselor: boolean };
type Occurrence =
  | { kind: "num"; value: number; decimals: number; money: boolean; scale: boolean; scope: Scope }
  | { kind: "day"; day: string; year?: number; scope: Scope }
  | { kind: "count"; value: number; noun: string; scope: Scope };
type Group = Set<string>;
type Ref = { start: number; end: number; ref: Group | "subject" | "any" };

/** Capitalized words that label a figure rather than name a school, a student or a thing. */
const GENERIC = new Set([
  ...Object.keys(MONTHS),
  ..."sunday monday tuesday wednesday thursday friday saturday".split(" "),
  ...(
    "gpa sat act psat ap ib ed ea rea rd ed2 ea2 ed1 early regular decision action restrictive rolling admit admission admissions rate rates " +
    "acceptance average median net price prices cost tuition undergraduate undergraduates enrollment source department education college colleges " +
    "scorecard university universities school schools high institute technology state name graduation hometown headline student students " +
    "common app application applications deadline deadlines due overdue today tomorrow yesterday calendar task tasks meeting meetings note notes " +
    "essay essays activity activities document documents intake profile academics score scores superscore composite middle class rank us usa " +
    "fall spring summer winter fafsa css uc toefl ielts weighted unweighted caseload ranking passages passage tip yes no ok axis meridies work " +
    "queue email drive onedrive google microsoft overall however open red flag flags total next last first final data year percent range scale " +
    "both also still because since while although though overview summary strategy recommendation recommendations update"
  ).split(" "),
]);
const SUBJECT_PRONOUNS = new Set(["she", "he", "her", "his", "him", "hers"]);
const ANY_PRONOUNS = new Set(["it", "its", "they", "their", "them", "theirs"]);
const CLAUSE_BREAK = /[;,]\s|\s(?:and|but|while|whereas)\s|\s[–—]\s/gi;
const hit = (g: Group, scope: Set<string>) => [...g].some((t) => scope.has(t));
const overlaps = (a: Group, b: Group) => [...a].some((t) => b.has(t));
const nameGroup = (name: string): Group => new Set(tokens(name).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d/.test(t)));

/** Which entity a figure is about, and which people its clause also names. */
export type Nearness = { group: Group | null; competitors: Group[]; persons: Group[] };

/**
 * Every number, calendar day and stated count in the evidence, each remembered with where it sits: its
 * line, its passage (a blank-line block, or one object of a JSON list) and the whole text it came in. A
 * figure in a sentence that names a school or a student is found only where that name is nearest.
 */
export class EvidenceIndex {
  private readonly occ: Occurrence[] = [];
  private readonly countNouns = new Set<string>();
  /** Words the evidence writes capitalized: the only words that can name something to check against. */
  private readonly cap = new Set<string>();
  private subject: Group | null = null;
  private persons: Group[] = [];

  /** The chat's student (lines with no name are about them) and every student on the roster. */
  setNames(subject: string | null | undefined, students: string[] = []): void {
    const g = subject ? nameGroup(subject) : null;
    this.subject = g?.size ? g : null;
    this.persons = [...students, ...(subject ? [subject] : [])].map(nameGroup).filter((p) => p.size);
  }

  /** `counselor`: the counselor's own words, whose figures aren't the model's to defend. */
  add(text: string | null | undefined, opts: { counselor?: boolean } = {}): void {
    if (!text) return;
    for (const w of text.matchAll(/\p{L}[\p{L}\p{N}'’]*/gu)) if (/^\p{Lu}/u.test(w[0])) for (const t of tokens(w[0])) this.cap.add(t);
    const textScope = new Set(tokens(text));
    let passage: string[] = [];
    const flush = () => {
      if (!passage.length) return;
      const pScope = new Set(tokens(passage.join("\n")));
      for (const line of passage) this.indexLine(line, { line: new Set(tokens(line)), passage: pScope, text: textScope, counselor: opts.counselor === true });
      passage = [];
    };
    for (const line of text.split("\n")) {
      if (!line.trim() || /^\s*[{}[\]],?\s*$/.test(line)) flush();
      else passage.push(line);
    }
    flush();
  }

  private indexLine(line: string, scope: Scope): void {
    for (const m of line.matchAll(ISO_DATE)) this.occ.push({ kind: "day", day: `${m[2]}-${m[3]}`, year: Number(m[1]), scope });
    for (const m of line.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
      const month = MONTHS[m[1]!.toLowerCase()];
      if (month !== undefined) this.occ.push({ kind: "day", day: `${pad(month + 1)}-${pad(Number(m[2]))}`, ...(m[3] ? { year: Number(m[3]) } : {}), scope });
    }
    // Dates are read as dates above, not as the numbers 2026, 11 and 1.
    const plainLine = line.replace(ISO_DATE, (d) => " ".repeat(d.length));
    const money = MONEY_WORDS.test(plainLine);
    for (const m of plainLine.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
      const raw = m[0].replace(/,/g, "");
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      const at = m.index!;
      const scale = isScale(plainLine.slice(Math.max(0, at - 10), at), plainLine.slice(at + m[0].length, at + m[0].length + 16));
      const d = decimalsOf(raw);
      this.occ.push({ kind: "num", value: v, decimals: d, money, scale, scope });
      // A fraction on file ("admit_rate 0.073") supports a percentage in the answer ("7.3%").
      if (v > 0 && v < 1) this.occ.push({ kind: "num", value: v * 100, decimals: Math.max(0, d - 2), money: false, scale: false, scope });
      // A count stated on file ("3 overdue tasks", "12 activities").
      if (/^\d{1,3}$/.test(m[0]) && !/[\d.,/:$-]$/.test(plainLine.slice(0, at))) {
        const head = countHead(plainLine, at + m[0].length);
        if (head) {
          this.occ.push({ kind: "count", value: v, noun: head.noun, scope });
          this.countNouns.add(head.noun);
        }
      }
    }
  }

  /** Whether the evidence states a count of this thing anywhere, which makes a count of it checkable. */
  counts(noun: string): boolean {
    return this.countNouns.has(noun);
  }

  /** The names, pronouns and their positions in a sentence (citation markers already blanked). */
  refs(base: string): Ref[] {
    const out: Ref[] = [];
    let open: { start: number; end: number; group: Group; possessive: boolean } | null = null;
    const close = () => {
      if (open) out.push({ start: open.start, end: open.end, ref: open.group });
      open = null;
    };
    for (const w of base.matchAll(/\p{L}[\p{L}\p{N}'’]*/gu)) {
      const word = w[0];
      const at = w.index!;
      const lower = fold(word).replace(/'s$/, "");
      if (SUBJECT_PRONOUNS.has(lower) || ANY_PRONOUNS.has(lower)) {
        close();
        out.push({ start: at, end: at + word.length, ref: SUBJECT_PRONOUNS.has(lower) ? "subject" : "any" });
        continue;
      }
      const toks = /^\p{Lu}/u.test(word) ? tokens(word).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !GENERIC.has(t) && this.cap.has(t)) : [];
      if (!toks.length) {
        close();
        continue;
      }
      // "Sophia Chen" is one name; "Sophia's Cornell" is two.
      const cur = open as { start: number; end: number; group: Group; possessive: boolean } | null;
      if (cur && !cur.possessive && /^[ \t]+$/.test(base.slice(cur.end, at))) {
        for (const t of toks) cur.group.add(t);
        cur.end = at + word.length;
        cur.possessive = /['’]s$/i.test(word);
      } else {
        close();
        open = { start: at, end: at + word.length, group: new Set(toks), possessive: /['’]s$/i.test(word) };
      }
    }
    close();
    return out;
  }

  /**
   * What a figure is about: the nearest name or pronoun before it in its clause, else after it in the clause,
   * else the last name before it in the sentence, else the first after it. "Her" is the chat's student. A sentence that names nothing gets no nearness.
   */
  nearness(f: Figure, refs: Ref[], base: string): Nearness | null {
    if (f.at === undefined || !refs.some((r) => r.ref !== "subject" && r.ref !== "any")) return null;
    const at = f.at;
    let cs = 0;
    let ce = base.length;
    for (const m of base.matchAll(CLAUSE_BREAK)) {
      const b = m.index!;
      if (b + m[0].length <= at) cs = b + m[0].length;
      else if (b >= at + f.text.length) {
        ce = b;
        break;
      }
    }
    const clause = refs.filter((r) => r.start >= cs && r.end <= ce);
    const before = clause.filter((r) => r.end <= at).sort((a, b) => b.end - a.end)[0];
    const after = clause.filter((r) => r.start >= at).sort((a, b) => a.start - b.start)[0];
    // A clause that names nothing carries on the last name before it ("Sophia has a 3.87, and a 1520 SAT"), else
    // the first after it ("At 5.1%, Brown is..."); a pronoun counts only in its own clause.
    const named = refs.filter((r) => r.ref !== "subject" && r.ref !== "any");
    const chosen =
      before ??
      after ??
      named.filter((r) => r.end <= at).sort((a, b) => b.end - a.end)[0] ??
      named.filter((r) => r.start >= at).sort((a, b) => a.start - b.start)[0];
    const resolve = (r: Ref): Group | null => (r.ref === "any" ? null : r.ref === "subject" ? this.subject : r.ref);
    const group = chosen ? resolve(chosen) : null;
    if (!group) return null;
    const groups = refs.map(resolve).filter((g): g is Group => !!g);
    const competitors = [...groups, ...this.persons].filter((g) => !overlaps(g, group));
    // Other people named in the same clause must fit too ("Liam's Cornell deadline" is not Sophia's).
    const persons = clause
      .filter((r) => r !== chosen)
      .map(resolve)
      .filter((g): g is Group => !!g && !overlaps(g, group) && this.persons.some((p) => overlaps(p, g)));
    return { group, competitors, persons };
  }

  /** Whether `g` is what this occurrence is about: the narrowest scope naming `g` or a competitor decides. */
  private owns(o: Occurrence, g: Group, competitors: Group[]): boolean {
    for (const scope of [o.scope.line, o.scope.passage, o.scope.text]) {
      if (hit(g, scope)) return true;
      if (competitors.some((c) => hit(c, scope))) return false;
    }
    // Nothing named anywhere around it: the counselor's own words, or a text about the chat's student.
    return o.scope.counselor || (!!this.subject && overlaps(g, this.subject));
  }

  private matches(f: Figure, o: Occurrence): boolean {
    if (f.kind === "date") return o.kind === "day" && o.day === f.day && (!f.year || !o.year || f.year === o.year);
    if (f.kind === "count") return o.kind === "count" && o.noun === f.noun && o.value === f.value;
    if (o.kind !== "num") return false;
    if (o.scale && !f.scale) return false;
    // A rounded amount of money ("$31k") comes only from an amount of money.
    if (f.kind === "money" && f.decimals < 0 && !o.money) return false;
    if (Math.abs(roundTo(o.value, f.decimals) - f.value) > 1e-6 * Math.max(1, Math.abs(f.value))) return false;
    if (Math.abs(o.value - f.value) <= 1e-9 || f.decimals >= o.decimals) return true;
    // Rounded: keep two significant figures (3.874 is "3.9", never "4"), unless an approximate percent or amount.
    return (f.sig ?? 2) >= 2 || (f.hedged === true && (f.kind === "percent" || f.kind === "money"));
  }

  /** Whether the evidence supports this figure; with `near`, only where its entity is nearest. */
  supports(f: Figure, near: Nearness | null = null): boolean {
    for (const o of this.occ) {
      if (!this.matches(f, o)) continue;
      if (!near) return true;
      if (!this.owns(o, near.group!, near.competitors)) continue;
      if (near.persons.every((p) => this.owns(o, p, this.persons.filter((q) => !overlaps(q, p))))) return true;
    }
    return false;
  }

  has(f: Figure): boolean {
    return this.supports(f);
  }

  get size(): number {
    return this.occ.length;
  }
}

export type SentenceCheck = {
  index: number;
  text: string;
  figures: { text: string; status: FigureStatus }[];
  citations: { id: string; support: number }[];
  status: "grounded" | "unverified" | "weak-citation";
};

/** Sum or difference of two found figures in the same sentence, at the precision written. */
function derived(f: Figure, found: Figure[]): boolean {
  if (f.kind === "date" || found.length < 2) return false;
  const target = Number(f.value.toFixed(Math.max(0, f.decimals)));
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      const a = found[i]!.value;
      const b = found[j]!.value;
      for (const v of [Math.abs(a - b), a + b]) if (Number(v.toFixed(Math.max(0, f.decimals))) === target) return true;
    }
  }
  return false;
}

/** How much of a sentence is in the passages it cites: shared content words over the sentence's content words. */
export function citationSupport(sentence: string, cited: string[]): number {
  const s = contentStems(sentence.replace(/\[S\d{1,3}\]/g, " "));
  if (!s.size || !cited.length) return 0;
  const c = contentStems(cited.join(" "));
  let hit = 0;
  for (const w of s) if (c.has(w)) hit++;
  return Math.round((hit / s.size) * 100) / 100;
}

export const WEAK_CITATION = 0.2;

export function checkSentence(index: number, text: string, evidence: EvidenceIndex, ledger: SourceLedger): SentenceCheck {
  // A count is a figure only when the evidence states a count of the same thing.
  const figures = extractFigures(text, { counts: true }).filter((f) => f.kind !== "count" || evidence.counts(f.noun!));
  const base = text.replace(/\[S\d{1,3}\]/g, (m) => " ".repeat(m.length));
  const refs = figures.length ? evidence.refs(base) : [];
  const found = figures.filter((f) => evidence.supports(f, evidence.nearness(f, refs, base)));
  const checks = figures.map((f) => ({
    text: f.text.trim(),
    status: (found.includes(f) ? "found" : derived(f, found) ? "derived" : "missing") as FigureStatus,
  }));
  const ids = [...new Set([...text.matchAll(/\[(S\d{1,3})\]/gi)].map((m) => m[1]!.toUpperCase()))];
  const citations = ids.map((id) => {
    const src = ledger.get(id);
    return { id, support: src ? citationSupport(text, [src.text, src.title]) : 0 };
  });
  const status: SentenceCheck["status"] = checks.some((c) => c.status === "missing")
    ? "unverified"
    : citations.some((c) => c.support < WEAK_CITATION)
      ? "weak-citation"
      : "grounded";
  return { index, text, figures: checks, citations, status };
}

/**
 * Feeds streamed text through the sentence splitter and checks each sentence
 * as it completes. `onCheck` fires only for sentences with figures or
 * citations, which are the ones a client can mark.
 */
export class LiveGrounder {
  private readonly stream = new SentenceStream();
  private readonly checks: SentenceCheck[] = [];
  private index = 0;

  constructor(
    private readonly evidence: EvidenceIndex,
    private readonly ledger: SourceLedger,
    private readonly onCheck: (c: SentenceCheck) => void
  ) {}

  push(delta: string): void {
    for (const s of this.stream.push(delta)) this.check(s);
  }

  finish(): SentenceCheck[] {
    for (const s of this.stream.flush()) this.check(s);
    return this.checks;
  }

  private check(sentence: string): void {
    const c = checkSentence(this.index++, sentence, this.evidence, this.ledger);
    if (!c.figures.length && !c.citations.length) return;
    this.checks.push(c);
    this.onCheck(c);
  }
}
