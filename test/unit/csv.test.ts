// lib/csv.ts: the CSV every export writes (the batched student export and the
// Google Sheets roster summary). RFC 4180 quoting, and a cell a spreadsheet
// would read as a formula is neutralised (OWASP "CSV injection").
import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, toCsv } from "../../src/lib/csv.js";

test("plain text is left alone", () => {
  assert.equal(csvCell("Ana Lopez"), "Ana Lopez");
  assert.equal(csvCell(""), "");
});

test("null and undefined are empty cells", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("commas, quotes and line breaks are quoted, quotes doubled", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line 1\nline 2"), '"line 1\nline 2"');
  assert.equal(csvCell("cr\r\nlf"), '"cr\r\nlf"');
});

test("a string a spreadsheet would read as a formula gets a leading apostrophe", () => {
  for (const s of ["=SUM(A1:A2)", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd", "=HYPERLINK(\"http://x\")"]) {
    const out = csvCell(s);
    const inner = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    assert.equal(inner, `'${s}`, `for ${JSON.stringify(s)}`);
  }
});

test("leading white space doesn't hide a formula", () => {
  assert.equal(csvCell("  =1+1"), "'  =1+1");
  assert.equal(csvCell(" =1+1"), "' =1+1");
  assert.equal(csvCell("\n=1+1"), `"'\n=1+1"`);
  // Full-width signs some spreadsheets normalise to ASCII.
  assert.equal(csvCell("＝cmd"), "'＝cmd");
  assert.equal(csvCell("﻿=cmd"), "'﻿=cmd");
});

test("a sign in the middle is not a formula", () => {
  assert.equal(csvCell("a=b"), "a=b");
  assert.equal(csvCell("e-mail"), "e-mail");
});

test("numbers, booleans and bigints are written as they are, negatives included", () => {
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell(3.75), "3.75");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell(10n), "10");
  // ...but a string that looks negative is still guarded: only typed numbers are trusted.
  assert.equal(csvCell("-5"), "'-5");
});

test("arrays and objects are written as JSON, and guarded like any string", () => {
  assert.equal(csvCell(["a", "b"]), '"[""a"",""b""]"');
  assert.equal(csvCell({ k: 1 }), '"{""k"":1}"');
  assert.equal(csvCell([]), "[]");
});

test("dates are ISO strings", () => {
  assert.equal(csvCell(new Date("2026-11-07T12:00:00Z")), "2026-11-07T12:00:00.000Z");
});

test("unicode passes through untouched", () => {
  assert.equal(csvCell("José Núñez 李雷 🎓"), "José Núñez 李雷 🎓");
  assert.equal(csvCell("مرحبا"), "مرحبا");
});

test("toCsv: header from every row's keys in first-seen order, CRLF rows", () => {
  const csv = toCsv([
    { id: 1, name: "Ana" },
    { id: 2, note: "=cmd", name: null },
  ]);
  assert.equal(csv, "id,name,note\r\n1,Ana,\r\n2,,'=cmd\r\n");
});

test("toCsv: given columns are used as the header, in that order", () => {
  assert.equal(toCsv([{ a: 1, b: 2 }], ["b", "a"]), "b,a\r\n2,1\r\n");
});

test("toCsv: a header cell is guarded too", () => {
  assert.equal(toCsv([{ "=x": 1 }]), "'=x\r\n1\r\n");
});

test("toCsv: no rows and no columns is an empty string", () => {
  assert.equal(toCsv([]), "");
  assert.equal(toCsv([], ["a", "b"]), "a,b\r\n");
});
