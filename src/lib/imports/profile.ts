/**
 * The profile of a parsed file (spec §5.2): per column, counts and shapes,
 * never values. It is what the mapping screen shows next to each header and
 * all the parse-plan model may see (§7.1). Kept on import_files.profile until
 * commit.
 *
 * Min and max are kept only for a numeric column whose values are all small
 * (GPA, scores, hours, years: at most 2,100), so a column of ID numbers,
 * phone numbers or zip codes never hands its extremes to anyone; a date
 * column gives its year range only.
 */

import { createHash } from "node:crypto";
import { headerLooksLikeData, headerLooksLikeName, maskHeader, maskValue } from "./mask.js";
import { sensitiveHeader, type SensitiveCategory } from "./sensitive.js";
import type { ParsedSheet } from "./sheet.js";
import { parseDate, parseNumber } from "./values.js";

export type ColumnProfile = {
  index: number;
  /** The counselor's own header text: shown to them, never sent to a model. */
  header: string;
  maskedHeader: string;
  nonEmpty: number;
  pctEmpty: number;
  distinct: number;
  numeric: boolean;
  min: number | null;
  max: number | null;
  integer: boolean;
  dateLike: boolean;
  yearMin: number | null;
  yearMax: number | null;
  dateHints: { firstOver12: boolean; secondOver12: boolean; excelSerial: boolean };
  maxLength: number;
  samples: string[];
  sensitive: SensitiveCategory | null;
};

export type SheetProfile = {
  name: string;
  headerRow: number;
  rowCount: number;
  date1904: boolean;
  wide: boolean;
  fingerprint: string;
  columns: ColumnProfile[];
};

export type FileProfile = {
  fingerprint: string;
  sheets: SheetProfile[];
  /** Characters the parse handed back (headers and cells), toward the import's budget (caps.ts). */
  chars?: number;
};

const SAFE_RANGE_MAX = 2100;
const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, " ");
}

export function fingerprintOf(headersPerSheet: string[][]): string {
  return createHash("sha256").update(JSON.stringify(headersPerSheet.map((hs) => hs.map(normalizeHeader)))).digest("hex");
}

export function profileColumn(header: string, index: number, values: string[]): ColumnProfile {
  const cells = values.map((v) => v.trim()).filter((v) => v !== "");
  const distinct = new Set(cells).size;
  const nums = cells.map((c) => parseNumber(c));
  const numeric = cells.length > 0 && nums.every((n) => n !== null);
  const numbers = nums.filter((n): n is number => n !== null);
  const smallRange = numeric && numbers.every((n) => Math.abs(n) <= SAFE_RANGE_MAX);
  const integer = numeric && numbers.every((n) => Number.isInteger(n));
  const isoish = cells.map((c) => parseDate(c, "MDY") ?? parseDate(c, "DMY"));
  const dateLike = cells.length > 0 && !numeric && isoish.every((d) => d !== null);
  const years = dateLike ? isoish.map((d) => Number((d as string).slice(0, 4))) : [];
  let firstOver12 = false;
  let secondOver12 = false;
  for (const c of cells) {
    const m = SLASH.exec(c);
    if (!m) continue;
    if (+m[1] > 12) firstOver12 = true;
    if (+m[2] > 12) secondOver12 = true;
  }
  const excelSerial = integer && numbers.length > 0 && numbers.every((n) => n >= 18000 && n <= 60000);
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const c of cells) {
    const m = maskValue(c);
    if (seen.has(m)) continue;
    seen.add(m);
    samples.push(m);
    if (samples.length === 5) break;
  }
  return {
    index,
    header,
    maskedHeader: maskHeader(header, samples),
    nonEmpty: cells.length,
    pctEmpty: values.length === 0 ? 100 : Math.round(((values.length - cells.length) / values.length) * 100),
    distinct,
    numeric,
    min: smallRange ? Math.min(...numbers) : null,
    max: smallRange ? Math.max(...numbers) : null,
    integer,
    dateLike,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    dateHints: { firstOver12, secondOver12, excelSerial },
    maxLength: cells.reduce((m, c) => Math.max(m, c.length), 0),
    samples,
    sensitive: sensitiveHeader(header),
  };
}

/**
 * A sheet with one column per student: three or more headers that look like
 * people's names, or many more columns than rows.
 */
export function isWide(headers: string[], rowCount: number): boolean {
  const names = headers.filter((h) => headerLooksLikeName(h)).length;
  if (names >= 3) return true;
  return headers.length >= 20 && headers.length > 3 * Math.max(rowCount, 1);
}

/**
 * A "header row" that is really a student's row: two or more of its cells,
 * or half of its non-blank ones, look like data (a value's shape, a name,
 * or the shape of the column under it). Then no header in it is a label.
 */
export function headerRowIsData(columns: Array<Pick<ColumnProfile, "header" | "samples">>): boolean {
  const filled = columns.filter((c) => c.header.trim() !== "");
  const dataLike = filled.filter((c) => headerLooksLikeData(c.header, c.samples)).length;
  return dataLike >= 2 || (filled.length > 0 && dataLike * 2 >= filled.length);
}

export function profileSheet(sheet: ParsedSheet): SheetProfile {
  const columns = sheet.headers.map((h, i) => profileColumn(h, i, sheet.rows.map((r) => r[i] ?? "")));
  // No header row: every "header" is a cell of the first student's row, and
  // the model sees its shape like any other cell (§7.2).
  if (headerRowIsData(columns)) {
    for (const c of columns) c.maskedHeader = c.header.trim() === "" ? "<blank>" : maskValue(c.header);
  }
  return {
    name: sheet.name,
    headerRow: sheet.headerRow,
    rowCount: sheet.rows.length,
    date1904: sheet.date1904,
    wide: isWide(sheet.headers, sheet.rows.length),
    fingerprint: fingerprintOf([sheet.headers]),
    columns,
  };
}

export function profileFile(sheets: ParsedSheet[]): FileProfile {
  return { fingerprint: fingerprintOf(sheets.map((s) => s.headers)), sheets: sheets.map(profileSheet) };
}

/**
 * What the parse-plan model may see of a sheet: masked headers, shapes, safe
 * stats. Sheets are numbered, never named (a tab or a file can be named after
 * a student).
 */
export function modelView(p: SheetProfile, sheetNumber: number, only?: Set<number>) {
  return {
    sheet: sheetNumber,
    rows: p.rowCount,
    date1904: p.date1904,
    columns: p.columns
      .filter((c) => (!only || only.has(c.index)) && c.sensitive === null)
      .map((c) => ({
        index: c.index,
        header: c.maskedHeader,
        pctEmpty: c.pctEmpty,
        distinct: c.distinct,
        numeric: c.numeric,
        ...(c.min !== null ? { min: c.min, max: c.max } : {}),
        integer: c.integer,
        dateLike: c.dateLike,
        ...(c.yearMin !== null ? { years: `${c.yearMin}-${c.yearMax}` } : {}),
        dateHints: c.dateHints,
        maxLength: c.maxLength,
        samples: c.samples,
      })),
  };
}
