/**
 * Quoted runs (AxIS security PR B, spec §3.3). An AxIS answer that repeats 8 or more consecutive words of free
 * text the turn could see (a document, a long student-written value: lib/context/freeText.ts) is flagged: the
 * runs are stored with the answer (`ai_messages.outside_quotes`, 20261108000004), the chat stays flagged while
 * that answer is among the replayed messages, and the memory fold replaces each run with
 * "[quote from <source>]" so the summary never carries the words.
 *
 * Words are compared with case, punctuation and spacing ignored: a word is a run of letters or digits.
 * Short fields never count toward the 8 words (callers pass free text only).
 */

/** Offsets into the stored answer text, and where the words came from. */
export type QuoteRun = { start: number; end: number; source: string };

export const QUOTE_WORDS = 8;
const WORD = /[\p{L}\p{N}]+/gu;

type Word = { w: string; start: number; end: number };
function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD)) out.push({ w: m[0].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  return out;
}

/** Every run of QUOTE_WORDS or more of the answer's words found in a source, overlapping runs merged. */
export function quotedRuns(answer: string, sources: { source: string; text: string }[]): QuoteRun[] {
  const aw = words(answer);
  if (aw.length < QUOTE_WORDS || sources.length === 0) return [];
  // Each window of QUOTE_WORDS words in the sources, and the first source it appears in.
  const grams = new Map<string, string>();
  for (const s of sources) {
    const sw = words(s.text).map((x) => x.w);
    for (let i = 0; i + QUOTE_WORDS <= sw.length; i++) {
      const key = sw.slice(i, i + QUOTE_WORDS).join(" ");
      if (!grams.has(key)) grams.set(key, s.source);
    }
  }
  if (grams.size === 0) return [];
  const runs: QuoteRun[] = [];
  for (let i = 0; i + QUOTE_WORDS <= aw.length; i++) {
    const source = grams.get(aw.slice(i, i + QUOTE_WORDS).map((x) => x.w).join(" "));
    if (!source) continue;
    const start = aw[i]!.start;
    const end = aw[i + QUOTE_WORDS - 1]!.end;
    const last = runs.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else runs.push({ start, end, source });
  }
  return runs;
}

/** A source label as the marker shows it: one line, no brackets, bounded (labels can carry a student's file name). */
const markerSource = (source: string) => source.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "outside text";

/** The stored runs, re-validated: whole offsets, inside the text, in order and not overlapping. */
export function validRuns(text: string, raw: unknown): QuoteRun[] {
  if (!Array.isArray(raw)) return [];
  const runs = raw
    .filter((r): r is QuoteRun => {
      const x = r as Partial<QuoteRun> | null;
      return !!x && Number.isInteger(x.start) && Number.isInteger(x.end) && typeof x.source === "string" && x.start! >= 0 && x.start! < x.end! && x.end! <= text.length;
    })
    .sort((a, b) => a.start - b.start);
  return runs.filter((r, i) => i === 0 || r.start >= runs[i - 1]!.end);
}

/** The text with each run replaced by "[quote from <source>]"; a run that doesn't fit the text is ignored. */
export function redactQuotes(text: string, runs: unknown): string {
  let out = text;
  for (const r of validRuns(text, runs).reverse()) out = `${out.slice(0, r.start)}[quote from ${markerSource(r.source)}]${out.slice(r.end)}`;
  return out;
}
