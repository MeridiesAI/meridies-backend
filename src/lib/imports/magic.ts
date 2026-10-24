/**
 * What a file really is, from its bytes (spec §5.1, §7.3), never from the
 * name or the type the browser declared.
 */

import { officeKind } from "../fileSniff.js";

export type Detected =
  | { type: "xlsx" }
  | { type: "csv"; encoding: "utf-8" | "windows-1252" }
  | { type: "refused"; reason: "not-spreadsheet" | "legacy-xls" | "macro" };

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

export function detectType(bytes: Uint8Array): Detected {
  if (bytes.length === 0) return { type: "refused", reason: "not-spreadsheet" };
  // Legacy .xls (OLE compound file).
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { type: "refused", reason: "legacy-xls" };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // The same bounded [Content_Types].xml reader and macro rule as Drive and OneDrive imports.
    const kind = officeKind(bytes);
    if (kind === "macro") return { type: "refused", reason: "macro" };
    if (kind === "xlsx") return { type: "xlsx" };
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
