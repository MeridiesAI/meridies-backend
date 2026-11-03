/**
 * Text from a student's uploaded file, for the Application page: an essay's
 * word count and the Resume adjuster.
 *
 * - `readStoredText` downloads the file on the caller's own client (Storage RLS
 *   decides; only the documents bucket and a path of a safe shape) and reads
 *   .txt / .md / .docx with lib/documentText.ts and a PDF with the capped
 *   worker in lib/pdfText.ts. A scan or a damaged file reads as null.
 * - `essayOnly` asks AxIS (FAST_MODEL) where the essay itself starts and ends
 *   in a document that may also hold a title, the prompt, notes or bullets.
 *   The model quotes the first and last words; code finds those quotes in the
 *   text (never trusting an offset), and the span is a verbatim slice. Nothing
 *   is rewritten, so the essay rule holds. Any doubt falls back to the whole
 *   text.
 */

import type { FastifyRequest } from "fastify";
import { hasAnthropic } from "../env.js";
import { FAST_MODEL, runStructured } from "./anthropic.js";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./context/pack.js";
import { countWords, maxReadBytes, readDocumentText } from "./documentText.js";
import { extractPdfText, PDF_LIMITS } from "./pdfText.js";
import { downloadCapped } from "./storageDownload.js";
import { isDocumentsBucket, isSafeStoragePath } from "./storagePath.js";
import { serializeErr } from "./requestLog.js";

type Row = Record<string, unknown>;

export function isPdf(filename: string, mimeType: string | null): boolean {
  return (mimeType ?? "").toLowerCase() === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}

/** Whether `readStoredText` can read this kind of file at all. */
export function canReadStoredText(filename: string, mimeType: string | null): boolean {
  if (isPdf(filename, mimeType)) return true;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ["txt", "md", "markdown", "docx"].includes(ext) || mimeType === "text/plain" || mimeType === "text/markdown"
    || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

/** A stored document's text, read on the caller's client, or null. */
export async function readStoredText(request: FastifyRequest, doc: Row): Promise<string | null> {
  const filename = String(doc.filename ?? "");
  const mimeType = (doc.mime_type as string | null) ?? null;
  if (!doc.storage_path || !canReadStoredText(filename, mimeType)) return null;
  const bucket = String(doc.bucket ?? "student-documents");
  if (!isDocumentsBucket(bucket) || !isSafeStoragePath(doc.storage_path)) return null;
  const pdf = isPdf(filename, mimeType);
  const dl = await downloadCapped(request.db, bucket, String(doc.storage_path), pdf ? PDF_LIMITS.maxBytes : maxReadBytes(filename, mimeType));
  if (dl.status !== "ok") return null;
  if (!pdf) return readDocumentText(dl.bytes, filename, mimeType);
  const r = await extractPdfText(new Uint8Array(dl.bytes.buffer, dl.bytes.byteOffset, dl.bytes.byteLength));
  if (!r.ok) return null;
  const text = r.text.trim();
  // A scan has no text layer: unreadable, not an empty essay.
  return text ? text : null;
}

// ---- Where the essay is -----------------------------------------------------------

/**
 * `quote` found in `text` with every run of whitespace matching any run of
 * whitespace (a PDF's line breaks, a doubled space): the start and end offsets
 * in `text`, or null. Linear in both lengths apart from indexOf's own search.
 */
export function findLoose(text: string, quote: string, from = 0, last = false): { start: number; end: number } | null {
  const q = quote.trim().split(/\s+/).filter(Boolean).join(" ");
  if (!q) return null;
  // Collapse `text` into the same shape, remembering where each kept character came from.
  let collapsed = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === " ") {
      if (!space && collapsed.length > 0) {
        collapsed += " ";
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    collapsed += c;
    at.push(i);
  }
  const fromC = at.findIndex((i) => i >= from);
  if (fromC < 0) return null;
  const idx = last ? collapsed.lastIndexOf(q) : collapsed.indexOf(q, fromC);
  if (idx < 0 || idx < fromC) return null;
  return { start: at[idx]!, end: at[idx + q.length - 1]! + 1 };
}

/**
 * The essay's span from the model's two quotes, checked in code: both found,
 * the end after the start, and the span holding a real share of the text (at
 * least 30 words and a quarter of the document), else null.
 */
export function locateEssay(text: string, startQuote: string, endQuote: string): string | null {
  const start = findLoose(text, startQuote);
  if (!start) return null;
  const end = findLoose(text, endQuote, start.start, true);
  if (!end || end.end <= start.start) return null;
  const span = text.slice(start.start, end.end).trim();
  const words = countWords(span);
  if (words < 30 || words < countWords(text) / 4) return null;
  return span;
}

const ESSAY_SPAN_SYSTEM = [
  "You find where an essay starts and ends inside a document a student uploaded.",
  "Besides the essay the document may hold a title, the student's name, the prompt, a word count, notes, outlines or bullet lists. Those are not the essay.",
  "Quote the first 6 to 12 words of the essay itself exactly as they appear, and its last 6 to 12 words exactly as they appear. Copy the words character for character. Never fix, change or add words.",
  "If the whole document is the essay, quote its first and last words.",
  UNTRUSTED_DATA_RULE,
].join("\n");

const ESSAY_SPAN_SCHEMA = {
  type: "object",
  properties: {
    startQuote: { type: "string", maxLength: 300 },
    endQuote: { type: "string", maxLength: 300 },
  },
  required: ["startQuote", "endQuote"],
} as const;

/** Most text sent to find the span: a personal statement with its notes fits many times over. */
const MAX_SPAN_INPUT = 40_000;

/**
 * The essay body inside `text`, or `text` itself when AI isn't available,
 * isn't allowed for this document, the text is short, or the answer doesn't
 * check out. Never throws.
 */
export async function essayOnly(
  request: FastifyRequest,
  studentId: string,
  text: string,
  opts: { aiAllowed: boolean }
): Promise<{ text: string; trimmed: boolean }> {
  if (!opts.aiAllowed || !hasAnthropic || countWords(text) < 60 || text.length > MAX_SPAN_INPUT) return { text, trimmed: false };
  try {
    const span = await runStructured({
      request,
      module: "essay-body",
      studentId,
      model: FAST_MODEL,
      system: ESSAY_SPAN_SYSTEM,
      prompt: wrapUntrusted("uploaded document", text),
      toolName: "essay_span",
      schema: ESSAY_SPAN_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 300,
      validate: (v) => {
        const o = (v ?? {}) as { startQuote?: unknown; endQuote?: unknown };
        return typeof o.startQuote === "string" && typeof o.endQuote === "string" ? locateEssay(text, o.startQuote, o.endQuote) : null;
      },
    });
    if (span && span !== text.trim()) return { text: span, trimmed: true };
  } catch (err) {
    request.log.warn({ err: serializeErr(err) }, "essay span skipped");
  }
  return { text, trimmed: false };
}
