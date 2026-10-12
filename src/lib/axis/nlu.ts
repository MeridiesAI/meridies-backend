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
import { parseWindow, type DateWindow } from "./dates.js";
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

export type { Intent, Attribute };

export type DialogueState = {
  students: { id: string; name: string }[];
  colleges: { id: string; name: string }[];
  at: string;
  /** The last turn read outside content: its answer is in the next turn's history, so that turn's changes wait for a click too. */
  outside?: boolean;
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

export function understand(text: string, ctx: UnderstandContext): Understanding {
  const now = ctx.now ?? new Date();
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
    window: parseWindow(text, now),
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
