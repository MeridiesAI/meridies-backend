/**
 * The text of an uploaded document, read on the server: .txt, .md and .docx.
 *
 * A port of meridies-demo's lib/readDocument.ts. A Word file is a zip archive
 * with the prose in `word/document.xml`; the central directory is read with a
 * DataView (local header sizes can be zero when the writer streamed the
 * archive) and the entry inflated with node:zlib, so no dependency is added.
 * Anything else (a PDF, a scan, a damaged file) returns null and the essay is
 * marked unreadable rather than counted as empty.
 */

import { inflateRawSync } from "node:zlib";

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown"]);
/**
 * Largest file read for its text, as submission review caps it. An essay is a
 * few KB; anything past this is read as unreadable rather than parsed on the
 * event loop every request shares.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/**
 * Largest `word/document.xml` inflated. The 10 MB file cap is on the
 * compressed archive, and a few KB of repeated markup inflates to tens of MB,
 * so the work is bounded here, on what is parsed. An essay's part is tens of
 * KB; 2 MB holds a long manuscript's.
 */
export const MAX_XML_BYTES = 2 * 1024 * 1024;
/** Largest .txt / .md file read: 1 MB is about 170,000 words. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
/**
 * Most text a document may yield, as exportGoogleDocText caps a Doc. Past it
 * the file reads as unreadable rather than as a cut-off essay with a wrong
 * word count.
 */
export const MAX_TEXT_CHARS = 200_000;

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Line endings to "\n", non-breaking spaces to spaces, spaces and tabs at
 * the end of each line dropped, three or more line breaks to two, the ends
 * trimmed: what `text.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n")`,
 * then `/[ \t]+\n/g` and `/\n{3,}/g` did, in one scan. `/[ \t]+\n/g` rescanned
 * a long run of spaces with no newline from every position (100k spaces took
 * 11 s); the chain of replaces stayed linear but cost a regular-expression
 * match per character on a file of line breaks. Here a run of spaces, tabs
 * and line breaks is read once: with no break it stays as it is; with k
 * breaks it becomes one "\n" (k = 1) or two, followed by the spaces after
 * its last break, which indent the next line.
 */
export function normalizeText(text: string): string {
  let out = "";
  let pos = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 0xa0 && c !== 10 && c !== 13) {
      i++;
      continue;
    }
    const start = i;
    let breaks = 0;
    let afterBreak = i;
    while (i < n) {
      const d = text.charCodeAt(i);
      if (d === 13) {
        breaks++;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        afterBreak = i;
      } else if (d === 10) {
        breaks++;
        i++;
        afterBreak = i;
      } else if (d === 32 || d === 9 || d === 0xa0) {
        i++;
      } else {
        break;
      }
    }
    if (breaks === 0) continue;
    // A plain "\n" or "\n\n" is already what it would become.
    const plain = afterBreak - start === breaks && breaks <= 2 && text.charCodeAt(start) === 10 && text.charCodeAt(afterBreak - 1) === 10;
    if (plain) continue;
    out += text.slice(pos, start) + (breaks === 1 ? "\n" : "\n\n");
    pos = afterBreak;
  }
  out = pos === 0 ? text : out + text.slice(pos);
  return (out.includes("\u00a0") ? out.split("\u00a0").join(" ") : out).trim();
}

/** Words as the database counts them (private.essays_set_word_count). */
export function countWords(text: string): number {
  const t = text.replace(/ /g, " ").trim();
  return t ? t.split(/\s+/).length : 0;
}

export function isReadableName(filename: string, mimeType: string | null): boolean {
  const ext = extensionOf(filename);
  return TEXT_EXTENSIONS.has(ext) || ext === "docx" || mimeType === "text/plain";
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function textKind(filename: string, mimeType: string | null): "text" | "docx" | null {
  const ext = extensionOf(filename);
  if (TEXT_EXTENSIONS.has(ext) || mimeType === "text/plain" || mimeType === "text/markdown") return "text";
  if (ext === "docx" || mimeType === DOCX_MIME) return "docx";
  return null;
}

/**
 * Whether `readDocumentText` could read this file at all, asked before
 * downloading it: a format it can't open, or a file over
 * MAX_DOCUMENT_BYTES, reads as null without fetching a byte.
 */
export function canReadDocumentText(filename: string, mimeType: string | null, sizeBytes: unknown): boolean {
  if (typeof sizeBytes === "number" && sizeBytes > maxReadBytes(filename, mimeType)) return false;
  return textKind(filename, mimeType) !== null;
}

/**
 * The most bytes worth downloading to read this file's text: a .txt over
 * MAX_TEXT_FILE_BYTES reads as null, so there is no point fetching more. The
 * caller passes it to downloadCapped, which never trusts documents.size_bytes
 * (the client writes it).
 */
export function maxReadBytes(filename: string, mimeType: string | null): number {
  return textKind(filename, mimeType) === "text" ? MAX_TEXT_FILE_BYTES : MAX_DOCUMENT_BYTES;
}

export function readDocumentText(bytes: Buffer, filename: string, mimeType: string | null): string | null {
  if (bytes.length > MAX_DOCUMENT_BYTES) return null;
  const kind = textKind(filename, mimeType);
  try {
    if (kind === "text") {
      if (bytes.length > MAX_TEXT_FILE_BYTES) return null;
      const text = normalizeText(bytes.toString("utf8"));
      return text.length > MAX_TEXT_CHARS ? null : text;
    }
    if (kind === "docx") {
      const xml = unzipEntry(bytes, "word/document.xml");
      if (xml === null) return null;
      const raw = docxText(xml);
      return raw === null ? null : normalizeText(raw);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Paragraphs from WordprocessingML: one per `<w:p>`, runs joined, tabs and
 * breaks kept. Null past MAX_TEXT_CHARS, so a part of a million one-letter
 * runs stops as soon as it is clearly not an essay.
 */
function docxText(xml: string): string | null {
  const out: string[] = [];
  let length = 0;
  let from = 0;
  while (from <= xml.length) {
    const end = xml.indexOf("</w:p>", from);
    const p = paragraphText(xml.slice(from, end < 0 ? xml.length : end));
    if (p.trim().length > 0) {
      length += p.length + (out.length > 0 ? 2 : 0);
      if (length > MAX_TEXT_CHARS) return null;
      out.push(p);
    }
    if (end < 0) break;
    from = end + 6;
  }
  return out.join("\n\n");
}

/**
 * One paragraph's runs, as `/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g`
 * reads them, in one pass: `[^>]*` with no ">" after it rescanned the rest of
 * the part from every "<w:t " (200 KB took 7 s; the inflate cap was 20 MB then, 2 MB now).
 */
function paragraphText(p: string): string {
  // Raw run text, tabs and breaks, decoded once at the end: XML text holds
  // no bare "&", so no entity spans two runs.
  let out = "";
  // Lookups shared by every "<w:t " before the same ">": each is done once,
  // and a ">" that isn't there at all is looked for once, not per "<w:t ".
  let gt = -1;
  let noGt = false;
  let ltFrom = -1;
  let lt = -1;
  let i = p.indexOf("<");
  while (i >= 0) {
    if (p.startsWith("<w:tab/>", i)) {
      out += "\t";
      i = p.indexOf("<", i + 8);
      continue;
    }
    if (p.startsWith("<w:br/>", i)) {
      out += "\n";
      i = p.indexOf("<", i + 7);
      continue;
    }
    if (p.startsWith("<w:t", i)) {
      const after = i + 4;
      let open = -1;
      if (p[after] === ">") open = after;
      else if (after < p.length && /\s/.test(p[after]!)) {
        if (!noGt && gt < after) {
          gt = p.indexOf(">", after);
          noGt = gt < 0;
        }
        open = noGt ? -1 : gt;
      }
      if (open >= 0) {
        if (ltFrom !== open) {
          ltFrom = open;
          lt = p.indexOf("<", open + 1);
        }
        if (lt >= 0 && p.startsWith("</w:t>", lt)) {
          out += p.slice(open + 1, lt);
          i = p.indexOf("<", lt + 6);
          continue;
        }
      }
    }
    i = p.indexOf("<", i + 1);
  }
  return out.includes("&") ? decodeEntities(out) : out;
}

/**
 * XML's five named entities and numeric references (`&#65;`, `&#x41;`,
 * `&#X41;`), decoded in one left-to-right scan. The old chain of seven
 * regular-expression replaces walked the text seven times and decoded twice
 * ("&#38;lt;" became "<", not "&lt;"); a callback per entity also cost a
 * quarter of a second on a 2 MB run of them. Each "&" looks only at the
 * characters right after it, and a digit scan stops at the first non-digit
 * (the next "&" at the latest), so the scan is linear.
 */
const NAMED: ReadonlyArray<[string, string]> = [["lt;", "<"], ["gt;", ">"], ["quot;", '"'], ["apos;", "'"], ["amp;", "&"]];

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

export function decodeEntities(s: string): string {
  let out = "";
  let pos = 0;
  let amp = s.indexOf("&");
  while (amp >= 0) {
    let decoded: string | null = null;
    let end = -1;
    if (s.charCodeAt(amp + 1) === 35 /* # */) {
      const hex = s.charCodeAt(amp + 2) === 120 || s.charCodeAt(amp + 2) === 88; // x X
      const start = amp + (hex ? 3 : 2);
      let j = start;
      while (j < s.length && (hex ? isHexDigit(s.charCodeAt(j)) : isDigit(s.charCodeAt(j)))) j++;
      if (j > start && s.charCodeAt(j) === 59 /* ; */) {
        const digits = s.slice(start, j);
        decoded = safeCodePoint(hex ? parseInt(digits, 16) : Number(digits));
        end = j + 1;
      }
    } else {
      for (const [name, value] of NAMED) {
        if (s.startsWith(name, amp + 1)) {
          decoded = value;
          end = amp + 1 + name.length;
          break;
        }
      }
    }
    if (decoded !== null) {
      out += s.slice(pos, amp) + decoded;
      pos = end;
      amp = s.indexOf("&", end);
    } else {
      amp = s.indexOf("&", amp + 1);
    }
  }
  return pos === 0 ? s : out + s.slice(pos);
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** One file out of a zip archive, by name, or null. */
function unzipEntry(buf: Buffer, wanted: string): string | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = buf.byteLength;
  if (len < 22) return null;

  // End of central directory: 22 bytes plus a comment of up to 64 KB.
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  for (let n = 0; n < entries; n++) {
    if (at + 46 > len || view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    if (name === wanted) {
      if (localOffset + 30 > len) return null;
      const localName = view.getUint16(localOffset + 26, true);
      const localExtra = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localName + localExtra;
      if (start + compressedSize > len) return null;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return compressedSize > MAX_XML_BYTES ? null : data.toString("utf8");
      if (method !== 8) return null;
      return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }).toString("utf8");
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
