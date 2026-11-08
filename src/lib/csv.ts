/**
 * CSV for exports a person opens in a spreadsheet (the batched student export,
 * the Google Sheets roster summary). RFC 4180: a cell holding a comma, a quote
 * or a line break is quoted and its quotes doubled; rows end in CRLF.
 *
 * **Formula injection (OWASP "CSV Injection").** Excel, Numbers, LibreOffice
 * and Google Sheets run a cell that starts with `=`, `+`, `-` or `@` as a
 * formula (`=HYPERLINK(...)`, DDE `=cmd|...`), and a leading tab or carriage
 * return can smuggle one in. Exported text is written by students, families,
 * imports and AI, so any STRING cell that starts with one of those, after any
 * leading white space (spaces, NBSP, BOM, ideographic space, line breaks) or as
 * a full-width look-alike (＝ ＋ － ＠), gets a leading apostrophe: the
 * spreadsheet shows the text as typed and runs nothing. Typed numbers,
 * booleans and bigints are written as they are, so `-5` stays a number; a
 * string `"-5"` is guarded like any other string. Arrays and objects are
 * written as their JSON (then guarded like a string), null/undefined as an
 * empty cell, a Date as its ISO time.
 *
 * `lib/ingest/collegePhotos.ts` keeps its own narrower `csvCell` for the
 * photo dry-run file; this is the one for anything a user exports.
 */

/** A string a spreadsheet would read as a formula. */
const FORMULA_START = /^(?:[\t\r]|[\s ﻿　]*[=+\-@＝＋－＠])/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  let s: string;
  if (typeof v === "string") s = v;
  else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? "" : v.toISOString();
  else s = JSON.stringify(v) ?? "";
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows to CSV text. The header is `columns` when given, else every key of
 * every row in first-seen order (rows of one table can differ, e.g. a column a
 * later migration added). No rows and no columns is an empty string.
 */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns?: readonly string[]): string {
  let cols = columns ? [...columns] : [];
  if (!columns) {
    const seen = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) if (!seen.has(k)) seen.add(k);
    cols = [...seen];
  }
  if (cols.length === 0) return "";
  const lines = [cols.map(csvCell).join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
