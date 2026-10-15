// Import pipeline step 2: hostile files through the real upload path (spec §9
// "Malicious files"): a zip bomb, XML entity expansion, a type that lies,
// macros, external links, a sheet with students as columns, an SSN in free
// text, and formula cells. Each fails by name or is neutralised; nothing
// reaches the database or a model.
import { strToU8, zipSync } from "fflate";
import { call, check, sql, user } from "./harness.mjs";
import { addImportFile, enc, stagedImport, studentOf } from "./imports-helpers.mjs";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function xlsx(sheetXml, { macro = false, extra = {} } = {}) {
  const main = macro ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${main}"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    ...extra,
  });
}
const cell = (r, c, v) => (typeof v === "number" ? `<c r="${c}${r}"><v>${v}</v></c>` : `<c r="${c}${r}" t="inlineStr"><is><t>${v}</t></is></c>`);
const sheet = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v === null ? "" : cell(i + 1, "ABCDEFGHIJ"[j], v))).join("")}</row>`).join("")}</sheetData></worksheet>`;

const c = await user("imp2-mal");
const imp = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const fails = async (label, name, bytes, mime, pattern) => {
  const r = await addImportFile(c, imp, name, bytes, mime);
  check(label, r.status === 200 && r.body.status === "failed" && pattern.test(r.body.error ?? ""), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
};

await fails("a zip bomb is refused as too large when unpacked", "bomb.xlsx",
  xlsx(sheet([["Email", "Name"]]), { extra: { "xl/media/zeros.xml": new Uint8Array(60 * 1024 * 1024) } }), XLSX, /too large when unpacked/);
await fails("XML entity expansion is refused", "billion.xlsx",
  xlsx(`<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`), XLSX, /settings we don't accept/);
await fails("a PDF named .csv is refused by its bytes", "grades.csv", enc("%PDF-1.7\n1 0 obj\n\u0000"), "text/csv", /isn't a spreadsheet/);
await fails("a CSV dressed as an xlsx is not trusted for its name", "grades.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), XLSX, /isn't a spreadsheet/);
await fails("a macro workbook is refused", "macros.xlsx", xlsx(sheet([["Email", "Name"]]), { macro: true }), XLSX, /macros/);
await fails("a workbook that links to other files is refused", "links.xlsx",
  xlsx(sheet([["Email", "Name"]]), { extra: { "xl/externalLinks/externalLink1.xml": strToU8("<externalLink/>") } }), XLSX, /links to other files/);
await fails("an old .xls is refused with what to do", "old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]), "application/vnd.ms-excel", /Save it as \.xlsx or CSV/);
await fails("a sheet with one column per student is refused", "wide.csv",
  enc("Subject,Jane Doe,John Roe,Ann Lee,Mia Park\nGPA,3.9,3.1,3.5,3.7\nSAT,1450,1200,1350,1500\n"), "text/csv", /one column per student/);
check("none of them was stored as a usable file", (await sql(`select count(*) from public.import_files where import_id = '${imp}' and status <> 'failed'`)) === "0");

// An SSN in free text is never staged; formula-looking text is kept as text and never evaluated.
const s = await studentOf(c, "imp2-mal-student");
const tag = Date.now();
await sql(`update public.profiles set full_name = 'Rae Kim', email = 'rae-${tag}@test.local' where id = '${s.id}'`);
const csv = [
  "Email,Name,Activity,Activity Description,Address,SSN",
  `rae-${tag}@test.local,Rae Kim,Robotics,"Captain; my SSN is 123-45-6789",=HYPERLINK("http://evil.example"),987-65-4321`,
].join("\n");
const { id: imp2, stage } = await stagedImport(c, csv, {
  edit: (plan) => {
    plan.sheets[0].columns.push({ index: 4, target: { kind: "field", table: "student_personal_details", field: "address" }, source: "counselor" });
    plan.sheets[0].columns.push({ index: 5, target: { kind: "field", table: "student_academics", field: "class_rank" }, source: "counselor" });
  },
});
check("the file stages", stage.status === 200, JSON.stringify(stage.body));
check("the SSN column was forced to ignore", (await sql(`select count(*) from public.import_changes where import_id = '${imp2}' and field = 'class_rank'`)) === "0");
check("an SSN in an activity description never reaches the database, and is counted", stage.body.stats?.blocked === 1 && (await sql(`select count(*) from public.import_changes where import_id = '${imp2}' and new_value::text like '%123-45%'`)) === "0", JSON.stringify(stage.body.stats));
const addr = await sql(`select new_value #>> '{}' from public.import_changes where import_id = '${imp2}' and field = 'address'`);
check("a formula is kept as text, never evaluated", addr === '=HYPERLINK("http://evil.example")', addr);
const plan2 = (await call(c.token, "GET", `/imports/${imp2}`)).body.plan;
check("the stored plan never maps the SSN column", !JSON.stringify(plan2.sheets[0].columns.find((x) => x.index === 5)?.target ?? {}).includes("class_rank"));
