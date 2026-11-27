/**
 * Language understanding without a model call.
 *
 * Every turn starts here and the result steers everything after it: whether
 * the question can be answered straight from the data, what evidence is
 * fetched before the model runs, which specialist answers, at what effort,
 * and whether the answer's figures are checked. It runs in well under a
 * millisecond, so routing costs no latency and no tokens.
 *
 *  - Intent: a weighted lexicon score per intent, per clause and for the
 *    whole message, with a confidence from the margin between the top two.
 *  - Entities: students on the roster and colleges in the catalog
 *    (lib/axis/entities.ts), with pronouns carried over from the last turns.
 *  - Attributes: which fact a lookup asks for (GPA, admit rate, deadlines).
 *  - A time window (lib/axis/dates.ts).
 *  - Complexity, from clauses, entities, judgement words and length.
 */
import { explicitDates, parseWindow, shortDay, type DateWindow } from "./dates.js";
import { dayIn, DEFAULT_ZONE } from "./tz.js";
import type { AmbiguousCollege, AmbiguousMention, CollegeIndex, CollegeMention, RosterIndex, StudentMention } from "./entities.js";
import {
  ATTRIBUTE_PATTERNS,
  COLLEGE_ATTRIBUTES,
  INTENT_FEATURES,
  INTENTS,
  JARGON,
  JUDGEMENT_WORDS,
  LOOKUP_LEAD,
  type Attribute,
  type Intent,
} from "./lexicon.js";
import { STOPWORDS, splitClauses, tokens } from "./text.js";
import type { DraftHeader } from "./drafts/state.js";

export type { Intent, Attribute };

/**
 * A question AxIS asked back in code, kept for one turn so the reply finishes the original question: which of two
 * students with one first name ("Chen", "the 12th grader", "the first one"), or when a school's break is.
 */
export type PendingAsk =
  | { kind: "student"; question: string; candidates: { id: string; name: string; grade: number | null; gradYear?: string | null }[] }
  | { kind: "date"; question: string; label: string; mode: "by" | "during" };

export type DialogueState = {
  students: { id: string; name: string }[];
  colleges: { id: string; name: string }[];
  at: string;
  /** The last turn read outside content: its answer is in the next turn's history, so that turn's changes wait for a click too. */
  outside?: boolean;
  /** Under the free-text rule: the last turn read a student's short fields, so changes a student or family sees wait too. */
  short?: boolean;
  /** The chat's open activity draft: its header (the rows are in ai_conversations.draft_rows; lib/axis/drafts/state.ts). */
  draft?: DraftHeader;
  /** The question the last answer asked back, if it did. Kept one turn, and expires with the rest of the state. */
  pending?: PendingAsk;
};

export type Clause = { text: string; intent: Intent; score: number };

export type Understanding = {
  text: string;
  /** tokens(text).join(" "), what the patterns run on. */
  norm: string;
  intent: Intent;
  /** 0 when the top two intents tie, 1 when only one scored. */
  confidence: number;
  scores: Record<Intent, number>;
  clauses: Clause[];
  students: StudentMention[];
  ambiguousStudents: AmbiguousMention[];
  colleges: CollegeMention[];
  ambiguousColleges: AmbiguousCollege[];
  attributes: Attribute[];
  window: DateWindow | null;
  form: "lookup" | "yesno" | "imperative" | "statement";
  /** A judgement, comparison or hypothetical word is present. */
  judgement: boolean;
  /** Content words plus jargon expansions, for document and email search. */
  keywords: string[];
  complexity: number;
};

export type UnderstandContext = {
  /** The student the chat is about, if any. */
  chatStudentId: string | null;
  roster: RosterIndex | null;
  colleges: CollegeIndex | null;
  state: DialogueState | null;
  now?: Date;
  /** The counselor's timezone (lib/axis/tz.ts): "today" and "this week" are theirs. */
  zone?: string;
};

const PRONOUN_PERSON = /\b(she|her|hers|he|him|his|they|them|their|theirs)\b/;
const PRONOUN_SCHOOL = /\b(it|its|there|that school|this school|that college|this college|the school|the college)\b/;
const AUX_LEAD = /^(is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|am)\b/;
const IMPERATIVE_LEAD = /^(show|list|tell|give|find|pull|remind|add|draft|write|email|create|schedule|summari[sz]e|compare|check|look|send|put|set|make)\b/;
/** Carried-over entities expire: a pronoun half an hour later is about someone new. */
const STATE_TTL_MS = 30 * 60 * 1000;

export function scoreIntents(norm: string): Record<Intent, number> {
  const scores = Object.fromEntries(INTENTS.map((i) => [i, 0])) as Record<Intent, number>;
  for (const intent of INTENTS) {
    for (const [re, w] of INTENT_FEATURES[intent]) if (re.test(norm)) scores[intent] += w;
  }
  return scores;
}

function rank(scores: Record<Intent, number>): [Intent, number][] {
  return (Object.entries(scores) as [Intent, number][]).sort((a, b) => b[1] - a[1]);
}

/** Structure the lexicon can't see: entities and attributes shift the scores. */
function adjust(scores: Record<Intent, number>, ctx: { colleges: number; students: number; attrs: Attribute[]; hasChatStudent: boolean }) {
  if (ctx.colleges > 0) scores.colleges += Math.min(ctx.colleges, 2) * 1.5;
  if (ctx.attrs.some((a) => COLLEGE_ATTRIBUTES.has(a)) && ctx.colleges > 0) scores.colleges += 2;
  // A roster question names nobody; with a student in view, "who" questions are about that student's people.
  if (ctx.hasChatStudent || ctx.students > 0) scores.roster *= 0.4;
  if (ctx.students > 0 && !ctx.hasChatStudent) scores.record += 1;
  // With nobody in view, a question about deadlines or progress is about the whole caseload.
  if (!ctx.hasChatStudent && ctx.students === 0) {
    scores.roster += scores.record;
    scores.record = 0;
  }
}

function pickIntent(scores: Record<Intent, number>, fallback: Intent): { intent: Intent; confidence: number } {
  const [[top, s1], [, s2]] = rank(scores) as [[Intent, number], [Intent, number]];
  if (s1 <= 0) return { intent: fallback, confidence: 0 };
  return { intent: top, confidence: Math.max(0, Math.min(1, (s1 - s2) / s1)) };
}

const QUESTION_LEAD = /^(should|shall|is|are|was|were|what|whats|how|why|when|which|who|whom|where|do|does|did|has|have|had|am|would i|could i|can i|should i)\b/;
const REQUEST_FORM = /^(please |pls |axis )?(can|could|would|will) you\b|\bplease\b|\bgo ahead\b/;

/**
 * A question asks; it doesn't order a change. "Should I remove Yale from her list?" is advice,
 * "Change in her GPA since last year?" a lookup. Unless it is put as a request ("can you…",
 * "please…"), a question's change score is capped below the level that makes it an action.
 */
export function dampQuestions(scores: Record<Intent, number>, text: string, norm: string): void {
  const question = text.trim().endsWith("?") || QUESTION_LEAD.test(norm);
  if (question && !REQUEST_FORM.test(norm)) scores.action = Math.min(scores.action, 2);
}

/** Judgement wins a near-tie with a lookup it would need anyway ("should she apply ED given her SAT?"). */
function resolveTies(scores: Record<Intent, number>): void {
  const max = Math.max(...Object.values(scores));
  if (scores.strategy > 0 && scores.strategy >= max - 1) scores.strategy = max + 0.5;
  if (scores.action >= 5) scores.action = Math.max(scores.action, max + 0.5);
  if (scores.essay >= 6) scores.essay = Math.max(scores.essay, max + 1);
}

export function attributesOf(norm: string): Attribute[] {
  const out = ATTRIBUTE_PATTERNS.filter(([, re]) => re.test(norm)).map(([attr]) => attr);
  // "SAT range" is a college question; the bare "sat" inside it is not a second ask.
  return out.filter((a) => !(a === "sat" && out.includes("sat_range")) && !(a === "act" && out.includes("act_range")));
}

export function keywordsOf(text: string): string[] {
  const out: string[] = [];
  for (const t of tokens(text)) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
    const exp = JARGON[t];
    if (exp) out.push(...exp.toLowerCase().split(" "));
  }
  return [...new Set(out)];
}

const ORDINALS: [RegExp, (n: number) => number][] = [
  [/\b(first|1st|former)\b/, () => 0],
  [/\b(second|2nd)\b/, () => 1],
  [/\b(third|3rd)\b/, () => 2],
  [/\b(fourth|4th)\b/, () => 3],
  [/\b(latter|last)\b/, (n) => n - 1],
];
const GRADES: [RegExp, number][] = [
  [/\b(12th|twelfth|senior|seniors)\b/, 12],
  [/\b(11th|eleventh|junior|juniors)\b/, 11],
  [/\b(10th|tenth|sophomore|sophomores)\b/, 10],
  [/\b(9th|ninth|freshman|freshmen)\b/, 9],
];

/**
 * Which of the students AxIS listed a short reply picks: by a part of the name only one of them has ("Chen",
 * "Alex Park"), by grade or class year ("the 12th grader", "class of 2027"), or by position ("the first one",
 * "2"). Every signal in the reply has to point at the same one student; a close spelling never counts (no guessing
 * between students). Null when the reply picks nobody, or is a new question (over eight words).
 */
export function pickCandidate(text: string, candidates: { name: string; grade: number | null; gradYear?: string | null }[]): number | null {
  const words = tokens(text);
  if (!words.length || words.length > 8) return null;
  const norm = words.join(" ");
  const picks: number[][] = [];
  if (/^\d$/.test(norm)) picks.push([Number(norm) - 1]);
  for (const [re, at] of ORDINALS) if (re.test(norm)) picks.push([at(candidates.length)]);
  for (const [re, grade] of GRADES) if (re.test(norm)) picks.push(candidates.flatMap((c, i) => (c.grade === grade ? [i] : [])));
  const year = /\b(20\d\d)\b/.exec(norm)?.[1];
  if (year) picks.push(candidates.flatMap((c, i) => (c.gradYear === year ? [i] : [])));
  const parts = candidates.map((c) => tokens(c.name));
  const shared = new Set(parts[0]!.filter((p) => parts.every((ps) => ps.includes(p))));
  const named = candidates.flatMap((_, i) => (words.some((w) => !shared.has(w) && parts[i]!.includes(w)) ? [i] : []));
  if (named.length) picks.push(named);
  if (!picks.length) return null;
  const first = picks[0]!;
  if (first.length !== 1 || first[0]! < 0 || first[0]! >= candidates.length) return null;
  return picks.every((p) => p.length === 1 && p[0] === first[0]) ? first[0]! : null;
}

/** The remembered question, finished by this reply; null when the message isn't a reply to it. */
function resolvePending(text: string, pending: PendingAsk, ctx: UnderstandContext, fresh: DialogueState, now: Date): Understanding | null {
  const again = (q: string) => understand(q, { ...ctx, state: { ...fresh, pending: undefined } });
  if (pending.kind === "student") {
    const i = pickCandidate(text, pending.candidates);
    if (i === null) return null;
    const c = pending.candidates[i]!;
    const base = again(pending.question);
    // The chat's own student is the chat's (the direct answers read it through the chat); anyone else is named.
    const students: StudentMention[] = c.id === ctx.chatStudentId ? [] : [{ id: c.id, name: c.name, score: 1, via: "full" }];
    return { ...base, students, ambiguousStudents: [] };
  }
  // The counselor's today, in their zone: "Dec 19" and "before" are read from their date, not UTC's.
  const zone = ctx.zone ?? DEFAULT_ZONE;
  const days = explicitDates(text, now, zone);
  if (!days.length || tokens(text).length > 8) return null;
  const today = dayIn(zone, now);
  const label = (d: string) => shortDay(new Date(`${d}T00:00:00Z`));
  // "Before winter break": from today to the day it starts. "During": its first and last day, both needed.
  const window: DateWindow | null =
    pending.mode === "by"
      ? days[0]! >= today
        ? { from: today, to: days[0]!, label: `before ${pending.label} (${label(days[0]!)})` }
        : null
      : days.length === 2
        ? { from: days[0]!, to: days[1]!, label: `during ${pending.label}` }
        : null;
  if (!window) return null;
  return { ...again(pending.question), window };
}

export function understand(text: string, ctx: UnderstandContext): Understanding {
  const now = ctx.now ?? new Date();
  const live = ctx.state && now.getTime() - Date.parse(ctx.state.at) < STATE_TTL_MS ? ctx.state : null;
  if (live?.pending) {
    const resolved = resolvePending(text, live.pending, ctx, live, now);
    if (resolved) return resolved;
  }
  const norm = tokens(text).join(" ");
  const fromRoster = ctx.roster ? ctx.roster.match(text) : { students: [], ambiguous: [] };
  const fromCatalog = ctx.colleges ? ctx.colleges.match(text) : { colleges: [], ambiguous: [] };
  let students = fromRoster.students.filter((s) => s.id !== ctx.chatStudentId);
  let colleges = fromCatalog.colleges;
  const attributes = attributesOf(norm);

  // Pronouns pick up the student or school of the last turns when the message names none.
  const fresh = ctx.state && now.getTime() - Date.parse(ctx.state.at) < STATE_TTL_MS ? ctx.state : null;
  if (!ctx.chatStudentId && !students.length && !fromRoster.ambiguous.length && fresh?.students[0] && PRONOUN_PERSON.test(norm)) {
    students = [{ ...fresh.students[0], score: 0.6, via: "pronoun" }];
  }
  const asksSchoolFact = attributes.some((a) => COLLEGE_ATTRIBUTES.has(a));
  // A school figure asked of a name the catalog doesn't know: the one school it is a close spelling of, if there is
  // exactly one (the direct answer then says "Assuming you meant …"). Before the carried-over school, which a
  // misspelled name is plainly not about. Never for students.
  if (!colleges.length && !fromCatalog.ambiguous.length && asksSchoolFact && ctx.colleges) {
    const guess = ctx.colleges.closest(text);
    if (guess) colleges = [guess];
  }
  if (!colleges.length && !fromCatalog.ambiguous.length && fresh?.colleges[0] && (PRONOUN_SCHOOL.test(norm) || asksSchoolFact)) {
    colleges = [{ ...fresh.colleges[0], score: 0.6, via: "pronoun", span: "" }];
  }

  const scores = scoreIntents(norm);
  const adjustCtx = { colleges: colleges.length, students: students.length, attrs: attributes, hasChatStudent: !!ctx.chatStudentId };
  adjust(scores, adjustCtx);
  dampQuestions(scores, text, norm);
  resolveTies(scores);
  const fallback: Intent = ctx.chatStudentId || students.length ? "record" : "roster";
  const { intent, confidence } = pickIntent(scores, fallback);

  const clauses: Clause[] = splitClauses(text).map((c) => {
    const cn = tokens(c).join(" ");
    const cs = scoreIntents(cn);
    adjust(cs, { ...adjustCtx, colleges: ctx.colleges ? ctx.colleges.match(c).colleges.length : 0, attrs: attributesOf(cn) });
    dampQuestions(cs, c, cn);
    resolveTies(cs);
    const picked = pickIntent(cs, intent);
    return { text: c, intent: picked.intent, score: cs[picked.intent] };
  });

  const form: Understanding["form"] = LOOKUP_LEAD.test(norm)
    ? "lookup"
    : AUX_LEAD.test(norm)
      ? "yesno"
      : IMPERATIVE_LEAD.test(norm)
        ? "imperative"
        : "statement";
  const judgement = JUDGEMENT_WORDS.test(norm);
  const distinctClauseIntents = new Set(clauses.map((c) => c.intent)).size;
  const complexity =
    Math.max(0, clauses.length - 1) +
    Math.max(0, distinctClauseIntents - 1) +
    (students.length > 1 ? 1 : 0) +
    (colleges.length > 2 ? 1 : 0) +
    (judgement ? 1 : 0) +
    (text.length > 400 ? 1 : 0) +
    (intent === "strategy" ? 2 : 0);

  return {
    text,
    norm,
    intent,
    confidence,
    scores,
    clauses: clauses.length ? clauses : [{ text, intent, score: scores[intent] }],
    students,
    ambiguousStudents: fromRoster.ambiguous,
    colleges,
    ambiguousColleges: fromCatalog.ambiguous,
    attributes,
    window: parseWindow(text, now, ctx.zone),
    form,
    judgement,
    keywords: keywordsOf(text),
    complexity,
  };
}

/** The entities to remember for the next turn's pronouns, newest first. */
export function nextState(u: Understanding, prev: DialogueState | null, chatStudent: { id: string; name: string } | null, now = new Date()): DialogueState {
  const merge = <T extends { id: string }>(fresh: T[], old: T[]) => {
    const seen = new Set<string>();
    return [...fresh, ...old].filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 5);
  };
  const students = u.students.filter((s) => s.via !== "pronoun").map(({ id, name }) => ({ id, name }));
  if (chatStudent) students.unshift(chatStudent);
  return {
    students: merge(students, prev?.students ?? []),
    colleges: merge(u.colleges.filter((c) => c.via !== "pronoun").map(({ id, name }) => ({ id, name })), prev?.colleges ?? []),
    at: now.toISOString(),
  };
}
