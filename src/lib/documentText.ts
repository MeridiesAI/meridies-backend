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
/** Largest XML part inflated: a 300-page manuscript is a few MB. */
const MAX_XML_BYTES = 20 * 1024 * 1024;

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function normalizeText(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
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

export function readDocumentText(bytes: Buffer, filename: string, mimeType: string | null): string | null {
  const ext = extensionOf(filename);
  try {
    if (TEXT_EXTENSIONS.has(ext) || mimeType === "text/plain" || mimeType === "text/markdown") {
      return normalizeText(bytes.toString("utf8"));
    }
    if (
      ext === "docx" ||
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
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
    .split(/<\/w:p>/)
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[0] === "<w:tab/>" ? "\t" : m[0] === "<w:br/>" ? "\n" : decodeEntities(m[1] ?? "")))
        .join("")
    )
    .filter((p) => p.trim().length > 0)
    .join("\n\n");
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
