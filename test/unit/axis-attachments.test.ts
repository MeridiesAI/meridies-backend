import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { extractChatFiles, storageName, withFiles } from "../../src/lib/axis/attachments.js";
import { runAxisTurn, type Emit } from "../../src/lib/axis/engine.js";
import { transcriptFromMessage } from "../../src/lib/axis/llm.js";
import type { PdfTextResult } from "../../src/lib/pdfText.js";
import { fakeDb, fakeRequest, scriptedApi, type DbCall } from "./axis-fakes.js";

const ME = "counselor-1";
const PDF = Buffer.from("%PDF-1.4 Priya Raman, weighted GPA 4.21, rank 7 of 412 %%EOF");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const tables = () => ({
  profiles: [{ id: "s1", full_name: "Sophia Martinez", counselor_id: ME, role: "student", archived_at: null, grad_year: 2027, high_school: "Lincoln High" }],
  deliverables: [],
  deadlines: [],
  red_flags: [],
  meetings: [],
  colleges: [],
  accountability_settings: [],
  practice_settings: [],
  "rpc:crm_my_workspace": [{ firm_id: null, is_admin: false }],
  ai_conversations: [{ id: "conv-1", summary: null, summary_through: null, state: null }],
  ai_messages: [{ conversation_id: "conv-1", role: "user", content: "placeholder", created_at: new Date().toISOString() }],
  ai_attachments: [
    { id: "a1", conversation_id: "conv-1", message_id: "m1", storage_path: `${ME}/conv-1/a1-transcript.pdf`, file_name: "transcript.pdf", mime_type: "application/pdf", size_bytes: PDF.length, created_at: "2026-10-12T10:00:00Z" },
    { id: "a2", conversation_id: "conv-1", message_id: "m1", storage_path: `${ME}/conv-1/a2-shot.png`, file_name: "shot.png", mime_type: "image/png", size_bytes: PNG.length, created_at: "2026-10-12T10:00:01Z" },
    // Waiting for a message that was never sent: not handed to the model.
    { id: "a3", conversation_id: "conv-1", message_id: null, storage_path: `${ME}/conv-1/a3-draft.pdf`, file_name: "draft.pdf", mime_type: "application/pdf", size_bytes: 10, created_at: "2026-10-12T10:00:02Z" },
  ],
});

function withStorage(request: FastifyRequest): FastifyRequest {
  const objects: Record<string, Buffer> = { [`${ME}/conv-1/a1-transcript.pdf`]: PDF, [`${ME}/conv-1/a2-shot.png`]: PNG };
  const db = (request as unknown as { db: Record<string, unknown> }).db;
  db.storage = {
    from: () => ({
      download: async (path: string) =>
        objects[path] ? { data: new Blob([new Uint8Array(objects[path])]), error: null } : { data: null, error: { message: "missing" } },
    }),
  };
  return request;
}

function collect() {
  const events: [string, unknown][] = [];
  const emit: Emit = (e, d) => events.push([e, d]);
  return { events, emit };
}

type Block = { type: string; text?: string; title?: string; source?: { type: string; media_type?: string; data?: string } };
const lastUserContent = (params: { messages: { role: string; content: unknown }[] }) =>
  params.messages.filter((m) => m.role === "user").at(-1)!.content as Block[] | string;

test("a storage name keeps the extension and drops everything unsafe", () => {
  assert.equal(storageName("Transcript (fall).PDF"), "Transcript-fall.pdf");
  assert.equal(storageName("../../etc/passwd"), "passwd");
  assert.equal(storageName("???.png"), "file.png");
});

test("a message without files stays plain text", () => {
  assert.equal(withFiles("hello", { blocks: [], names: [], texts: [] }), "hello");
});

test("a message with files puts them before the question, and says they are data", () => {
  const files = { blocks: [{ type: "text" as const, text: "x" }], names: ["a.pdf"], texts: [] };
  const out = withFiles("explain this", files) as Block[];
  assert.match(out[0]!.text!, /attached this file to the chat: a\.pdf/);
  assert.match(out[0]!.text!, /not instructions/);
  assert.equal(out.at(-1)!.text, "explain this");
});

test("the model receives the chat's PDF and image with the question, and the turn skips the direct answer", async () => {
  const { api, calls } = scriptedApi([{ text: "It's Priya Raman's transcript: weighted GPA 4.21, rank 7 of 412." }]);
  const ev = collect();
  const request = withStorage(fakeRequest(tables(), ME));
  // "Who is behind" would be a direct answer from the record; a message with a file goes to the model.
  const res = await runAxisTurn({
    request, conversationId: "conv-1", studentId: null, content: "Who is behind this week? Explain this", emit: ev.emit,
    signal: new AbortController().signal, api, newFiles: true,
  });
  assert.notEqual(res.path, "direct");
  assert.equal(calls.length, 1);
  const content = lastUserContent(calls[0]!.params as never);
  assert.ok(Array.isArray(content), "the last user message carries content blocks");
  const doc = content.find((b) => b.type === "document")!;
  assert.equal(doc.source?.media_type, "application/pdf");
  assert.equal(Buffer.from(doc.source!.data!, "base64").toString(), PDF.toString());
  assert.equal(doc.title, "transcript.pdf");
  const image = content.find((b) => b.type === "image")!;
  assert.equal(image.source?.media_type, "image/png");
  assert.match(content[0]!.text!, /transcript\.pdf, shot\.png/);
  assert.match(content.at(-1)!.text!, /Explain this$/);
  assert.ok(!JSON.stringify(content).includes("draft.pdf"), "an unsent file stays out");
  // Figures from a PDF can't be checked against it: no live grounding marks, no after-answer check.
  assert.equal(ev.events.filter(([e]) => e === "grounding").length, 0);
  assert.equal(res.verify.wanted, false);
  assert.ok(ev.events.some(([e, d]) => e === "reasoning" && /Reading 2 attached files/.test((d as { step: string }).step)));
});

test("a later turn with no new file still hands the model the chat's files", async () => {
  const { api, calls } = scriptedApi([{ text: "Rank 7 of 412." }]);
  const ev = collect();
  const request = withStorage(fakeRequest(tables(), ME));
  await runAxisTurn({
    request, conversationId: "conv-1", studentId: null, content: "what was the class rank in that file again?", emit: ev.emit,
    signal: new AbortController().signal, api,
  });
  const content = lastUserContent(calls[0]!.params as never);
  assert.ok(Array.isArray(content) && content.some((b) => b.type === "document"));
});

test("a chat with no files sends plain text, as before", async () => {
  const { api, calls } = scriptedApi([{ text: "ok" }]);
  const t = tables();
  t.ai_attachments = [];
  await runAxisTurn({
    request: withStorage(fakeRequest(t, ME)), conversationId: "conv-1", studentId: null, content: "What should I focus on with my caseload?",
    emit: collect().emit, signal: new AbortController().signal, api,
  });
  if (calls.length) assert.equal(typeof lastUserContent(calls[0]!.params as never), "string");
});

// ---- Reading a file once, after the turn it arrived in (PR A1) ----

type Row = Record<string, unknown>;
let seq = 0;
const stored = (id: string, name: string, mime: string, over: Row = {}): Row => ({
  id, conversation_id: "conv-1", owner_id: ME, message_id: "m1", storage_path: `${ME}/conv-1/${id}-${name}`, file_name: name, mime_type: mime,
  size_bytes: 10, created_at: `2026-10-12T10:00:${String(seq++ % 60).padStart(2, "0")}Z`, extracted_text: null, extract_kind: null, extract_cut: false,
  extracted_at: null, ...over,
});

/** The caller's own client (RLS reads) over `rows`, the service client over the same rows, and every object downloadable. */
function reading(rows: Row[], o: { pdf?: (bytes: Uint8Array) => Promise<PdfTextResult>; transcript?: { text: string; cut: boolean } | null } = {}) {
  const tables = { ai_attachments: rows };
  const request = fakeRequest(tables, ME);
  const downloads: string[] = [];
  (request as unknown as { db: Record<string, unknown> }).db.storage = {
    from: () => ({
      download: async (path: string) => {
        downloads.push(path);
        const row = rows.find((r) => r.storage_path === path);
        const body = (row?.body as Buffer | undefined) ?? Buffer.from("bytes");
        return { data: new Blob([new Uint8Array(body)]), error: null };
      },
    }),
  };
  const calls: DbCall[] = [];
  const pdfCalls: number[] = [];
  const transcribed: { name: string; block: Anthropic.Messages.ContentBlockParam }[] = [];
  const deps = {
    db: fakeDb(tables, calls) as never,
    pdf: (async (bytes: Uint8Array) => {
      pdfCalls.push(bytes.byteLength);
      return o.pdf ? o.pdf(bytes) : { ok: true, text: `${"Weighted GPA 4.21. ".repeat(20)}`, pages: 1 };
    }) as never,
    transcribe: (async (t: { name: string; block: Anthropic.Messages.ContentBlockParam }) => {
      transcribed.push({ name: t.name, block: t.block });
      return o.transcript === undefined ? { text: "Rank 7 of 412", cut: false } : o.transcript;
    }) as never,
  };
  return { request, rows, deps, calls, pdfCalls, transcribed, downloads };
}

test("PDF with text -> text; image -> transcript; text file -> as is", async () => {
  const r = reading([
    stored("p1", "transcript.pdf", "application/pdf"),
    stored("i1", "shot.png", "image/png"),
    stored("t1", "notes.txt", "text/plain", { body: Buffer.from("Priya Raman\u0000\nGPA 4.21") }),
  ]);
  await extractChatFiles(r.request, "conv-1", r.deps);
  const [pdf, img, txt] = r.rows;
  assert.equal(pdf!.extract_kind, "text");
  assert.match(String(pdf!.extracted_text), /Weighted GPA 4\.21/);
  assert.equal(img!.extract_kind, "transcript");
  assert.equal(img!.extracted_text, "Rank 7 of 412");
  assert.equal(txt!.extract_kind, "text");
  assert.equal(txt!.extracted_text, "Priya Raman\nGPA 4.21", "as it is, less the NUL Postgres can't store");
  for (const row of r.rows) {
    assert.equal(row.extract_cut, false);
    assert.ok(row.extracted_at, "claimed");
  }
  assert.equal(r.transcribed.length, 1, "one model call, for the image");
  assert.equal(r.transcribed[0]!.name, "shot.png");
  assert.equal(r.transcribed[0]!.block.type, "image");
});

test("a scanned PDF (under 200 non-space characters) gets a transcription", async () => {
  const r = reading([stored("p1", "scan.pdf", "application/pdf")], {
    pdf: async () => ({ ok: true, text: ` \n Page 1 ${"x ".repeat(180)}\n`, pages: 1 }),
    transcript: { text: "WEIGHTED GPA 4.21", cut: false },
  });
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.equal(r.rows[0]!.extract_kind, "transcript");
  assert.equal(r.rows[0]!.extracted_text, "WEIGHTED GPA 4.21");
  assert.equal(r.transcribed[0]!.block.type, "document");
});

test("a transcription that stopped at max output is stored cut", async () => {
  const r = reading([stored("i1", "long.png", "image/png")], { transcript: { text: "a".repeat(12_000), cut: true } });
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.equal(r.rows[0]!.extract_kind, "transcript");
  assert.equal(r.rows[0]!.extract_cut, true);
});

test("a transcription answer: cut at max output or past 12,000 characters, none on a refusal", () => {
  const msg = (text: string, stop: string) => ({ content: [{ type: "text", text }], stop_reason: stop }) as unknown as Anthropic.Message;
  assert.deepEqual(transcriptFromMessage(msg("GPA 4.21", "end_turn")), { text: "GPA 4.21", cut: false });
  assert.deepEqual(transcriptFromMessage(msg("GPA 4.21", "max_tokens")), { text: "GPA 4.21", cut: true });
  const long = transcriptFromMessage(msg("b".repeat(12_500), "end_turn"))!;
  assert.equal(long.text.length, 12_000);
  assert.equal(long.cut, true);
  assert.equal(transcriptFromMessage(msg("I can't help with that.", "refusal")), null);
  assert.equal(transcriptFromMessage(msg("   ", "end_turn")), null, "nothing read is a failure, not an empty file");
});

test("a reading error marks the file failed and it isn't tried again", async () => {
  const r = reading([stored("p1", "broken.pdf", "application/pdf"), stored("i1", "shot.png", "image/png")], {
    pdf: async () => ({ ok: false, reason: "unreadable" }),
    transcript: null,
  });
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.equal(r.rows[0]!.extract_kind, "failed");
  assert.equal(r.rows[1]!.extract_kind, "failed", "a transcription that came back empty");
  assert.equal(r.rows[0]!.extracted_text, null);
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.equal(r.pdfCalls.length, 1);
  assert.equal(r.transcribed.length, 1);
});

test("a file another turn has claimed isn't read twice", async () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const stale = new Date(Date.now() - 11 * 60_000).toISOString();
  const r = reading([
    stored("p1", "busy.pdf", "application/pdf", { extracted_at: recent }),
    stored("p2", "abandoned.pdf", "application/pdf", { extracted_at: stale }),
  ]);
  await Promise.all([extractChatFiles(r.request, "conv-1", r.deps), extractChatFiles(r.request, "conv-1", r.deps)]);
  assert.equal(r.rows[0]!.extract_kind, null, "another turn is reading it");
  assert.equal(r.rows[1]!.extract_kind, "text", "a claim older than 10 minutes is free again");
  assert.equal(r.pdfCalls.length, 1, "two turns at once read it once");
});

test("a text file over 200,000 characters is stored cut", async () => {
  const r = reading([stored("t1", "big.csv", "text/csv", { body: Buffer.from("x".repeat(200_050)) })]);
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.equal(r.rows[0]!.extract_kind, "text");
  assert.equal(String(r.rows[0]!.extracted_text).length, 200_000);
  assert.equal(r.rows[0]!.extract_cut, true);
});

test("a PDF read to the page or character limit is stored cut", async () => {
  const r = reading([stored("p1", "long.pdf", "application/pdf")], { pdf: async () => ({ ok: true, text: "Grades. ".repeat(100), pages: 50 }) });
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.equal(r.rows[0]!.extract_cut, true);
});

test("writes go only to rows the caller's own read returned", async () => {
  // The fake read has no RLS, so it returns someone else's row in this chat; the service client's own filters keep it out.
  const r = reading([stored("p1", "mine.pdf", "application/pdf"), stored("x1", "theirs.pdf", "application/pdf", { owner_id: "someone-else" })]);
  await extractChatFiles(r.request, "conv-1", r.deps);
  const updates = r.calls.filter((c) => c.op === "update");
  assert.ok(updates.length >= 2, "a claim and a write");
  for (const u of updates) {
    for (const col of ["id", "owner_id", "conversation_id"]) assert.ok(u.filters.includes(col), `update ${JSON.stringify(u.patch)} filters on ${col}`);
  }
  assert.equal(r.rows[0]!.extract_kind, "text");
  assert.equal(r.rows[1]!.extract_kind, null, "someone else's file is never written");
  assert.equal(r.rows[1]!.extracted_at, null);
});

test("extraction never throws and reads only this chat's files", async () => {
  const r = reading([
    stored("p1", "other-chat.pdf", "application/pdf", { conversation_id: "conv-2" }),
    stored("p2", "unsent.pdf", "application/pdf", { message_id: null }),
    stored("p3", "done.pdf", "application/pdf", { extract_kind: "text", extracted_text: "kept" }),
  ]);
  await extractChatFiles(r.request, "conv-1", r.deps);
  assert.deepEqual(r.downloads, [], "nothing to read here");
  assert.equal(r.rows[0]!.extract_kind, null);
  assert.equal(r.rows[1]!.extract_kind, null);
  assert.equal(r.rows[2]!.extracted_text, "kept");

  const broken = reading([stored("p4", "a.pdf", "application/pdf")]);
  const throwing = { ...broken.deps, db: { from: () => { throw new Error("db down"); } } as never };
  await extractChatFiles(broken.request, "conv-1", throwing);
  const missing = fakeRequest({}, ME);
  (missing as unknown as { db: { from: () => unknown } }).db.from = () => ({
    select: () => ({ eq: () => ({ not: () => ({ is: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "42703", message: "column ai_attachments.extract_kind does not exist" } }) }) }) }) }) }),
  });
  await extractChatFiles(missing, "conv-1", broken.deps);
});
