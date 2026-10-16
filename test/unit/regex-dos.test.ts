/**
 * The other text scans the security review's sweep found with the same shape
 * (a quantifier that rescans the rest of the input when what follows it is
 * missing): AxIS's token scan, log redaction and Commons credit HTML. Each
 * still gives its old answer, and a worst-case input finishes in well under
 * 100 ms.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scanTokens } from "../../src/lib/axis/entities.js";
import { collapseBeforeNewlines } from "../../src/lib/axis/ledger.js";
import { SentenceStream, splitClauses } from "../../src/lib/axis/text.js";
import { stripHtml } from "../../src/lib/ingest/collegePhotos.js";
import { redactText } from "../../src/lib/requestLog.js";
import { BUDGET_MS, CAP_BUDGET_MS, elapsed, randomText, seeded } from "./regex-dos-helpers.js";

const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

// ---- AxIS: which tokens open a sentence ------------------------------------------

function oldSentenceStarts(text: string): boolean[] {
  const out: boolean[] = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index);
    out.push(!/\S/.test(before) || /[.!?:\n•*-]\s*$/.test(before));
  }
  return out;
}

test("scanTokens marks sentence starts exactly as before", () => {
  const rand = seeded(31);
  const pieces = ["Jane", "met", "MIT", " ", "  ", "\n", "\t", ".", "!", "?", ":", "•", "*", "-", ",", "(", "'s", " ", "2027", "😀"];
  for (let i = 0; i < 10000; i++) {
    const s = randomText(rand, pieces, Math.floor(rand() * 16));
    assert.deepEqual(scanTokens(s).map((t) => t.sentenceStart), oldSentenceStarts(s), JSON.stringify(s));
  }
});

test("scanTokens reads an 8,000-character message of any shape in well under 100 ms", () => {
  // 8,000 is the AxIS message cap; the old prefix test read the whole text
  // before every token, and rescanned a run of newlines from each newline.
  for (const unit of ["a ", "a.", "a\n", "\n", "a" + "\n".repeat(50), "Jane ", "- a ", " "]) {
    const text = `x${fill(unit, 8000)}y`;
    const ms = elapsed(() => scanTokens(text));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
  }
});

// ---- AxIS: streamed sentences --------------------------------------------------

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "dr", "mr", "mrs", "ms", "st", "u.s", "jr", "sr", "no", "approx", "est", "dept", "univ", "inc", "mt", "ft",
]);

/** SentenceStream as it stood before the fix: it rescanned the buffer on every push. */
class OldSentenceStream {
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
function endsWithAbbreviation(before: string): boolean {
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(before);
  if (!m) return false;
  const w = m[1]!.toLowerCase();
  return ABBREVIATIONS.has(w) || /^[a-z]$/i.test(w);
}

function sentences(stream: { push(d: string): string[]; flush(): string[] }, text: string, cuts: number[]): string[][] {
  const out: string[][] = [];
  let at = 0;
  for (const c of [...cuts, text.length]) {
    out.push(stream.push(text.slice(at, c)));
    at = c;
  }
  out.push(stream.flush());
  return out;
}

test("SentenceStream cuts a stream exactly as before, whatever the chunks", () => {
  const rand = seeded(33);
  const pieces = [
    "a", "Her", " ", "  ", "\t", "\n", ".", "!", "?", ")", "\"", "’", "3.87", "U.S", "e.g", "J", "approx", "[S1]", "[S", "1]", "[", "S12",
    " [S2]", "x", "St", "..", "Mr", "?!",
  ];
  for (let i = 0; i < 4000; i++) {
    const text = randomText(rand, pieces, 1 + Math.floor(rand() * 24));
    const cuts: number[] = [];
    for (let c = 0; c < text.length; c++) if (rand() < 0.3) cuts.push(c);
    assert.deepEqual(sentences(new SentenceStream(), text, cuts), sentences(new OldSentenceStream(), text, cuts), JSON.stringify([text, cuts]));
  }
});

test("SentenceStream streams a 20,000-character reply of any shape in well under 100 ms", () => {
  for (const unit of ["a ", ".", "a.", ". ", "a. ", "aaaaaaaaaa", " ", "U.S. ", "e.g. ", "[S1] ", "?!", "a.a.a ", "\t"]) {
    const text = `x${fill(unit, 20000)}`;
    const ms = elapsed(() => {
      const st = new SentenceStream();
      for (let at = 0; at < text.length; at += 4) st.push(text.slice(at, at + 4));
      st.flush();
    });
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
  }
});

// ---- AxIS: clauses and passages ---------------------------------------------------

const QUESTION_LEAD =
  "what|when|who|whom|which|how|why|where|did|does|do|is|are|was|were|can|could|should|would|will|has|have|tell|show|give|list|remind|add|draft|email|find|check|pull|summari[sz]e|compare";

function oldSplitClauses(text: string): string[] {
  const lead = new RegExp(`,?\\s+(?:and|also|plus|then)\\s+(?=(?:${QUESTION_LEAD})\\b)`, "i");
  return text
    .split(/(?<=[?!])\s+|(?<=[a-z)\]"”]\.)\s+(?=[A-Z])|\n+|;\s+/)
    .flatMap((p) => p.split(lead))
    .map((p) => p.trim())
    .filter((p) => p.replace(/[^\p{L}\p{N}]/gu, "").length > 2);
}

test("splitClauses and collapseBeforeNewlines answer as before, in linear time", () => {
  const rand = seeded(34);
  const pieces = ["what", "is", "her", "GPA", " ", "  ", ",", ", ", "and", "also", "then", "did", "?", ".", "\n", "\t", ";", "x", "Mom"];
  for (let i = 0; i < 10000; i++) {
    const s = randomText(rand, pieces, 1 + Math.floor(rand() * 20));
    assert.deepEqual(splitClauses(s), oldSplitClauses(s), JSON.stringify(s));
    assert.equal(collapseBeforeNewlines(s), s.replace(/\s+\n/g, "\n"), JSON.stringify(s));
  }
  for (const unit of [" ", "\t", " and", ", ", " \n", "a "]) {
    const text = `what ${fill(unit, 8000)} x`;
    const ms = elapsed(() => splitClauses(text));
    assert.ok(ms < BUDGET_MS, `splitClauses ${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
    const big = fill(unit, 1_000_000);
    const ms2 = elapsed(() => collapseBeforeNewlines(big));
    assert.ok(ms2 < CAP_BUDGET_MS, `collapseBeforeNewlines ${JSON.stringify(unit)} took ${ms2.toFixed(1)} ms`);
  }
});

// ---- Log redaction ---------------------------------------------------------------

test("redactText cuts a long input before redacting, and never shows half a token", () => {
  for (const [unit, max] of [
    ["a", 2000], ["a ", 2000], ["a.", 2000], ["http://", 2000], ["sk-ant-", 2000], ["eyJ-", 2000], ["+1", 2000],
    ["a@", 2000], ["SG.", 2000], ["Bearer ", 2000], ["a", 4000], ["a.", 4000], ["-", 4000], ["1", 4000],
  ] as const) {
    for (const input of [fill(unit, 1_000_000), `${fill(unit, max + 500)} x`, `x ${fill(unit, max + 500)}`]) {
      const ms = elapsed(() => redactText(input, max));
      assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} (${max}) took ${ms.toFixed(1)} ms`);
    }
  }
  // An address the cut would split is dropped whole, not shown in part.
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${"eyJzdWIiOiJqYW5lQGV4YW1wbGUuY29tIn0".repeat(40)}.c2lnbmF0dXJl`;
  const quoted = `${"[jwt] ".repeat(300)}${jwt}`;
  const out = redactText(quoted);
  assert.ok(!out.includes("eyJ"), "no part of the token past the cut is shown");
  assert.match(out, /more characters\]$/);
  // Short text is redacted as before.
  assert.equal(
    redactText("mail jane@school.org with Bearer abc.def and +15551234567"),
    "mail [email] with Bearer [redacted] and [phone]"
  );
  const long = redactText(`${"word ".repeat(1000)}`);
  assert.ok(long.startsWith("word word"));
  assert.match(long, /… \[\d+ more characters\]$/);
});

// ---- Commons credit HTML ----------------------------------------------------------

test("stripHtml strips tags as /<[^>]*>/g did, in linear time", () => {
  const rand = seeded(32);
  for (let i = 0; i < 5000; i++) {
    const s = randomText(rand, ["<", ">", "<>", "a", " ", "&amp;", "<b>", "</b>"], Math.floor(rand() * 20));
    const old = s
      .replace(/<[^>]*>/g, " ")
      .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e: string) => (e.toLowerCase() === "amp" ? "&" : m))
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(stripHtml(s), old, JSON.stringify(s));
  }
  const ms = elapsed(() => stripHtml(fill("<a", 2_000_000)));
  assert.ok(ms < CAP_BUDGET_MS, `"<a" x 1M took ${ms.toFixed(1)} ms`);
});
