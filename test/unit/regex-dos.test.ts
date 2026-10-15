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
import { stripHtml } from "../../src/lib/ingest/collegePhotos.js";
import { redactText } from "../../src/lib/requestLog.js";
import { BUDGET_MS, elapsed, randomText, seeded } from "./regex-dos-helpers.js";

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
  assert.ok(ms < BUDGET_MS, `"<a" x 1M took ${ms.toFixed(1)} ms`);
});
