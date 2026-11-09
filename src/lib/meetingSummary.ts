// AI meeting-note summaries: a counselor pastes raw notes, the model drafts a
// summary and action items, the counselor reviews and files them. Nothing here
// stores anything: the draft is saved through `/notes` and the action items
// become tasks through `POST /tasks`, so RLS, limits and notifications apply.
//
// The model never reads a stored note (`meeting_notes.body` is deliberately off
// the AI allowlist): it sees only the text the counselor sent in this request,
// as an escaped data block, with no student name.
import { z } from "zod";
import { env } from "../env.js";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./context/pack.js";
import { FAKE_ALLOWED_ENVS } from "./research/bootGuard.js";
import { restoreSpeakers, type PreparedTranscript, type SpeakerLegend } from "./transcript.js";

export const MAX_RAW_NOTES = 20_000;
export const MAX_SUMMARY = 4000;
export const MAX_ACTION_ITEMS = 10;
export const MAX_ACTION_TITLE = 300;

export const meetingSummaryBody = z
  .object({
    studentId: z.string().uuid(),
    rawNotes: z.string().trim().min(20, "Paste a few lines of notes first").max(MAX_RAW_NOTES),
    meetingDate: z.string().date().optional(),
    /** Optional: old clients send none and get notes, as before. */
    kind: z.literal("notes").optional(),
  })
  .strict();

/** A transcript file travels as base64 in the JSON body: at most 2 MB of file. */
export const MAX_TRANSCRIPT_FILE_BASE64 = Math.ceil((2 * 1024 * 1024) / 3) * 4;

/**
 * `kind: "transcript"`: the pasted transcript in `rawNotes` (no 20,000 cap; the
 * length check after cleaning answers 413 `transcript_too_long`), or an
 * exported file in `file` ({ name, type?, data: base64 }), never both.
 */
export const transcriptSummaryBody = z
  .object({
    studentId: z.string().uuid(),
    kind: z.literal("transcript"),
    meetingDate: z.string().date().optional(),
    rawNotes: z.string().optional(),
    file: z
      .object({
        name: z.string().trim().min(1).max(255),
        type: z.string().max(120).optional(),
        data: z.string().min(1).max(MAX_TRANSCRIPT_FILE_BASE64),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => (b.rawNotes !== undefined) !== (b.file !== undefined), {
    message: "Paste the transcript or attach its file, not both",
  });

export type NotesBody = z.infer<typeof meetingSummaryBody> & { kind: "notes" };
export type TranscriptBody = z.infer<typeof transcriptSummaryBody>;

const kindOnly = z.object({ kind: z.enum(["notes", "transcript"]).optional() }).passthrough();

/** Which body this is, then that body's own strict schema. Throws a ZodError (the error handler's 400). */
export function parseSummaryBody(body: unknown): NotesBody | TranscriptBody {
  const { kind } = kindOnly.parse(body);
  if (kind === "transcript") return transcriptSummaryBody.parse(body);
  return { ...meetingSummaryBody.parse(body), kind: "notes" };
}

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
export function cleanSummary(
  value: unknown,
  rawNotes: string,
  opts: { speakerLabels?: boolean } = {}
): MeetingSummaryDraft {
  const parsed = modelOut.safeParse(value);
  if (!parsed.success) throw new Error("The summary came back in the wrong shape");

  const rawFigures = figures(rawNotes);
  const rawWords = contentWords(rawNotes);
  // A transcript's neutral labels ("Speaker 2") are not figures; every other number still must be in the text.
  const keep = (s: string) => keepSentence(opts.speakerLabels ? s.replace(/\bSpeaker \d+\b/g, "Speaker") : s, rawFigures);

  const sentences = squash(parsed.data.summary).match(/[^.!?]+[.!?]*/g) ?? [];
  const summary = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && keep(s))
    .join(" ")
    .slice(0, MAX_SUMMARY)
    .trim();
  if (!summary) throw new Error("The summary was empty");

  const seen = new Set<string>();
  const actionItems: ActionItem[] = [];
  for (const item of parsed.data.actionItems) {
    const title = squash(item.title).slice(0, MAX_ACTION_TITLE);
    const key = title.toLowerCase();
    if (!title || seen.has(key) || !keepItem(title, rawWords) || !keep(title)) continue;
    seen.add(key);
    const dueHint = item.dueHint ? squash(item.dueHint).slice(0, 80) : "";
    actionItems.push(dueHint ? { title, dueHint } : { title });
    if (actionItems.length >= MAX_ACTION_ITEMS) break;
  }

  return { summary, actionItems };
}

// ---------------------------------------------------------------------------
// Transcripts: one call per part, then one call that merges the parts
// ---------------------------------------------------------------------------

export const TRANSCRIPT_SUMMARY_SYSTEM = [
  MEETING_SUMMARY_SYSTEM,
  "These notes are a transcript of the meeting. Speakers are labelled Speaker 1, Speaker 2 and so on: refer to them by those labels and never guess who a label is.",
  "Leave out greetings, small talk and filler.",
].join("\n");

export const TRANSCRIPT_MERGE_SYSTEM = [
  "You merge summaries of consecutive parts of one meeting an independent college counselor held into one short record.",
  "Use only what the part summaries state. Invent no names, dates, numbers, scores or commitments.",
  "Write one summary in plain, neutral sentences a counselor could file as is. Do not mention parts, and do not repeat yourself.",
  "Combine the action items into one list: each once, repeats dropped.",
  "Speakers are labelled Speaker 1, Speaker 2 and so on: keep those labels and never guess who a label is.",
  UNTRUSTED_DATA_RULE,
].join("\n");

export function transcriptPartPrompt(chunk: string, index: number, total: number, meetingDate?: string): string {
  return [
    meetingDate ? `The meeting was on ${meetingDate}.` : "",
    total > 1
      ? `This is part ${index} of ${total} of one meeting's transcript. Summarize only this part; a later step merges the parts.`
      : "This is the meeting's transcript.",
    "Summarize it and list the action items.",
    wrapUntrusted("meeting-transcript", chunk),
  ]
    .filter(Boolean)
    .join("\n");
}

export function transcriptMergeText(parts: MeetingSummaryDraft[]): string {
  return parts
    .map((p, i) => {
      const items = p.actionItems.map((a) => `- ${a.title}${a.dueHint ? ` (${a.dueHint})` : ""}`).join("\n");
      return `Part ${i + 1} of ${parts.length}:\n${p.summary}\nAction items:\n${items || "(none)"}`;
    })
    .join("\n\n");
}

export function transcriptMergePrompt(parts: MeetingSummaryDraft[], meetingDate?: string): string {
  return [
    meetingDate ? `The meeting was on ${meetingDate}.` : "",
    "Merge these part summaries into one summary and one list of action items.",
    wrapUntrusted("meeting-part-summaries", transcriptMergeText(parts)),
  ]
    .filter(Boolean)
    .join("\n");
}

/** One model call of a transcript summary. In production it is `runStructured` (the AI switch, budget gate and ai_runs row per call). */
export type SummaryStep = {
  stage: "single" | "part" | "merge";
  index: number;
  total: number;
  system: string;
  prompt: string;
  maxTokens: number;
  /** The text this call summarizes (a part, or the part summaries). Only the fake reads it. */
  source: string;
  validate: (value: unknown) => MeetingSummaryDraft;
};
export type SummaryCall = (step: SummaryStep) => Promise<MeetingSummaryDraft>;

const PART_MAX_TOKENS = 1200;
const MERGE_MAX_TOKENS = 1500;

/** At most `max` characters, cut at a sentence end if one is near, else at a space: never mid-word. */
function clampWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence >= max * 0.8) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : text.slice(0, max)).trim();
}

function restoreDraft(draft: MeetingSummaryDraft, speakers: SpeakerLegend): MeetingSummaryDraft {
  return {
    summary: clampWords(restoreSpeakers(draft.summary, speakers).trim(), MAX_SUMMARY),
    actionItems: draft.actionItems.map((a) => {
      const title = clampWords(restoreSpeakers(a.title, speakers), MAX_ACTION_TITLE);
      return a.dueHint ? { title, dueHint: a.dueHint } : { title };
    }),
  };
}

/**
 * Summarize a prepared transcript: one call when it is one part; otherwise one
 * call per part (`concurrency` at a time) and a final merge call. Every answer,
 * the parts' and the merge's, goes through `cleanSummary` against the WHOLE
 * transcript's spoken words, so an invented figure dies wherever it appears.
 * The first failed call stops the run: no further part starts, nothing is
 * merged, the error goes to the caller, and nothing was stored. Speaker labels
 * become names only in the returned draft.
 */
export async function summarizeTranscript(
  prepared: PreparedTranscript,
  opts: { call: SummaryCall; meetingDate?: string; concurrency?: number }
): Promise<{ draft: MeetingSummaryDraft; calls: number }> {
  const validate = (value: unknown) => cleanSummary(value, prepared.source, { speakerLabels: true });
  let calls = 0;
  const call: SummaryCall = (step) => {
    calls++;
    return opts.call(step);
  };
  const total = prepared.chunks.length;

  if (total === 1) {
    const draft = await call({
      stage: "single",
      index: 1,
      total: 1,
      system: TRANSCRIPT_SUMMARY_SYSTEM,
      prompt: transcriptPartPrompt(prepared.chunks[0]!, 1, 1, opts.meetingDate),
      maxTokens: PART_MAX_TOKENS,
      source: prepared.chunks[0]!,
      validate,
    });
    return { draft: restoreDraft(draft, prepared.speakers), calls };
  }

  const parts: MeetingSummaryDraft[] = new Array(total);
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < total) {
      const i = next++;
      try {
        parts[i] = await call({
          stage: "part",
          index: i + 1,
          total,
          system: TRANSCRIPT_SUMMARY_SYSTEM,
          prompt: transcriptPartPrompt(prepared.chunks[i]!, i + 1, total, opts.meetingDate),
          maxTokens: PART_MAX_TOKENS,
          source: prepared.chunks[i]!,
          validate,
        });
      } catch (err) {
        if (failure === null) failure = { err };
      }
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? 3, total));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure !== null) throw (failure as { err: unknown }).err;

  const merged = await call({
    stage: "merge",
    index: total + 1,
    total,
    system: TRANSCRIPT_MERGE_SYSTEM,
    prompt: transcriptMergePrompt(parts, opts.meetingDate),
    maxTokens: MERGE_MAX_TOKENS,
    source: parts.map((p) => p.summary).join(" "),
    validate,
  });
  return { draft: restoreDraft(merged, prepared.speakers), calls };
}

// ---------------------------------------------------------------------------
// The test double: MEETING_SUMMARY_FAKE=fixture (development and test only)
// ---------------------------------------------------------------------------

export type MeetingSummaryFakeEnv = { MEETING_SUMMARY_FAKE?: string | undefined; NODE_ENV?: string | undefined };

/** A message for index.ts to refuse to start with, or null: the fake would file text no model wrote. */
export function meetingSummaryFakeRefusal(e: MeetingSummaryFakeEnv): string | null {
  if (!e.MEETING_SUMMARY_FAKE) return null;
  if (e.NODE_ENV === "production") {
    return "refusing to start: MEETING_SUMMARY_FAKE is for tests only and must not be set when NODE_ENV=production";
  }
  if (e.NODE_ENV === undefined || !FAKE_ALLOWED_ENVS.includes(e.NODE_ENV)) {
    return "refusing to start: MEETING_SUMMARY_FAKE is for tests only and needs NODE_ENV=development or NODE_ENV=test";
  }
  return null;
}

export function meetingSummaryFakeOn(): boolean {
  return !!env.MEETING_SUMMARY_FAKE && meetingSummaryFakeRefusal({ MEETING_SUMMARY_FAKE: env.MEETING_SUMMARY_FAKE, NODE_ENV: process.env.NODE_ENV }) === null;
}

/**
 * The fake model: a part's answer is its first line ("Speaker 1 said: ..."), the
 * merge's is the part answers joined. It still goes through `validate`, so the
 * checks run exactly as on a model's answer. No model, no budget.
 */
export const fakeSummaryCall: SummaryCall = async (step) => {
  if (step.stage === "merge") return step.validate({ summary: step.source, actionItems: [] });
  const first = (step.source.split("\n").find((l) => l.trim()) ?? "").slice(0, 600);
  const summary = first.replace(/^(Speaker \d+): /, "$1 said: ");
  return step.validate({ summary, actionItems: [] });
};
