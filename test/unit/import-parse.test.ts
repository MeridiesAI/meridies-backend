import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { detectType } from "../../src/lib/imports/magic.js";
import { MAX_CELL_CHARS, MAX_PARSE_OUTPUT_BYTES } from "../../src/lib/imports/caps.js";
import { checkOutcome, MAX_CONCURRENT_PARSES, parseFailureMessage, parseInWorker, parsesRunning } from "../../src/lib/imports/parse.js";
import { answerJson, findHeaderRow, parseSpreadsheet, sniffDelimiter, type ParseOutcome } from "../../src/lib/imports/sheet.js";
import { containsMarker, inspectXlsx } from "../../src/lib/imports/zipGuard.js";
import { csv, sharedStringBomb, xlsx } from "./import-fixtures.js";

// --- magic bytes -----------------------------------------------------------

test("CSV in UTF-8 (with or without a BOM) and windows-1252 is text", () => {
  assert.deepEqual(detectType(csv("Name,Email\nJane,j@x.org\n")), { type: "csv", encoding: "utf-8" });
  assert.deepEqual(detectType(new Uint8Array([0xef, 0xbb, 0xbf, ...csv("a,b\n1,2\n")])), { type: "csv", encoding: "utf-8" });
  // "José" in windows-1252: 0xE9 is not valid UTF-8 on its own.
  assert.deepEqual(detectType(new Uint8Array([...csv("Name,City\nJos"), 0xe9, ...csv(",Lima\n")])), { type: "csv", encoding: "windows-1252" });
});

test("an XLSX is a zip whose content types name a workbook", () => {
  assert.deepEqual(detectType(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }] })), { type: "xlsx" });
});

test("xlsm, legacy xls, PDF, PNG, plain zip and empty files are refused", () => {
  assert.equal(detectType(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }], macro: true })).type, "refused");
  assert.deepEqual(detectType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), { type: "refused", reason: "legacy-xls" });
  assert.deepEqual(detectType(csv("%PDF-1.7\n...")), { type: "refused", reason: "not-spreadsheet" });
  assert.deepEqual(detectType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), { type: "refused", reason: "not-spreadsheet" });
  assert.deepEqual(detectType(zipSync({ "a.txt": strToU8("hello") })), { type: "refused", reason: "not-spreadsheet" });
  assert.deepEqual(detectType(new Uint8Array()), { type: "refused", reason: "not-spreadsheet" });
});

// --- the zip guard -------------------------------------------------------------

test("a zip bomb is refused by its declared size before anything is inflated", () => {
  const bomb = xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }], extraEntries: { "xl/media/zeros.xml": new Uint8Array(60 * 1024 * 1024) } });
  assert.ok(bomb.length < 2 * 1024 * 1024, "the bomb itself is small");
  assert.deepEqual(inspectXlsx(bomb), { ok: false, reason: "too-large-unpacked" });
  // The total cap, with small entries.
  const total = inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }] }), { total: 100, entry: 1000, entries: 100 });
  assert.deepEqual(total, { ok: false, reason: "too-large-unpacked" });
});

test("too many entries is refused", () => {
  const extra: Record<string, string> = {};
  for (let i = 0; i < 30; i++) extra[`xl/x${i}.bin`] = "x";
  assert.deepEqual(inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }], extraEntries: extra }), { total: 1e9, entry: 1e9, entries: 20 }), { ok: false, reason: "too-large-unpacked" });
});

test("a DOCTYPE or ENTITY in any XML part is refused, in any case, and UTF-16 XML too", () => {
  const entity = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
  assert.deepEqual(inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [] }], rawSheetXml: entity })), { ok: false, reason: "unsafe-xml" });
  const lower = `<?xml version="1.0"?><!doctype x><worksheet/>`;
  assert.deepEqual(inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [] }], rawSheetXml: lower })), { ok: false, reason: "unsafe-xml" });
  const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00]);
  assert.deepEqual(inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }], extraEntries: { "xl/odd.xml": utf16 } })), { ok: false, reason: "unsafe-xml" });
  assert.equal(containsMarker(strToU8("ab<!EnTiTy"), strToU8("<!entity")), true);
  assert.equal(containsMarker(strToU8("<!-- entity -->"), strToU8("<!entity")), false);
});

test("a workbook with external links is refused", () => {
  const linked = xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }], extraEntries: { "xl/externalLinks/externalLink1.xml": "<externalLink/>" } });
  assert.deepEqual(inspectXlsx(linked), { ok: false, reason: "external-links" });
});

test("the 1904 date system is read from the workbook", () => {
  const v = inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }], date1904: true }));
  assert.ok(v.ok && v.date1904);
  const w = inspectXlsx(xlsx({ sheets: [{ name: "S", rows: [["a", "b"]] }] }));
  assert.ok(w.ok && !w.date1904);
});

// --- parsing -------------------------------------------------------------------

test("the header row is the first with two or more cells, within 20 rows", () => {
  assert.equal(findHeaderRow([["Roster export"], [""], ["Name", "Email"], ["Jane", "j@x.org"]]), 2);
  assert.equal(findHeaderRow([["only one"]]), -1);
  assert.equal(findHeaderRow(Array.from({ length: 25 }, (_, i) => (i === 22 ? ["a", "b"] : ["x"]))), -1);
});

test("the delimiter is sniffed: comma, semicolon, tab", () => {
  assert.equal(sniffDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(sniffDelimiter("a;b;c\n1;2,5;3"), ";");
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
});

test("a CSV parses to text cells, with a title row skipped and empty rows dropped", async () => {
  const out = await parseSpreadsheet(csv("Fall roster\nName,Email,GPA\nJane Doe,jane@x.org,3.8\n\nJohn Roe,john@x.org,=1+1\n"), "fall roster.csv", 5000);
  assert.ok(out.ok);
  const s = out.sheets[0];
  assert.equal(s.name, "fall roster");
  assert.deepEqual(s.headers, ["Name", "Email", "GPA"]);
  assert.equal(s.headerRow, 2);
  assert.deepEqual(s.rows, [["Jane Doe", "jane@x.org", "3.8"], ["John Roe", "john@x.org", "=1+1"]]);
  assert.deepEqual(s.rowNumbers, [3, 5]);
});

test("more than the row limit is refused", async () => {
  const lines = ["Name,Email", ...Array.from({ length: 12 }, (_, i) => `S ${i},s${i}@x.org`)];
  const out = await parseSpreadsheet(csv(lines.join("\n")), "big.csv", 10);
  assert.deepEqual(out, { ok: false, detectedType: "csv", reason: "too-many-rows" });
});

test("XLSX: formulas give cached values only, formula-looking text stays text, dates come back ISO", async () => {
  const bytes = xlsx({
    sheets: [{
      name: "Roster",
      rows: [
        ["Name", "GPA", "DOB", "Calc", "Note"],
        ["Jane Doe", 3.85, { date: 39448 }, { formula: "B2*2", cached: 7.7 }, "=cmd|' /C calc'!A0"],
        ["John Roe", 4, 39448, { formula: "HYPERLINK(\"http://x\")" }, true],
      ],
    }],
  });
  const out = await parseSpreadsheet(bytes, "r.xlsx", 5000);
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.sheets[0].rows, [
    ["Jane Doe", "3.85", "2008-01-01", "7.7", "=cmd|' /C calc'!A0"],
    ["John Roe", "4", "39448", "", "TRUE"],
  ]);
  assert.equal(out.sheets[0].date1904, false);
});

test("XLSX in the 1904 date system reads date cells in that system", async () => {
  const out = await parseSpreadsheet(xlsx({ sheets: [{ name: "S", rows: [["Name", "DOB"], ["Jane", { date: 37986 }]] }], date1904: true }), "r.xlsx", 5000);
  assert.ok(out.ok);
  assert.equal(out.sheets[0].rows[0][1], "2008-01-01");
  assert.equal(out.sheets[0].date1904, true);
});

test("XLSX: empty sheets are skipped; a workbook with none is empty", async () => {
  const out = await parseSpreadsheet(xlsx({ sheets: [{ name: "Notes", rows: [["just a title"]] }, { name: "Data", rows: [["Name", "Email"], ["A B", "a@b.co"]] }] }), "r.xlsx", 5000);
  assert.ok(out.ok);
  assert.deepEqual(out.sheets.map((s) => s.name), ["Data"]);
  const none = await parseSpreadsheet(xlsx({ sheets: [{ name: "Notes", rows: [["title"]] }] }), "r.xlsx", 5000);
  assert.deepEqual(none, { ok: false, detectedType: "xlsx", reason: "empty" });
});

// --- the parse process --------------------------------------------------------------------

test("the parse process reads a file and returns the same answer", async () => {
  const out = await parseInWorker(csv("Name,Email\nJane Doe,jane@x.org\n"), "a.csv", { maxRows: 5000 });
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.sheets[0].rows, [["Jane Doe", "jane@x.org"]]);
});

test("the parse process is killed at its timeout", async () => {
  const out = await parseInWorker(csv("Name,Email\nJane Doe,jane@x.org\n"), "a.csv", { maxRows: 5000, timeoutMs: 1 });
  assert.deepEqual(out, { ok: false, detectedType: "unknown", reason: "timeout" });
});

test("the parse process is killed at its heap cap, whatever NODE_OPTIONS says", async () => {
  // Several million short cells in a tiny heap.
  const big = "a,b\n" + "x,y\n".repeat(2_000_000);
  const out = await parseInWorker(csv(big), "big.csv", { maxRows: 5_000_000, heapMb: 64, timeoutMs: 60_000 });
  assert.deepEqual(out, { ok: false, detectedType: "unknown", reason: "memory" });
});

test("no more than a few parse processes run at once; the rest wait", async () => {
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, parsesRunning())), 5);
  const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => parseInWorker(csv(`Name,Email\nA ${i},a${i}@x.org\n`), `f${i}.csv`, { maxRows: 10 })));
  clearInterval(timer);
  assert.ok(outs.every((o) => o.ok));
  assert.ok(peak <= MAX_CONCURRENT_PARSES && peak > 0, `peak ${peak}`);
  assert.equal(parsesRunning(), 0);
});

// --- what a parse may hand back (the shared-string fan-out) ------------------------

test("a workbook whose cells all share one string is refused in the child; this process stays small", async () => {
  // 3.8 MB on disk, inside every zip-guard cap: 5,000 rows x 300 columns,
  // every cell the same 1,000-character shared string. Over advanced IPC the
  // answer was 1.5 billion characters, one copy per cell, and it took the
  // API process down (heap OOM inside the deserializer).
  const bomb = sharedStringBomb(5000, 300, "A".repeat(1000));
  assert.ok(bomb.length < 5 * 1024 * 1024, `the file is small (${bomb.length} bytes)`);
  assert.equal(inspectXlsx(bomb).ok, true, "the zip guard lets it through");
  global.gc?.();
  const before = process.memoryUsage();
  const out = await parseInWorker(bomb, "roster.xlsx", { maxRows: 5000, timeoutMs: 60_000 });
  const after = process.memoryUsage();
  assert.deepEqual(out, { ok: false, detectedType: "xlsx", reason: "too-large-unpacked" });
  assert.equal(parseFailureMessage(out.ok ? "" : out.reason, "roster.xlsx"), "roster.xlsx couldn't be read (too large when unpacked)");
  assert.ok(after.rss - before.rss < 200 * 1024 * 1024, `rss grew ${Math.round((after.rss - before.rss) / 1e6)} MB`);
  assert.ok(after.heapUsed - before.heapUsed < 100 * 1024 * 1024, `heap grew ${Math.round((after.heapUsed - before.heapUsed) / 1e6)} MB`);
  // Healthy afterwards: the next file parses as usual.
  const next = await parseInWorker(csv("Name,Email\nJane Doe,jane@x.org\n"), "a.csv", { maxRows: 5000 });
  assert.ok(next.ok);
  // The same shape with a short string is an ordinary file.
  const fine = await parseInWorker(sharedStringBomb(3, 3, "hello"), "fine.xlsx", { maxRows: 5000 });
  assert.ok(fine.ok && fine.sheets[0].rows[0][0] === "hello" && fine.chars === 3 * 2 + 9 * 5);
});

test("a cell longer than Excel's own limit, or a file over the character budget, is refused by name", async () => {
  const long = await parseSpreadsheet(csv(`Name,Notes\nJane,${"x".repeat(MAX_CELL_CHARS + 1)}\n`), "n.csv", 5000);
  assert.deepEqual(long, { ok: false, detectedType: "csv", reason: "cell-too-long" });
  assert.equal(parseFailureMessage("cell-too-long", "n.csv"), "n.csv has a cell longer than 32,767 characters");
  const fits = await parseSpreadsheet(csv("Name,Email\nJane Doe,jane@x.org\n"), "a.csv", 5000);
  assert.ok(fits.ok && fits.chars === "Name".length + "Email".length + "Jane Doe".length + "jane@x.org".length);
  const over = await parseSpreadsheet(csv("Name,Email\nJane Doe,jane@x.org\n"), "a.csv", 5000, 20);
  assert.deepEqual(over, { ok: false, detectedType: "csv", reason: "too-large-unpacked" });
  const xOver = await parseSpreadsheet(xlsx({ sheets: [{ name: "S", rows: [["Name", "Email"], ["Jane Doe", "jane@x.org"]] }] }), "a.xlsx", 5000, 20);
  assert.deepEqual(xOver, { ok: false, detectedType: "xlsx", reason: "too-large-unpacked" });
});

test("the parent stops reading and kills the child once the answer passes its byte budget", async () => {
  const out = await parseInWorker(csv("Name,Email\nJane Doe,jane@x.org\n"), "a.csv", { maxRows: 5000, maxOutputBytes: 40 });
  assert.deepEqual(out, { ok: false, detectedType: "unknown", reason: "too-large-unpacked" });
  assert.equal(parsesRunning(), 0);
});

test("the child's answer is used only with the outcome's shape, inside its limits", () => {
  const sheet = { name: "S", headerRow: 1, headers: ["Name", "Email"], rows: [["Jane", "j@x.org"]], rowNumbers: [2], date1904: false };
  const good = { ok: true, detectedType: "csv", sheets: [sheet], chars: 4 + 5 + 4 + 7 };
  assert.deepEqual(checkOutcome(good, 5000, 1000), good);
  assert.equal(checkOutcome({ ...good, extra: 1 }, 5000, 1000), null);
  assert.equal(checkOutcome({ ...good, chars: 1 }, 5000, 1000), null, "the claimed count must be the real one");
  assert.equal(checkOutcome({ ...good, sheets: [{ ...sheet, rows: [["Jane", "j@x.org", "extra"]] }] }, 5000, 1000), null);
  assert.equal(checkOutcome({ ...good, sheets: [{ ...sheet, rowNumbers: [] }] }, 5000, 1000), null);
  assert.equal(checkOutcome({ ...good, sheets: [{ ...sheet, rows: [["Jane", 7]] }] }, 5000, 1000), null);
  assert.equal(checkOutcome(good, 0, 1000), null, "more rows than asked for");
  assert.equal(checkOutcome({ ...good, sheets: [{ ...sheet, headers: ["Name", "x".repeat(MAX_CELL_CHARS + 1)] }] }, 5000, 1e9), null);
  assert.deepEqual(checkOutcome(good, 5000, 10), { ok: false, detectedType: "csv", reason: "too-large-unpacked" });
  assert.deepEqual(checkOutcome({ ok: false, detectedType: "xlsx", reason: "macro" }, 5000, 10), { ok: false, detectedType: "xlsx", reason: "macro" });
  assert.equal(checkOutcome({ ok: false, detectedType: "xlsx", reason: "anything" }, 5000, 10), null);
  assert.equal(checkOutcome("not an object", 5000, 10), null);
});

test("an answer that would pass the byte budget as JSON is replaced by a refusal", () => {
  // Control characters escape to six bytes each, so characters alone don't bound the bytes.
  const cells = "\u0001".repeat(Math.ceil(MAX_PARSE_OUTPUT_BYTES / 6) + 10);
  const out: ParseOutcome = { ok: true, detectedType: "csv", sheets: [{ name: "S", headerRow: 1, headers: ["a", "b"], rows: [[cells, ""]], rowNumbers: [2], date1904: false }], chars: cells.length + 2 };
  assert.deepEqual(JSON.parse(answerJson(out)), { ok: false, detectedType: "csv", reason: "too-large-unpacked" });
  const small: ParseOutcome = { ok: false, detectedType: "csv", reason: "empty" };
  assert.equal(answerJson(small), JSON.stringify(small));
});

test("failure messages name the file and never echo anything else", () => {
  assert.equal(parseFailureMessage("not-spreadsheet", "grades.xlsx"), "grades.xlsx isn't a spreadsheet");
  assert.equal(parseFailureMessage("too-large-unpacked", "grades.xlsx"), "grades.xlsx couldn't be read (too large when unpacked)");
  assert.equal(parseFailureMessage("wide", "x.csv"), "This sheet has one column per student; export it with one row per student");
});
