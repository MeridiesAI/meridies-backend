import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { storageName, withFiles } from "../../src/lib/axis/attachments.js";
import { runAxisTurn, type Emit } from "../../src/lib/axis/engine.js";
import { fakeRequest, scriptedApi } from "./axis-fakes.js";

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
