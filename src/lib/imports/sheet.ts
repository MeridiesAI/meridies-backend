/**
 * Turn a file's bytes into sheets of text cells. Runs inside the parse
 * worker (parseWorker.ts); pure, so it is unit-tested without one.
 *
 * Every cell comes back as a string: numbers as their text, date-formatted
 * XLSX cells as ISO dates, booleans as TRUE/FALSE. Formulas are never
 * evaluated: an XLSX formula cell gives its cached value (or nothing), and a
 * cell whose text starts with = + - @ stays text.
 */

import { parse as parseCsv } from "csv-parse/sync";
import { zipSync } from "fflate";
import readXlsxFile from "read-excel-file/universal";
import { HEADER_SEARCH_ROWS, MAX_COLUMNS } from "./caps.js";
import { detectType } from "./magic.js";
import { inspectXlsx } from "./zipGuard.js";

export type ParsedSheet = {
  name: string;
  /** 1-based spreadsheet row of the header. */
  headerRow: number;
  headers: string[];
  /** Data rows only, each padded to the header width. */
  rows: string[][];
  /** 1-based spreadsheet row number of each data row (for "Sheet1!D12"). */
  rowNumbers: number[];
  date1904: boolean;
};

export type ParseFailure =
  | "not-spreadsheet"
  | "legacy-xls"
  | "macro"
  | "too-large-unpacked"
  | "external-links"
  | "unsafe-xml"
  | "unreadable"
  | "too-many-rows"
  | "too-many-columns"
  | "empty"
  | "timeout"
  | "memory";

export type ParseOutcome =
  | { ok: true; detectedType: "csv" | "xlsx"; sheets: ParsedSheet[] }
  | { ok: false; detectedType: "csv" | "xlsx" | "unknown"; reason: ParseFailure };

/** The first row with two or more non-empty cells, within the first rows. */
export function findHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    if (rows[i].filter((c) => c.trim() !== "").length >= 2) return i;
  }
  return -1;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  return "";
}

/** Rows of raw cells into a sheet: header found, empty rows dropped, widths padded. */
export function toSheet(
  name: string,
  raw: string[][],
  date1904: boolean,
  maxRows: number,
  /** 1-based line of each raw row, when it isn't its index + 1 (CSV). */
  lines?: number[]
): ParsedSheet | "empty" | "too-many-rows" | "too-many-columns" {
  const h = findHeaderRow(raw);
  if (h === -1) return "empty";
  let headers = raw[h].map((c) => c.trim());
  // Trailing blank headers with no data under them are noise.
  while (headers.length > 0 && headers[headers.length - 1] === "") headers = headers.slice(0, -1);
  if (headers.length > MAX_COLUMNS) return "too-many-columns";
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = h + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r.some((c) => c.trim() !== "")) continue;
    if (r.length > MAX_COLUMNS && r.slice(MAX_COLUMNS).some((c) => c.trim() !== "")) return "too-many-columns";
    rows.push(Array.from({ length: headers.length }, (_, j) => r[j] ?? ""));
    rowNumbers.push(lines?.[i] ?? i + 1);
    if (rows.length > maxRows) return "too-many-rows";
  }
  return { name, headerRow: lines?.[h] ?? h + 1, headers, rows, rowNumbers, date1904 };
}

/** `,` `;` or tab, whichever splits the first lines most consistently. */
export function sniffDelimiter(text: string): "," | ";" | "\t" {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 10);
  let best: "," | ";" | "\t" = ",";
  let bestScore = 0;
  for (const d of [",", ";", "\t"] as const) {
    const counts = lines.map((l) => l.replace(/"[^"]*"/g, "").split(d).length - 1);
    const min = Math.min(...counts);
    const score = counts.length === 0 ? 0 : min * 10 + counts.reduce((a, b) => a + b, 0) / counts.length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function sheetNameForCsv(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N} _-]+/gu, "").trim();
  return (base || "Sheet1").slice(0, 60);
}

export async function parseSpreadsheet(bytes: Uint8Array, fileName: string, maxRows: number): Promise<ParseOutcome> {
  const detected = detectType(bytes);
  if (detected.type === "refused") return { ok: false, detectedType: "unknown", reason: detected.reason };

  if (detected.type === "csv") {
    let text: string;
    try {
      text = new TextDecoder(detected.encoding).decode(bytes);
    } catch {
      return { ok: false, detectedType: "csv", reason: "unreadable" };
    }
    let records: string[][];
    let lines: number[];
    try {
      const parsed = parseCsv(text, {
        info: true,
        bom: true,
        delimiter: sniffDelimiter(text.slice(0, 65536)),
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        // Enough to find a header and to know the file is over the limit.
        to: maxRows + HEADER_SEARCH_ROWS + 1,
      }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
      records = parsed.map((p) => p.record);
      lines = parsed.map((p) => p.info.lines);
    } catch {
      return { ok: false, detectedType: "csv", reason: "unreadable" };
    }
    const sheet = toSheet(sheetNameForCsv(fileName), records, false, maxRows, lines);
    if (typeof sheet === "string") return { ok: false, detectedType: "csv", reason: sheet };
    return { ok: true, detectedType: "csv", sheets: [sheet] };
  }

  const verdict = inspectXlsx(bytes);
  if (!verdict.ok) return { ok: false, detectedType: "xlsx", reason: verdict.reason };
  // The parser reads the parts the guard checked, stored uncompressed: no
  // second reading of the original archive, and no inflation (or helper
  // threads) inside the parser.
  const vetted = zipSync(verdict.parts, { level: 0 });
  let workbook: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    workbook = await readXlsxFile(vetted.buffer.slice(vetted.byteOffset, vetted.byteOffset + vetted.byteLength) as ArrayBuffer);
  } catch {
    return { ok: false, detectedType: "xlsx", reason: "unreadable" };
  }
  const sheets: ParsedSheet[] = [];
  let total = 0;
  for (const s of workbook) {
    const raw = s.data.map((row) => row.map(cellText));
    const sheet = toSheet(String(s.sheet).slice(0, 60), raw, verdict.date1904, maxRows - total);
    if (sheet === "empty") continue;
    if (typeof sheet === "string") return { ok: false, detectedType: "xlsx", reason: sheet };
    total += sheet.rows.length;
    sheets.push(sheet);
  }
  if (sheets.length === 0) return { ok: false, detectedType: "xlsx", reason: "empty" };
  return { ok: true, detectedType: "xlsx", sheets };
}
