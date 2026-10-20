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

import { strFromU8, unzipSync } from "fflate";

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

/** [Content_Types].xml alone, inflated only when its declared size is small. Null when absent or unreadable. */
function contentTypes(bytes: Uint8Array): string | null {
  try {
    const out = unzipSync(bytes, {
      filter: (f) => f.name === "[Content_Types].xml" && f.originalSize <= 256 * 1024,
    });
    const entry = out["[Content_Types].xml"];
    return entry ? strFromU8(entry) : null;
  } catch {
    return null;
  }
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
    const ct = contentTypes(bytes);
    if (!ct) return "zip";
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
