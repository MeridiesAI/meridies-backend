/**
 * Shape checks on cells and headers from an uploaded file, in time linear in
 * the text. A CSV cell or header can be megabytes long, and the regular
 * expressions these replace rescanned the rest of it from every position
 * (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` on "a@" and "a." repeated, `,(?![^(]*\))` on
 * a long run of commas, `\s+(score|...)$` on a long run of spaces), which held
 * the event loop for seconds per cell while a file was profiled or staged.
 * Each function names the expression it stands for and matches it exactly
 * (test/unit/import-text-shapes.test.ts compares them on random input).
 */

const isSpace = (c: string) => /\s/.test(c);
/** What `.` does not match: the line terminators. */
const isLineTerminator = (c: string) => c === "\n" || c === "\r" || c === " " || c === " ";

/** `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)`. */
export function isEmailShape(v: string): boolean {
  const at = v.indexOf("@");
  if (at < 1 || v.indexOf("@", at + 1) !== -1) return false;
  if (/\s/.test(v)) return false;
  const dot = v.indexOf(".", at + 2);
  return dot !== -1 && dot < v.length - 1;
}

/**
 * `/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v)`: an email address anywhere in the
 * text. Each "@" looks only at the run of non-space, non-"@" characters after
 * it, and those runs never overlap, so the scan is linear.
 */
export function containsEmailShape(v: string): boolean {
  let at = v.indexOf("@");
  while (at !== -1) {
    const before = at > 0 ? v[at - 1] : "";
    let end = at + 1;
    while (end < v.length && v[end] !== "@" && !isSpace(v[end])) end++;
    if (before !== "" && before !== "@" && !isSpace(before)) {
      // A dot with at least one character before it (after the "@") and one after it.
      const dot = v.indexOf(".", at + 2);
      if (dot !== -1 && dot < end - 1) return true;
    }
    at = end < v.length && v[end] === "@" ? end : v.indexOf("@", end);
  }
  return false;
}

const SCORE_WORDS = ["exam score", "score", "result"] as const;

/**
 * Where `/\s+(score|exam score|result)$/i` would start matching in `s`, at or
 * after `min`, or -1: the first character of the whitespace run before the
 * last word, taking "exam score" over "score" because it starts earlier.
 */
export function scoreSuffixStart(s: string, min = 0): number {
  let best = -1;
  for (const word of SCORE_WORDS) {
    const q = s.length - word.length;
    if (q <= min || s.slice(q).toLowerCase() !== word) continue;
    let r = q;
    while (r > min && isSpace(s[r - 1]!)) r--;
    if (r === q) continue;
    if (best === -1 || r < best) best = r;
  }
  return best;
}

/**
 * `/^(ap|ib)\s+(.+?)(\s+(score|exam score|result))?$/i.exec(s)` as
 * `[prefix, exam]` (groups 1 and 2), or null.
 */
export function scoreColumnParts(s: string): [string, string] | null {
  const prefix = s.slice(0, 2);
  if (!/^(ap|ib)$/i.test(prefix)) return null;
  let start = 2;
  while (start < s.length && isSpace(s[start]!)) start++;
  if (start === 2) return null;
  if (start === s.length) {
    // All whitespace: the run gives its last character back to the exam.
    if (start - 2 < 2 || isLineTerminator(s[start - 1]!)) return null;
    return [prefix, s[start - 1]!];
  }
  const suffix = scoreSuffixStart(s, start);
  const exam = s.slice(start, suffix === -1 ? s.length : suffix);
  for (const c of exam) if (isLineTerminator(c)) return null;
  return [prefix, exam];
}

/**
 * `s.split(/[;|\n]+|,(?![^(]*\))/)`: a list cell split on runs of ";", "|"
 * and newlines, and on every comma that isn't inside parentheses (one whose
 * next "(" or ")" is a ")").
 */
export function splitListCell(s: string): string[] {
  // The next "(" or ")" at or after each position, read right to left once.
  const nextParen = new Array<string>(s.length + 1);
  nextParen[s.length] = "";
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]!;
    nextParen[i] = c === "(" || c === ")" ? c : nextParen[i + 1]!;
  }
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ";" || c === "|" || c === "\n") {
      out.push(s.slice(start, i));
      while (i < s.length && (s[i] === ";" || s[i] === "|" || s[i] === "\n")) i++;
      start = i;
      continue;
    }
    if (c === "," && nextParen[i + 1] !== ")") {
      out.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(s.slice(start));
  return out;
}
