/**
 * What a file really is, from its bytes (spec §5.1, §7.3), never from the
 * name or the type the browser declared.
 */

import { unzipSync, strFromU8 } from "fflate";

export type Detected =
  | { type: "xlsx" }
  | { type: "csv"; encoding: "utf-8" | "windows-1252" }
  | { type: "refused"; reason: "not-spreadsheet" | "legacy-xls" | "macro" };

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

/**
 * The zip's [Content_Types].xml, read on its own: a small entry, inflated
 * only when its declared size is small. Null when the zip has none.
 */
function contentTypes(bytes: Uint8Array): string | null {
  let found: string | null = null;
  try {
    const out = unzipSync(bytes, {
      filter: (f) => f.name === "[Content_Types].xml" && f.originalSize <= 256 * 1024,
    });
    const entry = out["[Content_Types].xml"];
    if (entry) found = strFromU8(entry);
  } catch {
    return null;
  }
  return found;
}

export function detectType(bytes: Uint8Array): Detected {
  if (bytes.length === 0) return { type: "refused", reason: "not-spreadsheet" };
  // Legacy .xls (OLE compound file).
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { type: "refused", reason: "legacy-xls" };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const ct = contentTypes(bytes);
    if (!ct) return { type: "refused", reason: "not-spreadsheet" };
    if (/macroEnabled/i.test(ct)) return { type: "refused", reason: "macro" };
    if (/spreadsheetml\.sheet\.main\+xml/i.test(ct)) return { type: "xlsx" };
    return { type: "refused", reason: "not-spreadsheet" };
  }
  // Anything else must be text. A NUL byte means binary (PDF, image, UTF-16).
  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  if (head.includes(0)) return { type: "refused", reason: "not-spreadsheet" };
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { type: "refused", reason: "not-spreadsheet" }; // %PDF
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { type: "csv", encoding: "utf-8" };
  } catch {
    // Not UTF-8: Excel's "CSV" on Windows is windows-1252. Refuse control
    // characters other than tab, CR and LF, which no spreadsheet text has.
    for (const b of head) {
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return { type: "refused", reason: "not-spreadsheet" };
    }
    return { type: "csv", encoding: "windows-1252" };
  }
}
