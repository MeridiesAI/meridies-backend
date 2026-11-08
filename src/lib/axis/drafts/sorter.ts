/**
 * While an activity draft is open, code sorts each counselor message into the draft or not (spec 4.1).
 *
 * A message continues the draft when it is a cancel, continue or yes word, carries an activity value ("grade 11",
 * "6hr", "summer"), names one of the draft's organizations or positions, starts with a correction ("actually",
 * "make it"), is a change request, or scores no intent at all (a bare list of details, "i gave it"). Anything else
 * is unrelated: answered as usual, and it can't change the draft. Essay requests are always unrelated, so they keep
 * the essay route. The table in test/unit/axis-draft-sorter.test.ts pins the rule; tune it there.
 */
import { COLLEGE_ATTRIBUTES } from "../lexicon.js";
import type { Understanding } from "../nlu.js";
import { freeTextKey, hasActivityValue } from "./normalize.js";
import type { Draft } from "./state.js";

export type Verdict = "cancel" | "continue" | "draft" | "unrelated";

/** The whole message, lowercased, without trailing punctuation or a trailing "please". */
const whole = (text: string) =>
  text.toLowerCase().replace(/[’]/g, "'").replace(/[.!?\s]+$/g, "").replace(/\s+/g, " ").trim().replace(/,? please$/, "").trim();

const CANCEL = /^(?:please )?(?:cancel|never ?mind|forget (?:it|that|about it)|stop|drop (?:it|that)|don'?t add (?:it|that|them)|scrap (?:it|that))(?: (?:it|that|the draft|the activity|this|please))*$/;
const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|start again|do it|please do|yes please)$/;
const CONTINUE = /^(?:continue|keep going|go on|resume|let'?s continue|back to (?:the|my) (?:draft|activity|activities))$/;
const FILE_NOW = /\b(?:add (?:it|them)|that'?s (?:all|it|everything)|file it|save (?:it|them))\b/;
const CORRECTION = /^(?:actually|no\b|wait|make it|change|sorry|correction|oops|i meant)/;

export const isCancel = (text: string) => CANCEL.test(whole(text));
export const isYes = (text: string) => YES.test(whole(text));
export const isContinue = (text: string) => CONTINUE.test(whole(text));
export const isFileNow = (text: string) => FILE_NOW.test(text.toLowerCase().replace(/[’]/g, "'"));
export const isCorrection = (text: string) => CORRECTION.test(text.toLowerCase().trim());

/** The message names one of the draft's organizations or positions (whole words, at least 3 characters). */
function namesDraft(text: string, draft: Draft): boolean {
  const key = ` ${freeTextKey(text)} `;
  return draft.rows.some((r) =>
    [r.fields.organization, r.fields.position].some((v) => {
      const k = typeof v === "string" ? freeTextKey(v) : "";
      return k.length >= 3 && key.includes(` ${k} `);
    })
  );
}

export function sortMessage(text: string, u: Pick<Understanding, "intent" | "scores"> & Partial<Pick<Understanding, "attributes">>, draft: Draft): Verdict {
  if (isCancel(text)) return "cancel";
  if (isContinue(text)) return "continue";
  if (u.intent === "essay") return "unrelated";
  // A college matched by a place name in the details ("the Santa Clara library") is no question about a college.
  const asksCollege = (u.attributes ?? []).some((a) => COLLEGE_ATTRIBUTES.has(a));
  const nothingScored = Object.entries(u.scores).every(([k, s]) => s <= 0 || (k === "colleges" && !asksCollege));
  if (isYes(text) || hasActivityValue(text) || namesDraft(text, draft) || isCorrection(text) || u.intent === "action" || nothingScored) return "draft";
  return "unrelated";
}
