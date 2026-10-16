/**
 * The link reader's and document reader's text scanning (lib/linearText.ts,
 * links.ts extractText, documentText.ts): each linear helper gives exactly what
 * the regular expression it replaced gave, on random input, and the worst-case
 * inputs from the security review finish in well under 100 ms. The regular
 * expressions took 26 s ("<script" x 100k), 107 s ("<a" x 200k) and 37 s
 * (200k spaces) on the same shapes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { asciiLower, replaceBlocks, replaceTags, trimLineEnds } from "../../src/lib/linearText.js";
import { extractText } from "../../src/lib/links.js";
import {
  MAX_DOCUMENT_BYTES,
  canReadDocumentText,
  normalizeText,
  readDocumentText,
} from "../../src/lib/documentText.js";
import { BUDGET_MS, CAP_BUDGET_MS, elapsed, randomText, seeded } from "./regex-dos-helpers.js";

const HTML_PIECES = [
  "<", ">", "</", "a", "A", " ", "\t", "\n", "-", "!", "/", "x", "&amp;", "&nbsp;",
  "<script", "</script>", "<SCRIPT", "</Script>", "<style", "</style>", "<noscript", "</noscript>",
  "<!--", "-->", "<p>", "</p>", "</div>", "<br>", "<br/>", "<title>", "</title>", "<TITLE x>", " ",
];

// ---- The helpers against the regular expressions they replace ----------------

test("asciiLower lowers A-Z only and keeps every index", () => {
  const rand = seeded(1);
  for (let i = 0; i < 500; i++) {
    const s = randomText(rand, ["A", "z", "Ä", "İ", "K", "ſ", " ", "<"], 30);
    const lowered = asciiLower(s);
    assert.equal(lowered.length, s.length);
    assert.equal(lowered, s.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  }
});

test("replaceBlocks matches /<open>[\\s\\S]*?<close>/gi", () => {
  const rand = seeded(2);
  const cases: [string, string, RegExp][] = [
    ["<script", "</script>", /<script[\s\S]*?<\/script>/gi],
    ["<style", "</style>", /<style[\s\S]*?<\/style>/gi],
    ["<!--", "-->", /<!--[\s\S]*?-->/g],
  ];
  for (let i = 0; i < 3000; i++) {
    const s = randomText(rand, HTML_PIECES, 1 + Math.floor(rand() * 25));
    for (const [open, close, re] of cases) {
      assert.equal(replaceBlocks(s, open, close, " "), s.replace(re, " "), JSON.stringify(s));
    }
  }
});

test("replaceTags matches /<[^>]+>/g, and /<[^>]*>/g with allowEmpty", () => {
  const rand = seeded(3);
  for (let i = 0; i < 3000; i++) {
    const s = randomText(rand, ["<", ">", "<>", "a", " ", "\n", "</", "/>"], 1 + Math.floor(rand() * 30));
    assert.equal(replaceTags(s, " "), s.replace(/<[^>]+>/g, " "), JSON.stringify(s));
    assert.equal(replaceTags(s, "#", true), s.replace(/<[^>]*>/g, "#"), JSON.stringify(s));
  }
});

test("trimLineEnds matches /[ \\t]+\\n/g", () => {
  const rand = seeded(4);
  for (let i = 0; i < 3000; i++) {
    const s = randomText(rand, [" ", "\t", "\n", "a", "\r", " "], 1 + Math.floor(rand() * 30));
    assert.equal(trimLineEnds(s), s.replace(/[ \t]+\n/g, "\n"), JSON.stringify(s));
  }
});

// ---- extractText against the old implementation -------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

/** extractText as it stood before the fix (quadratic on a missing closing token). */
function oldExtractText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).trim().slice(0, 300) : null;
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

test("extractText reads a page exactly as before", () => {
  const rand = seeded(5);
  for (let i = 0; i < 3000; i++) {
    const html = randomText(rand, HTML_PIECES, 1 + Math.floor(rand() * 40));
    assert.deepEqual(extractText(html), oldExtractText(html), JSON.stringify(html));
  }
  const page =
    "<html><head><TITLE lang=en>Fees &amp; aid</TITLE><style>p{}</style><script>var a='<p>'</script></head>" +
    "<body><!-- nav --><h1>Aid</h1><p>Apply by <b>March&nbsp;1</b>.</p><br/><div>Done</div></body></html>";
  assert.deepEqual(extractText(page), oldExtractText(page));
  assert.deepEqual(extractText(page), {
    title: "Fees & aid",
    text: "Fees & aid Aid\n Apply by March 1 .\n\n Done",
  });
});

test("extractText keeps the 300-character title window", () => {
  const long = `<title>${"t".repeat(300)}</title><title>second</title>`;
  assert.deepEqual(extractText(long), oldExtractText(long));
  const tooLong = `<title>${"t".repeat(301)}</title><title>second</title>`;
  assert.equal(extractText(tooLong).title, "second");
  assert.deepEqual(extractText(tooLong), oldExtractText(tooLong));
});

// ---- Worst cases from the review ----------------------------------------------

/** 2 MB, the most readCapped hands to extractText. */
const TWO_MB = 2_000_000;
const fill = (unit: string, size = TWO_MB) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** The review's sizes: "<a" x 200k took 107 s, "<script" x 100k 26 s, 200k spaces 37 s. */
const REVIEW_SIZE = 400_000;

test("extractText finishes a page with no closing token in well under 100 ms, and a 2 MB one in under a second", () => {
  for (const unit of ["<a", "<script", "<style", "<noscript", "<!--", "<title", "<title>", "<br ", "< ", "<p"]) {
    const html = fill(unit, REVIEW_SIZE);
    const ms = elapsed(() => extractText(html));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} x ${REVIEW_SIZE / unit.length} took ${ms.toFixed(1)} ms`);
    const page = fill(unit);
    const capMs = elapsed(() => extractText(page));
    assert.ok(capMs < CAP_BUDGET_MS, `${JSON.stringify(unit)} x ${TWO_MB / unit.length} took ${capMs.toFixed(1)} ms`);
  }
  // A real document followed by an unclosed tag still reads.
  const mixed = `<title>Real</title><p>Kept</p>${fill("<a", TWO_MB - 40)}`;
  const ms = elapsed(() => {
    const r = extractText(mixed);
    assert.equal(r.title, "Real");
    assert.ok(r.text.startsWith("Real Kept"));
  });
  assert.ok(ms < CAP_BUDGET_MS, `mixed page took ${ms.toFixed(1)} ms`);
});

test("normalizeText finishes spaces with no newline in well under 100 ms, and 10 MB of them in under a second", () => {
  for (const unit of [" ", "\t", " \t", "a "]) {
    const text = fill(unit, REVIEW_SIZE);
    const ms = elapsed(() => normalizeText(text));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
    const big = fill(unit, MAX_DOCUMENT_BYTES);
    const capMs = elapsed(() => normalizeText(big));
    assert.ok(capMs < CAP_BUDGET_MS, `${JSON.stringify(unit)} x 10 MB took ${capMs.toFixed(1)} ms`);
  }
  assert.equal(normalizeText("a  \t\nb \r\n\n\n\nc  "), "a\nb\n\nc");
});

// ---- .docx --------------------------------------------------------------------

/** A minimal .docx: one stored-or-deflated word/document.xml in a zip. */
function docx(xml: string): Buffer {
  const name = Buffer.from("word/document.xml");
  const raw = Buffer.from(xml, "utf8");
  const data = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralAt = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralAt, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

function oldDocxText(xml: string): string {
  const decode = (s: string) =>
    s
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[0] === "<w:tab/>" ? "\t" : m[0] === "<w:br/>" ? "\n" : decode(m[1] ?? "")))
        .join("")
    )
    .filter((p) => p.trim().length > 0)
    .join("\n\n");
}

test("a .docx reads exactly as the regular expression read it", () => {
  const rand = seeded(6);
  const pieces = [
    "<w:t>", "<w:t xml:space=\"preserve\">", "<w:t ", "<w:t\t", "<w:tx>", "</w:t>", "<w:tab/>", "<w:br/>",
    "<w:p>", "</w:p>", "<w:r>", "</w:r>", ">", "<", "a", "B", " ", "&amp;", "&#65;", "&#x42;", "\n",
  ];
  for (let i = 0; i < 3000; i++) {
    const xml = randomText(rand, pieces, 1 + Math.floor(rand() * 30));
    const expected = normalizeText(oldDocxText(xml));
    assert.equal(readDocumentText(docx(xml), "essay.docx", null), expected, JSON.stringify(xml));
  }
  const xml =
    '<w:body><w:p><w:r><w:t>Dear</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> reader &amp; friend</w:t></w:r></w:p>' +
    "<w:p><w:r><w:t>Line</w:t><w:br/><w:t>two</w:t></w:r></w:p></w:body>";
  assert.equal(readDocumentText(docx(xml), "a.docx", null), "Dear\t reader & friend\n\nLine\ntwo");
});

test("a .docx of one long unclosed run reads in well under 100 ms, and a 4 MB part in under a second", () => {
  for (const unit of ["<w:t ", "<w:t", "<w:t>", "<w:t x>", "<"]) {
    const small = docx(`<w:body><w:p>${fill(unit, REVIEW_SIZE)}</w:p></w:body>`);
    const ms = elapsed(() => readDocumentText(small, "essay.docx", null));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} x ${REVIEW_SIZE / unit.length} took ${ms.toFixed(1)} ms`);
    const bytes = docx(`<w:body><w:p>${fill(unit, 4_000_000)}</w:p></w:body>`);
    assert.ok(bytes.length < 200_000, "the archive is small; the inflated part is what costs");
    const capMs = elapsed(() => readDocumentText(bytes, "essay.docx", null));
    assert.ok(capMs < CAP_BUDGET_MS, `${JSON.stringify(unit)} x 4 MB took ${capMs.toFixed(1)} ms`);
  }
});

test("a file over MAX_DOCUMENT_BYTES is unreadable, and is refused before download", () => {
  const big = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20);
  assert.equal(readDocumentText(big, "essay.txt", "text/plain"), null);
  assert.equal(canReadDocumentText("essay.txt", "text/plain", MAX_DOCUMENT_BYTES + 1), false);
  assert.equal(canReadDocumentText("essay.txt", "text/plain", MAX_DOCUMENT_BYTES), true);
  assert.equal(canReadDocumentText("essay.docx", null, 1000), true);
  assert.equal(canReadDocumentText("essay.pdf", "application/pdf", 1000), false);
  // A row with no recorded size is checked on the bytes instead.
  assert.equal(canReadDocumentText("essay.md", null, null), true);
});
