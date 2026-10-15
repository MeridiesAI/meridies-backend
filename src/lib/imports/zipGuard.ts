/**
 * The XLSX guard (spec §7.3), run in the parse worker before the parser.
 *
 * 1. The central directory's declared sizes: too many entries, an entry over
 *    50 MiB or over 100 MiB in all is refused as "too large when unpacked".
 *    fflate inflates into a buffer of the declared size and never grows it,
 *    so a header that lies only truncates; the worker's heap cap and timeout
 *    are the backstop for anything else.
 * 2. External links are refused (a workbook that reaches for other files).
 * 3. Every XML part is refused if it declares a DOCTYPE or an ENTITY, or is
 *    UTF-16 (where those markers would hide from a byte search). The parser
 *    (saxen) doesn't expand entities either; this refuses before it runs.
 * 4. The workbook's 1900/1904 date system, for raw serial numbers.
 *
 * The parts that passed are returned, so the parser reads exactly what was
 * checked (never a second reading of the original zip, which a crafted
 * archive could make differ).
 */

import { unzipSync } from "fflate";
import { MAX_UNCOMPRESSED_ENTRY, MAX_UNCOMPRESSED_TOTAL, MAX_ZIP_ENTRIES } from "./caps.js";

export type ZipVerdict =
  /** `parts`: the XML parts that passed, to hand to the parser (see sheet.ts). */
  | { ok: true; date1904: boolean; parts: Record<string, Uint8Array> }
  | { ok: false; reason: "too-large-unpacked" | "external-links" | "unsafe-xml" | "unreadable" };

type Caps = { total: number; entry: number; entries: number };
const DEFAULT_CAPS: Caps = { total: MAX_UNCOMPRESSED_TOTAL, entry: MAX_UNCOMPRESSED_ENTRY, entries: MAX_ZIP_ENTRIES };

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const MARKERS = [ascii("<!doctype"), ascii("<!entity")];

/** Case-insensitive search for an ASCII marker in bytes. */
export function containsMarker(bytes: Uint8Array, marker: Uint8Array): boolean {
  const first = marker[0];
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - marker.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < marker.length; j++) {
      const b = bytes[i + j];
      const lower = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
      if (lower !== marker[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function inspectXlsx(bytes: Uint8Array, caps: Caps = DEFAULT_CAPS): ZipVerdict {
  let entries = 0;
  let total = 0;
  let tooLarge = false;
  let external = false;
  try {
    // Pass 1: the central directory only (the filter declines every entry).
    unzipSync(bytes, {
      filter: (f) => {
        entries += 1;
        total += f.originalSize;
        if (f.originalSize > caps.entry) tooLarge = true;
        if (/^xl\/externalLinks\//i.test(f.name)) external = true;
        return false;
      },
    });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (tooLarge || entries > caps.entries || total > caps.total) return { ok: false, reason: "too-large-unpacked" };
  if (external) return { ok: false, reason: "external-links" };

  // Pass 2: every XML part, inflated to its declared size and searched.
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (f) => /\.(xml|rels|vml)$/i.test(f.name) });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let date1904 = false;
  for (const [name, data] of Object.entries(parts)) {
    if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
      return { ok: false, reason: "unsafe-xml" };
    }
    if (MARKERS.some((m) => containsMarker(data, m))) return { ok: false, reason: "unsafe-xml" };
    if (/^xl\/workbook\.xml$/i.test(name)) {
      const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 65536)));
      date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/i.test(head);
    }
  }
  return { ok: true, date1904, parts };
}
