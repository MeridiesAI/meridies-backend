// lib/axisChatExport.ts: AxIS chats in the data exports. The pure parts: the order an export lists them in (oldest
// chat first, each chat's messages, cards and files together under it), the bound on file text, and readPaged's
// `stop`, which ends a read early like the row cap does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_ID_CHUNK, CHAT_PARTS, FILE_TEXT_BUDGET, fileTextBudget, orderChatParts, readByChats } from "../../src/lib/axisChatExport.js";
import { readPaged } from "../../src/lib/pagedRead.js";

test("the four parts and their names in a student's records and a counselor's practice", () => {
  assert.deepEqual(
    CHAT_PARTS.map((p) => [p.table, p.record, p.practice]),
    [
      ["ai_conversations", "axis_chats", "axisChats"],
      ["ai_messages", "axis_chat_messages", "axisChatMessages"],
      ["axis_actions", "axis_chat_actions", "axisChatActions"],
      ["ai_attachments", "axis_chat_files", "axisChatFiles"],
    ]
  );
});

test("chats oldest first; each part grouped by chat in that order, then by time, ties by id", () => {
  const chats = [
    { id: "c-new", created_at: "2026-11-03T10:00:00+00:00" },
    { id: "c-old", created_at: "2026-11-01T10:00:00+00:00" },
  ];
  const messages = [
    { id: "m3", conversation_id: "c-new", created_at: "2026-11-03T10:00:01+00:00" },
    { id: "m2", conversation_id: "c-old", created_at: "2026-11-01T10:00:05+00:00" },
    { id: "m1b", conversation_id: "c-old", created_at: "2026-11-01T10:00:01+00:00" },
    { id: "m1a", conversation_id: "c-old", created_at: "2026-11-01T10:00:01+00:00" },
    { id: "orphan", conversation_id: "c-missing", created_at: "2026-10-01T00:00:00+00:00" },
  ];
  const out = orderChatParts({ ai_conversations: chats, ai_messages: messages, axis_actions: [], ai_attachments: [] });
  assert.deepEqual(out.ai_conversations.map((r) => r.id), ["c-old", "c-new"]);
  // A row whose chat isn't in the export (its chat was past the cap) goes last rather than being dropped.
  assert.deepEqual(out.ai_messages.map((r) => r.id), ["m1a", "m1b", "m2", "m3", "orphan"]);
});

test("ordering doesn't mutate what it was given", () => {
  const chats = [
    { id: "b", created_at: "2026-11-02T00:00:00Z" },
    { id: "a", created_at: "2026-11-01T00:00:00Z" },
  ];
  orderChatParts({ ai_conversations: chats, ai_messages: [], axis_actions: [], ai_attachments: [] });
  assert.deepEqual(chats.map((r) => r.id), ["b", "a"]);
});

test("file text is budgeted in UTF-8 bytes across pages", () => {
  assert.equal(FILE_TEXT_BUDGET, 20 * 1024 * 1024);
  const b = fileTextBudget(10);
  b.onPage([{ extracted_text: "é".repeat(3) }, { extracted_text: null }]); // 6 bytes
  assert.equal(b.spent(), false);
  b.onPage([{ extracted_text: "abcd" }]); // 10 bytes: the budget is spent
  assert.equal(b.spent(), true);
});

test("readPaged's stop ends the read after a page, keeps what was read, and probes for more", async () => {
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, 30);
    return { data: Array.from({ length: Math.max(0, end - from) }, (_, i) => ({ id: from + i })), error: null };
  };
  let pages = 0;
  const r = await readPaged(fetchPage, { pageSize: 10, onPage: () => void pages++, stop: () => pages >= 2 });
  assert.equal(r.rows.length, 20);
  assert.equal(r.truncated, true);
  assert.deepEqual(calls, [[0, 9], [10, 19], [20, 20]]);
});

test("readPaged's stop on the last page is not truncated", async () => {
  const fetchPage = async (from: number, to: number) => ({
    data: Array.from({ length: Math.max(0, Math.min(to + 1, 10) - from) }, (_, i) => ({ id: from + i })),
    error: null,
  });
  const r = await readPaged(fetchPage, { pageSize: 10, stop: () => true });
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, false);
});

// ---- Reading a part by its chats' ids, in chunks (the indexed column), under one row cap and one budget ----------

/** Child rows per chat id, served like PostgREST: inclusive range, ordered by id, `in` over the chunk's ids. */
function children(perChat: Record<string, number>) {
  const all = Object.entries(perChat).flatMap(([chat, n]) => Array.from({ length: n }, (_, i) => ({ id: `${chat}-${String(i).padStart(4, "0")}`, conversation_id: chat })));
  const calls: Array<{ ids: string[]; from: number; to: number }> = [];
  const fetchChunk = async (ids: string[], from: number, to: number) => {
    calls.push({ ids, from, to });
    const rows = all.filter((r) => ids.includes(r.conversation_id)).sort((a, b) => a.id.localeCompare(b.id));
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { fetchChunk, calls };
}

test("chat ids go 100 to a query", async () => {
  assert.equal(CHAT_ID_CHUNK, 100);
  const ids = Array.from({ length: 250 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const t = children(Object.fromEntries(ids.map((id) => [id, 1])));
  const r = await readByChats(ids, t.fetchChunk);
  assert.equal(r.rows.length, 250);
  assert.equal(r.truncated, false);
  assert.deepEqual([...new Set(t.calls.map((c) => c.ids.length))], [100, 50]);
});

test("no chats is no query", async () => {
  const t = children({});
  const r = await readByChats([], t.fetchChunk);
  assert.deepEqual(r, { rows: [], truncated: false, error: null });
  assert.equal(t.calls.length, 0);
});

test("the row cap holds across chunks: rows left in a later chunk are reported truncated", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const t = children(Object.fromEntries(ids.map((id) => [id, 1])));
  const r = await readByChats(ids, t.fetchChunk, { cap: 100 });
  assert.equal(r.rows.length, 100);
  assert.equal(r.truncated, true);
});

test("exactly the cap across chunks is not truncated", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const perChat = Object.fromEntries(ids.map((id, i) => [id, i < 100 ? 1 : 0]));
  const t = children(perChat);
  const r = await readByChats(ids, t.fetchChunk, { cap: 100 });
  assert.equal(r.rows.length, 100);
  assert.equal(r.truncated, false);
});

test("a spent budget stops the read; rows left in a later chunk are reported truncated", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const t = children(Object.fromEntries(ids.map((id) => [id, 1])));
  let seen = 0;
  const r = await readByChats(ids, t.fetchChunk, { pageSize: 50, onPage: (rows) => void (seen += rows.length), stop: () => seen >= 50 });
  assert.equal(r.rows.length, 50);
  assert.equal(r.truncated, true);
});

test("an error comes back with the rows read so far, never thrown", async () => {
  const fetchChunk = async () => ({ data: null, error: { code: "42501" } });
  const r = await readByChats(["c1"], fetchChunk);
  assert.deepEqual(r, { rows: [], truncated: false, error: { code: "42501" } });
});
