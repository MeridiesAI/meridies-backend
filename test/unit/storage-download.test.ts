/**
 * downloadCapped / readCapped (lib/storageDownload.ts): a Storage object is
 * read only up to a cap, whatever documents.size_bytes says. The review found
 * that a row registered with `sizeBytes: null` (or 0) made
 * POST /application/essays/from-document buffer the whole object, up to the
 * bucket's 50 MB limit, on every call; these check the reader stops pulling
 * chunks as soon as the cap is passed and cancels the transfer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadCapped, readCapped } from "../../src/lib/storageDownload.js";

const CHUNK = 64 * 1024;

/** A stream of `total` bytes in 64 KB chunks that counts what was pulled. */
function countingStream(total: number) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled * CHUNK >= total) {
        controller.close();
        return;
      }
      seen.pulled++;
      controller.enqueue(new Uint8Array(Math.min(CHUNK, total - (seen.pulled - 1) * CHUNK)).fill(0x61));
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

test("readCapped returns the whole body when it fits", async () => {
  const { stream } = countingStream(300_000);
  const r = await readCapped(stream, 1_000_000);
  assert.equal(r.status, "ok");
  assert.equal(r.status === "ok" && r.bytes.length, 300_000);
});

test("readCapped stops a 50 MB body just past the cap and cancels it", async () => {
  const cap = 1024 * 1024;
  const { stream, seen } = countingStream(50 * 1024 * 1024);
  const r = await readCapped(stream, cap);
  assert.equal(r.status, "too-large");
  assert.ok(seen.pulled <= cap / CHUNK + 1, `pulled ${seen.pulled} chunks for a ${cap / CHUNK}-chunk cap`);
  assert.equal(seen.cancelled, true);
});

test("a body of exactly the cap is read; one byte more is too large", async () => {
  assert.equal((await readCapped(countingStream(CHUNK * 2).stream, CHUNK * 2)).status, "ok");
  assert.equal((await readCapped(countingStream(CHUNK * 2 + 1).stream, CHUNK * 2)).status, "too-large");
});

/** A client whose storage.download(path).asStream() answers with `result`. */
function fakeClient(result: () => Promise<{ data: ReadableStream | null; error: unknown }>): SupabaseClient {
  return {
    storage: { from: () => ({ download: () => ({ asStream: result }) }) },
  } as unknown as SupabaseClient;
}

test("downloadCapped reads through the client's stream, and reports errors without throwing", async () => {
  const big = countingStream(20 * 1024 * 1024);
  assert.equal((await downloadCapped(fakeClient(async () => ({ data: big.stream, error: null })), "b", "p", 1024 * 1024)).status, "too-large");
  assert.ok(big.seen.pulled <= 17);
  const small = countingStream(10);
  const ok = await downloadCapped(fakeClient(async () => ({ data: small.stream, error: null })), "b", "p", 100);
  assert.equal(ok.status === "ok" && ok.bytes.toString(), "aaaaaaaaaa");
  assert.equal((await downloadCapped(fakeClient(async () => ({ data: null, error: new Error("nope") })), "b", "p", 100)).status, "error");
  assert.equal((await downloadCapped(fakeClient(async () => { throw new Error("network"); }), "b", "p", 100)).status, "error");
});
