import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PDFJS_OPTIONS } from "../../src/lib/pdfText.options.js";
import { extractInThisThread } from "../../src/lib/pdfText.extract.js";
import { bundledPdfjsVersion, extractPdfText, pdfQueueStats, pdfQueueWaitingPriorities, PDF_LIMITS } from "../../src/lib/pdfText.js";
import { fontMatrixPdf, javascriptPdf, textPdf } from "../fixtures/pdf/build.js";

const atLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

test("unpdf is pinned exactly and bundles PDF.js at or past the CVE-2024-4367 fix", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.unpdf, "1.8.1");
  const v = await bundledPdfjsVersion();
  assert.ok(atLeast(v, "4.2.67"), `bundled PDF.js ${v}`);
});

test("every load passes isEvalSupported false and scripting off", () => {
  assert.equal(PDFJS_OPTIONS.isEvalSupported, false);
  assert.equal(PDFJS_OPTIONS.enableScripting, false);
});

test("text comes out of a normal PDF, in a worker", async () => {
  const r = await extractPdfText(textPdf(["Official Transcript", "Cumulative GPA 3.9"]));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.text, /Official Transcript/);
    assert.equal(r.pages, 2);
  }
});

test("embedded JavaScript never runs: an OpenAction script and a crafted FontMatrix", async () => {
  delete (globalThis as Record<string, unknown>).__meridiesMarker;
  // The script PDF is otherwise valid, so it must still read: the marker staying unset is then meaningful.
  const withScript = await extractInThisThread(javascriptPdf(), 50, 200_000);
  assert.match(withScript.text, /Has a script/);
  await extractInThisThread(fontMatrixPdf(), 50, 200_000).catch(() => undefined);
  assert.equal((globalThis as Record<string, unknown>).__meridiesMarker, undefined);
});

test("only the first 50 pages are read and the text stops at 200,000 characters", async () => {
  const many = await extractPdfText(textPdf(Array.from({ length: 60 }, (_, i) => `Page ${i + 1}`)));
  assert.ok(many.ok && many.pages === 50 && !many.text.includes("Page 51"));
  const long = await extractPdfText(textPdf(Array.from({ length: 50 }, () => "x".repeat(5_000)), { mediaBox: "0 0 1000000 792" }));
  assert.ok(long.ok && long.text.length === PDF_LIMITS.maxChars);
});

test("a file over 25 MB is refused before any worker starts", async () => {
  const r = await extractPdfText(new Uint8Array(PDF_LIMITS.maxBytes + 1));
  assert.deepEqual(r, { ok: false, reason: "too-large" });
  assert.deepEqual(pdfQueueStats(), { running: 0, waiting: 0 });
});

test("a worker that never answers is terminated at the time limit, and the next extraction works", async () => {
  const started = Date.now();
  const r = await extractPdfText(textPdf(["x"]), { timeoutMs: 400, workerUrl: new URL("../fixtures/pdf/loop.worker.mjs", import.meta.url) });
  assert.deepEqual(r, { ok: false, reason: "timeout" });
  assert.ok(Date.now() - started < 3_000);
  assert.equal(pdfQueueStats().running, 0);
  assert.equal((await extractPdfText(textPdf(["after"]))).ok, true);
});

test("a worker over its memory cap fails cleanly", async () => {
  const r = await extractPdfText(textPdf(["x"]), { workerUrl: new URL("../fixtures/pdf/hog.worker.mjs", import.meta.url) });
  assert.deepEqual(r, { ok: false, reason: "memory" });
  assert.equal((await extractPdfText(textPdf(["after"]))).ok, true);
});

test("at most two run at once; the rest wait in order, and high priority jumps the queue", async () => {
  const loop = new URL("../fixtures/pdf/loop.worker.mjs", import.meta.url);
  const slow = [1, 2].map(() => extractPdfText(textPdf(["x"]), { timeoutMs: 600, workerUrl: loop }));
  // Enqueue in an order that proves both rules: n1, n2 (normal, FIFO), then h1, h2 (high, jump ahead, FIFO among themselves).
  const jobs = [
    extractPdfText(textPdf(["n1"])),
    extractPdfText(textPdf(["n2"])),
    extractPdfText(textPdf(["h1"]), { priority: "high" }),
    extractPdfText(textPdf(["h2"]), { priority: "high" }),
  ];
  assert.deepEqual(pdfQueueStats(), { running: 2, waiting: 4 });
  assert.deepEqual(pdfQueueWaitingPriorities(), ["high", "high", "normal", "normal"]);
  const results = await Promise.all([...jobs, ...slow]);
  assert.ok(results.slice(0, 4).every((r) => r.ok));
  assert.deepEqual(pdfQueueStats(), { running: 0, waiting: 0 });
});

test("a high-priority job that can't start within its wait gives up as busy", async () => {
  const loop = new URL("../fixtures/pdf/loop.worker.mjs", import.meta.url);
  const slow = [1, 2].map(() => extractPdfText(textPdf(["x"]), { timeoutMs: 800, workerUrl: loop }));
  const r = await extractPdfText(textPdf(["guess"]), { priority: "high", waitMs: 100 });
  assert.deepEqual(r, { ok: false, reason: "busy" });
  await Promise.all(slow);
});
