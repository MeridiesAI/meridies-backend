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
  MAX_TEXT_CHARS,
  MAX_TEXT_FILE_BYTES,
  MAX_XML_BYTES,
  canReadDocumentText,
  decodeEntities as decodeXmlEntities,
  maxReadBytes,
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

test("a .docx of one long unclosed run reads in well under 100 ms, and a 4 MB part is refused in under a second", () => {
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
  assert.equal(canReadDocumentText("essay.docx", null, MAX_DOCUMENT_BYTES + 1), false);
  assert.equal(canReadDocumentText("essay.docx", null, MAX_DOCUMENT_BYTES), true);
  assert.equal(canReadDocumentText("essay.docx", null, 1000), true);
  // A text file has its own, smaller cap.
  assert.equal(canReadDocumentText("essay.txt", "text/plain", MAX_TEXT_FILE_BYTES + 1), false);
  assert.equal(canReadDocumentText("essay.txt", "text/plain", MAX_TEXT_FILE_BYTES), true);
  assert.equal(maxReadBytes("essay.txt", null), MAX_TEXT_FILE_BYTES);
  assert.equal(maxReadBytes("essay.docx", null), MAX_DOCUMENT_BYTES);
  assert.equal(canReadDocumentText("essay.pdf", "application/pdf", 1000), false);
  // A row with no recorded size is checked on the bytes instead.
  assert.equal(canReadDocumentText("essay.md", null, null), true);
});

// ---- The follow-up review: bounded work per request ---------------------------

/** normalizeText as a chain of regular expressions, before it became one scan. */
function oldNormalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

test("normalizeText gives what the chain of regular expressions gave", () => {
  const rand = seeded(61);
  const pieces = ["a", "b c", " ", "  ", "\t", "\n", "\r", "\r\n", "\u00a0", "\f", "\v", "\u2003", "é"];
  for (let i = 0; i < 40000; i++) {
    const s = randomText(rand, pieces, Math.floor(rand() * 14));
    assert.equal(normalizeText(s), oldNormalizeText(s), JSON.stringify(s));
  }
});

/** The entity decode as seven replaces, before it became one scan. */
function oldDecode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

test("the .docx entity decode decodes once, as XML means it", () => {
  const rand = seeded(62);
  const pieces = ["&lt;", "&gt;", "&quot;", "&apos;", "&amp;", "&#65;", "&#x42;", "&#X43;", "&#;", "&#x;", "&", "#", ";", "a", "lt", "x", "1"];
  for (let i = 0; i < 40000; i++) {
    const s = randomText(rand, pieces, Math.floor(rand() * 10));
    // The old chain decoded a second time when one entity's result started
    // another ("&amp;lt;" survived, "&#38;lt;" did not); away from that the
    // two agree.
    const once = oldDecode(s);
    if (!/&#(?:38|x26|X26);/.test(s)) assert.equal(decodeXmlEntities(s), once, JSON.stringify(s));
  }
  assert.equal(decodeXmlEntities("&#38;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&#x110000;&#99999999999999999999;x"), "x");
  assert.equal(decodeXmlEntities("a & b &am"), "a & b &am");
});

/** `unit` repeated to `size` characters inside a body. */
function part(unit: string, size: number, wrap = false): string {
  const body = wrap ? `<w:p><w:t>${fill(unit, size)}</w:t></w:p>` : fill(unit, size);
  return `<w:document><w:body>${body}</w:body></w:document>`;
}

test("the review's inflating .docx files read in well under 100 ms", () => {
  // Each archive is a few KB to 37 KB; the old 20 MB inflate cap let them
  // expand to 19 MB and cost 0.8 to 1.6 s of parsing per request.
  for (const [label, xml] of [
    ["<w:t>x</w:t> to 19 MB", part("<w:t>x</w:t>", 19_000_000)],
    ["<w:t>\\r</w:t> to 19 MB", part("<w:t>\r</w:t>", 19_000_000)],
    ["&#x41; in one run to 19 MB", part("&#x41;", 19_000_000, true)],
    ["<w:br/></w:p><w:t>a</w:t></w:p> to 19 MB", part("<w:br/></w:p><w:t>a</w:t></w:p>", 19_000_000)],
  ] as const) {
    const bytes = docx(xml);
    assert.ok(bytes.length < 100_000, `${label}: the archive is small`);
    let text: string | null = "";
    const ms = elapsed(() => (text = readDocumentText(bytes, "essay.docx", null)));
    assert.equal(text, null, `${label} is past the inflate cap`);
    assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(1)} ms`);
  }
});

test("a .docx at the inflate cap, of any of the review's shapes, reads in under a second", () => {
  for (const [label, xml] of [
    ["one-letter runs", part("<w:t>x</w:t>", MAX_XML_BYTES - 100)],
    ["carriage returns", part("<w:t>\r</w:t>", MAX_XML_BYTES - 100)],
    ["entities in one run", part("&#x41;", MAX_XML_BYTES - 100, true)],
    ["&amp; runs", part("<w:t>&amp;</w:t>", MAX_XML_BYTES - 100)],
    ["empty paragraphs", part("<w:br/></w:p><w:t>a</w:t></w:p>", MAX_XML_BYTES - 100)],
  ] as const) {
    const bytes = docx(xml);
    const ms = elapsed(() => readDocumentText(bytes, "essay.docx", null));
    assert.ok(ms < CAP_BUDGET_MS, `${label} took ${ms.toFixed(1)} ms`);
  }
});

test("text past MAX_TEXT_CHARS, or a .txt past MAX_TEXT_FILE_BYTES, reads as unreadable", () => {
  const long = docx(part("<w:t>x</w:t>", 12 * (MAX_TEXT_CHARS + 10)));
  assert.equal(readDocumentText(long, "essay.docx", null), null);
  const fits = docx(`<w:body><w:p><w:t>${"word ".repeat(1000)}</w:t></w:p></w:body>`);
  assert.equal(readDocumentText(fits, "essay.docx", null)?.split(" ").length, 1000);
  assert.equal(readDocumentText(Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61), "essay.txt", null), null);
  assert.equal(readDocumentText(Buffer.alloc(MAX_TEXT_CHARS + 1, 0x61), "essay.txt", null), null);
  assert.equal(readDocumentText(Buffer.alloc(MAX_TEXT_CHARS, 0x61), "essay.txt", null)?.length, MAX_TEXT_CHARS);
});

test("a .txt of carriage returns reads in well under 100 ms, at the text cap and at 10 MB", () => {
  for (const size of [MAX_TEXT_FILE_BYTES, MAX_DOCUMENT_BYTES]) {
    const bytes = Buffer.alloc(size, 0x0d);
    const ms = elapsed(() => readDocumentText(bytes, "essay.txt", "text/plain"));
    assert.ok(ms < BUDGET_MS, `${size} bytes of "\\r" took ${ms.toFixed(1)} ms`);
  }
  for (const unit of ["\r", "a\r\n", " \n", "\u00a0"]) {
    const text = fill(unit, MAX_TEXT_FILE_BYTES);
    const ms = elapsed(() => normalizeText(text));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} x 1 MB took ${ms.toFixed(1)} ms`);
  }
});
