/**
 * What an imported file really is, from its bytes: PDF by `%PDF-`, Word /
 * Excel / PowerPoint by a zip whose [Content_Types].xml names the matching
 * main part, legacy Office by the OLE header, images by their signatures, and
 * text by the absence of NUL bytes.
 *
 * A file whose name (or, without an extension, its declared type) claims one
 * of these must carry it; a file that is one of these must not arrive under a
 * name that says otherwise. Anything else (an .odt, a .heic) passes; under a
 * declared type of ours that its bytes don't match, it's kept only as a download.
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
  // Other OLE formats a counselor keeps: Outlook mail, Publisher, Office templates and shows.
  msg: "ole",
  pub: "ole",
  dot: "ole",
  xlt: "ole",
  pps: "ole",
  pot: "ole",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  jfif: "jpeg",
  jpe: "jpeg",
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
  // The end record is the one whose comment runs exactly to the end of the
  // file. A second one that also fits (a fake planted in the comment) makes the
  // zip ambiguous: readers disagree on which directory is real, so read none.
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  let e = -1;
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (u32(bytes, at) !== 0x06054b50 || at + 22 + u16(bytes, at + 20) !== bytes.length) continue;
    if (e !== -1) return null;
    e = at;
  }
  if (e === -1) return null;
  let off = u32(bytes, e + 16);
  // Zip64: the real directory offset is in the zip64 end record (low 32 bits suffice under 4 GB).
  if (e >= 20 && u32(bytes, e - 20) === 0x07064b50) {
    const z = u32(bytes, e - 12);
    if (z + 56 <= bytes.length && u32(bytes, z) === 0x06064b50) off = u32(bytes, z + 48);
  }
  while (off + 46 <= e && u32(bytes, off) === 0x02014b50) {
    const method = u16(bytes, off + 10);
    const nlen = u16(bytes, off + 28);
    const name = strFromU8(bytes.subarray(off + 46, off + 46 + nlen));
    if (name.toLowerCase() === "[content_types].xml") {
      const sizes = zip64Sizes(bytes, off, nlen);
      if (!sizes) return null;
      const { csize, lho } = sizes;
      if (lho + 30 > bytes.length || u32(bytes, lho) !== 0x04034b50) return null;
      const start = lho + 30 + u16(bytes, lho + 26) + u16(bytes, lho + 28);
      if (start + csize > bytes.length) return null;
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

/**
 * A central-directory entry's compressed size and local-header offset. Either
 * may be 0xFFFFFFFF with the real value in the zip64 extra field (id 0x0001),
 * which streaming zip writers always use. Null when that field is missing or
 * the value is past 4 GB (no import is that large).
 */
function zip64Sizes(bytes: Uint8Array, off: number, nlen: number): { csize: number; lho: number } | null {
  let csize = u32(bytes, off + 20);
  let lho = u32(bytes, off + 42);
  const usize = u32(bytes, off + 24);
  if (csize !== 0xffffffff && lho !== 0xffffffff && usize !== 0xffffffff) return { csize, lho };
  let x = off + 46 + nlen;
  const end = Math.min(bytes.length, x + u16(bytes, off + 30));
  while (x + 4 <= end) {
    const id = u16(bytes, x);
    const len = u16(bytes, x + 2);
    if (id === 0x0001) {
      // Values appear in this order, each only when its 32-bit field is 0xFFFFFFFF.
      let v = x + 4;
      const next = () => {
        if (v + 8 > x + 4 + len || v + 8 > end || u32(bytes, v + 4) !== 0) return null;
        const n = u32(bytes, v);
        v += 8;
        return n;
      };
      if (usize === 0xffffffff && next() === null) return null;
      if (csize === 0xffffffff) { const n = next(); if (n === null) return null; csize = n; }
      if (lho === 0xffffffff) { const n = next(); if (n === null) return null; lho = n; }
      return { csize, lho };
    }
    x += 4 + len;
  }
  return null;
}

/** What an OOXML zip's [Content_Types].xml declares; null when it isn't a readable OOXML zip. */
export type OfficeKind = "docx" | "xlsx" | "pptx" | "macro" | "other";

export function officeKind(bytes: Uint8Array): OfficeKind | null {
  const xml = contentTypes(bytes);
  if (!xml) return null;
  // The main part is usually named by an Override, but a Default can type it
  // too (every .xml part). So any macro-enabled main part (…macroEnabled.main+xml)
  // or a VBA project, in either, is a macro file. The xlsb Default SheetJS writes
  // into every .xlsx it saves (…binary.macroEnabled.main, no +xml) is not.
  const typed = (tag: string) =>
    [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*\\bContentType\\s*=\\s*["']([^"']*)["']`, "gi"))].map((m) => m[1]);
  const ct = typed("Override").join("\n");
  const all = [...typed("Override"), ...typed("Default")].join("\n");
  if (/macroEnabled/i.test(ct) || /macroEnabled\.main\+xml|vbaProject/i.test(all)) return "macro";
  if (/wordprocessingml\.document\.main\+xml/i.test(ct)) return "docx";
  if (/spreadsheetml\.sheet\.main\+xml/i.test(ct)) return "xlsx";
  if (/presentationml\.presentation\.main\+xml/i.test(ct)) return "pptx";
  return "other";
}

export function sniff(bytes: Uint8Array): Sniffed {
  if (bytes.length === 0) return "empty";
  // %PDF- may follow a BOM or blank lines some scanners write first.
  let lead = 0;
  while (lead < 1024 && lead < bytes.length && [0x00, 0x09, 0x0a, 0x0d, 0x20, 0xef, 0xbb, 0xbf].includes(bytes[lead])) lead++;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], lead)) return "pdf"; // %PDF-
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const kind = officeKind(bytes);
    if (kind === null) return "zip";
    return kind === "macro" || kind === "other" ? "ooxml-other" : kind;
  }
  // UTF-16 text (Excel's "Unicode Text", some SIS exports) is full of NULs.
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return "text";
  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  return head.includes(0) ? "binary" : "text";
}

/**
 * The name's extension, lower-cased, or null. Only a short run of letters and
 * digits (with at least one letter) after the last dot counts: "Rec - Mr. Jones"
 * or "Transcript 10.15.24" (Drive names) have none.
 */
export function extensionOf(name: string): string | null {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name.trim());
  return match && /[a-z]/i.test(match[1]) ? match[1].toLowerCase() : null;
}

const normalizeMime = (mime: string | null) => (mime ?? "").toLowerCase().split(";")[0].trim();

/** The family the file claims, by its extension or else its declared type. */
function declaredFamily(ext: string | null, mime: string): Family | null {
  if (ext && Object.hasOwn(BY_EXTENSION, ext)) return BY_EXTENSION[ext];
  return Object.hasOwn(BY_MIME, mime) ? BY_MIME[mime] : null;
}

const IMAGES = new Set<Sniffed>(["png", "jpeg", "gif", "webp"]);
const OOXML = new Set<Sniffed>(["docx", "xlsx", "pptx"]);
const LEGACY: Record<string, string> = {
  docx: "application/msword",
  xlsx: "application/vnd.ms-excel",
  pptx: "application/vnd.ms-powerpoint",
};

const LEGACY_EXT: Record<string, string> = { docx: "doc", xlsx: "xls", pptx: "ppt" };
const EXT_FOR: Record<string, string> = { docx: "docx", xlsx: "xlsx", pptx: "pptx", png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };

/** `{ extension }` when the name has one and it doesn't already say `to` (a family or a legacy extension). */
function renamed(current: string | null, to: string): { extension?: string } {
  if (!current) return {};
  const ext = EXT_FOR[to] ?? to;
  if (current === ext || BY_EXTENSION[current] === to) return {};
  return { extension: ext };
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
): { ok: true; mimeType: string | null; extension?: string } | { ok: false; declared: Family | null; found: string } {
  const found = sniff(bytes);
  const ext = extensionOf(name);
  const m = normalizeMime(declaredMime);
  const declared = declaredFamily(ext, m);
  if (declared === null) {
    if (!STRICT.has(found)) return { ok: true, mimeType: null };
    // A legacy Office file with no name to go by ("Transcript 10.15.24", octet-stream):
    // which one it is (.doc, .xls) isn't in the header, so keep the declared type.
    if (found === "ole" && !ext) return { ok: true, mimeType: null };
    const known = found !== "ole" && found !== "ooxml-other" ? CANONICAL[found as Exclude<Family, "ole" | "text">] : null;
    // A photo with no name to go by ("IMG_0001", octet-stream), or a .heic that is
    // really a JPEG: an image is an image. Same for a nameless PDF or Office file.
    if (known && (IMAGES.has(found) ? m.startsWith("image/") || !ext : !ext)) {
      return { ok: true, mimeType: known };
    }
    return { ok: false, declared, found };
  }
  if (found !== declared) {
    // An extension we don't know (.heic, .pages) under a declared type we do
    // (Drive and Graph label HEIC photos image/jpeg): the bytes aren't one of
    // ours, so neither label is trusted. Kept, but only as a download.
    if (ext && !Object.hasOwn(BY_EXTENSION, ext) && !STRICT.has(found)) {
      return { ok: true, mimeType: "application/octet-stream" };
    }
    // A photo saved under the wrong image extension, or an old/new Office
    // format swapped (.xls that is really .xlsx): same kind of file, store it as what it is.
    // The extension follows the stored type: text extraction picks its reader
    // from the name, and a .docx holding a legacy .doc would be read as a zip.
    if ((IMAGES.has(declared) && IMAGES.has(found)) || (declared === "ole" && OOXML.has(found))) {
      return { ok: true, mimeType: CANONICAL[found as Exclude<Family, "ole" | "text">], ...renamed(ext, found) };
    }
    if (OOXML.has(declared) && found === "ole") return { ok: true, mimeType: LEGACY[declared], ...renamed(ext, LEGACY_EXT[declared]) };
    // An empty .txt/.csv, or a legacy .doc/.xls that is really HTML, XML, RTF or
    // tab-separated text (SIS and web exports): what Drive held before, kept as declared.
    if ((declared === "text" && found === "empty") || (declared === "ole" && found === "text")) {
      return { ok: true, mimeType: null };
    }
    return { ok: false, declared, found };
  }
  if (declared === "ole" || declared === "text") return { ok: true, mimeType: null };
  return { ok: true, mimeType: CANONICAL[declared] };
}
