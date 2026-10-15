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
import { trimLineEnds } from "./linearText.js";

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown"]);
/** Largest XML part inflated: a 300-page manuscript is a few MB. */
const MAX_XML_BYTES = 20 * 1024 * 1024;
/**
 * Largest file read for its text, as submission review caps it. An essay is a
 * few KB; anything past this is read as unreadable rather than parsed on the
 * event loop every request shares.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Linear in the text: the line-end trim is a per-line scan, not
 * `/[ \t]+\n/g`, which rescans a long run of spaces with no newline from
 * every position (100k spaces took 11 s).
 */
export function normalizeText(text: string): string {
  return trimLineEnds(text.replace(/ /g, " ").replace(/\r\n?/g, "\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  if (typeof sizeBytes === "number" && sizeBytes > MAX_DOCUMENT_BYTES) return false;
  return textKind(filename, mimeType) !== null;
}

export function readDocumentText(bytes: Buffer, filename: string, mimeType: string | null): string | null {
  if (bytes.length > MAX_DOCUMENT_BYTES) return null;
  const kind = textKind(filename, mimeType);
  try {
    if (kind === "text") {
      return normalizeText(bytes.toString("utf8"));
    }
    if (kind === "docx") {
      const xml = unzipEntry(bytes, "word/document.xml");
      return xml === null ? null : normalizeText(docxText(xml));
    }
  } catch {
    return null;
  }
  return null;
}

/** Paragraphs from WordprocessingML: one per `<w:p>`, runs joined, tabs and breaks kept. */
function docxText(xml: string): string {
  return xml
    .split("</w:p>")
    .map(paragraphText)
    .filter((p) => p.trim().length > 0)
    .join("\n\n");
}

/**
 * One paragraph's runs, as `/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g`
 * reads them, in one pass: `[^>]*` with no ">" after it rescanned the rest of
 * the part from every "<w:t " (200 KB took 7 s, and the inflate cap allows 20 MB).
 */
function paragraphText(p: string): string {
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
          out += decodeEntities(p.slice(open + 1, lt));
          i = p.indexOf("<", lt + 6);
          continue;
        }
      }
    }
    i = p.indexOf("<", i + 1);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
      if (method === 0) return data.toString("utf8");
      if (method !== 8) return null;
      return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }).toString("utf8");
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
