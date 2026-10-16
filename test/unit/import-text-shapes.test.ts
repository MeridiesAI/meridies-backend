/**
 * Import cells and headers (lib/imports/textShapes.ts, values.ts, zipGuard.ts):
 * each linear check gives what the regular expression it replaced gave, on
 * random input, and a crafted cell, header or workbook.xml finishes in well
 * under 100 ms. The expressions took 1.2 s for one 40,000-character cell
 * shaped like "a@a.a.a.…", 0.9 s for a run of commas in a list cell, 0.4 s
 * for a header with a long run of spaces, and the whole cost repeats per cell
 * across 5,000 rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { maskHeader, maskValue } from "../../src/lib/imports/mask.js";
import { presetTarget } from "../../src/lib/imports/presets.js";
import { containsEmailShape, isEmailShape, scoreColumnParts, scoreSuffixStart, splitListCell } from "../../src/lib/imports/textShapes.js";
import { cleanCell, parseNumber } from "../../src/lib/imports/values.js";
import { workbookUses1904 } from "../../src/lib/imports/zipGuard.js";
import { BUDGET_MS, elapsed, randomText, seeded } from "./regex-dos-helpers.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCORE_COLUMN = /^(ap|ib)\s+(.+?)(\s+(score|exam score|result))?$/i;
const SCORE_SUFFIX = /\s+(score|exam score|result)$/i;
const LIST_SPLIT = /[;|\n]+|,(?![^(]*\))/;
const OLD_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;
const NEW_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;
const DATE1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/i;

test("isEmailShape matches /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/", () => {
  const rand = seeded(21);
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, ["a", "@", ".", " ", "\t", " ", "x.y", "-", "@."], 1 + Math.floor(rand() * 10));
    assert.equal(isEmailShape(s), EMAIL.test(s), JSON.stringify(s));
  }
});

test("containsEmailShape matches /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/", () => {
  const CONTAINS = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const rand = seeded(27);
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, ["a", "@", ".", " ", "\t", " ", "x.y", "-", "@.", "1"], 1 + Math.floor(rand() * 12));
    assert.equal(containsEmailShape(s), CONTAINS.test(s), JSON.stringify(s));
  }
  for (const s of ["a".repeat(40000), "a@" + "b".repeat(40000), "a@.".repeat(15000), "Cell " + "@a.".repeat(15000)]) {
    assert.ok(elapsed(() => containsEmailShape(s)) < BUDGET_MS, `${s.slice(0, 8)}… took too long`);
    assert.ok(elapsed(() => maskHeader(s)) < BUDGET_MS, `maskHeader ${s.slice(0, 8)}… took too long`);
  }
});

test("scoreSuffixStart finds where /\\s+(score|exam score|result)$/i starts", () => {
  const rand = seeded(22);
  const pieces = ["a", " ", "\t", "\n", "score", "Score", "exam", "exam score", "EXAM SCORE", "result", "x", " "];
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, pieces, 1 + Math.floor(rand() * 8));
    const m = SCORE_SUFFIX.exec(s);
    assert.equal(scoreSuffixStart(s), m ? m.index : -1, JSON.stringify(s));
    assert.equal(s.slice(0, scoreSuffixStart(s) === -1 ? s.length : scoreSuffixStart(s)), s.replace(SCORE_SUFFIX, ""));
  }
});

test("scoreColumnParts reads what /^(ap|ib)\\s+(.+?)(\\s+(score|exam score|result))?$/i read", () => {
  const rand = seeded(23);
  const pieces = ["ap", "AP", "ib", "Ib", " ", "  ", "\t", "\n", "\r", " ", "x", "Bio", "score", "exam score", "result", "Score", "y"];
  for (let i = 0; i < 30000; i++) {
    const s = randomText(rand, pieces, 1 + Math.floor(rand() * 8));
    const m = SCORE_COLUMN.exec(s);
    assert.deepEqual(scoreColumnParts(s), m ? [m[1], m[2]] : null, JSON.stringify(s));
  }
  assert.deepEqual(presetTarget("AP Calculus BC Score"), { kind: "score_column", exam: "AP Calculus BC", testKind: "ap" });
  assert.deepEqual(presetTarget("IB Math HL exam score"), { kind: "score_column", exam: "IB Math HL", testKind: "ib" });
});

test("splitListCell splits as /[;|\\n]+|,(?![^(]*\\))/ split", () => {
  const rand = seeded(24);
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, ["a", ",", ";", "|", "\n", "(", ")", " ", "b c"], Math.floor(rand() * 14));
    assert.deepEqual(splitListCell(s), s.split(LIST_SPLIT), JSON.stringify(s));
  }
  assert.deepEqual(cleanCell("text[]", "Spanish (AP, IB), French; Latin"), { ok: true, value: ["Spanish (AP, IB)", "French", "Latin"] });
});

test("parseNumber's pattern accepts exactly what it accepted", () => {
  const rand = seeded(25);
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, ["1", "2", ".", "-", "+", "a", ","], 1 + Math.floor(rand() * 8));
    assert.equal(NEW_NUMBER.test(s), OLD_NUMBER.test(s), JSON.stringify(s));
  }
  assert.equal(parseNumber("1,234.5"), 1234.5);
  assert.equal(parseNumber("92%"), 92);
  assert.equal(parseNumber("3,8", true), 3.8);
  assert.equal(parseNumber("4."), 4);
  assert.equal(parseNumber(".5"), 0.5);
});

test("workbookUses1904 reads date1904 as the regular expression read it", () => {
  const rand = seeded(26);
  const pieces = [
    "<workbookPr", "<x:workbookPr", "<WorkbookPr", "<workbookPrx", " ", ">", "<", "date1904=\"1\"", "date1904='true'",
    "date1904 = \"1\"", "xdate1904=\"1\"", "date1904=\"0\"", "a", "/>", "<x:", ":",
  ];
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, pieces, 1 + Math.floor(rand() * 10));
    assert.equal(workbookUses1904(s), DATE1904.test(s), JSON.stringify(s));
  }
  assert.equal(workbookUses1904('<workbook><workbookPr date1904="1" defaultThemeVersion="1"/></workbook>'), true);
  assert.equal(workbookUses1904("<workbook><workbookPr defaultThemeVersion=\"1\"/></workbook>"), false);
});

// ---- Worst cases ---------------------------------------------------------------

const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** A large cell: XLSX's own limit is 32,767 characters; a CSV has none. */
const CELL = 200_000;

test("masking, checking and cleaning a crafted cell finishes in well under 100 ms", () => {
  const cells = [
    `a@${fill("a.", CELL)} x`, `a@${fill(".", CELL)} x`, `a@${fill("1.", CELL)} x`, fill("1", CELL) + "!",
    fill(",", CELL) + "x", fill("1,", CELL) + "x", `ap x${fill(" ", CELL)}y`, `${fill(" ", CELL)}x`,
  ];
  for (const cell of cells) {
    const label = JSON.stringify(cell.slice(0, 8));
    for (const [name, fn] of [
      ["maskValue", () => maskValue(cell)],
      ["maskHeader", () => maskHeader(cell)],
      ["presetTarget", () => presetTarget(cell)],
      ["text[]", () => cleanCell("text[]", cell)],
      ["number", () => cleanCell("sat_total", cell)],
      ["gpa", () => cleanCell("gpa", cell)],
      ["email", () => isEmailShape(cell)],
      ["suffix", () => scoreSuffixStart(cell)],
    ] as const) {
      const ms = elapsed(fn);
      assert.ok(ms < BUDGET_MS, `${name} on ${label}… took ${ms.toFixed(1)} ms`);
    }
  }
});

test("a workbook.xml head of unclosed workbookPr tags is read in well under 100 ms", () => {
  for (const unit of ["<workbookPr ", "<x:workbookPr date1904 ", "<workbookPr date1904=\"1\"", "date1904=\"1\" "]) {
    const head = fill(unit, 65536);
    const ms = elapsed(() => workbookUses1904(head));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
  }
});
