/**
 * IPEDS Institutional Characteristics -> college_accessibility.pct_registered_ds / pct_three_or_less (pure parts;
 * the script is scripts/ingest/ipeds-accessibility.ts).
 *
 * WHAT IS KNOWN: the IC survey asks, in Section 2 Part B (Question 9 in the 2023-24 package), for the percentage of
 * all undergraduates who were formally registered as students with disabilities with the institution's office of
 * disability services (or the equivalent office). Source: NCES IC survey form,
 * https://nces.ed.gov/Ipeds/use-the-data/download-survey-material/2023/institutional%20characteristics/package_11_2.pdf
 *
 * WHAT IS NOT CONFIRMED: the variable's name in the public data files (believed to be DISABPCT), the code that means
 * "3 percent or less" (the form reports that as a bucket, not a number), and whether every year's public file carries
 * the variable at all. So nothing here guesses: the script takes the column names as arguments, and when a named
 * column is not in the file it prints every column whose name contains "DISAB" and stops. Read the data dictionary
 * that ships with the file you load (the .xlsx/.html dictionary next to ic<year>.zip on
 * https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx), write the real names and codes into the run command, and add
 * them to this header.
 *
 * How a row is read:
 *   - a bucket code (arguments `--bucket-var` and `--bucket-codes`): pct_three_or_less = true, pct_registered_ds = null;
 *   - a number 0-100 in the percent column: that figure, pct_three_or_less = false;
 *   - blank, or an IPEDS missing code (-1, -2, -3, -9): the college is left alone.
 */

export type IpedsRow = Record<string, string>;

/** A CSV with quoted fields, a BOM and CRLF, as IPEDS ships it. */
export function parseCsv(text: string): IpedsRow[] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  const [head, ...body] = rows;
  if (!head) return [];
  const names = head.map((h) => h.trim().toUpperCase());
  return body.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? "").trim()])));
}

/** Column names in the header that look like disability variables, for the "name not found" message. */
export function disabilityColumns(rows: IpedsRow[]): string[] {
  return Object.keys(rows[0] ?? {}).filter((n) => n.includes("DISAB"));
}

export type Reading = { unitid: number; pctRegisteredDs: number | null; pctThreeOrLess: boolean };

const MISSING = new Set(["-1", "-2", "-3", "-9", "."]);

export type ReadOptions = { pctVar: string; bucketVar?: string; bucketCodes?: string[] };

/** One file row, read; null when the college reported nothing usable. */
export function readRow(row: IpedsRow, o: ReadOptions): Reading | null {
  const unitid = Number.parseInt(row["UNITID"] ?? "", 10);
  if (!Number.isFinite(unitid)) return null;
  if (o.bucketVar) {
    const code = (row[o.bucketVar.toUpperCase()] ?? "").trim();
    if (code && (o.bucketCodes ?? []).includes(code)) return { unitid, pctRegisteredDs: null, pctThreeOrLess: true };
  }
  const raw = (row[o.pctVar.toUpperCase()] ?? "").trim();
  if (raw === "" || MISSING.has(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return { unitid, pctRegisteredDs: Math.round(n * 100) / 100, pctThreeOrLess: false };
}

export type ExistingRow = { college_id: string; data_source: string; pct_registered_ds: number | null; pct_three_or_less: boolean } | undefined;

export type Plan =
  | { kind: "insert"; row: Record<string, unknown> }
  | { kind: "update"; collegeId: string; fields: Record<string, unknown> }
  | { kind: "same" };

export const IPEDS_PAGE = "https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx";

/**
 * How one reading lands. A college with no row gets one (`data_source = 'ipeds'`, the page recorded as its source,
 * `last_verified_at = now`). A college with a row gets ONLY the two percent columns, never another field and never a
 * changed `data_source` or source list: an 'axis' row is richer, and its `last_verified_at` is about its own pages, so
 * the import leaves that alone too. Nothing to change is "same", so a re-run writes nothing.
 */
export function planRow(r: Reading, collegeId: string, existing: ExistingRow, now: Date): Plan {
  if (!existing) {
    return {
      kind: "insert",
      row: {
        college_id: collegeId,
        unitid: r.unitid,
        pct_registered_ds: r.pctRegisteredDs,
        pct_three_or_less: r.pctThreeOrLess,
        data_source: "ipeds",
        source_urls: [IPEDS_PAGE],
        last_verified_at: now.toISOString(),
      },
    };
  }
  if (existing.pct_registered_ds === r.pctRegisteredDs && existing.pct_three_or_less === r.pctThreeOrLess) return { kind: "same" };
  return { kind: "update", collegeId, fields: { pct_registered_ds: r.pctRegisteredDs, pct_three_or_less: r.pctThreeOrLess } };
}
