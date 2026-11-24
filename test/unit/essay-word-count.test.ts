// The three linked-Doc word-count causes (HANDOFF-word-count.md):
//   1. an essay picked from Google Drive was never read again, so its count stayed at the first read;
//   2. a pasted Doc link counted the whole Doc, not just the essay;
//   3. a changed link kept the old Doc's text and count (route + database: test/integration/essays-relink.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { readTicked } from "../../src/lib/coherenceDocs.js";
import { readLinkedEssay, readPickedEssay, readUnderRule, READ_RULE_SINCE, stillCurrent, type Trim } from "../../src/lib/essayText.js";
import { HttpError } from "../../src/lib/errors.js";
import type { RemoteFile } from "../../src/lib/suiteApi.js";

type Row = Record<string, unknown>;
const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE = "22222222-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";
const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const AFTER_RULE = new Date(Date.parse(READ_RULE_SINCE) + 86_400_000).toISOString();
const LATER = new Date(Date.parse(READ_RULE_SINCE) + 2 * 86_400_000).toISOString();
const NOW = new Date(Date.parse(READ_RULE_SINCE) + 3 * 86_400_000).toISOString();

const ESSAY = "essay ".repeat(650).trim();
const WHOLE_DOC = `Personal Statement, draft 3\nPrompt: Some students have a background...\nNotes from Ms. Lee: tighten paragraph 2\n\n${ESSAY}\n\nOld draft:\n${"old ".repeat(400).trim()}`;

/** A trim that finds ESSAY inside whatever it's given, and records how it was asked. */
function trimSpy() {
  const calls: { studentId: string; aiAllowed: boolean; prompt?: string | null }[] = [];
  const trim: Trim = async (_r, studentId, text, o) => {
    calls.push({ studentId, ...o });
    return { text: text.includes(ESSAY) ? ESSAY : text };
  };
  return { trim, calls };
}

function fakeRequest(userId = ME) {
  const writes: { update: Row; id: unknown }[] = [];
  const request = {
    auth: { userId },
    log: { warn() {} },
    db: {
      from: () => ({
        update: (update: Row) => ({
          eq: (_c: string, id: unknown) => {
            writes.push({ update, id });
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id, ...update, word_count: String(update.body ?? "").split(/\s+/).filter(Boolean).length }, error: null }),
              }),
            };
          },
        }),
      }),
    },
  } as unknown as FastifyRequest;
  return { request, writes };
}

const linked = (over: Row = {}): Row => ({
  id: "e1",
  student_id: STUDENT,
  essay_kind: "personal-statement",
  prompt: "Some students have a background...",
  body: "",
  word_count: 0,
  text_status: "read",
  text_synced_at: null,
  external_url: `https://docs.google.com/document/d/${FILE}/edit`,
  link_owner_id: ME,
  document_id: null,
  supplement_doc_id: null,
  ...over,
});

const words = (s: unknown) => String(s ?? "").split(/\s+/).filter(Boolean).length;

// ---- cause 2: a pasted link counts only the essay ----------------------------------------------------------

test("cause 2: a pasted Doc with a title, prompt, notes and an old draft stores only the essay (650 words, not 1,069)", async () => {
  const { request, writes } = fakeRequest();
  const { trim, calls } = trimSpy();
  const r = await readLinkedEssay(request, linked(), { now: NOW, trim, exportText: async () => ({ ok: true, text: WHOLE_DOC }) });
  assert.equal(r.ok, true);
  assert.equal(words(writes[0]!.update.body), 650);
  assert.deepEqual(calls, [{ studentId: STUDENT, aiAllowed: true, prompt: "Some students have a background..." }], "the essay's prompt is the hint");
});

test("cause 2: materials (a resume linked as 'other') are counted whole", async () => {
  const { request, writes } = fakeRequest();
  const { trim, calls } = trimSpy();
  await readLinkedEssay(request, linked({ essay_kind: "other" }), { now: NOW, trim, exportText: async () => ({ ok: true, text: WHOLE_DOC }) });
  assert.equal(calls.length, 0);
  assert.equal(writes[0]!.update.body, WHOLE_DOC);
});

// ---- when to read again --------------------------------------------------------------------------------

test("the read rule: never read, waiting, or read before the rule means read; otherwise read only if Google says it changed", () => {
  assert.equal(readUnderRule(linked()), false);
  assert.equal(readUnderRule(linked({ text_synced_at: AFTER_RULE, text_status: "pending" })), false);
  assert.equal(readUnderRule(linked({ text_synced_at: "2026-11-20T00:00:00Z" })), false);
  assert.equal(readUnderRule(linked({ text_synced_at: AFTER_RULE })), true);
  const read = linked({ text_synced_at: LATER });
  assert.equal(stillCurrent(read, AFTER_RULE), true, "modified before the read");
  assert.equal(stillCurrent(read, LATER), true, "modified at the read");
  assert.equal(stillCurrent(read, NOW), false, "modified after the read");
  assert.equal(stillCurrent(read, null), false, "Google didn't say");
});

test("an unchanged linked Doc read under the rule costs one metadata call: no export, no AI, no write", async () => {
  const { request, writes } = fakeRequest();
  const { trim, calls } = trimSpy();
  let exported = false;
  const e = linked({ body: ESSAY, word_count: 650, text_synced_at: LATER });
  const r = await readLinkedEssay(request, e, {
    trim,
    modifiedAt: async () => AFTER_RULE,
    exportText: async () => {
      exported = true;
      return { ok: true, text: WHOLE_DOC };
    },
  });
  assert.deepEqual(r, { ok: true, text: ESSAY, changed: false, row: null });
  assert.equal(exported, false);
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
});

test("a linked Doc edited after its last read is read again; a metadata failure falls through to the read", async () => {
  for (const modifiedAt of [async () => NOW, async () => Promise.reject(new Error("404"))]) {
    const { request, writes } = fakeRequest();
    const e = linked({ body: "short old text", word_count: 3, text_synced_at: LATER });
    const r = await readLinkedEssay(request, e, { now: NOW, trim: trimSpy().trim, modifiedAt, exportText: async () => ({ ok: true, text: WHOLE_DOC }) });
    assert.equal(r.ok && r.changed, true);
    assert.equal(words(writes[0]!.update.body), 650);
  }
});

// ---- cause 1: essays picked from Google Drive are read again ---------------------------------------------

const pickedDoc = (over: Row = {}): Row => ({
  id: "d1",
  student_id: STUDENT,
  owner_id: ME,
  external_provider: "google",
  external_file_id: FILE,
  external_drive_id: null,
  kind: "essay",
  kind_confirmed: true,
  available_to_llm: true,
  ...over,
});
const picked = (over: Row = {}): Row => linked({ external_url: null, link_owner_id: null, document_id: "d1", body: "first read", word_count: 2, text_synced_at: LATER, ...over });
const file = (modifiedAt: string | null, mimeType = "application/vnd.google-apps.document"): RemoteFile =>
  ({ id: FILE, name: "Statement", mimeType, modifiedAt }) as unknown as RemoteFile;

test("cause 1: a Drive-picked essay whose Doc changed since the last read is read again, cut down to the essay", async () => {
  const { request, writes } = fakeRequest();
  const { trim, calls } = trimSpy();
  const r = await readPickedEssay(request, picked(), pickedDoc(), { now: NOW, trim, getFile: async () => file(NOW), exportText: async () => WHOLE_DOC });
  assert.equal(r.ok && r.changed, true);
  assert.equal(words(writes[0]!.update.body), 650);
  assert.equal(writes[0]!.update.text_synced_at, NOW);
  assert.equal(calls[0]!.aiAllowed, true, "a confirmed file left open to AI");
});

test("cause 1: an unchanged picked Doc isn't exported; one first read before the rule is", async () => {
  const { request, writes } = fakeRequest();
  let exported = 0;
  const exportText = async () => {
    exported++;
    return "first read";
  };
  const same = await readPickedEssay(request, picked(), pickedDoc(), { getFile: async () => file(AFTER_RULE), exportText });
  assert.deepEqual(same, { ok: true, changed: false, row: null });
  assert.equal(exported, 0);
  await readPickedEssay(request, picked({ text_synced_at: "2026-11-20T00:00:00Z" }), pickedDoc(), { now: NOW, getFile: async () => file(AFTER_RULE), exportText });
  assert.equal(exported, 1);
  assert.deepEqual(writes.map((w) => w.update), [{ text_status: "read", text_synced_at: NOW }]);
});

test("cause 1: a picked Doc is read only by whoever picked it, only when confirmed, and only a Google Doc", async () => {
  const { request, writes } = fakeRequest();
  const getFile = async () => file(NOW);
  const exportText = async () => WHOLE_DOC;
  for (const [doc, e] of [
    [pickedDoc({ owner_id: SOMEONE }), picked()],
    [pickedDoc({ kind_confirmed: false }), picked()],
    [pickedDoc({ external_provider: "microsoft" }), picked()],
    [pickedDoc({ student_id: SOMEONE }), picked()],
    [pickedDoc({ id: "other" }), picked()],
  ] as const) {
    assert.deepEqual(await readPickedEssay(request, e, doc, { getFile, exportText }), { ok: false, reason: "skip" });
  }
  assert.deepEqual(await readPickedEssay(request, picked(), pickedDoc(), { getFile: async () => file(NOW, "application/pdf"), exportText }), { ok: false, reason: "skip" });
  assert.equal(writes.length, 0);
});

test("cause 1: a file the document AI rules keep from AI is still re-read, counted whole", async () => {
  const { request, writes } = fakeRequest();
  const { trim, calls } = trimSpy();
  await readPickedEssay(request, picked(), pickedDoc({ available_to_llm: false }), { now: NOW, trim, getFile: async () => file(NOW), exportText: async () => WHOLE_DOC });
  assert.equal(calls[0]!.aiAllowed, false);
  assert.ok(writes[0]!.update.body);
});

test("cause 1: a Google connection that can't be used says so; other failures are failed, nothing written", async () => {
  const { request, writes } = fakeRequest();
  const off = await readPickedEssay(request, picked(), pickedDoc(), {
    getFile: async () => {
      throw new HttpError(409, "Google isn't connected.", "google_disconnected");
    },
  });
  assert.deepEqual(off, { ok: false, reason: "no-access", message: "Google isn't connected." });
  const gone = await readPickedEssay(request, picked(), pickedDoc(), { getFile: async () => file(NOW), exportText: async () => null });
  assert.deepEqual(gone, { ok: false, reason: "failed" });
  assert.equal(writes.length, 0);
});

// ---- a Narrative Coherence run reads changed Docs too -------------------------------------------------------

test("a run re-reads ticked linked Docs that were read before; a failure there keeps the text on file", async () => {
  const { request } = fakeRequest();
  const e = linked({ body: ESSAY, word_count: 650, text_synced_at: LATER, title: "PS" });
  const essays = [e];
  const asked: unknown[] = [];
  const problems = await readTicked(request, essays, [e], {
    select: "*",
    read: async (_r, x) => {
      asked.push(x.id);
      return { ok: false, reason: "not-picked" };
    },
  });
  assert.deepEqual(asked, ["e1"]);
  assert.deepEqual(problems, [], "the run isn't refused: there is text");
  assert.equal(essays[0], e);
});
