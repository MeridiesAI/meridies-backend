// A meeting transcript, cleaned for the meeting-summary model: WebVTT, SRT or
// pasted text to speaker turns, speaker names swapped for neutral labels, and
// the result cut into parts for the map-reduce in lib/meetingSummary.ts.
//
// Pure: no I/O, no logging. Transcript text is never logged anywhere.
//
// Speaker names. The meeting-summary rule is that no student name is sent to
// the model by the server; the counselor's own words go as typed. A speaker
// label is not something the counselor typed: Zoom, Meet and Teams write each
// participant's display name (often a full name, sometimes an email) on every
// cue. So labels are treated like a name from the record: each distinct one
// becomes "Speaker 1", "Speaker 2", ... in order of first appearance, and only
// the answer to the counselor maps them back (`restoreSpeakers`). Names said
// inside the spoken text pass through, exactly as names in pasted notes do.
import { decodeEntities } from "./documentText.js";
import { HttpError } from "./errors.js";

/** Most pasted or file text accepted before cleaning (timestamps and cue numbers roughly double a transcript). */
export const MAX_RAW_TRANSCRIPT = 600_000;
/** Most cleaned transcript summarized: about three hours of talk. */
export const MAX_TRANSCRIPT = 200_000;
/** Fewest spoken characters worth a summary. */
export const MIN_TRANSCRIPT = 20;
/** A part is at most this long. */
export const CHUNK_LIMIT = 15_000;
/** Past this a part closes at the next speaker turn rather than mid-turn. */
export const SOFT_BREAK = 14_000;
/** A sentence longer than this (unpunctuated auto-captions) is cut at a space. */
export const MAX_PIECE = 1_000;
/**
 * Most parts, so most model calls is MAX_CHUNKS + 1 (the merge). Every part
 * but the last holds more than CHUNK_LIMIT - MAX_PIECE - a label, so a
 * transcript at MAX_TRANSCRIPT needs at most 15.
 */
export const MAX_CHUNKS = 15;

export type Turn = { speaker: string | null; text: string };
export type SpeakerLegend = { label: string; name: string }[];
export type PreparedTranscript = {
  /** What the model may read: neutral labels, one turn a line. */
  text: string;
  /** The spoken words only (no labels): what a figure in the answer must come from. */
  source: string;
  turns: Turn[];
  speakers: SpeakerLegend;
  chunks: string[];
};

export const transcriptTooLong = (chars?: number) =>
  new HttpError(
    413,
    `That transcript is too long to summarize at once${chars ? ` (about ${chars.toLocaleString("en-US")} characters once cleaned)` : ""}. The most is ${MAX_TRANSCRIPT.toLocaleString("en-US")} characters, about three hours of talk: split it and summarize each part.`,
    "transcript_too_long"
  );

const TIMING = /^\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->/;
const LEADING_TIME = /^[[(]?(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?[\])]?\s+/;
const OTTER_HEADER = /^(.{1,40}?)(?:\s{2,}|\t+)(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
const LABEL_PREFIX = /^([^:]{1,80}?):\s+(.+)$/;
const LABEL_CHARS = /^[\p{L}\p{M}\d .'’\-()&/@_]+$/u;
/** What a caption tool may write in a display name: commas, (nested) parentheses, [brackets], emails with "+", | – — ·. */
const WIDE_LABEL_CHARS = /^[\p{L}\p{M}\d .,'’\-()[\]&/@_+|–—·]+$/u;
/** A token that is only punctuation ("-", "&", "|", "–", "·"): a separator inside a display name, not a word. */
const SEPARATOR = /^[-&/+|–—·]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Lower-case words a capitalised name may hold (de la Cruz, van der Berg, bin Salman). */
const PARTICLES = new Set(["de", "da", "del", "della", "di", "du", "dos", "das", "van", "von", "der", "den", "la", "le", "bin", "binti", "al", "el", "y", "e"]);
const NOT_SPEAKERS = new Set([
  "note", "notes", "nb", "ps", "re", "subject", "date", "time", "when", "where", "agenda", "summary", "action",
  "actions", "action items", "todo", "to do", "update", "question", "answer", "q", "a", "fyi", "important",
  "reminder", "warning", "tip", "example", "next steps", "takeaway", "takeaways", "goal", "goals", "result",
  "results", "status", "deadline", "deadlines", "location", "attendees", "topic", "topics", "decision", "decisions",
  "remember", "total", "totals", "key point", "key points", "follow up", "follow-up", "follow ups", "follow-ups",
  "open question", "open questions", "action item", "yes", "no", "wait", "ok", "okay", "so", "also", "but", "and",
  "then", "now", "today", "tomorrow", "yesterday", "tonight", "next", "first", "second", "third", "finally", "update",
  "updates", "plan", "plans", "issue", "issues", "problem", "problems", "idea", "ideas", "pros", "cons", "why", "how",
  "what", "who", "price", "cost", "score", "scores", "grade", "grades", "link", "links", "email", "phone", "address",
]);
/** "Step 1", "Q2", "Option 3", "Part 4": numbered prose headings, never a speaker. */
const NUMBERED_HEADING = /^(?:step|option|part|item|phase|round|point|question|answer|q|a|day|week)\s*\d{1,3}$/i;
const CALENDAR_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu",
  "thur", "thurs", "fri", "sat", "sun", "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
  "oct", "nov", "dec", "summer", "fall", "autumn", "winter", "spring",
]);

const keyOf = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

/** A whole label that is a prose heading ("Note", "Step 1", "Friday"), never a speaker. Whole-label match only. */
function isStopLabel(s: string): boolean {
  const k = keyOf(s);
  return NOT_SPEAKERS.has(k) || NUMBERED_HEADING.test(k) || CALENDAR_WORDS.has(k);
}

function isLabel(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 1 || s.length > 40) return false;
  if (!/^\p{L}/u.test(s) || !LABEL_CHARS.test(s)) return false;
  if (s.split(/\s+/).length > 5) return false;
  return !isStopLabel(s);
}

/** "Last, First" (each part one or two capitalised words): the shape a roster export writes. */
function isCommaName(s: string): boolean {
  return /^\p{Lu}[\p{L}\p{M}'’-]*(?: \p{Lu}[\p{L}\p{M}'’.-]*)?, \p{Lu}[\p{L}\p{M}'’.-]*(?: \p{Lu}[\p{L}\p{M}'’.-]*){0,2}$/u.test(s.trim());
}

/** Every word, outside parentheses and around commas, is capitalised, a name particle, or a number: a name, not a sentence. */
function isNameShaped(s: string): boolean {
  let core = s;
  // Parentheses out, innermost first (a label is at most 80 characters, so three passes cover any nesting it holds).
  for (let i = 0; i < 3; i++) core = core.replace(/\([^()]{0,80}\)/g, " ");
  core = core.replace(/[[\],]/g, " ");
  const words = core.split(/\s+/).filter((w) => w && !SEPARATOR.test(w) && w.toLowerCase() !== "and");
  if (!words.length || words.length > 6) return false;
  return words.every((w) => /^\p{Lu}/u.test(w) || PARTICLES.has(w.toLowerCase()) || /^\d+$/.test(w) || /^\p{Lo}/u.test(w));
}

/** Words of a label, separators left out: what the five-word short-label rule counts. */
const labelWords = (s: string) => s.split(/\s+/).filter((w) => w && !SEPARATOR.test(w));

/**
 * A caption cue's leading "label:" (VTT/SRT only). Meeting tools write a
 * participant's display name there, which can be "Chen, Maya", "Maya Chen
 * (Lincoln High School student)" or an email, so the bound is 80 characters
 * of a wider set, with no word cap. Accepted on the first cue when it is short
 * (five words or fewer, separators not counted), name-shaped (above) or an
 * email; a longer label that isn't name-shaped only when it starts two or more
 * cues (`repeated`), so "Here is the plan for October: retake the SAT" stays
 * text. HEURISTIC: a label that fails every rule and starts one cue reaches the
 * model as text.
 * Never a stoplisted word ("Note"), never ending in "!" or "?", and a final "."
 * only on a short abbreviation ("Jr.", "M.").
 */
function isTimedLabel(raw: string, repeated: boolean): boolean {
  const s = raw.trim();
  if (s.length < 1 || s.length > 80) return false;
  if (!/^[\p{L}[(]/u.test(s) || !WIDE_LABEL_CHARS.test(s)) return false;
  if (isStopLabel(s) || isStopLabel(s.replace(/^\[|\]$/g, ""))) return false;
  if (/[!?]$/.test(s)) return false;
  if (s.endsWith(".") && (s.split(/\s+/).at(-1)?.length ?? 0) > 4) return false;
  // Speaker labels never reaching the model outranks a short prose heading read as a name: a short label
  // (five words or fewer, separators not counted) is a speaker on its first cue, like any name or email.
  if (labelWords(s).length <= 5 || EMAIL.test(s) || isNameShaped(s)) return true;
  // Longer and not name-shaped ("So the thing we decided on is this"): only when it starts two or more cues.
  return repeated;
}

/**
 * Tags out in one pass: a "<" that starts a tag (a letter, "/", "." or a digit
 * for a timestamp) up to its ">" within 200 characters. "a < b" stays text.
 */
function stripTags(s: string): string {
  let out = "";
  let pos = 0;
  let i = s.indexOf("<");
  while (i >= 0) {
    // The ">" is looked for in the next 200 characters only, so a line of "<" with no ">" stays linear.
    const window = /[\p{L}/.\d]/u.test(s.charAt(i + 1)) ? s.slice(i + 1, i + 201) : "";
    const rel = window.indexOf(">");
    const gt = rel >= 0 ? i + 1 + rel : -1;
    const lt = rel >= 0 ? window.indexOf("<") : -1;
    if (gt > 0 && (lt < 0 || lt > rel)) {
      out += s.slice(pos, i);
      pos = gt + 1;
      i = s.indexOf("<", pos);
    } else {
      i = s.indexOf("<", i + 1);
    }
  }
  return pos === 0 ? s : out + s.slice(pos);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** One line of caption or pasted text: the voice tag's speaker, and the text with markup and entities gone. */
function cleanLine(line: string): { voice: string | null; text: string } {
  const v = /<v(?:\.[^\s>]{0,40})?\s+([^>]{1,200})>/.exec(line);
  let text = line.replace(/\{\\[^}]{0,40}\}/g, "");
  text = stripTags(text);
  text = text.replace(/&nbsp;/gi, " ").replace(/&lrm;|&rlm;/gi, "");
  text = decodeEntities(text).replace(/[ ‎‏]/g, " ");
  text = squash(text).replace(/^-\s+/, "");
  return { voice: v ? squash(decodeEntities(v[1]!)) || null : null, text };
}

/** The text's leading "label: rest", when `accept` says the label is a speaker. */
function labelOf(text: string, accept: (label: string) => boolean): { label: string; rest: string } | null {
  const m = LABEL_PREFIX.exec(text);
  if (!m || !accept(m[1]!.trim())) return null;
  return { label: m[1]!.trim(), rest: m[2]!.trim() };
}

class TurnBuilder {
  turns: Turn[] = [];
  private lines: string[] = [];
  private speaker: string | null = null;
  private open = false;

  add(speaker: string | null, text: string, mergeNull: boolean) {
    const same = this.open && (speaker === null ? this.speaker === null && mergeNull : this.speaker !== null && keyOf(this.speaker) === keyOf(speaker));
    if (!same) this.flush();
    if (!this.open) {
      this.open = true;
      this.speaker = speaker;
      this.lines = [];
    }
    const last = this.lines.at(-1);
    if (last !== undefined) {
      if (text === last) return;
      // A rolling caption that extends the line before it keeps only the longer line.
      if (text.startsWith(last + " ")) {
        this.lines[this.lines.length - 1] = text;
        return;
      }
    }
    this.lines.push(text);
  }

  lastText(): string | undefined {
    return this.open ? this.lines.at(-1) : undefined;
  }

  flush() {
    if (this.open && this.lines.length) this.turns.push({ speaker: this.speaker, text: this.lines.join(" ") });
    this.open = false;
    this.lines = [];
    this.speaker = null;
  }
}

function parseTimed(lines: string[]): Turn[] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) blocks.push(cur);

  const cues = blocks
    .filter((block) => {
      const first = block[0]!.trim();
      return !/^WEBVTT/.test(first) && !/^(NOTE|STYLE|REGION)(\s|$)/.test(first);
    })
    .map((block) => {
      const at = block.findIndex((l) => l.includes("-->"));
      const textLines = at >= 0 ? block.slice(at + 1) : block.filter((l) => !/^\s*\d+\s*$/.test(l));
      return textLines.map((raw) => cleanLine(raw));
    });

  // How often each candidate label starts a line: a short label repeated across cues is a speaker.
  const counts = new Map<string, number>();
  for (const lines of cues) {
    for (const { voice, text } of lines) {
      const m = voice ? null : LABEL_PREFIX.exec(text);
      if (m) counts.set(keyOf(m[1]!), (counts.get(keyOf(m[1]!)) ?? 0) + 1);
    }
  }
  const accept = (label: string) => isTimedLabel(label, (counts.get(keyOf(label)) ?? 0) >= 2);

  const b = new TurnBuilder();
  let speaker: string | null = null;
  let prevCue = new Set<string>();
  // A line is a repeat only when the same speaker said it in this cue or the one before.
  const said = (who: string | null, line: string) => `${who === null ? "" : keyOf(who)}\u0000${line}`;
  for (const lines of cues) {
    const thisCue = new Set<string>();
    for (const { voice, text } of lines) {
      let line = text;
      if (voice) speaker = voice;
      else {
        const lab = labelOf(line, accept);
        if (lab) {
          speaker = lab.label;
          line = lab.rest;
        }
      }
      if (!line) continue;
      const key = said(speaker, line);
      const seen = prevCue.has(key) || thisCue.has(key);
      thisCue.add(key);
      // Auto-captions repeat the previous cue's lines; a line the same speaker already showed is dropped.
      if (seen) continue;
      b.add(speaker, line, true);
    }
    if (thisCue.size) prevCue = thisCue;
  }
  b.flush();
  return b.turns;
}

function parsePlain(lines: string[]): Turn[] {
  // An Otter-style "Name  0:03" header is read before spacing is squashed; it stays a header line.
  const headers = lines.map((l) => {
    const h = OTTER_HEADER.exec(l.trim());
    return h && isLabel(h[1]!) ? h[1]!.trim() : null;
  });
  const stripped = lines.map((l, i) => (headers[i] ? "" : cleanLine(l).text.replace(LEADING_TIME, "")));
  // In free text a "Word:" is a speaker only when the same label starts two or more lines, and it is either the
  // short label shape (five words, no comma) or "Last, First". Anything else with a colon stays prose.
  const plainLabel = (label: string) => isLabel(label) || (isCommaName(label) && !NOT_SPEAKERS.has(keyOf(label)));
  const counts = new Map<string, number>();
  for (const l of stripped) {
    const lab = labelOf(l, plainLabel);
    if (lab) counts.set(keyOf(lab.label), (counts.get(keyOf(lab.label)) ?? 0) + 1);
  }
  const b = new TurnBuilder();
  let speaker: string | null = null;
  for (const [i, l] of stripped.entries()) {
    const header = headers[i];
    if (header) {
      b.flush();
      speaker = header;
      continue;
    }
    if (!l) {
      b.flush();
      speaker = null;
      continue;
    }
    const lab = labelOf(l, plainLabel);
    if (lab && (counts.get(keyOf(lab.label)) ?? 0) >= 2) {
      speaker = lab.label;
      b.add(speaker, lab.rest, false);
      continue;
    }
    b.add(speaker, l, false);
  }
  b.flush();
  return b.turns;
}

/** WebVTT, SRT or pasted text to speaker turns, with every caption artefact removed. */
export function parseTranscript(raw: string): Turn[] {
  const text = raw.replace(/﻿/g, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const firstReal = lines.find((l) => l.trim() !== "") ?? "";
  const timed = /^WEBVTT/.test(firstReal.trim()) || lines.some((l) => TIMING.test(l));
  const turns = timed ? parseTimed(lines) : parsePlain(lines);
  return turns.filter((t) => t.text.length > 0);
}

/** Each distinct speaker becomes "Speaker N" in order of first appearance (case and spacing ignored). */
export function neutralizeSpeakers(turns: Turn[]): { turns: Turn[]; speakers: SpeakerLegend } {
  const byKey = new Map<string, string>();
  const speakers: SpeakerLegend = [];
  const out = turns.map((t) => {
    if (t.speaker === null) return { speaker: null, text: t.text };
    const k = keyOf(t.speaker);
    let label = byKey.get(k);
    if (!label) {
      label = `Speaker ${speakers.length + 1}`;
      byKey.set(k, label);
      speakers.push({ label, name: t.speaker });
    }
    return { speaker: label, text: t.text };
  });
  return { turns: out, speakers };
}

/** The model's "Speaker N" back to the name the transcript gave, for the counselor's eyes only. */
export function restoreSpeakers(text: string, speakers: SpeakerLegend): string {
  if (!speakers.length) return text;
  return text.replace(/\bSpeaker (\d+)\b/g, (m, n: string) => speakers[Number(n) - 1]?.name ?? m);
}

export function renderTurns(turns: Turn[]): string {
  return turns.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join("\n");
}

/** Sentences, cut after . ! or ? (and any closing quote or bracket) that a space follows. */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    let j = i + 1;
    while (j < text.length && /["'”’)\]]/.test(text[j]!)) j++;
    if (j < text.length && text[j] === " ") {
      out.push(text.slice(start, j));
      start = j + 1;
      i = j;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter(Boolean);
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Parts for the map step: whole sentences packed up to `limit`, a new part
 * preferring a speaker turn once past `soft`. A part that starts mid-turn
 * repeats the speaker's label so the model knows who is talking. Nothing is
 * dropped or repeated: joined back, the parts are the turns' words in order.
 */
export function chunkTurns(turns: Turn[], limit = CHUNK_LIMIT, soft = SOFT_BREAK, maxPiece = MAX_PIECE): string[] {
  const chunks: string[] = [];
  let cur = "";
  let lastTurn = -1;
  turns.forEach((t, ti) => {
    const label = t.speaker ? `${t.speaker}: ` : "";
    for (const sentence of sentences(t.text)) {
      for (const piece of hardSplit(sentence, maxPiece)) {
        const continuing = cur !== "" && ti === lastTurn;
        const add = continuing ? ` ${piece}` : `${cur ? "\n" : ""}${label}${piece}`;
        if (cur && (cur.length + add.length > limit || (!continuing && cur.length >= soft))) {
          chunks.push(cur);
          cur = label + piece;
        } else cur += add;
        lastTurn = ti;
      }
    }
  });
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Raw transcript to what the summary needs. Throws an HttpError the route
 * passes on: 413 `transcript_too_long`, 400 `transcript_empty`.
 */
export function prepareTranscript(raw: string): PreparedTranscript {
  if (raw.length > MAX_RAW_TRANSCRIPT) throw transcriptTooLong();
  const neutral = neutralizeSpeakers(parseTranscript(raw));
  const text = renderTurns(neutral.turns);
  const source = neutral.turns.map((t) => t.text).join("\n");
  if (source.replace(/\s/g, "").length < MIN_TRANSCRIPT) {
    throw new HttpError(400, "We couldn't find any spoken lines in that transcript. Check it's the meeting's transcript or captions file.", "transcript_empty");
  }
  if (text.length > MAX_TRANSCRIPT) throw transcriptTooLong(text.length);
  const chunks = chunkTurns(neutral.turns);
  if (chunks.length > MAX_CHUNKS) throw transcriptTooLong(text.length);
  return { text, source, turns: neutral.turns, speakers: neutral.speakers, chunks };
}
