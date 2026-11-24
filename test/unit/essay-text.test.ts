import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { pickStatement, readTicked, RUN_READ_CAP } from "../../src/lib/coherenceDocs.js";
import { unreadDocsMessage, type UnreadDoc } from "../../src/lib/context/coherenceMaterial.js";
import { essayTextState, linkedGoogleDoc, readLinkedEssay, type LinkedRead } from "../../src/lib/essayText.js";
import { HttpError } from "../../src/lib/errors.js";
import { toEssayDoc } from "../../src/lib/studentApplication.js";

type Row = Record<string, unknown>;

const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE = "22222222-2222-4222-8222-222222222222";
const DOC_URL = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit";

/** A personal statement that is only a pasted Google Doc link, as POST /essays leaves it: no text, never read. */
const linked = (over: Row = {}): Row => ({
  id: "e-linked",
  essay_kind: "personal-statement",
  title: "Personal Statement",
  school: null,
  body: "",
  word_count: 0,
  text_status: "read",
  text_synced_at: null,
  external_url: DOC_URL,
  link_owner_id: ME,
  document_id: null,
  supplement_doc_id: null,
  updated_at: "2026-11-10T00:00:00Z",
  ...over,
});

const words = (s: unknown) => (String(s ?? "").trim() ? String(s).trim().split(/\s+/).length : 0);

/** request.db for the one write readLinkedEssay makes: update(...).eq("id", ...).select(...).maybeSingle(). */
function fakeRequest(opts: { userId?: string; write?: { data: unknown; error: unknown } } = {}) {
  const writes: { table: string; update: Row; id: unknown; select: string }[] = [];
  const db = {
    from(table: string) {
      return {
        update(update: Row) {
          const w = { table, update, id: undefined as unknown, select: "" };
          writes.push(w);
          return {
            eq(_column: string, id: unknown) {
              w.id = id;
              return {
                select(cols: string) {
                  w.select = cols;
                  return {
                    maybeSingle: async () =>
                      opts.write ?? { data: { ...linked(), id, ...update, word_count: words(update.body) }, error: null },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const warnings: unknown[] = [];
  const request = {
    db,
    auth: { userId: opts.userId ?? ME },
    log: { warn: (o: unknown) => warnings.push(o) },
  } as unknown as FastifyRequest;
  return { request, writes, warnings };
}

// ---- essayTextState ---------------------------------------------------------------

test("a pasted Doc link that was never read is pending, not empty: its 0 words aren't its length", () => {
  assert.equal(essayTextState(linked()), "pending");
});

test("a linked Doc that was read and is empty is empty; one with words is read", () => {
  assert.equal(essayTextState(linked({ text_synced_at: "2026-11-11T00:00:00Z" })), "empty");
  assert.equal(essayTextState(linked({ word_count: 640, body: "x", text_synced_at: "2026-11-11T00:00:00Z" })), "read");
  // Words on file count even if no read was ever stamped (typed in by hand).
  assert.equal(essayTextState(linked({ word_count: 12 })), "read");
});

test("unreadable wins over everything; an explicit pending is pending", () => {
  assert.equal(essayTextState(linked({ text_status: "unreadable" })), "unreadable");
  assert.equal(essayTextState(linked({ text_status: "unreadable", word_count: 50 })), "unreadable");
  assert.equal(essayTextState({ text_status: "pending", word_count: 0 }), "pending");
});

test("a file in Files or a supplement Doc with no words is empty: both are read when they are filed or synced", () => {
  assert.equal(essayTextState(linked({ document_id: "d1" })), "empty", "from-document reads the file when it files it");
  assert.equal(essayTextState(linked({ supplement_doc_id: "s1" })), "empty", "a blank answer in the school's Doc");
  assert.equal(essayTextState({ word_count: 0, text_status: "read" }), "empty", "nothing linked");
});

// ---- linkedGoogleDoc ---------------------------------------------------------------

test("only the person who linked a Google Doc may read it in", () => {
  assert.deepEqual(linkedGoogleDoc(linked(), ME), { fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" });
  assert.deepEqual(linkedGoogleDoc(linked({ link_owner_id: SOMEONE }), ME), { reason: "not-mine" });
  assert.deepEqual(linkedGoogleDoc(linked({ link_owner_id: null }), ME), { reason: "not-mine" });
  assert.deepEqual(linkedGoogleDoc(linked(), ""), { reason: "not-mine" });
});

test("a link that isn't a Google Doc, or a row with a file behind it, is not read this way", () => {
  assert.deepEqual(linkedGoogleDoc(linked({ external_url: "https://onedrive.live.com/edit?id=1" }), ME), { reason: "not-google" });
  assert.deepEqual(linkedGoogleDoc(linked({ document_id: "d1" }), ME), { reason: "not-linked" });
  assert.deepEqual(linkedGoogleDoc(linked({ supplement_doc_id: "s1" }), ME), { reason: "not-linked" });
  assert.deepEqual(linkedGoogleDoc(linked({ external_url: null }), ME), { reason: "not-linked" });
});

// ---- readLinkedEssay ----------------------------------------------------------------

test("reading a linked Doc stores its text the way Essays sync does, with the caller's own grant", async () => {
  const { request, writes } = fakeRequest();
  const asked: unknown[] = [];
  const r = await readLinkedEssay(request, linked(), {
    select: "id, word_count",
    now: "2026-11-15T12:00:00.000Z",
    exportText: async (owner, fileId) => {
      asked.push([owner, fileId]);
      return { ok: true, text: "One two three four" };
    },
  });
  assert.deepEqual(asked, [[ME, "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"]]);
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.update, { body: "One two three four", text_status: "read", text_synced_at: "2026-11-15T12:00:00.000Z" });
  assert.equal(writes[0]!.id, "e-linked");
  assert.equal(writes[0]!.select, "id, word_count");
  if (r.ok) {
    assert.equal(r.changed, true);
    assert.equal(r.row?.word_count, 4);
    assert.equal(essayTextState(r.row!), "read");
  }
});

test("an empty Doc read for the first time is stamped, so it stops reading as not read yet", async () => {
  const { request, writes } = fakeRequest();
  const r = await readLinkedEssay(request, linked(), { now: "2026-11-15T12:00:00.000Z", exportText: async () => ({ ok: true, text: "" }) });
  assert.equal(r.ok, true);
  assert.deepEqual(writes.map((w) => w.update), [{ text_status: "read", text_synced_at: "2026-11-15T12:00:00.000Z" }], "no body write");
  if (r.ok) {
    assert.equal(r.changed, false);
    assert.equal(essayTextState(r.row!), "empty");
  }
});

test("a Doc read before the essay-only rule is read once more; unchanged text only stamps the read", async () => {
  const { request, writes } = fakeRequest();
  const e = linked({ body: "Same text", word_count: 2, text_synced_at: "2026-11-01T00:00:00Z" });
  const r = await readLinkedEssay(request, e, { now: "2026-12-02T00:00:00.000Z", exportText: async () => ({ ok: true, text: "Same text" }) });
  assert.equal(r.ok && r.changed, false);
  assert.deepEqual(writes.map((w) => w.update), [{ text_status: "read", text_synced_at: "2026-12-02T00:00:00.000Z" }], "no body write");
});

test("a Doc the grant can't reach is not-picked, and nothing is written", async () => {
  const { request, writes } = fakeRequest();
  const r = await readLinkedEssay(request, linked(), { exportText: async () => ({ ok: false, reason: "not-picked" }) });
  assert.deepEqual(r, { ok: false, reason: "not-picked" });
  assert.equal(writes.length, 0);
});

test("someone else's link is never read with the caller's grant", async () => {
  const { request, writes } = fakeRequest();
  let called = false;
  const r = await readLinkedEssay(request, linked({ link_owner_id: SOMEONE }), {
    exportText: async () => {
      called = true;
      return { ok: true, text: "secret" };
    },
  });
  assert.deepEqual(r, { ok: false, reason: "not-mine" });
  assert.equal(called, false);
  assert.equal(writes.length, 0);
});

test("a connection that can't be used says why, in its own words; anything else is failed and logged", async () => {
  const { request, warnings } = fakeRequest();
  const off = await readLinkedEssay(request, linked(), {
    exportText: async () => {
      throw new HttpError(409, "Google isn't connected. Connect it under App Integrations first.", "google_disconnected");
    },
  });
  assert.deepEqual(off, { ok: false, reason: "no-access", message: "Google isn't connected. Connect it under App Integrations first." });
  assert.equal(warnings.length, 0);
  const down = await readLinkedEssay(request, linked(), {
    exportText: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.deepEqual(down, { ok: false, reason: "failed" });
  assert.equal(warnings.length, 1);
});

test("a write the database refused (or that matched no row) is failed, not a read", async () => {
  const blocked = fakeRequest({ write: { data: null, error: null } });
  assert.deepEqual(await readLinkedEssay(blocked.request, linked(), { exportText: async () => ({ ok: true, text: "words here" }) }), {
    ok: false,
    reason: "failed",
  });
  const broken = fakeRequest({ write: { data: null, error: { message: "boom" } } });
  assert.deepEqual(await readLinkedEssay(broken.request, linked(), { exportText: async () => ({ ok: true, text: "words here" }) }), {
    ok: false,
    reason: "failed",
  });
});

// ---- the essay DTO -----------------------------------------------------------------

test("an essay row shows no count while its linked Doc hasn't been read in (not a count of 0)", () => {
  assert.equal(toEssayDoc(linked()).readable, false);
  assert.equal(toEssayDoc(linked()).textStatus, "read", "the stored status is unchanged");
  assert.equal(toEssayDoc(linked({ text_synced_at: "2026-11-11T00:00:00Z" })).readable, true, "read and empty: 0 is right");
  assert.equal(toEssayDoc(linked({ word_count: 640, body: "x" })).readable, true);
  assert.equal(toEssayDoc(linked({ text_status: "unreadable" })).readable, false);
  assert.equal(toEssayDoc(linked({ external_url: null })).readable, true, "a row with nothing behind it");
});

// ---- pickStatement ------------------------------------------------------------------

test("a personal statement linked as a Google Doc is on file before its text is read", () => {
  assert.equal(pickStatement([linked()])?.id, "e-linked");
});

test("a statement with text still wins over a newer linked one that hasn't been read", () => {
  const typed = linked({ id: "e-typed", external_url: null, body: "x", word_count: 600, updated_at: "2026-10-01T00:00:00Z" });
  const newer = linked({ id: "e-new", updated_at: "2026-11-14T00:00:00Z" });
  assert.equal(pickStatement([newer, typed])?.id, "e-typed");
  const newerTyped = linked({ id: "e-typed2", external_url: null, body: "y", word_count: 610, updated_at: "2026-11-12T00:00:00Z" });
  assert.equal(pickStatement([typed, newer, newerTyped])?.id, "e-typed2", "newest with text");
});

test("an unreadable statement shows only when nothing better is on file; empty rows and supplements never do", () => {
  const scan = linked({ id: "e-scan", external_url: null, document_id: "d1", document: { available_to_llm: true }, text_status: "unreadable", updated_at: "2026-11-14T00:00:00Z" });
  assert.equal(pickStatement([scan, linked()])?.id, "e-linked");
  assert.equal(pickStatement([scan])?.id, "e-scan");
  assert.equal(pickStatement([linked({ external_url: null })]), null, "a placeholder row with nothing behind it");
  assert.equal(pickStatement([linked({ essay_kind: "supplement" })]), null);
  assert.equal(pickStatement([]), null);
});

// ---- readTicked ---------------------------------------------------------------------

const ok = (row: Row): LinkedRead => ({ ok: true, text: String(row.body ?? ""), changed: true, row });

test("a run reads a ticked linked Doc in first and swaps in the stored row", async () => {
  const { request } = fakeRequest();
  const e = linked();
  const essays = [e];
  const stored = { ...e, body: "Now it has words", word_count: 4, text_synced_at: "2026-11-15T12:00:00Z" };
  const seen: string[] = [];
  const problems = await readTicked(request, essays, [e], {
    select: "id, body, word_count",
    read: async (_r, row, o) => {
      seen.push(`${String(row.id)}|${o?.select}`);
      return ok(stored);
    },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(seen, ["e-linked|id, body, word_count"]);
  assert.equal(essays[0], stored, "the run reads the stored text");
});

test("a run never quietly drops a ticked Doc it couldn't read: it says which and why, in the order ticked", async () => {
  const { request } = fakeRequest();
  const statement = linked();
  const scan = linked({ id: "e-scan", essay_kind: "supplement", title: "Why us", school: "Rice", external_url: null, document_id: "d1", text_status: "unreadable" });
  const blank = linked({ id: "e-blank", essay_kind: "supplement", title: "Community", school: "Tufts" });
  const fine = linked({ id: "e-fine", essay_kind: "supplement", body: "has words", word_count: 2 });
  const essays = [statement, scan, blank, fine];
  const problems = await readTicked(request, essays, [statement, scan, blank, fine], {
    select: "*",
    read: async (_r, row) => (row.id === "e-linked" ? { ok: false, reason: "not-picked" } : ok({ ...row, text_synced_at: "2026-11-15T00:00:00Z" })),
  });
  assert.deepEqual(
    problems.map((p) => [p.part, p.reason]),
    [
      ["statement", "not-picked"],
      ["supplement", "unreadable"],
      ["supplement", "empty"],
    ]
  );
  assert.equal(problems[1]!.title, "Why us");
});

test("a run reads at most RUN_READ_CAP linked Docs, four at a time; the rest ask for fewer", async () => {
  const { request } = fakeRequest();
  const many = Array.from({ length: RUN_READ_CAP + 2 }, (_, i) => linked({ id: `e${i}`, essay_kind: "supplement" }));
  let inFlight = 0;
  let most = 0;
  let reads = 0;
  const problems = await readTicked(request, [...many], many, {
    select: "*",
    read: async (_r, row) => {
      reads++;
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return ok({ ...row, body: "a b", word_count: 2, text_synced_at: "x" });
    },
  });
  assert.equal(reads, RUN_READ_CAP);
  assert.ok(most <= 4, `at most four at once (saw ${most})`);
  assert.deepEqual(problems.map((p) => p.reason), ["too-many", "too-many"]);
});

// ---- the message --------------------------------------------------------------------

const statementUnread = (reason: UnreadDoc["reason"], message?: string): UnreadDoc => ({ part: "statement", title: "PS", school: null, reason, message });

test("the counselor is told the statement's Doc isn't read yet and how to fix it", () => {
  const m = unreadDocsMessage([statementUnread("not-picked")], "counselor");
  assert.match(m, /^The personal statement: its Google Doc hasn't been read in yet/);
  assert.match(m, /Pick this Doc to keep it in sync/);
  assert.match(m, /Or untick it to run the report without it\.$/);
});

test("a connection problem passes its own words through to the counselor only", () => {
  const msg = "Google isn't connected. Connect it under App Integrations first.";
  assert.ok(unreadDocsMessage([statementUnread("no-access", msg)], "counselor").includes(msg));
  const student = unreadDocsMessage([statementUnread("no-access", msg)], "student");
  assert.ok(!student.includes("App Integrations"));
  assert.match(student, /Ask your counselor/);
});

test("several unread documents are each named, with one closing line", () => {
  const docs: UnreadDoc[] = [
    statementUnread("not-mine"),
    { part: "supplement", title: "Why us\n  essay", school: "Rice", reason: "not-google" },
    { part: "supplement", title: "", school: "", reason: "failed" },
  ];
  const m = unreadDocsMessage(docs, "counselor");
  assert.match(m, /The personal statement: .*only whoever linked it can read it in/);
  assert.ok(m.includes("Why us essay (Rice): its link isn't a Google Doc"), "titles are one line");
  assert.ok(m.includes("A supplement: Google didn't send its text."));
  assert.match(m, /Or untick them to run the report without them\.$/);
});

test("past four documents the rest are counted, not listed", () => {
  const docs = Array.from({ length: 7 }, (_, i): UnreadDoc => ({ part: "supplement", title: `S${i}`, school: "X", reason: "failed" }));
  const m = unreadDocsMessage(docs, "counselor");
  assert.ok(m.includes("S3 (X)") && !m.includes("S4 (X)"));
  assert.ok(m.includes("3 more ticked documents can't be read yet either."));
});
