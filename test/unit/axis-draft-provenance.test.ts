import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESCRIPTION_REFUSAL,
  freeTextKey,
  IMAGE_ONLY_HINT,
  provenanceRefusal,
  sourcesFor,
  traceDescription,
  traceValue,
} from "../../src/lib/axis/drafts/provenance.js";
import { fakeRequest } from "./axis-fakes.js";

type Row = Record<string, unknown>;
const CONV = "conv-1";
const STUDENT = "s1";

/** Messages oldest first, ids m1, m2, … */
function sources(o: { messages?: string[]; notes?: Row[]; files?: Row[]; documents?: Row[]; reads?: boolean; extract?: (t: Record<string, Row[]>) => void }) {
  const tables: Record<string, Row[]> = {
    ai_messages: (o.messages ?? []).map((content, i) => ({
      id: `m${i + 1}`, conversation_id: CONV, role: "user", content, created_at: `2026-11-08T10:${String(i).padStart(2, "0")}:00Z`,
    })),
    meeting_notes: (o.notes ?? []).map((n) => ({ student_id: STUDENT, ...n })),
    ai_attachments: (o.files ?? []).map((f) => ({ conversation_id: CONV, message_id: "m1", ...f })),
    documents: (o.documents ?? []).map((d) => ({
      student_id: STUDENT, kind_confirmed: true, available_to_llm: true, ai_access: "default", ferpa_waived: false, ...d,
    })),
  };
  let extracted = 0;
  const set = sourcesFor(fakeRequest(tables), CONV, STUDENT, {
    practiceReadsDocuments: async () => o.reads ?? true,
    extract: async () => {
      extracted++;
      o.extract?.(tables);
    },
  });
  return { set, extracted: () => extracted };
}

test("freeTextKey keeps letters of any script and drops punctuation", () => {
  assert.equal(freeTextKey("  Club de Fútbol! "), "club de fútbol");
  assert.equal(freeTextKey("Cofounder/Teacher"), "cofounder teacher");
});

test("a typed name passes whatever its case and punctuation; a made-up one doesn't", async () => {
  const { set } = sources({ messages: ["add code kidds adventure, cofounder/teacher"] });
  assert.deepEqual(await traceValue(set, "organization", "Code Kidds Adventure"), { label: "your message", outside: false });
  assert.equal((await traceValue(set, "position", "Cofounder/Teacher"))?.label, "your message");
  assert.equal(await traceValue(set, "position", "Host, library workshop"), null);
});

test("accented names pass when typed", async () => {
  const { set } = sources({ messages: ["she plays for Club de Fútbol, captain"] });
  assert.equal((await traceValue(set, "organization", "Club de Fútbol"))?.label, "your message");
  assert.equal(await traceValue(set, "organization", "club de futbol"), null);
});

test("a fragment of a longer name doesn't trace; a name inside an instruction does", async () => {
  const a = sources({ messages: ["add code kidds adventure, cofounder/teacher"] }).set;
  assert.equal(await traceValue(a, "organization", "Adventure"), null);
  assert.equal((await traceValue(a, "organization", "Code Kidds Adventure"))?.label, "your message");
  const b = sources({ messages: ["add Code Club to his activities sheet"] }).set;
  assert.equal((await traceValue(b, "organization", "Code Club"))?.label, "your message");
  const d = sources({ messages: ["2 week/yr and Debate Club, captain"] }).set;
  assert.equal((await traceValue(d, "organization", "Debate Club"))?.label, "your message", "'and' between two names starts a new phrase");
  const e = sources({ messages: ["add Robotics and Coding Club"] }).set;
  assert.equal((await traceValue(e, "organization", "Robotics and Coding Club"))?.label, "your message", "a name with 'and' in it still traces");
  const c = sources({ messages: ["Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr"] }).set;
  assert.equal((await traceValue(c, "position", "Cofounder/Teacher"))?.label, "your message");
  assert.equal((await traceValue(c, "organization", "Code Club"))?.label, "your message");
});

test("structured values trace through the normalizers", async () => {
  const { set } = sources({ messages: ["Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr"] });
  assert.equal((await traceValue(set, "grade_levels", ["11"]))?.label, "your message");
  assert.equal((await traceValue(set, "timing", ["break"]))?.label, "your message");
  assert.equal((await traceValue(set, "hours_per_week", 6))?.label, "your message");
  assert.equal((await traceValue(set, "weeks_per_year", 2))?.label, "your message");
  assert.equal(await traceValue(set, "hours_per_week", 8), null);
  assert.equal(await traceValue(set, "grade_levels", ["11", "12"]), null);
});

test("bare numbers trace only from messages since the draft opened, and only the fields asked for", async () => {
  // m1 before the draft; m2 opens it; m3 is AxIS's question's turn; m4 answers it.
  const { set } = sources({ messages: ["she was in grade 10 then", "add Code Club, cofounder", "anything else?", "6"] });
  assert.equal(await traceValue(set, "hours_per_week", 10, { openedMsg: "m2" }), null, "'grade 10' earlier doesn't trace hours 10");
  const asked = { openedMsg: "m2", asked: { fields: ["hours_per_week" as const], afterMsg: "m3" } };
  assert.equal((await traceValue(set, "hours_per_week", 6, asked))?.label, "your message");
  assert.equal(await traceValue(set, "weeks_per_year", 6, asked), null, "the reply answered hours, not weeks");
  assert.equal((await traceValue(set, "weeks_per_year", 6, { openedMsg: "m2" }))?.label, "your message", "with no question pending any field may use it");
});

test("without an opening message, bare numbers count only in the newest message", async () => {
  const { set } = sources({ messages: ["10", "add Code Club"] });
  assert.equal(await traceValue(set, "hours_per_week", 10), null);
  const fresh = sources({ messages: ["add Code Club", "10"] }).set;
  assert.equal((await traceValue(fresh, "hours_per_week", 10))?.label, "your message");
});

test("a value only in a document is labelled with the document and marked outside", async () => {
  const { set } = sources({
    messages: ["add the activities from her resume"],
    documents: [{ id: "d1", title: "Resume.pdf", filename: "resume.pdf", kind: "resume", parsed_data: { text: "Debate Club, Captain, 5 hrs/week" } }],
  });
  assert.deepEqual(await traceValue(set, "organization", "Debate Club"), { label: "Resume.pdf", outside: true });
  assert.deepEqual(await traceValue(set, "hours_per_week", 5), { label: "Resume.pdf", outside: true });
  assert.equal(await traceValue(set, "hours_per_week", 7), null);
});

test("a document the AI may not read is never a source", async () => {
  const doc = { id: "d1", title: "Resume.pdf", kind: "resume", parsed_data: { text: "Debate Club, Captain" } };
  assert.equal(await traceValue(sources({ documents: [{ ...doc, available_to_llm: false }] }).set, "organization", "Debate Club"), null);
  assert.equal(await traceValue(sources({ documents: [doc], reads: false }).set, "organization", "Debate Club"), null);
});

test("a meeting note is a source and isn't outside", async () => {
  const { set } = sources({ notes: [{ meeting_date: "2026-10-12", title: "Check-in", summary: "He started Robotics Club this fall." }] });
  assert.deepEqual(await traceValue(set, "organization", "Robotics Club"), { label: "meeting notes (Oct 12)", outside: false });
});

test("an attachment's text counts; a transcript doesn't; an unread one is read first", async () => {
  const text = sources({ files: [{ file_name: "list.txt", extract_kind: "text", extracted_text: "Chess Club, president" }] });
  assert.deepEqual(await traceValue(text.set, "organization", "Chess Club"), { label: "list.txt", outside: true });
  assert.equal(text.extracted(), 0);

  const scan = sources({ files: [{ file_name: "photo.png", extract_kind: "transcript", extracted_text: "Chess Club, president" }] });
  assert.equal(await traceValue(scan.set, "organization", "Chess Club"), null);
  assert.equal(await scan.set.hasTranscriptsOnly(), true);

  const unread = sources({
    files: [{ file_name: "list.txt", extract_kind: null, extracted_text: null }],
    extract: (t) => Object.assign(t.ai_attachments![0]!, { extract_kind: "text", extracted_text: "Chess Club, president" }),
  });
  assert.equal((await traceValue(unread.set, "organization", "Chess Club"))?.label, "list.txt");
  assert.equal(unread.extracted(), 1);
});

test("descriptions: exact copies from a message or a resume only", async () => {
  const typed = "Taught 20 middle schoolers to code in Scratch every Saturday.";
  const { set } = sources({
    messages: [`description: ${typed}`],
    documents: [
      { id: "d1", title: "Resume.pdf", kind: "resume", parsed_data: { text: "Code Club — Founded a club that\nteaches kids Python." } },
      { id: "d2", title: "Essay.pdf", kind: "essay", ai_access: "allowed", parsed_data: { text: "I love robots and building them." } },
    ],
    files: [{ file_name: "notes.txt", extract_kind: "text", extracted_text: "Ran the library's summer reading program." }],
  });
  assert.deepEqual(await traceDescription(set, typed), { label: "your message", outside: false });
  assert.deepEqual(await traceDescription(set, "Founded a club that teaches kids Python."), { label: "resume", outside: true });
  assert.equal(await traceDescription(set, "Founded a club that teaches children Python."), null, "one word changed");
  assert.equal(await traceDescription(set, typed.toLowerCase()), null, "case changed");
  assert.equal(await traceDescription(set, "I love robots and building them."), null, "an essay file isn't a source");
  assert.equal(await traceDescription(set, "Ran the library's summer reading program."), null, "a chat file isn't a source for descriptions");
});

test("the fixed sentences", () => {
  assert.equal(DESCRIPTION_REFUSAL, "description must be copied exactly from the counselor's message or the student's resume; AxIS can't write or edit it.");
  assert.equal(provenanceRefusal("position", "Host, library workshop"), "position 'Host, library workshop' isn't in the counselor's words; use their wording or leave it blank and ask");
  assert.equal(IMAGE_ONLY_HINT, "ask the counselor to type it or attach a PDF or text file");
});
