/**
 * Live grounding: every figure in the answer is checked against what AxIS
 * read, sentence by sentence, while the answer streams.
 *
 * Numbers are where a fluent answer goes wrong without anyone noticing: a GPA
 * one hundredth off, last year's admit rate, a deadline on the wrong day. So
 * the evidence (the student record, the roster, every numbered passage, the
 * counselor's own question) is indexed once per turn into normalized numbers
 * and calendar days. As each sentence of the answer completes, its figures
 * are extracted and looked up:
 *
 *   found     the value is in the evidence at the precision written (3.874 on
 *             file supports "3.87"; 12.3% supports "12%")
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
import { contentStems, SentenceStream } from "./text.js";

export type FigureKind = "number" | "percent" | "money" | "date";
export type Figure = { text: string; kind: FigureKind; value: number; decimals: number; day?: string };
export type FigureStatus = "found" | "derived" | "missing";

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const SCORE_WORDS = /\b(sat|act|psat|score|scores|scored|rank|ranked|gpa|ap|ib|composite|superscore|percentile)\b/i;
const pad = (n: number) => String(n).padStart(2, "0");
const decimalsOf = (s: string) => (s.includes(".") ? s.split(".")[1]!.length : 0);

/** Pulls the figures out of one sentence, longest patterns first so "$12,000" isn't also read as "12" and "000". */
export function extractFigures(sentence: string): Figure[] {
  let s = sentence.replace(/\[S\d{1,3}\]/g, " ");
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
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => ({ text: m[0], kind: "date", value: 0, decimals: 0, day: `${m[2]}-${m[3]}` }));
  take(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), (m) => {
    const month = MONTHS[m[1]!.toLowerCase()];
    const day = Number(m[2]);
    return month === undefined || day < 1 || day > 31 ? null : { text: m[0], kind: "date", value: 0, decimals: 0, day: `${pad(month + 1)}-${pad(day)}` };
  });
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g, (m) => {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { text: m[0], kind: "date", value: 0, decimals: 0, day: `${pad(mo)}-${pad(d)}` } : null;
  });
  take(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|K|thousand|million|M)\b)?/g, (m) => {
    const base = Number(`${m[1]!.replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    const mult = m[3] ? (/^m/i.test(m[3]) ? 1_000_000 : 1_000) : 1;
    return { text: m[0], kind: "money", value: base * mult, decimals: mult > 1 ? -3 : decimalsOf(m[0].replace(/[^\d.]/g, "")) };
  });
  take(/\b(\d+(?:\.\d+)?)\s?(%|percent\b)/g, (m) => ({ text: m[0], kind: "percent", value: Number(m[1]), decimals: decimalsOf(m[1]!) }));
  take(/\b(\d{2,4})\s?[–-]\s?(\d{2,4})\b/g, (m) => [
    { text: m[1]!, kind: "number", value: Number(m[1]), decimals: 0 },
    { text: m[2]!, kind: "number", value: Number(m[2]), decimals: 0 },
  ]);
  take(/\b\d+\.\d+\b/g, (m) => ({ text: m[0], kind: "number", value: Number(m[0]), decimals: decimalsOf(m[0]) }));
  // Whole numbers: 100 and up (scores, prices, enrollments), or smaller ones next to a score word ("ACT 34").
  // Bare years are left alone; so are small counts ("3 tasks"), which are arithmetic over a list, not a fact on file.
  take(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (m, at) => {
    const value = Number(m[0]!.replace(/,/g, ""));
    const near = sentence.slice(Math.max(0, at - 24), at + m[0]!.length + 12);
    if (value >= 1900 && value <= 2100 && !SCORE_WORDS.test(near)) return null;
    if (value < 100 && !(value >= 1 && SCORE_WORDS.test(near))) return null;
    return { text: m[0], kind: "number", value, decimals: 0 };
  });
  return out;
}

/** Every number and calendar day in the evidence, kept at every precision it supports. */
export class EvidenceIndex {
  private readonly numbers = new Set<string>();
  private readonly days = new Set<string>();
  private readonly values: number[] = [];

  add(text: string | null | undefined): void {
    if (!text) return;
    for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) this.days.add(`${m[2]}-${m[3]}`);
    for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})\\b`, "gi"))) {
      const month = MONTHS[m[1]!.toLowerCase()];
      if (month !== undefined) this.days.add(`${pad(month + 1)}-${pad(Number(m[2]))}`);
    }
    for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
      const raw = m[0].replace(/,/g, "");
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      this.addValue(v, decimalsOf(raw));
      // A fraction on file ("admit_rate 0.073") supports a percentage in the answer ("7.3%").
      if (v > 0 && v < 1) this.addValue(v * 100, Math.max(0, decimalsOf(raw) - 2));
    }
  }

  private addValue(v: number, decimals: number): void {
    this.values.push(v);
    for (let d = 0; d <= Math.max(decimals, 0); d++) this.numbers.add(Number(v.toFixed(d)).toString());
    this.numbers.add(`k:${Math.round(v / 1000)}`);
  }

  has(f: Figure): boolean {
    if (f.kind === "date") return !!f.day && this.days.has(f.day);
    if (f.decimals < 0) return this.numbers.has(`k:${Math.round(f.value / 1000)}`);
    return this.numbers.has(Number(f.value.toFixed(f.decimals)).toString());
  }

  get size(): number {
    return this.numbers.size + this.days.size;
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
  const figures = extractFigures(text);
  const found = figures.filter((f) => evidence.has(f));
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
