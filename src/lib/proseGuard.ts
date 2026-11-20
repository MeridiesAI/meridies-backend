/**
 * The essay guardrail for free-text answers that stream (AxIS v2's agent and
 * synthesis paths, the v1 /chat stream), and for the free text AxIS files on a
 * card (an email draft, a message body, a note: lib/axis/ops/run.ts,
 * lib/axis/tools.ts).
 *
 * The bullet-only routes run enforceNoProse() over a finished list. A chat
 * answer is prose by nature (a paragraph of advice, an email draft) and streams
 * as it is written, so that filter can't apply; and the essay router that sends
 * "write her essay" to the bullet path is a classifier a rephrasing can miss.
 * This is the code-level backstop behind both. Essay prose is first-person
 * narrative, so two counts are kept over the sentences written in the first
 * person singular ("I", "me", "my", "mine", "myself"):
 *
 *  - narrative words: first-person sentences that address nobody (no "you",
 *    "your"). An essay is told, not addressed; a counselor's email ("I wanted
 *    to let you know…") and AxIS talking to the counselor ("I'd suggest you…")
 *    mostly are addressed, so their first-person lines don't count here.
 *    At most NARRATIVE_WORD_CAP of them.
 *  - first-person words, addressed or not: at most FIRST_PERSON_WORD_CAP, so
 *    sprinkling "as you know" into every sentence of an essay doesn't get it
 *    through whole.
 *
 * Past either cap nothing more of the answer reaches the client and it ends
 * with WITHHELD_NOTICE. A long family email in the counselor's voice sits well
 * under both; a personal statement or a long supplement doesn't.
 *
 * Streaming: text is released as it arrives while even counting everything
 * not yet classified would stay under both caps, so a normal answer streams
 * exactly as before. Only near a cap does the current sentence wait for its
 * end to be judged, so at most the caps' worth of first-person prose can ever
 * be released.
 *
 * Known limits: this is a shape test, not a judgement. A short supplement
 * (under ~200 words) asked for in pieces, or written in the third person, is
 * not caught here; the essay router (lib/axis/lexicon.ts) and the system
 * prompts are the other layers.
 */

export const NARRATIVE_WORD_CAP = 200;
export const FIRST_PERSON_WORD_CAP = 450;

export const WITHHELD_NOTICE =
  "I don't write essay text, so the rest of this answer was withheld. Ask for bullet-point feedback on a draft instead.";

const FIRST_PERSON = /(^|[^\p{L}\p{N}'’])(I|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself)(?=$|[^\p{L}\p{N}])/u;
const SECOND_PERSON = /(^|[^\p{L}\p{N}'’])([Yy]ou|[Yy]our|[Yy]ours|[Yy]ourself|[Yy]ourselves)(?=$|[^\p{L}\p{N}])/u;
/** A sentence ends at . ! ? (and any closing quotes or brackets) followed by space, or at a line break. */
const BOUNDARY = /[.!?]+["'”’)\]]*(?=\s)|\n/g;

const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length;
export const isFirstPersonSentence = (s: string): boolean => FIRST_PERSON.test(s);
/** First person and addressed to nobody: how an essay reads. */
export const isNarrativeSentence = (s: string): boolean => FIRST_PERSON.test(s) && !SECOND_PERSON.test(s);

type Counts = { firstPerson: number; narrative: number };

function count(s: string, into: Counts): void {
  if (!isFirstPersonSentence(s)) return;
  const n = wordCount(s);
  into.firstPerson += n;
  if (!SECOND_PERSON.test(s)) into.narrative += n;
}

/** Both counts over a finished text. */
export function proseCounts(text: string): Counts {
  const c: Counts = { firstPerson: 0, narrative: 0 };
  let last = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const end = (m.index ?? 0) + m[0].length;
    count(text.slice(last, end), c);
    last = end;
  }
  count(text.slice(last), c);
  return c;
}

/** First-person words in a finished text, addressed or not. */
export const firstPersonWords = (text: string): number => proseCounts(text).firstPerson;
/** Narrative (first-person, unaddressed) words in a finished text. */
export const narrativeWords = (text: string): number => proseCounts(text).narrative;

const over = (c: Counts, caps: { narrative: number; firstPerson: number }) => c.narrative > caps.narrative || c.firstPerson > caps.firstPerson;

/** Whether a finished text reads as essay prose: past either cap. */
export function essayShaped(text: string, caps = { narrative: NARRATIVE_WORD_CAP, firstPerson: FIRST_PERSON_WORD_CAP }): boolean {
  return over(proseCounts(text), caps);
}

export class ProseGate {
  /** Released to the client so far. */
  private out = "";
  /** The sentence being written: `released` chars of it already went out. */
  private sentence = "";
  private released = 0;
  private counts: Counts = { firstPerson: 0, narrative: 0 };
  private stopped = false;
  private readonly caps: { narrative: number; firstPerson: number };

  constructor(caps: Partial<{ narrative: number; firstPerson: number }> = {}) {
    this.caps = { narrative: caps.narrative ?? NARRATIVE_WORD_CAP, firstPerson: caps.firstPerson ?? FIRST_PERSON_WORD_CAP };
  }

  /** Whether the answer crossed a cap and its rest was withheld. */
  get blocked(): boolean {
    return this.stopped;
  }

  /** Everything the client was given, the notice included once finished. */
  get text(): string {
    return this.out;
  }

  /** Feeds a streamed delta; returns what may be shown now (possibly ""). */
  push(delta: string): string {
    if (this.stopped || !delta) return "";
    let emitted = "";
    this.sentence += delta;
    // Close every complete sentence in the buffer.
    for (;;) {
      BOUNDARY.lastIndex = 0;
      const m = BOUNDARY.exec(this.sentence);
      if (!m) break;
      const end = m.index + m[0].length;
      const done = this.sentence.slice(0, end);
      count(done, this.counts);
      if (over(this.counts, this.caps)) return this.stop(emitted);
      emitted += done.slice(this.released);
      this.sentence = this.sentence.slice(end);
      this.released = 0;
    }
    // The open sentence goes out live while, counted as first-person narrative, it would still fit both caps.
    const open = wordCount(this.sentence);
    if (this.counts.narrative + open <= this.caps.narrative && this.counts.firstPerson + open <= this.caps.firstPerson) {
      emitted += this.sentence.slice(this.released);
      this.released = this.sentence.length;
    }
    this.out += emitted;
    return emitted;
  }

  /** The end of the stream: the held tail, or the notice when the answer was cut. */
  finish(): string {
    if (this.stopped) return "";
    const tail = this.sentence;
    count(tail, this.counts);
    if (over(this.counts, this.caps)) return this.stop("");
    const rest = tail.slice(this.released);
    this.sentence = "";
    this.released = 0;
    this.out += rest;
    return rest;
  }

  private stop(before: string): string {
    this.stopped = true;
    this.sentence = "";
    this.released = 0;
    const notice = `${this.out + before ? "\n\n" : ""}${WITHHELD_NOTICE}`;
    const shown = before + notice;
    this.out += shown;
    return shown;
  }
}
