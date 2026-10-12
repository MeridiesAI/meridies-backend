/**
 * Text utilities shared by the language understanding, retrieval fusion and
 * grounding code. Deterministic and allocation-light: they run on every turn,
 * and the sentence splitter runs on every streamed token.
 */

/** Lower case, accents and apostrophe variants folded, "&" spelled out. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/&/g, " and ");
}

/**
 * Word tokens: folded, possessives dropped ("Sophia's" -> "sophia"), inner
 * apostrophes removed ("o'brien" -> "obrien"), decimals kept whole ("3.87").
 */
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of fold(s).replace(/'s\b/g, "").replace(/'/g, "").split(/[^\p{L}\p{N}.]+/u)) {
    if (/^\d+\.\d+$/.test(raw)) out.push(raw);
    else for (const part of raw.split(".")) if (part) out.push(part);
  }
  return out;
}

export const STOPWORDS = new Set(
  (
    "a an the and or but if then so of to in on at by for from with about as into over under than that this these those " +
    "is are was were be been being am do does did done has have had having can could should would will shall may might must " +
    "i me my we our us you your he him his she her they them their it its what which who whom whose when where why how " +
    "there here not no yes up down out off again just also very too more most some any each all both few other such only own same " +
    "tell show give get got know let please thanks thank hi hey hello okay ok really any"
  ).split(" ")
);

/** A light suffix stripper: enough for overlap scoring, not a linguistic stemmer. */
export function stem(w: string): string {
  if (w.length <= 3 || /^\d/.test(w)) return w;
  // "admitted" -> "admit", "planning" -> "plan": a doubled consonant left by the suffix goes too.
  const undouble = (x: string) => (/([b-df-hj-np-tv-z])\1$/.test(x) && !/(ll|ss|zz)$/.test(x) ? x.slice(0, -1) : x);
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ied") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith("ed") && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith("ly") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

/** The content words of a text, stemmed. */
export function contentStems(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(s)) if (t.length > 1 && !STOPWORDS.has(t)) out.add(stem(t));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Word n-grams, for near-duplicate detection. */
export function shingles(s: string, n = 3): Set<string> {
  const t = tokens(s);
  const out = new Set<string>();
  if (t.length < n) {
    if (t.length) out.add(t.join(" "));
    return out;
  }
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

const QUESTION_LEAD =
  "what|when|who|whom|which|how|why|where|did|does|do|is|are|was|were|can|could|should|would|will|has|have|tell|show|give|list|remind|add|draft|email|find|check|pull|summari[sz]e|compare";

/**
 * Splits a message into the questions or requests it contains: at sentence
 * ends, semicolons and line breaks, and at "and"/"also"/"plus"/"then" when a
 * new question starts after it ("did her mom reply, and what's Cornell's ED
 * deadline?").
 */
export function splitClauses(text: string): string[] {
  const lead = new RegExp(`,?\\s+(?:and|also|plus|then)\\s+(?=(?:${QUESTION_LEAD})\\b)`, "i");
  return text
    .split(/(?<=[?!])\s+|(?<=[a-z)\]"”]\.)\s+(?=[A-Z])|\n+|;\s+/)
    .flatMap((p) => p.split(lead))
    .map((p) => p.trim())
    .filter((p) => p.replace(/[^\p{L}\p{N}]/gu, "").length > 2);
}

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "dr", "mr", "mrs", "ms", "st", "u.s", "jr", "sr", "no", "approx", "est", "dept", "univ", "inc", "mt", "ft",
]);

function endsWithAbbreviation(before: string): boolean {
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(before);
  if (!m) return false;
  const w = m[1]!.toLowerCase();
  // A single capital is an initial ("J. Smith").
  return ABBREVIATIONS.has(w) || /^[a-z]$/i.test(w);
}

/**
 * Cuts a stream of text into sentences as it arrives. A sentence ends at a line
 * break, or at . ! ? followed by space; decimals ("3.87"), abbreviations
 * ("U.S.") and initials don't end one. Citation markers right after the
 * punctuation ("... in AP Bio. [S3]") stay with the sentence they cite, so the
 * splitter waits for the next character before letting a sentence go.
 */
export class SentenceStream {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    return this.drain(false);
  }

  flush(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.boundary(final);
      if (cut < 0) break;
      const s = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (s) out.push(s);
    }
    if (final) {
      const rest = this.buf.trim();
      if (rest) out.push(rest);
      this.buf = "";
    }
    return out;
  }

  private boundary(final: boolean): number {
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i]!;
      if (ch === "\n") return i + 1;
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      let j = i + 1;
      while (j < b.length && /[.!?)"'”’]/.test(b[j]!)) j++;
      if (j >= b.length) return final ? b.length : -1;
      if (!/\s/.test(b[j]!)) continue;
      if (ch === "." && endsWithAbbreviation(b.slice(0, i))) continue;
      let k = j;
      while (k < b.length && (b[k] === " " || b[k] === "\t")) k++;
      if (k >= b.length) return final ? b.length : -1;
      if (b[k] === "[") {
        const rest = b.slice(k);
        const m = /^(?:\[S\d{1,3}\][ \t]*)+/.exec(rest);
        if (m) return k + m[0].length;
        if (!final && /^\[(?:S\d{0,3})?$/.test(rest)) return -1;
      }
      return j;
    }
    return -1;
  }
}
