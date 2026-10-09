/**
 * The name rule for matching imported rows to accounts (spec §4.4).
 * Too strict and everything becomes a suggestion; too loose and twins on a
 * shared parent email collapse into one student. Both first and last name
 * must match; initials never do.
 */

const NICKNAME_GROUPS: readonly string[][] = [
  ["robert", "bob", "rob", "bobby", "robbie"],
  ["william", "will", "bill", "billy", "liam"],
  ["elizabeth", "liz", "beth", "eliza", "lizzie", "betsy"],
  ["katherine", "catherine", "kate", "katie", "kathy", "cate"],
  ["michael", "mike", "mikey"],
  ["christopher", "chris"],
  ["alexander", "alex", "xander"],
  ["alexandra", "alex", "lexi", "sasha"],
  ["jonathan", "jon", "john", "johnny"],
  ["joseph", "joe", "joey"],
  ["daniel", "dan", "danny"],
  ["matthew", "matt"],
  ["nicholas", "nick", "nico"],
  ["benjamin", "ben", "benji"],
  ["samuel", "sam", "sammy"],
  ["samantha", "sam", "sammy"],
  ["jennifer", "jen", "jenny"],
  ["jessica", "jess", "jessie"],
  ["margaret", "maggie", "meg", "peggy"],
  ["richard", "rich", "rick"],
  ["james", "jim", "jimmy", "jamie"],
  ["anthony", "tony"],
  ["andrew", "andy", "drew"],
  ["victoria", "vicky", "tori"],
  ["rebecca", "becky", "becca"],
  ["abigail", "abby"],
  ["madeline", "maddie"],
  ["thomas", "tom", "tommy"],
  ["edward", "ed", "eddie", "ted"],
  ["steven", "stephen", "steve"],
  ["timothy", "tim"],
  ["zachary", "zach", "zack"],
  ["isabella", "isabel", "bella", "izzy"],
  ["olivia", "liv", "livvy"],
  ["gabriel", "gabe"],
  ["gabriela", "gabriella", "gabby"],
  ["patricia", "pat", "patty", "trish"],
  ["natalie", "nat"],
  ["nathaniel", "nathan", "nate"],
  ["eleanor", "ellie", "nora"],
  ["charlotte", "charlie"],
  ["charles", "charlie", "chuck"],
  ["francisco", "paco", "pancho"],
  ["jose", "pepe"],
  ["guillermo", "memo"],
  ["alejandro", "alex", "ale"],
];

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseName(s: string): { first: string; surnames: string[] } {
  const n = normalizeName(s);
  let first: string;
  let last: string;
  if (n.includes(",")) {
    const [l, f] = n.split(",", 2);
    last = l.trim();
    first = (f ?? "").trim().split(" ")[0] ?? "";
  } else {
    const parts = n.split(" ").filter(Boolean);
    first = parts[0] ?? "";
    last = parts.slice(1).join(" ");
  }
  const surnames = last.split(/[\s-]+/).filter(Boolean);
  return { first, surnames };
}

export function firstNamesMatch(a: string, b: string): boolean {
  const x = normalizeName(a).replace(/[^a-z]/g, "");
  const y = normalizeName(b).replace(/[^a-z]/g, "");
  if (x.length < 2 || y.length < 2) return false;
  if (x === y) return true;
  return NICKNAME_GROUPS.some((g) => g.includes(x) && g.includes(y));
}

function surnamesMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return b.includes(lastA) || a.includes(lastB);
}

export function namesMatch(imported: string, account: string, preferred?: string | null): boolean {
  const i = parseName(imported);
  const a = parseName(account);
  if (!surnamesMatch(i.surnames, a.surnames)) return false;
  if (firstNamesMatch(i.first, a.first)) return true;
  return Boolean(preferred) && firstNamesMatch(i.first, preferred as string);
}
