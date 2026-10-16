// Spreadsheet fixtures for the import tests, built in memory with fflate so
// no binary files are checked in. Cells: string (inline), number, boolean,
// { date: serial } (date-formatted), { formula, cached? }.
import { strToU8, unzipSync, zipSync } from "fflate";

export type Cell = string | number | boolean | null | { date: number } | { formula: string; cached?: number | string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function col(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(c: Cell, ref: string): string {
  if (c === null) return "";
  if (typeof c === "string") return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
  if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
  if (typeof c === "boolean") return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
  if ("date" in c) return `<c r="${ref}" s="1"><v>${c.date}</v></c>`;
  const cached = c.cached === undefined ? "" : typeof c.cached === "string" ? `<v>${esc(c.cached)}</v>` : `<v>${c.cached}</v>`;
  return `<c r="${ref}"${typeof c.cached === "string" ? ' t="str"' : ""}><f>${esc(c.formula)}</f>${cached}</c>`;
}

export function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((c, j) => cellXml(c, `${col(j)}${i + 1}`)).join("")}</row>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export type XlsxOptions = {
  sheets: Array<{ name: string; rows: Cell[][] }>;
  date1904?: boolean;
  macro?: boolean;
  extraEntries?: Record<string, string | Uint8Array>;
  /** Replace a sheet's XML outright (malicious fixtures). */
  rawSheetXml?: string;
};

export function xlsx(o: XlsxOptions): Uint8Array {
  const main = o.macro
    ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const overrides = o.sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${main}"/>${overrides}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${o.date1904 ? '<workbookPr date1904="1"/>' : "<workbookPr/>"}<sheets>${o.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${o.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`),
  };
  o.sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(i === 0 && o.rawSheetXml ? o.rawSheetXml : sheetXml(s.rows));
  });
  for (const [k, v] of Object.entries(o.extraEntries ?? {})) files[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(files);
}

export const csv = (text: string) => new TextEncoder().encode(text);

/**
 * A workbook whose every data cell points at one shared string (t="s", index
 * 0): small on disk and inside every zip-guard cap, but a parser hands back
 * the same string object for each cell, so a naive answer carries a copy per
 * cell. Built in memory; the sheet XML stays under the 50 MiB entry cap.
 */
export function sharedStringBomb(rows: number, cols: number, text: string): Uint8Array {
  const base = xlsx({ sheets: [{ name: "Roster", rows: [] }] });
  const files = unzipSync(base);
  const header = `<row r="1">${Array.from({ length: cols }, (_, j) => `<c r="${col(j)}1" t="inlineStr"><is><t>H${j}</t></is></c>`).join("")}</row>`;
  const body: string[] = [header];
  for (let i = 2; i <= rows + 1; i++) {
    let r = `<row r="${i}">`;
    for (let j = 0; j < cols; j++) r += `<c r="${col(j)}${i}" t="s"><v>0</v></c>`;
    body.push(r + "</row>");
  }
  files["xl/worksheets/sheet1.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`
  );
  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${esc(text)}</t></si></sst>`
  );
  const ct = new TextDecoder().decode(files["[Content_Types].xml"]);
  files["[Content_Types].xml"] = strToU8(ct.replace("</Types>", `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`));
  const rels = new TextDecoder().decode(files["xl/_rels/workbook.xml.rels"]);
  files["xl/_rels/workbook.xml.rels"] = strToU8(rels.replace("</Relationships>", `<Relationship Id="rIdSS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`));
  return zipSync(files);
}

/** import_fields as 20261014000001 seeds it, plus the questionnaire's rows (20261023010001). */
export const FIELDS = [
  ["student_academics", "gpa_unweighted", "gpa", 3], ["student_academics", "gpa_weighted", "gpa", 3],
  ["student_academics", "gpa_scale", "text:20", 3], ["student_academics", "class_rank", "text:40", 3],
  ["student_academics", "class_rank_value", "text:40", 3], ["student_academics", "test_status", "enum:test_status", 3],
  ["student_academics", "sat_ebrw", "sat_section", 3], ["student_academics", "sat_math", "sat_section", 3],
  ["student_academics", "sat_superscore", "sat_total", 3], ["student_academics", "act_composite", "act_composite", 3],
  ["student_personal_details", "contact_email", "email", 1], ["student_personal_details", "address", "text:400", 2],
  ["student_personal_details", "gender", "enum:gender", 2], ["student_personal_details", "birthday", "date", 2],
  ["student_personal_details", "citizenship", "enum:citizenship", 2], ["student_personal_details", "first_gen", "bool", 2],
  ["student_personal_details", "intended_majors", "text[]", 1],
  ["test_scores", "*", "row:test_score", 3], ["courses", "*", "row:course", 1], ["activities", "*", "row:activity", 1],
  ["student_academics", "gpa_band", "text:40", 3], ["profiles", "high_school", "text:200", 1],
  ["profiles", "hometown", "text:200", 1], ["profiles", "grad_year", "grad_year", 1], ["awards", "*", "row:award", 1],
].map(([table, field, valueType, sensitivity]) => ({ table: String(table), field: String(field), valueType: String(valueType), sensitivity: Number(sensitivity) }));
