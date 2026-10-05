/**
 * Mass invite (demo v10): the counselor pastes a list of addresses in whatever
 * shape it came in (a spreadsheet column, an email thread's To: line, a roster
 * with names) and AxIS sorts it into one clean, sendable list: names kept,
 * typos repaired, duplicates and already-invited addresses set aside.
 *
 * Two passes, deliberately:
 *
 *  1. `preParse()` — deterministic, a port of the demo's parser. It finds every
 *     address, repairs what a paste breaks (mailto:, brackets, quotes, spaces
 *     around the @, "jane at school dot org", the common domain typos) and keeps
 *     a name when the text gives one. It alone decides which addresses exist.
 *
 *  2. The model (Haiku, via runStructured) reads the paste with that result and
 *     may attach names the regex missed and repair what the rules could not.
 *     Its output is untrusted: `groundModelEntries()` accepts an address only
 *     when it is a pre-parsed address or a small edit of something actually in
 *     the paste, and a name only when every word of it appears in the paste. A
 *     model can therefore never add a recipient nobody pasted, and dropping an
 *     address does not drop it — the pre-parse result is the floor.
 */

import { z } from "zod";

export type SortedAddress = {
  email: string;
  name: string | null;
  /** What the paste said, when it had to be fixed. */
  fixedFrom: string | null;
};

export type PreParse = {
  ready: SortedAddress[];
  /** Fragments with an @ that still are not an address. */
  unreadable: string[];
  duplicates: number;
};

/** Strict enough to refuse "a@b", loose enough for real school domains. */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;
const emailSchema = z.string().max(320).email();

export function isValidEmail(value: string): boolean {
  const v = value.trim().toLowerCase();
  return EMAIL_RE.test(v) && emailSchema.safeParse(v).success && !v.includes("..");
}

/** Domain typos common enough to fix without asking. */
const DOMAIN_FIXES: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.om": "gmail.com",
  gmailcom: "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "outlok.com": "outlook.com",
  "iclod.com": "icloud.com",
};

const TLD_FIXES: [RegExp, string][] = [
  [/\.con$/, ".com"],
  [/\.cmo$/, ".com"],
  [/\.ocm$/, ".com"],
  [/\.comm$/, ".com"],
  [/\.ogr$/, ".org"],
  [/\.rog$/, ".org"],
  [/\.edu\.$/, ".edu"],
];

const EDGE_JUNK = /^[<("'[{]+|[>)"'\]},;:.!?]+$/g;

/** Repairs one candidate address; returns it lower-cased and trimmed. */
export function repairAddress(raw: string): string {
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

const LABELS = /^(to|cc|bcc|from|email|e-mail|emails|and|name|names|student|students|parent|parents)$/i;

/** "Jane Doe" from the text just before an address, if it reads like a name. */
function nameBefore(text: string): string | null {
  const m = text.match(/([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’.-]*){1,3})\s*[,<(:\t-]*\s*["']?\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  if (LABELS.test(name)) return null;
  return name;
}

/** Folds "jane [at] school [dot] org" back into an address, leaving prose alone. */
function foldSpelledOut(text: string): string {
  return text
    .replace(
      /([\w.+-]+)\s*[[(]?\bat\b[\])]?\s*([\w-]+(?:\s*[[(]?\bdot\b[\])]?\s*[\w-]+)+)/gi,
      (match, local: string, domain: string) =>
        /\bdot\b/i.test(domain)
          ? `${local}@${domain.replace(/\s*[[(]?\bdot\b[\])]?\s*/gi, ".")}`
          : match
    )
    .replace(/\s*@\s*/g, "@");
}

export function preParse(text: string): PreParse {
  const normalised = foldSpelledOut(text);
  const seen = new Set<string>();
  const ready: SortedAddress[] = [];
  const unreadable: string[] = [];
  let duplicates = 0;

  for (const line of normalised.split(/\r?\n/)) {
    const pieces = line.split(/[,;\t|]+/);
    let carry = "";
    for (const piece of pieces) {
      // A name on its own piece ("Jane Doe, jane@school.org") carries forward.
      const tokens = piece.split(/\s+/).filter(Boolean);
      const atIndex = tokens.findIndex((t) => t.includes("@"));
      if (atIndex === -1) {
        carry = piece;
        continue;
      }
      const before = tokens.slice(0, atIndex).join(" ");
      for (const token of tokens.slice(atIndex)) {
        if (!token.includes("@")) continue;
        const email = repairAddress(token);
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
        ready.push({
          email,
          name: nameBefore(before) ?? nameBefore(carry),
          fixedFrom: original !== email ? original : null,
        });
      }
      carry = "";
    }
  }
  return { ready, unreadable, duplicates };
}

/**
 * Whether the model has anything to add. A clean column of bare addresses
 * with nothing else in the paste needs no model call.
 */
export function needsModel(text: string, parsed: PreParse): boolean {
  if (parsed.unreadable.length > 0) return true;
  if (parsed.ready.every((r) => r.name)) return false;
  const residue = foldSpelledOut(text)
    .replace(/\S+@\S+/g, " ")
    .split(/[^A-Za-z'’-]+/)
    .filter((w) => w.length >= 2 && !LABELS.test(w) && !/^mailto$/i.test(w));
  return residue.length > 0;
}

// ---- The model pass ---------------------------------------------------------

export const MASS_INVITE_SYSTEM = [
  "You sort a list of email addresses a college counselor pasted, so they can invite students.",
  "The paste may be a spreadsheet column, an email To: line, a roster with names, or a mix.",
  "Return one entry per distinct address in the paste. For each: the corrected address,",
  "the person's name exactly as the paste writes it (or null when the paste gives none),",
  "and the original text when you changed the address (or null).",
  "Repair only obvious damage: stray punctuation, spaces, a misspelled common mail domain",
  "(gmal.com -> gmail.com), a missing or garbled .com/.org/.edu. Never invent an address,",
  "a domain or a name that is not in the paste. If a fragment cannot be repaired with",
  "confidence, return it in `unreadable` unchanged. Ignore everything that is not a contact.",
].join(" ");

export const MASS_INVITE_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        properties: {
          email: { type: "string" },
          name: { type: ["string", "null"] },
          fixedFrom: { type: ["string", "null"] },
        },
        required: ["email", "name", "fixedFrom"],
      },
    },
    unreadable: { type: "array", maxItems: 200, items: { type: "string" } },
  },
  required: ["entries", "unreadable"],
} as const;

const modelOutput = z.object({
  entries: z
    .array(
      z.object({
        email: z.string().max(400),
        name: z.string().max(200).nullable().optional(),
        fixedFrom: z.string().max(400).nullable().optional(),
      })
    )
    .max(200),
  unreadable: z.array(z.string().max(400)).max(200),
});
export type ModelOutput = z.infer<typeof modelOutput>;

export function parseModelOutput(value: unknown): ModelOutput {
  return modelOutput.parse(value);
}

export function massInvitePrompt(text: string, parsed: PreParse): string {
  return [
    "<paste>",
    text,
    "</paste>",
    "",
    "A rule-based pass already found these (address | name | original):",
    ...parsed.ready.map((r) => `${r.email} | ${r.name ?? "-"} | ${r.fixedFrom ?? "-"}`),
    parsed.unreadable.length ? `And could not read: ${parsed.unreadable.join(" ; ")}` : "",
    "",
    "Return the full sorted list.",
  ].join("\n");
}

/** Classic edit distance, capped: anything past `max` returns max + 1. */
export function editDistance(a: string, b: string, max = 4): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z'’-]+/i)
    .filter(Boolean);
}

/**
 * Keep only what the paste supports. Returns the merged list (pre-parse as the
 * floor), the unreadable fragments that remain, and how many duplicates the
 * repairs produced.
 */
export function groundModelEntries(
  text: string,
  parsed: PreParse,
  output: ModelOutput
): PreParse {
  const pasteLower = text.toLowerCase();
  const pasteWords = new Set(words(text));
  const known = new Map(parsed.ready.map((r) => [r.email, r]));
  const fragments = parsed.unreadable.map((f) => ({ raw: f, norm: repairAddress(f) }));
  const usedFragments = new Set<string>();

  const groundedName = (name: string | null | undefined): string | null => {
    const n = name?.trim();
    if (!n || n.length > 200) return null;
    const ws = words(n);
    if (ws.length === 0 || ws.length > 5) return null;
    return ws.every((w) => pasteWords.has(w)) ? n : null;
  };

  const out = new Map<string, SortedAddress>();
  let duplicates = parsed.duplicates;

  for (const entry of output.entries) {
    const email = repairAddress(entry.email);
    if (!isValidEmail(email)) continue;

    let accepted: SortedAddress | null = null;
    const pre = known.get(email);
    if (pre) {
      accepted = { ...pre, name: pre.name ?? groundedName(entry.name) };
    } else {
      // A repair: must sit within a small edit of a fragment or address that
      // is really in the paste, and its local part must be there verbatim.
      const local = email.split("@")[0];
      const fragment = fragments.find(
        (f) => !usedFragments.has(f.raw) && editDistance(f.norm, email) <= 3
      );
      const near = fragment
        ? null
        : parsed.ready.find((r) => editDistance(r.email, email) <= 2 && r.email.split("@")[0] === local);
      if ((fragment || near) && pasteLower.includes(local)) {
        if (fragment) usedFragments.add(fragment.raw);
        if (near) known.delete(near.email);
        accepted = {
          email,
          name: (near?.name ?? null) || groundedName(entry.name),
          fixedFrom: fragment ? fragment.raw.toLowerCase() : near?.fixedFrom ?? near?.email ?? null,
        };
      }
    }
    if (!accepted) continue;
    if (out.has(accepted.email)) {
      duplicates += 1;
      continue;
    }
    out.set(accepted.email, accepted);
  }

  // The floor: an address the rules found is never lost to the model.
  for (const r of parsed.ready) {
    if (!known.has(r.email)) continue;
    if (!out.has(r.email)) out.set(r.email, r);
  }

  const unreadable = parsed.unreadable.filter((f) => !usedFragments.has(f));
  return { ready: [...out.values()], unreadable, duplicates };
}
