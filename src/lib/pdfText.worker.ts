import { parentPort, workerData } from "node:worker_threads";
import { extractInThisThread } from "./pdfText.extract.js";

const { bytes, maxPages, maxChars } = workerData as { bytes: Uint8Array; maxPages: number; maxChars: number };
extractInThisThread(bytes, maxPages, maxChars)
  .then((r) => parentPort?.postMessage({ ok: true, text: r.text, pages: r.pages }))
  .catch(() => parentPort?.postMessage({ ok: false, reason: "unreadable" }));
