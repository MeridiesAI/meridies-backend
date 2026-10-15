import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { detectType } from "../../src/lib/imports/magic.js";
import { MAX_CONCURRENT_PARSES, parseFailureMessage, parseInWorker, parsesRunning } from "../../src/lib/imports/parse.js";
import { findHeaderRow, parseSpreadsheet, sniffDelimiter } from "../../src/lib/imports/sheet.js";
import { containsMarker, inspectXlsx } from "../../src/lib/imports/zipGuard.js";
import { csv, xlsx } from "./import-fixtures.js";

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

test("failure messages name the file and never echo anything else", () => {
  assert.equal(parseFailureMessage("not-spreadsheet", "grades.xlsx"), "grades.xlsx isn't a spreadsheet");
  assert.equal(parseFailureMessage("too-large-unpacked", "grades.xlsx"), "grades.xlsx couldn't be read (too large when unpacked)");
  assert.equal(parseFailureMessage("wide", "x.csv"), "This sheet has one column per student; export it with one row per student");
});
