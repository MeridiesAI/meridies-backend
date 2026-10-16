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
import { MAX_HEADER_CHARS } from "../../src/lib/imports/caps.js";
import { maskHeader, maskValue } from "../../src/lib/imports/mask.js";
import { presetTarget } from "../../src/lib/imports/presets.js";
import { profileFile } from "../../src/lib/imports/profile.js";
import { HEADER_RULES, sensitiveHeader } from "../../src/lib/imports/sensitive.js";
import { toSheet } from "../../src/lib/imports/sheet.js";
import { containsEmailShape, isEmailShape, scoreColumnParts, scoreSuffixStart, splitListCell } from "../../src/lib/imports/textShapes.js";
import { cleanCell, parseNumber } from "../../src/lib/imports/values.js";
import { workbookUses1904 } from "../../src/lib/imports/zipGuard.js";
import { BUDGET_MS, CAP_BUDGET_MS, elapsed, randomText, seeded } from "./regex-dos-helpers.js";

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
/**
 * A large cell: XLSX's own limit is 32,767 characters; a CSV has none. The
 * budget test uses the review's 40,000 (the old expressions took 0.4 to 1.2 s
 * there); the cap test a 200,000-character cell, under the looser budget, so a
 * busy test runner can't turn it red.
 */
const CELL = 40_000;
const BIG_CELL = 200_000;

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

test("a 200,000-character crafted cell is masked, checked and cleaned in under a second", () => {
  for (const unit of ["a.", ".", "1.", "1", ",", "1,", " "]) {
    const cell = `a@${fill(unit, BIG_CELL)} x`;
    for (const fn of [() => maskValue(cell), () => cleanCell("text[]", cell), () => cleanCell("sat_total", cell), () => isEmailShape(cell)]) {
      const ms = elapsed(fn);
      assert.ok(ms < CAP_BUDGET_MS, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
    }
  }
});

// ---- Sensitive-category headers (the follow-up review) ---------------------------

const OLD_ECONOMIC = /\b(free\s*(and|&|\/)?\s*reduced|reduced\s*lunch|lunch\s*status|frl|frpl|fee\s*waiver|low[\s-]*income|pell|title\s*i)\b/i;

test("the economic-status rule names exactly the headers it named", () => {
  const economic = HEADER_RULES.find(([c]) => c === "economic-status")![1];
  const rand = seeded(26);
  const pieces = ["free", "Free", " ", "  ", "\t", "and", "&", "/", "reduced", "lunch", "x", "-", "low", "income", "frl", "title", "i"];
  for (let i = 0; i < 30000; i++) {
    const s = randomText(rand, pieces, 1 + Math.floor(rand() * 8));
    assert.equal(economic.test(s), OLD_ECONOMIC.test(s), JSON.stringify(s));
  }
  for (const h of ["Free and Reduced", "free & reduced lunch", "free/reduced", "free   reduced", "FreeReduced", "free_and_reduced"]) {
    assert.equal(sensitiveHeader(h), "economic-status", h);
  }
});

test("every sensitive-header rule reads a 40,000-character run in well under 100 ms", () => {
  // "free" + 40,000 spaces took 1.6 s with `free\s*(and|&|\/)?\s*reduced`, and
  // a 160 KB header 43 s; the rules are timed here without the header cap.
  const prefixes = [
    "free", "free and", "social", "soc.", "driver's", "licence", "a", "tax", "state", "national", "account", "credit",
    "card", "net", "counselling", "reduced", "lunch", "fee", "low", "title", "sexual", "gender", "immigration", "pin",
    "security", "",
  ];
  for (const run of [" ", "\t", "-", " -", "and "]) {
    for (const prefix of prefixes) {
      const header = `${prefix}${fill(run, 40_000)}x`;
      for (const [category, re] of HEADER_RULES) {
        const ms = elapsed(() => re.test(header));
        assert.ok(ms < BUDGET_MS, `${category} on ${JSON.stringify(prefix)} + ${JSON.stringify(run)}* took ${ms.toFixed(1)} ms`);
      }
    }
  }
  const header = `free${" ".repeat(40_000)}x`;
  const ms = elapsed(() => sensitiveHeader(header));
  assert.ok(ms < BUDGET_MS, `sensitiveHeader took ${ms.toFixed(1)} ms`);
});

test("a header is cut to MAX_HEADER_CHARS when the sheet is read, and profiled promptly", () => {
  const long = `free${" ".repeat(160_000)}lunch`;
  const sheet = toSheet("Sheet1", [["email", long, `  Grad ${"y".repeat(MAX_HEADER_CHARS)}  `], ["a@b.co", "yes", "2027"]], false, 10);
  assert.ok(typeof sheet === "object");
  assert.equal(sheet.headers[0], "email");
  assert.equal(sheet.headers[1], "free", "the cut header's trailing spaces are trimmed");
  assert.equal(sheet.headers[2]!.length, MAX_HEADER_CHARS);
  const ms = elapsed(() => profileFile([sheet]));
  assert.ok(ms < BUDGET_MS, `profileFile took ${ms.toFixed(1)} ms`);
});

test("a workbook.xml head of unclosed workbookPr tags is read in well under 100 ms", () => {
  for (const unit of ["<workbookPr ", "<x:workbookPr date1904 ", "<workbookPr date1904=\"1\"", "date1904=\"1\" "]) {
    const head = fill(unit, 65536);
    const ms = elapsed(() => workbookUses1904(head));
    assert.ok(ms < BUDGET_MS, `${JSON.stringify(unit)} took ${ms.toFixed(1)} ms`);
  }
});
