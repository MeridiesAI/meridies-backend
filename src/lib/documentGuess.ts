/**
 * What a picked file probably is (spec §4.3.1). Pure, no model, no I/O: filename, Google file
 * type and a few printed phrases. The text it reads is used here and dropped; `matched` is one
 * of our own labels below, never document text. A sensitive signal anywhere wins, so a doubtful
 * file errs toward being kept out of AI.
 */

export type GuessKind =
  | "transcript" | "test-report" | "financial" | "iep-504"
  | "award-letter" | "recommendation-letter" | "resume" | "activity-list";

export type KindGuess = {
  kind: GuessKind | null;
  basis: "text" | "filename" | "type" | null;
  matched: string | null;
  textFound: boolean;
  keepOut: boolean;
};

export const GUESS_TEXT_LIMIT = 20_000;
export const GUESS_PAGES = 3;

const SENSITIVE: readonly GuessKind[] = ["financial", "iep-504"];

type Rule = { kind: GuessKind; label: string; re: RegExp };

// Order matters only for picking the label shown; kinds are counted by distinct labels.
const TEXT_RULES: Rule[] = [
  { kind: "financial", label: "Form 1040", re: /\bform\s+1040\b/i },
  { kind: "financial", label: "W-2", re: /\bW-2\b/ },
  { kind: "financial", label: "1099", re: /\b(?:form\s+1099|1099-[a-z]{1,4})\b/i },
  { kind: "financial", label: "Student Aid Report", re: /\bstudent\s+aid\s+report\b/i },
  { kind: "financial", label: "FAFSA", re: /\bFAFSA\b/ },
  { kind: "financial", label: "CSS Profile", re: /\bCSS\s+profile\b/i },
  { kind: "financial", label: "tax return", re: /\btax\s+return\b/i },
  { kind: "iep-504", label: "Individualized Education Program", re: /\bindividuali[sz]ed\s+education\s+(?:program|plan)\b/i },
  { kind: "iep-504", label: "504 Plan", re: /\b504\s+plan\b/i },
  { kind: "iep-504", label: "Section 504", re: /\bsection\s+504\b/i },
  { kind: "iep-504", label: "IEP", re: /\bIEP\b/ },
  { kind: "transcript", label: "Official Transcript", re: /\bofficial\s+transcript\b/i },
  { kind: "transcript", label: "Unofficial Transcript", re: /\bunofficial\s+transcript\b/i },
  { kind: "transcript", label: "Academic Transcript", re: /\bacademic\s+transcript\b/i },
  { kind: "transcript", label: "Cumulative GPA", re: /\bcumulative\s+gpa\b/i },
  { kind: "test-report", label: "Score Report", re: /\bscore\s+report\b/i },
  { kind: "test-report", label: "College Board", re: /\bcollege\s+board\b/i },
  { kind: "test-report", label: "SAT score", re: /\bSAT\b[^.\n]{0,40}\bscores?\b/ },
  { kind: "test-report", label: "ACT score", re: /\bACT\b[^.\n]{0,40}\bscores?\b/ },
  { kind: "test-report", label: "AP Scores", re: /\bAP\s+scores\b/i },
  { kind: "award-letter", label: "Financial Aid Award", re: /\bfinancial\s+aid\s+award\b/i },
  { kind: "award-letter", label: "Award Letter", re: /\baward\s+letter\b/i },
  { kind: "award-letter", label: "Offer of Financial Aid", re: /\boffer\s+of\s+financial\s+aid\b/i },
  { kind: "recommendation-letter", label: "Letter of Recommendation", re: /\bletter\s+of\s+recommendation\b/i },
  { kind: "recommendation-letter", label: "Recommendation for", re: /\brecommendation\s+for\b/i },
  { kind: "resume", label: "Resume", re: /\br[eé]sum[eé]\b/i },
  { kind: "resume", label: "Curriculum Vitae", re: /\bcurriculum\s+vitae\b/i },
  { kind: "activity-list", label: "Activities List", re: /\bactivities\s+list\b/i },
  { kind: "activity-list", label: "Extracurricular Activities", re: /\bextracurricular\s+activities\b/i },
];

const FILENAME_WORDS: Record<string, GuessKind> = {
  transcript: "transcript", transcripts: "transcript",
  "1040": "financial", w2: "financial", "1099": "financial", fafsa: "financial", taxes: "financial", tax: "financial",
  iep: "iep-504", "504": "iep-504",
  score: "test-report", scores: "test-report", sat: "test-report", act: "test-report",
  resume: "resume", cv: "resume",
  recommendation: "recommendation-letter",
  award: "award-letter",
  activities: "activity-list",
};

const SHEETS = new Set([
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const none = (textFound: boolean): KindGuess => ({ kind: null, basis: null, matched: null, textFound, keepOut: false });

function words(filename: string): string[] {
  return filename
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Pick among matches: sensitive first; else the kind with strictly the most distinct labels. */
function pick(matches: { kind: GuessKind; label: string }[]): { kind: GuessKind; label: string } | null {
  if (matches.length === 0) return null;
  const sensitive = matches.find((m) => SENSITIVE.includes(m.kind));
  if (sensitive) return sensitive;
  const counts = new Map<GuessKind, number>();
  for (const m of matches) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) return null;
  return matches.find((m) => m.kind === ranked[0]![0])!;
}

export function guessKind(input: { filename: string; mimeType: string | null; text: string | null }): KindGuess {
  const text = (input.text ?? "").slice(0, GUESS_TEXT_LIMIT);
  const textFound = text.trim().length >= 20;

  const fromText = textFound ? TEXT_RULES.filter((r) => r.re.test(text)).map((r) => ({ kind: r.kind, label: r.label })) : [];
  const ws = words(input.filename);
  const fromName = ws.flatMap((w) => (FILENAME_WORDS[w] ? [{ kind: FILENAME_WORDS[w]!, label: w }] : []));
  if (ws.includes("rec") && ws.includes("letter")) fromName.push({ kind: "recommendation-letter", label: "rec letter" });

  // A sensitive signal anywhere wins, text or filename.
  const sensitive = [...fromText, ...fromName].find((m) => SENSITIVE.includes(m.kind));
  if (sensitive) {
    const basis = fromText.includes(sensitive) ? "text" : "filename";
    return { kind: sensitive.kind, basis, matched: sensitive.label, textFound, keepOut: true };
  }
  const t = pick(fromText);
  if (t) return { kind: t.kind, basis: "text", matched: t.label, textFound, keepOut: false };
  if (fromText.length > 0) return none(textFound); // a tie in the text is unknown, not a filename guess
  const f = pick(fromName);
  if (f) return { kind: f.kind, basis: "filename", matched: f.label, textFound, keepOut: false };
  if (input.mimeType && SHEETS.has(input.mimeType) && ws.includes("list")) {
    return { kind: "activity-list", basis: "type", matched: "spreadsheet named like a list", textFound, keepOut: false };
  }
  return none(textFound);
}
