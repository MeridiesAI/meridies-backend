/**
 * What an imported file really is, from its bytes: PDF by `%PDF-`, Word /
 * Excel / PowerPoint by a zip whose [Content_Types].xml names the matching
 * main part, legacy Office by the OLE header, images by their signatures, and
 * text by the absence of NUL bytes.
 *
 * A file whose name (or, without an extension, its declared type) claims one
 * of these must carry it; a file that is one of these must not arrive under a
 * name that says otherwise. Anything else (an .odt, a .heic) passes as before.
 */

import { inflateRawSync } from "node:zlib";
import { strFromU8 } from "fflate";

export type Family =
  | "pdf" | "docx" | "xlsx" | "pptx" | "ole" | "png" | "jpeg" | "gif" | "webp" | "text";

/** What bytes can be found to be beyond the families: a macro or unknown Office zip, another zip, or nothing known. */
type Sniffed = Family | "ooxml-other" | "zip" | "empty" | "binary";

const CANONICAL: Record<Exclude<Family, "ole" | "text">, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const BY_EXTENSION: Record<string, Family> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  doc: "ole",
  xls: "ole",
  ppt: "ole",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  txt: "text",
  csv: "text",
  md: "text",
};

const BY_MIME: Record<string, Family> = {
  "application/pdf": "pdf",
  [CANONICAL.docx]: "docx",
  [CANONICAL.xlsx]: "xlsx",
  [CANONICAL.pptx]: "pptx",
  "application/msword": "ole",
  "application/vnd.ms-excel": "ole",
  "application/vnd.ms-powerpoint": "ole",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "text",
  "text/csv": "text",
  "text/markdown": "text",
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

const CT_MAX = 256 * 1024;
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

/**
 * [Content_Types].xml alone, read by hand from the central directory: every
 * step is bounded by the bytes themselves (a forged entry count can't loop
 * past them) and inflation stops at CT_MAX output (a deflate bomb can't spin).
 * Null when absent, unreadable or larger than CT_MAX.
 */
function contentTypes(bytes: Uint8Array): string | null {
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  let e = bytes.length - 22;
  while (e >= floor && u32(bytes, e) !== 0x06054b50) e--;
  if (e < floor) return null;
  let off = u32(bytes, e + 16);
  // Zip64: the real directory offset is in the zip64 end record (low 32 bits suffice under 4 GB).
  if (e >= 20 && u32(bytes, e - 20) === 0x07064b50) {
    const z = u32(bytes, e - 12);
    if (z + 56 <= bytes.length && u32(bytes, z) === 0x06064b50) off = u32(bytes, z + 48);
  }
  while (off + 46 <= e && u32(bytes, off) === 0x02014b50) {
    const method = u16(bytes, off + 10);
    const csize = u32(bytes, off + 20);
    const nlen = u16(bytes, off + 28);
    const name = strFromU8(bytes.subarray(off + 46, off + 46 + nlen));
    if (name.toLowerCase() === "[content_types].xml") {
      const lho = u32(bytes, off + 42);
      if (lho + 30 > bytes.length || u32(bytes, lho) !== 0x04034b50) return null;
      const start = lho + 30 + u16(bytes, lho + 26) + u16(bytes, lho + 28);
      if (csize === 0xffffffff || start + csize > bytes.length) return null;
      const raw = bytes.subarray(start, start + csize);
      try {
        if (method === 0) return csize <= CT_MAX ? strFromU8(raw) : null;
        if (method === 8) return strFromU8(inflateRawSync(raw, { maxOutputLength: CT_MAX }));
      } catch {
        return null;
      }
      return null;
    }
    off += 46 + nlen + u16(bytes, off + 30) + u16(bytes, off + 32);
  }
  return null;
}

export function sniff(bytes: Uint8Array): Sniffed {
  if (bytes.length === 0) return "empty";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const xml = contentTypes(bytes);
    if (!xml) return "zip";
    // The main part is named by an Override. A Default (by extension) doesn't
    // make a file macro-enabled: SheetJS writes a .bin Default naming the xlsb
    // type into every .xlsx it saves.
    const ct = [...xml.matchAll(/<Override\b[^>]*\bContentType\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]).join("\n");
    if (/macroEnabled/i.test(ct)) return "ooxml-other";
    if (/wordprocessingml\.document\.main\+xml/i.test(ct)) return "docx";
    if (/spreadsheetml\.sheet\.main\+xml/i.test(ct)) return "xlsx";
    if (/presentationml\.presentation\.main\+xml/i.test(ct)) return "pptx";
    return "ooxml-other";
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  return head.includes(0) ? "binary" : "text";
}

function declaredFamily(name: string, mime: string | null): Family | null {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext && Object.hasOwn(BY_EXTENSION, ext)) return BY_EXTENSION[ext];
  // An extension we don't know (.odt, .heic) speaks for the file: the declared type doesn't.
  if (ext) return null;
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  return Object.hasOwn(BY_MIME, m) ? BY_MIME[m] : null;
}

/** Bytes that are certainly one of the families (text excluded: any NUL-free bytes read as text). */
const STRICT = new Set<Sniffed>(["pdf", "docx", "xlsx", "pptx", "ole", "png", "jpeg", "gif", "webp", "ooxml-other"]);

/**
 * `ok: false` when the bytes and the name disagree. `mimeType` is the type
 * to store a known family under, else null (keep the declared one).
 */
export function detectContentType(
  bytes: Uint8Array,
  name: string,
  declaredMime: string | null
): { ok: true; mimeType: string | null } | { ok: false; declared: Family | null; found: string } {
  const found = sniff(bytes);
  const declared = declaredFamily(name, declaredMime);
  if (declared === null) {
    return STRICT.has(found) ? { ok: false, declared, found } : { ok: true, mimeType: null };
  }
  if (found !== declared) return { ok: false, declared, found };
  if (declared === "ole" || declared === "text") return { ok: true, mimeType: null };
  return { ok: true, mimeType: CANONICAL[declared] };
}
