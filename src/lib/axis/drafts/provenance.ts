/**
 * Where a draft value came from (spec 4.4, 4.5; plan review 11/8 items 3 and 4).
 *
 * Before a value goes on an activity card it must trace back to something the counselor wrote or pointed to:
 * their typed messages in this chat, their meeting notes for the student, a chat file's text, or one of the
 * student's documents the AI may read. Anything else (AxIS's own answers, emails, intake answers, the web) never
 * counts, so a value the model made up is refused by name. Files and documents are someone else's words: a value
 * from one marks its card as outside content (Confirm all skips it).
 *
 * Sources load lazily, once per turn: messages and notes first, files and documents only when a value isn't found
 * in those. The text read here never reaches the model.
 */
import type { FastifyRequest } from "fastify";
import { documentAiDecision, toAiDoc } from "../../context/documentAi.js";
import { loadPracticeSettings } from "../../practiceSettings.js";
import { extractChatFiles } from "../attachments.js";
import { STOPWORDS } from "../text.js";
import { freeTextKey, mentionsIn, type ActivityField, type Mentions } from "./normalize.js";

export { freeTextKey };

export type SourceKind = "message" | "notes" | "file" | "document";
export type Source = { kind: SourceKind; label: string; text: string; docKind?: string; id?: string };
export type Trace = { label: string; outside: boolean };
/** From the draft header: the message that opened the draft, and the fields AxIS last asked for after which message. */
export type TraceContext = { openedMsg?: string; asked?: { fields: ActivityField[]; afterMsg: string } };

export const DESCRIPTION_REFUSAL =
  "description must be copied exactly from the counselor's message or the student's resume; AxIS can't write or edit it.";
export const IMAGE_ONLY_HINT = "ask the counselor to type it or attach a PDF or text file";
export const provenanceRefusal = (field: string, value: unknown) =>
  `${field} '${Array.isArray(value) ? value.join(", ") : String(value)}' isn't in the counselor's words; use their wording or leave it blank and ask`;

/** Document kinds a description may be copied from, and how the card names them. */
const DESCRIPTION_KINDS: Record<string, string> = { resume: "resume", "activity-list": "activity list" };
const MESSAGE_WINDOW = 200;
const NOTES_WINDOW = 20;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Row = Record<string, unknown>;
type Deps = { practiceReadsDocuments?: () => Promise<boolean>; extract?: (request: FastifyRequest, conversationId: string) => Promise<void> };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const notesLabel = (date: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(date));
  return m ? `meeting notes (${MONTHS[Number(m[2]) - 1]} ${Number(m[3])})` : "meeting notes";
};

export class SourceSet {
  private nearP: Promise<Source[]> | null = null;
  private farP: Promise<{ sources: Source[]; transcripts: boolean }> | null = null;

  constructor(
    private readonly request: FastifyRequest,
    private readonly conversationId: string,
    private readonly studentId: string,
    private readonly deps: Deps = {}
  ) {}

  /** The counselor's typed messages (oldest first), then their meeting notes for the student. */
  near(): Promise<Source[]> {
    return (this.nearP ??= this.loadNear());
  }

  /** Chat files with read text, then the student's documents the AI may read. */
  async far(): Promise<Source[]> {
    return (await (this.farP ??= this.loadFar())).sources;
  }

  /** Whether the chat has files whose only text is a model's transcript (an image or a scan): never a source. */
  async hasTranscriptsOnly(): Promise<boolean> {
    return (await (this.farP ??= this.loadFar())).transcripts;
  }

  private async loadNear(): Promise<Source[]> {
    const db = this.request.db;
    const [msgs, notes] = await Promise.all([
      db.from("ai_messages").select("id, content, created_at").eq("conversation_id", this.conversationId).eq("role", "user")
        .order("created_at", { ascending: false }).limit(MESSAGE_WINDOW),
      db.from("meeting_notes").select("meeting_date, title, summary").eq("student_id", this.studentId)
        .order("meeting_date", { ascending: false }).limit(NOTES_WINDOW),
    ]);
    const messages = ((msgs.data ?? []) as Row[]).slice().reverse()
      .map((r): Source => ({ kind: "message", label: "your message", text: str(r.content), id: str(r.id) }));
    const noteSources = ((notes.error ? [] : notes.data ?? []) as Row[])
      .map((r): Source => ({ kind: "notes", label: notesLabel(r.meeting_date), text: [str(r.title), str(r.summary)].filter(Boolean).join("\n") }));
    return [...messages, ...noteSources];
  }

  private async loadFar(): Promise<{ sources: Source[]; transcripts: boolean }> {
    const db = this.request.db;
    const files = async () =>
      (await db.from("ai_attachments").select("file_name, extracted_text, extract_kind").eq("conversation_id", this.conversationId)
        .not("message_id", "is", null)).data as Row[] | null ?? [];
    let rows = await files().catch((): Row[] => []);
    // A file attached in this very message is read after the turn; read it now (it is claimed, so never twice).
    if (rows.some((r) => r.extract_kind === null || r.extract_kind === undefined)) {
      await (this.deps.extract ?? extractChatFiles)(this.request, this.conversationId).catch(() => undefined);
      rows = await files().catch((): Row[] => []);
    }
    const fileSources = rows
      .filter((r) => r.extract_kind === "text" && typeof r.extracted_text === "string")
      .map((r): Source => ({ kind: "file", label: str(r.file_name) || "attached file", text: r.extracted_text as string }));
    const transcripts = rows.some((r) => r.extract_kind === "transcript");

    const reads = await (this.deps.practiceReadsDocuments ?? (async () => (await loadPracticeSettings(this.request)).settings.autoParseDocuments))()
      .catch(() => false);
    const docs = await db.from("documents")
      .select("id, title, filename, kind, available_to_llm, ai_access, ferpa_waived, kind_confirmed, parsed_data")
      .eq("student_id", this.studentId);
    const docSources = ((docs.error ? [] : docs.data ?? []) as Row[])
      .filter((d) => documentAiDecision(toAiDoc(d), reads).allowed)
      .map((d): Source => {
        const parsed = (d.parsed_data ?? {}) as Row;
        return { kind: "document", label: str(d.title) || str(d.filename) || "a document", text: str(parsed.text), docKind: str(d.kind), id: str(d.id) };
      })
      .filter((s) => s.text.trim() !== "");
    return { sources: [...fileSources, ...docSources], transcripts };
  }
}

export function sourcesFor(request: FastifyRequest, conversationId: string, studentId: string, deps: Deps = {}): SourceSet {
  return new SourceSet(request, conversationId, studentId, deps);
}

// ---- Free text: a phrase the value covers at least half of ------------------------------------------

/** Words that carry no part of a name: the stopwords and the words a request is made of. */
const INSTRUCTION_WORDS = new Set(["add", "put", "please", "change", "update", "set", "make", "list", "sheet", "row", "activity", "activities", "his", "her", "their", "it"]);
const isContent = (w: string) => !STOPWORDS.has(w) && !INSTRUCTION_WORDS.has(w);
/** Where one phrase ends and the next starts. Captured, so a connector word ("and") stays in the word stream. */
const PHRASE_BREAK = /(\n|[,;|·.!?:()]|\s[/\-–—&]\s|\sand\s)/i;

/** True when `value` is a whole-word run in `text` covering at least half the content words of the phrase(s) it sits in. */
export function coversPhrase(value: string, text: string): boolean {
  const want = freeTextKey(value).split(" ").filter(Boolean);
  if (!want.length || !want.some(isContent)) return false;
  // Words in order, each tagged with its phrase; a connector between phrases ("and") belongs to none (-1).
  const words: { w: string; phrase: number }[] = [];
  let phrase = 0;
  text.split(PHRASE_BREAK).forEach((p, i) => {
    const isBreak = i % 2 === 1;
    for (const w of freeTextKey(p).split(" ").filter(Boolean)) words.push({ w, phrase: isBreak ? -1 : phrase });
    if (isBreak) phrase++;
  });
  const content = new Map<number, number>();
  for (const x of words) if (isContent(x.w)) content.set(x.phrase, (content.get(x.phrase) ?? 0) + 1);
  for (let i = 0; i + want.length <= words.length; i++) {
    if (!want.every((w, j) => words[i + j]!.w === w)) continue;
    const phrases = new Set(words.slice(i, i + want.length).map((x) => x.phrase).filter((p) => p >= 0));
    const total = [...phrases].reduce((n, p) => n + (content.get(p) ?? 0), 0);
    if (want.length * 2 >= total) return true;
  }
  return false;
}

// ---- Structured values -------------------------------------------------------------------------------

function mentionsHold(field: ActivityField, value: unknown, m: Mentions): boolean {
  switch (field) {
    case "grade_levels":
      return Array.isArray(value) && value.length > 0 && value.every((g) => m.grades.includes(g as never));
    case "timing":
      return Array.isArray(value) && value.length === 1 && m.timing.includes(value[0] as never);
    case "hours_per_week":
      return typeof value === "number" && m.hours.some((h) => Math.abs(h - value) < 1e-9);
    case "weeks_per_year":
      return typeof value === "number" && m.weeks.includes(value);
    case "continuing":
      return typeof value === "boolean" && m.continuing.includes(value);
    case "uc_category":
      return m.uc.includes(value as never);
    case "category":
      return m.category.includes(value as never);
    default:
      return false;
  }
}

/** Whether message `i` (of `ids`, oldest first) may lend a bare number to `field` (plan review item 3). */
function bareAllowed(field: ActivityField, i: number, ids: string[], tc: TraceContext): boolean {
  if (!tc.openedMsg) return i === ids.length - 1;
  const opened = Math.max(0, ids.indexOf(tc.openedMsg));
  if (i < opened) return false;
  if (tc.asked) {
    const after = ids.indexOf(tc.asked.afterMsg);
    if (after >= 0 && i > after) return tc.asked.fields.includes(field);
  }
  return true;
}

const traceOf = (s: Source): Trace => ({ label: s.label, outside: s.kind === "file" || s.kind === "document" });

/**
 * The first source a value traces to, or null. Free text (organization, position) must cover at least half of a
 * phrase; structured values must be what the normalizers read in a source, bare numbers only from the counselor's
 * replies since the draft opened. A cleared value (null, []) needs no source.
 */
export async function traceValue(set: SourceSet, field: ActivityField, value: unknown, tc: TraceContext = {}): Promise<Trace | null> {
  if (value === null || (Array.isArray(value) && value.length === 0)) return { label: "your message", outside: false };
  const free = field === "organization" || field === "position";
  const check = (s: Source, bare: boolean) =>
    free ? typeof value === "string" && coversPhrase(value, s.text) : mentionsHold(field, value, mentionsIn(s.text, { bare }));
  const near = await set.near();
  const ids = near.filter((s) => s.kind === "message").map((s) => s.id ?? "");
  let i = -1;
  for (const s of near) {
    if (s.kind === "message") i++;
    const bare = s.kind === "message" && !free && bareAllowed(field, i, ids, tc);
    if (check(s, false) || (bare && check(s, true))) return traceOf(s);
  }
  for (const s of await set.far()) if (check(s, false)) return traceOf(s);
  return null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Descriptions: an exact, case-sensitive copy (trimmed) of a typed message, or of a resume or activity list among
 * the student's documents, with whitespace runs collapsed on both sides. Chat files and other kinds never count.
 */
export async function traceDescription(set: SourceSet, value: string): Promise<Trace | null> {
  const v = value.trim();
  if (!v) return null;
  for (const s of await set.near()) if (s.kind === "message" && s.text.includes(v)) return { label: "your message", outside: false };
  const cv = collapse(v);
  for (const s of await set.far()) {
    const label = s.kind === "document" ? DESCRIPTION_KINDS[s.docKind ?? ""] : undefined;
    if (label && collapse(s.text).includes(cv)) return { label, outside: true };
  }
  return null;
}
