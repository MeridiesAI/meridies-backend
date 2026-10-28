// AI meeting-note summaries: a counselor pastes raw notes, the model drafts a
// summary and action items, the counselor reviews and files them. Nothing here
// stores anything: the draft is saved through `/notes` and the action items
// become tasks through `POST /tasks`, so RLS, limits and notifications apply.
//
// The model never reads a stored note (`meeting_notes.body` is deliberately off
// the AI allowlist): it sees only the text the counselor sent in this request,
// as an escaped data block, with no student name.
import { z } from "zod";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./context/pack.js";

export const MAX_RAW_NOTES = 20_000;
export const MAX_SUMMARY = 4000;
export const MAX_ACTION_ITEMS = 10;
export const MAX_ACTION_TITLE = 300;

export const meetingSummaryBody = z
  .object({
    studentId: z.string().uuid(),
    rawNotes: z.string().trim().min(20, "Paste a few lines of notes first").max(MAX_RAW_NOTES),
    meetingDate: z.string().date().optional(),
  })
  .strict();

export const MEETING_SUMMARY_SYSTEM = [
  "You turn an independent college counselor's raw meeting notes into a short record.",
  "Summarize only what the notes state. Invent no names, dates, numbers, scores or commitments.",
  "Write the summary in plain, neutral sentences a counselor could file as is. It is not an essay and not a message to the family.",
  "List an action item only when the notes say, or clearly imply, that someone will do something. Phrase each as a short task.",
  "If the notes hold nothing to act on, return no action items.",
  UNTRUSTED_DATA_RULE,
].join("\n");

export const MEETING_SUMMARY_TOOL = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: 3800 },
    actionItems: {
      type: "array",
      maxItems: MAX_ACTION_ITEMS,
      items: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 200 },
          dueHint: { type: "string", maxLength: 80 },
        },
        required: ["title"],
      },
    },
  },
  required: ["summary", "actionItems"],
} as const;

const modelOut = z.object({
  summary: z.string(),
  actionItems: z
    .array(z.object({ title: z.string(), dueHint: z.string().optional() }))
    .default([]),
});

export type ActionItem = { title: string; dueHint?: string };
export type MeetingSummaryDraft = { summary: string; actionItems: ActionItem[] };

/** The prompt: the counselor's text as one escaped data block, never inlined. */
export function summaryPrompt(rawNotes: string, meetingDate?: string): string {
  return [
    meetingDate ? `The meeting was on ${meetingDate}.` : "",
    "Summarize these notes and list the action items.",
    wrapUntrusted("meeting-notes", rawNotes),
  ]
    .filter(Boolean)
    .join("\n");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const figures = (s: string) => new Set(s.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]+$/, "")) ?? []);
const contentWords = (s: string) =>
  new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

/**
 * A sentence that states a figure the notes never did (a score, a date, a
 * count) is dropped rather than filed under the counselor's name.
 */
function keepSentence(sentence: string, raw: Set<string>): boolean {
  for (const n of figures(sentence)) if (!raw.has(n)) return false;
  return true;
}

/** An action item must share a real word with the notes, or the model made it up. */
function keepItem(title: string, rawWords: Set<string>): boolean {
  for (const w of contentWords(title)) if (rawWords.has(w)) return true;
  return false;
}

/**
 * The last line of defence over the model's answer. Throws on a malformed
 * answer or an empty summary (the route answers 502 and nothing is filed);
 * otherwise returns a clamped, de-duplicated draft.
 */
export function cleanSummary(value: unknown, rawNotes: string): MeetingSummaryDraft {
  const parsed = modelOut.safeParse(value);
  if (!parsed.success) throw new Error("The summary came back in the wrong shape");

  const rawFigures = figures(rawNotes);
  const rawWords = contentWords(rawNotes);

  const sentences = squash(parsed.data.summary).match(/[^.!?]+[.!?]*/g) ?? [];
  const summary = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && keepSentence(s, rawFigures))
    .join(" ")
    .slice(0, MAX_SUMMARY)
    .trim();
  if (!summary) throw new Error("The summary was empty");

  const seen = new Set<string>();
  const actionItems: ActionItem[] = [];
  for (const item of parsed.data.actionItems) {
    const title = squash(item.title).slice(0, MAX_ACTION_TITLE);
    const key = title.toLowerCase();
    if (!title || seen.has(key) || !keepItem(title, rawWords) || !keepSentence(title, rawFigures)) continue;
    seen.add(key);
    const dueHint = item.dueHint ? squash(item.dueHint).slice(0, 80) : "";
    actionItems.push(dueHint ? { title, dueHint } : { title });
    if (actionItems.length >= MAX_ACTION_ITEMS) break;
  }

  return { summary, actionItems };
}
