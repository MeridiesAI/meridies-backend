/**
 * The system prompts of the AI tools a student may now run (Build College Lists' chat bar, and, in later steps,
 * Coherence and Activities Build), written for the person reading the answer. A student's version changes who
 * the words are addressed to and nothing else: the same fixed set of actions or the same structured output, the
 * same rules in code that check the model's answer. Pure, so a test can read them.
 */

import { NO_PROSE_SYSTEM, isAdviceNotProse } from "./anthropic.js";
import { UNTRUSTED_DATA_RULE } from "./context/pack.js";
import { isNarrativeSentence } from "./proseGuard.js";

export type Audience = "counselor" | "student";

/** Build College Lists > Ask AxIS: one structured change to the form. The model never picks schools. */
export function listChatSystem(audience: Audience): string {
  const student = audience === "student";
  return [
    `You turn ${student ? "a student's request about their college list" : "a counselor's request about a college list"} into ONE structured change. You do not pick schools yourself: a deterministic filter does.`,
    "Actions: refresh (show the next schools in each band), more / fewer (schools per band), closer / farther (halve or double the radius, or set miles), test-optional, set (change majors, sizes, settings, aid, diversity, testOptional), exclude (remove named schools), none (only answer).",
    `Sizes: Small, Medium, Large, Very large. Settings: Rural, Small city, Major city, Suburban, College town. Aid: No preference, Lenient, Limited. Diversity: No preference, Yes, No.`,
    `points: one to three short bullets saying what changed, addressed to the ${audience}. If the request can't be done with these actions, use none and say what you can do.`,
  ].join("\n");
}

// ---- Narrative Coherence ----

/**
 * The essay guardrail's standing rules (lib/anthropic.ts NO_PROSE_SYSTEM) for the person reading the answer. The
 * counselor's is the constant itself; the student's is the same rules with the one phrase that names the
 * counselor's voice turned to the student: "addressed to the student, as a coach would".
 */
export function noProseSystemFor(audience: Audience): string {
  return audience === "counselor"
    ? NO_PROSE_SYSTEM
    : NO_PROSE_SYSTEM.replace("in the counselor's voice", "addressed to the student, as a coach would (you, your)");
}

/** The Coherence report's system prompt. The counselor's is word for word what it was before students could run it. */
export function coherenceSystem(audience: Audience): string {
  const student = audience === "student";
  return [
    noProseSystemFor(audience),
    "",
    student
      ? "You read the parts of one college application side by side, for the student who wrote them."
      : "You read the parts of one college application side by side, for the student's counselor.",
    "Storyline: three short bullets labelled Origin, Through-line, Landing: where the story starts, what carries it, where it should end.",
    "Flags: contradictions and gaps between the documents (dates, roles, hours, claims that disagree), most serious first. Name both places each one sits.",
    "Fix: what the student should settle or decide, never the words to write.",
    student ? "Next: up to three bullets on what the student does next." : "Next: up to three bullets on what the counselor does next.",
    student
      ? "Address the student directly (you, your). Never write as the student, and never in the first person."
      : "Address the counselor; the student's name is in the student record below.",
    UNTRUSTED_DATA_RULE,
  ].join("\n");
}

/** The report popup's follow-up chat. */
export function coherenceAskSystem(audience: Audience): string {
  return [
    noProseSystemFor(audience),
    "",
    `Answer the ${audience}'s question about this Narrative Coherence report only, in at most four bullets.`,
    "If the report doesn't say, answer that it doesn't.",
    UNTRUSTED_DATA_RULE,
  ].join("\n");
}

/** The last "next step" on a report: the counselor assigns tasks, the student takes it to their meeting. */
export function coherenceNext(audience: Audience, first: string): string {
  return audience === "student"
    ? "Take this report to your next meeting with your counselor."
    : `Bring the report to ${first}'s next meeting and assign each fix as a task with a word budget.`;
}

/** A request for wording is answered with questions, not words, and no model call. */
export function rewriteRefusal(audience: Audience, first: string): string[] {
  return audience === "student"
    ? [
        "I won't write wording for your essays; the words have to be yours.",
        "Ask yourself: which moment in your statement is the true start of this interest?",
        "Ask yourself: what does each supplement add that your statement doesn't already say?",
      ]
    : [
        "I won't write wording for the essays; the words have to be the student's.",
        `Ask ${first}: which moment in the statement is the true start of this interest?`,
        `Ask ${first}: what does the supplement add that the statement doesn't already say?`,
      ];
}

/**
 * What a student may be shown: the existing shape test (short, at most two sentences) AND nothing in the student's
 * own voice (first person addressed to nobody, which is how an essay reads). Their report speaks TO them, so a
 * bullet that sounds like them speaking is the model drifting toward the essay, and it is dropped. A shape test,
 * not a judgement: it is a second layer behind the prompt, not a guarantee.
 */
export const isStudentSafe = (text: string): boolean => isAdviceNotProse(text) && !isNarrativeSentence(text.trim());

export const studentSafeBullets = (bullets: string[]): string[] => bullets.map((b) => b.trim()).filter(isStudentSafe);

// ---- Activities Build ----

/**
 * The Activities Build system prompt. The counselor's is word for word what it was before students could run it
 * (the shared base lines, then the tool's own); the student's changes who it is written for and who reviews the
 * answer: the student checks each program on its own site before applying, and `whyFit` is written to them.
 */
export function activitiesSystem(audience: Audience, ctx: { onlineOnly: boolean; miles: number; near: string | null }): string {
  const student = audience === "student";
  return [
    student ? "You help a high school student find activities, programs and opportunities." : "You support independent college counselors at Meridies.",
    "Be concrete, specific to this student, and honest about uncertainty.",
    "Never invent statistics, deadlines, or admissions outcomes. If you don't know, say so.",
    student ? "The student checks each program on its own website before applying." : "The counselor reviews everything before a family sees it.",
    "Recommend real, named programs, jobs, labs and volunteer roles the student can actually sign up for.",
    "If you are not confident a program currently exists and is open to high school students, leave it out. A short honest list beats a long invented one.",
    "Give the host's official https address only when you are sure of it; otherwise leave url out.",
    'Deadlines: say what the host publishes ("Early spring", "Rolling"), never a guessed date.',
    ...(student ? ["Write whyFit to the student (you, your), in one short sentence that points at something already in their record."] : []),
    ctx.onlineOnly ? "Only online programs." : `In person within about ${ctx.miles} miles of ${ctx.near}, plus online ones when the format allows.`,
  ].join("\n");
}

/** The free-text note a person adds to a search, labelled as theirs in the prompt. */
export const activitiesNote = (audience: Audience, text: string): string => `${audience === "student" ? "Student's" : "Counselor's"} note: ${text}`;
