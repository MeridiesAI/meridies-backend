/**
 * Mass invite's paste parser (lib/massInvite.ts): the linear rewrite gives
 * exactly what the regular expressions gave on random pastes, still reads the
 * shapes a counselor pastes, and the worst-case 20,000-character pastes from
 * the security review finish in well under 100 ms (the spelled-out fold took
 * 2.2 s on 20,000 "a", and the edge and "@" patterns over a second each).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldSpelledOut, isValidEmail, needsModel, preParse, repairAddress, type PreParse, type SortedAddress } from "../../src/lib/massInvite.js";
import { BUDGET_MS, elapsed, randomText, seeded } from "./regex-dos-helpers.js";

// ---- The parser as it stood before the fix ------------------------------------

const DOMAIN_FIXES: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com",
  "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com", gmailcom: "gmail.com",
  "hotmial.com": "hotmail.com", "hotmail.co": "hotmail.com", "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com",
  "outlok.com": "outlook.com", "iclod.com": "icloud.com",
};
const TLD_FIXES: [RegExp, string][] = [
  [/\.con$/, ".com"], [/\.cmo$/, ".com"], [/\.ocm$/, ".com"], [/\.comm$/, ".com"],
  [/\.ogr$/, ".org"], [/\.rog$/, ".org"], [/\.edu\.$/, ".edu"],
];
const EDGE_JUNK = /^[<("'[{]+|[>)"'\]},;:.!?]+$/g;
const LABELS = /^(to|cc|bcc|from|email|e-mail|emails|and|name|names|student|students|parent|parents)$/i;

function oldRepairAddress(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^mailto:/, "");
  s = s.replace(EDGE_JUNK, "");
  s = s.replace(/\s*@\s*/g, "@");
  const at = s.lastIndexOf("@");
  if (at > 0) {
    let domain = s.slice(at + 1).replace(/\.{2,}/g, ".");
    domain = DOMAIN_FIXES[domain] ?? domain;
    for (const [pattern, fix] of TLD_FIXES) domain = domain.replace(pattern, fix);
    s = `${s.slice(0, at)}@${domain}`;
  }
  return s;
}

function oldNameBefore(text: string): string | null {
  const m = text.match(/([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’.-]*){1,3})\s*[,<(:\t-]*\s*["']?\s*$/);
  if (!m) return null;
  const name = m[1]!.trim();
  if (LABELS.test(name)) return null;
  return name;
}

function oldFoldSpelledOut(text: string): string {
  return text
    .replace(
      /([\w.+-]+)\s*[[(]?\bat\b[\])]?\s*([\w-]+(?:\s*[[(]?\bdot\b[\])]?\s*[\w-]+)+)/gi,
      (match, local: string, domain: string) =>
        /\bdot\b/i.test(domain) ? `${local}@${domain.replace(/\s*[[(]?\bdot\b[\])]?\s*/gi, ".")}` : match
    )
    .replace(/\s*@\s*/g, "@");
}

function oldPreParse(text: string): PreParse {
  const normalised = oldFoldSpelledOut(text);
  const seen = new Set<string>();
  const ready: SortedAddress[] = [];
  const unreadable: string[] = [];
  let duplicates = 0;
  for (const line of normalised.split(/\r?\n/)) {
    const pieces = line.split(/[,;\t|]+/);
    let carry = "";
    for (const piece of pieces) {
      const tokens = piece.split(/\s+/).filter(Boolean);
      const atIndex = tokens.findIndex((t) => t.includes("@"));
      if (atIndex === -1) {
        carry = piece;
        continue;
      }
      const before = tokens.slice(0, atIndex).join(" ");
      for (const token of tokens.slice(atIndex)) {
        if (!token.includes("@")) continue;
        const email = oldRepairAddress(token);
        const original = token.trim().toLowerCase().replace(/^mailto:/, "").replace(EDGE_JUNK, "");
        if (!isValidEmail(email)) {
          const fragment = token.replace(/^[<("'[{]+|[>)"'\]},;:]+$/g, "").slice(0, 320);
          if (fragment && !unreadable.includes(fragment)) unreadable.push(fragment);
          continue;
        }
        if (seen.has(email)) {
          duplicates += 1;
          continue;
        }
        seen.add(email);
        ready.push({ email, name: oldNameBefore(before) ?? oldNameBefore(carry), fixedFrom: original !== email ? original : null });
      }
      carry = "";
    }
  }
  return { ready, unreadable, duplicates };
}

function oldNeedsModel(text: string, parsed: PreParse): boolean {
  if (parsed.unreadable.length > 0) return true;
  if (parsed.ready.every((r) => r.name)) return false;
  const residue = oldFoldSpelledOut(text)
    .replace(/\S+@\S+/g, " ")
    .split(/[^A-Za-z'’-]+/)
    .filter((w) => w.length >= 2 && !LABELS.test(w) && !/^mailto$/i.test(w));
  return residue.length > 0;
}

// ---- Same answers --------------------------------------------------------------

const FOLD_PIECES = [
  "a", "b", "Jo", "x1", "_", ".", "+", "-", " ", "  ", "\t", "\n", "at", "AT", "dot", "Dot", "[at]", "(at)",
  "[dot]", "(dot)", "[", "]", "(", ")", "@", "-dot", "x-dot", "dotx", "atx", "org", "com", ",", "'",
];
const PASTE_PIECES = [
  ...FOLD_PIECES, "Jane", "Doe", "O'Neil", "jane@school.org", "<jo@x.com>", "mailto:", "\"", ";", "|", ":",
  "gmial.com", ".con", "Ann Lee", "To:", " @ ", "..", "!", "?", "{", "}", "a@b", "x@y.edu.", "Mr.",
];

test("foldSpelledOut finds what the regular expression found", () => {
  const rand = seeded(11);
  for (let i = 0; i < 20000; i++) {
    const s = randomText(rand, FOLD_PIECES, 1 + Math.floor(rand() * 16));
    assert.equal(foldSpelledOut(s), oldFoldSpelledOut(s), JSON.stringify(s));
  }
});

test("repairAddress repairs exactly as before", () => {
  const rand = seeded(12);
  for (let i = 0; i < 5000; i++) {
    const s = randomText(rand, PASTE_PIECES, 1 + Math.floor(rand() * 8));
    assert.equal(repairAddress(s), oldRepairAddress(s), JSON.stringify(s));
  }
});

test("preParse and needsModel read every paste exactly as before", () => {
  const rand = seeded(13);
  for (let i = 0; i < 5000; i++) {
    const s = randomText(rand, PASTE_PIECES, 1 + Math.floor(rand() * 24));
    const parsed = preParse(s);
    assert.deepEqual(parsed, oldPreParse(s), JSON.stringify(s));
    assert.equal(needsModel(s, parsed), oldNeedsModel(s, parsed), JSON.stringify(s));
  }
});

test("the shapes a counselor pastes still sort", () => {
  const paste = [
    "To: Jane Doe <JANE@School.org>, \"Ann Lee\" <ann.lee@gmial.com>",
    "Mr. Bo Park, bo.park [at] lincoln [dot] edu",
    "sam at mail dot example dot com",
    "jane@school.org; broken@@; kim @ x.con",
  ].join("\n");
  const r = preParse(paste);
  assert.deepEqual(
    r.ready.map((x) => [x.email, x.name, x.fixedFrom]),
    [
      ["jane@school.org", "Jane Doe", null],
      ["ann.lee@gmail.com", "Ann Lee", "ann.lee@gmial.com"],
      ["bo.park@lincoln.edu", "Bo Park", null],
      ["sam@mail.example.com", null, null],
      ["kim@x.com", null, "kim@x.con"],
    ]
  );
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.unreadable, ["broken@@"]);
  assert.deepEqual(r, oldPreParse(paste));
});

test("a name before an address is found past a long run of text", () => {
  const before = `${"word ".repeat(2000)}Jane Doe`;
  const r = preParse(`${before} jane@school.org`);
  assert.equal(r.ready[0]?.name, "Jane Doe");
});

// ---- Worst cases ---------------------------------------------------------------

/** The sort and send schemas' cap. */
const MAX_PASTE = 20000;
const fill = (unit: string, size = MAX_PASTE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

test("a 20,000-character paste of any one shape is sorted in well under 100 ms", () => {
  const units = [
    "a", "a.", "a ", "a-", "a at ", "a dot ", "at ", "dot ", "a at b ", " at b dot", "a@", "@", " @ ", "a @ ",
    ")", "a)", "(", "<", "a.a@", ".", " ", "\t", "Jane ", "Jane Doe ", "A", "Aa ", "x-dot", "-dot ", "[at]", "[dot]",
  ];
  for (const unit of units) {
    for (const [prefix, suffix] of [["", ""], ["", "x"], ["x@", ""], ["", "@x"], ["", " @"]]) {
      const paste = prefix + fill(unit, MAX_PASTE - prefix.length - suffix.length) + suffix;
      const ms = elapsed(() => needsModel(paste, preParse(paste)));
      assert.ok(ms < BUDGET_MS, `${JSON.stringify(prefix)} + ${JSON.stringify(unit)}* + ${JSON.stringify(suffix)} took ${ms.toFixed(1)} ms`);
    }
  }
});
