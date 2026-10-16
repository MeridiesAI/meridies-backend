/**
 * Text scanning that runs in time linear in the input, for text a user (or a
 * page, a document or a model) supplied.
 *
 * A regular expression such as `/<[^>]+>/g` or `/<script[\s\S]*?<\/script>/g`
 * rescans from every start position to the end of the input when its closing
 * token is missing, so its cost grows with the square of the input: two
 * megabytes of "<a" with no ">" blocks the event loop for most of an hour, and
 * Node serves every tenant from that one thread. These helpers do the same
 * jobs with `indexOf` from moving positions, so each character is looked at a
 * bounded number of times. Each one documents the regular expression it
 * replaces and matches it exactly (test/unit/linear-text.test.ts compares them
 * on random input).
 */

/** `s` with A-Z lowered and nothing else touched, so indices stay the same. */
export function asciiLower(s: string): string {
  // Each match is a run of capitals, so this is one linear pass.
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * Every `open ... close` block replaced, the way
 * `s.replace(/<open>[\s\S]*?<close>/gi, replacement)` does it: blocks found
 * left to right, each ending at the first `close` after its `open`, ASCII case
 * ignored. `open` and `close` are lower-case ASCII. An `open` with no `close`
 * after it, and everything after it, is left as it is.
 */
export function replaceBlocks(s: string, open: string, close: string, replacement: string): string {
  const lower = asciiLower(s);
  let out = "";
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start < 0) break;
    const end = lower.indexOf(close, start + open.length);
    // No close after this open means none after any later open either.
    if (end < 0) break;
    out += s.slice(pos, start) + replacement;
    pos = end + close.length;
  }
  return pos === 0 ? s : out + s.slice(pos);
}

/**
 * Every tag replaced, the way `s.replace(/<[^>]+>/g, replacement)` does it
 * (or `/<[^>]*>/g` with `allowEmpty`): from a "<" to the next ">", which may
 * have other "<" before it. A "<" with no ">" after it stays.
 */
export function replaceTags(s: string, replacement: string, allowEmpty = false): string {
  let out = "";
  let pos = 0;
  let i = s.indexOf("<");
  while (i >= 0) {
    const gt = s.indexOf(">", i + 1);
    if (gt < 0) break;
    if (gt === i + 1 && !allowEmpty) {
      // "<>" is not a tag; the scan goes on from the next "<".
      i = s.indexOf("<", i + 1);
      continue;
    }
    out += s.slice(pos, i) + replacement;
    pos = gt + 1;
    i = s.indexOf("<", pos);
  }
  return pos === 0 ? s : out + s.slice(pos);
}

/**
 * Spaces and tabs at the end of every line removed, the way
 * `s.replace(/[ \t]+\n/g, "\n")` does it. The last line (no "\n" after it) is
 * left alone, as the regular expression leaves it.
 */
export function trimLineEnds(s: string): string {
  // One scan from newline to newline, with no array of lines: each backwards
  // walk stops at the previous "\n" (neither a space nor a tab), so every
  // character is looked at at most twice.
  let out = "";
  let pos = 0;
  let nl = s.indexOf("\n");
  while (nl >= 0) {
    let end = nl;
    while (end > pos) {
      const c = s.charCodeAt(end - 1);
      if (c !== 32 && c !== 9) break;
      end--;
    }
    if (end < nl) {
      out += s.slice(pos, end);
      pos = nl;
    }
    nl = s.indexOf("\n", nl + 1);
  }
  return pos === 0 && out === "" ? s : out + s.slice(pos);
}
