/**
 * Text for AI after a counselor confirms a file's type (spec §4.3; Elvin 10/15: queued, two at
 * a time, progress shown). The queue is in-process; the database is the durable part: a
 * confirmation sets `extraction_requested_at` and leaves `parse_status = 'pending'`, a worker
 * claims a row by moving it to `parsing` under a 2-minute lease (and counts an attempt), and the
 * result clears the marker. Recovery (on boot and every minute) returns an expired lease to the
 * queue, and after 3 attempts marks the row failed, so every item reaches a final state and the
 * app's polling always ends. Rows without the
 * marker (everything that existed before) are never touched: there is no backfill.
 *
 * Runs on the service client, outside the request: every row is re-checked when it runs
 * (still confirmed, still allowed for AI, its counselor still approved), and the text write is
 * conditional on the same, so a file kept out while it waited never gets text.
 */
import type { FastifyInstance } from "fastify";
import { isCounselorApproved } from "./access.js";
import { GUESS_PAGES, GUESS_TEXT_LIMIT } from "./documentGuess.js";
import { readDocumentText } from "./documentText.js";
import { parseSpreadsheet } from "./imports/sheet.js";
import { extractPdfText, PDF_LIMITS } from "./pdfText.js";
import { serializeErr } from "./requestLog.js";
import { serviceClient } from "./supabase.js";

type Log = { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
type Row = Record<string, unknown>;

const CONCURRENCY = 2;
export const LEASE_MS = 120_000;
export const MAX_ATTEMPTS = 3;
const RECOVERY_EVERY_MS = 60_000;
const RECOVERY_WINDOW_HOURS = 24;

/** What recovery does with an expired lease. */
export function leaseVerdict(row: { extraction_attempts: number }): "retry" | "give-up" {
  return row.extraction_attempts >= MAX_ATTEMPTS ? "give-up" : "retry";
}

export type ExtractionState = "queued" | "reading" | "done" | "empty" | "failed" | "kept-out" | "unconfirmed" | "none";

export function extractorFor(mimeType: string | null, filename: string): "pdf" | "text" | "sheet" | "none" {
  const m = (mimeType ?? "").toLowerCase();
  const n = filename.toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.includes("spreadsheetml") || m === "text/csv" || /\.(xlsx|csv)$/.test(n)) return "sheet";
  if (m.includes("wordprocessingml") || m === "text/plain" || /\.(docx|txt|md)$/.test(n)) return "text";
  return "none";
}

export function extractionState(row: Row): ExtractionState {
  if (row.kind_confirmed === false) return "unconfirmed";
  if (row.available_to_llm === false) return "kept-out";
  const requested = row.extraction_requested_at != null;
  switch (row.parse_status) {
    case "pending": return requested ? "queued" : "none";
    case "parsing": return "reading";
    case "parsed": return "done";
    case "skipped": return row.parse_error === "no-text" ? "empty" : "none";
    case "failed": return "failed";
    default: return "none";
  }
}

/** A claim that failed on a row still carrying the marker: clear it when the row can never be extracted as it stands. */
export function claimFailure(row: Row | null): "clear" | "leave" {
  if (!row || row.extraction_requested_at == null || row.parse_status !== "pending") return "leave";
  return row.kind_confirmed !== true || row.available_to_llm !== true ? "clear" : "leave";
}

/** Whose approval allows the read: the student's counselor, or for a file with no student the uploader. */
async function approvalFor(db: NonNullable<ReturnType<typeof serviceClient>>, row: Row): Promise<"approved" | "not-approved" | "unknown"> {
  try {
    let counselorId: string | null = String(row.owner_id);
    if (row.student_id) {
      const { data, error } = await db.from("profiles").select("counselor_id").eq("id", String(row.student_id)).maybeSingle();
      if (error) return "unknown";
      counselorId = data?.counselor_id ? String(data.counselor_id) : null;
    }
    if (!counselorId) return "not-approved";
    return (await isCounselorApproved(db, counselorId)) ? "approved" : "not-approved";
  } catch {
    return "unknown";
  }
}

const waiting: string[] = [];
const inQueue = new Set<string>();
let running = 0;

export function requestExtraction(ids: string[], log: Log): void {
  for (const id of ids) {
    if (inQueue.has(id)) continue;
    inQueue.add(id);
    waiting.push(id);
  }
  pump(log);
}

function pump(log: Log): void {
  while (running < CONCURRENCY && waiting.length > 0) {
    const id = waiting.shift()!;
    running++;
    runExtraction(id, log)
      .catch((err) => log.error({ err: serializeErr(err) }, "document extraction failed"))
      .finally(() => {
        running--;
        inQueue.delete(id);
        pump(log);
      });
  }
}

async function textOf(kind: "pdf" | "text" | "sheet", bytes: Uint8Array, filename: string, mimeType: string | null): Promise<{ text: string | null; from: string }> {
  if (kind === "pdf") {
    const r = await extractPdfText(bytes);
    return { text: r.ok ? r.text : null, from: "pdf" };
  }
  if (kind === "text") {
    const t = readDocumentText(Buffer.from(bytes), filename, mimeType);
    return { text: t === null ? null : t.slice(0, PDF_LIMITS.maxChars), from: "text" };
  }
  const parsed = await parseSpreadsheet(bytes, filename, 2_000);
  if (!parsed.ok) return { text: null, from: "sheet" };
  const lines = parsed.sheets.flatMap((s) => [s.headers.join(", "), ...s.rows.map((r) => r.join(", "))]);
  return { text: lines.join("\n").slice(0, PDF_LIMITS.maxChars), from: "sheet" };
}

export async function runExtraction(id: string, log: Log): Promise<"done" | "empty" | "failed" | "skipped"> {
  const db = serviceClient();
  if (!db) return "skipped";

  // Claim: only a confirmed, AI-allowed row that a confirmation asked for, once, under a lease.
  // The attempt count is compare-and-set, so two replicas can't both claim the same attempt.
  const { data: current, error: currentErr } = await db
    .from("documents")
    .select("extraction_attempts")
    .eq("id", id)
    .eq("parse_status", "pending")
    .not("extraction_requested_at", "is", null)
    .maybeSingle();
  if (currentErr) log.error({ err: serializeErr(currentErr) }, "extraction claim read failed");
  if (!current) return "skipped";
  const attempts = Number(current.extraction_attempts ?? 0);
  if (attempts >= MAX_ATTEMPTS) {
    const { error } = await db
      .from("documents")
      .update({ parse_status: "failed", parse_error: "gave-up", extraction_requested_at: null, extraction_lease_until: null })
      .eq("id", id)
      .eq("parse_status", "pending")
      .eq("extraction_attempts", attempts);
    if (error) log.error({ err: serializeErr(error) }, "extraction give-up write failed");
    return "failed";
  }
  const { data: claimed, error: claimErr } = await db
    .from("documents")
    .update({ parse_status: "parsing", extraction_attempts: attempts + 1, extraction_lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq("id", id)
    .eq("parse_status", "pending")
    .eq("extraction_attempts", attempts)
    .eq("kind_confirmed", true)
    .eq("available_to_llm", true)
    .not("extraction_requested_at", "is", null)
    .select("id, owner_id, student_id, bucket, storage_path, filename, mime_type")
    .maybeSingle();
  if (claimErr) {
    log.error({ err: serializeErr(claimErr) }, "extraction claim failed");
    return "skipped";
  }
  if (!claimed) {
    // Kept out or retyped between the confirmation and now: the marker must not outlive the request.
    const { data: now } = await db
      .from("documents")
      .select("kind_confirmed, available_to_llm, parse_status, extraction_requested_at")
      .eq("id", id)
      .maybeSingle();
    if (claimFailure(now as Row | null) === "clear") {
      const { error } = await db
        .from("documents")
        .update({ extraction_requested_at: null, extraction_lease_until: null })
        .eq("id", id)
        .eq("parse_status", "pending")
        .not("extraction_requested_at", "is", null);
      if (error) log.error({ err: serializeErr(error) }, "extraction marker clear failed");
    }
    return "skipped";
  }
  const row = claimed as Row;

  // Every write below is conditional on still holding this claim (parsing, at this attempt).
  const release = async (fields: Row, keepMarker = false) => {
    const marker = keepMarker ? {} : { extraction_requested_at: null };
    const { error } = await db
      .from("documents")
      .update({ ...fields, ...marker, extraction_lease_until: null })
      .eq("id", id)
      .eq("parse_status", "parsing")
      .eq("extraction_attempts", attempts + 1);
    if (error) log.error({ err: serializeErr(error) }, "extraction release failed");
  };

  const approval = await approvalFor(db, row);
  if (approval === "unknown") {
    // An unreadable answer is not a decision: back to the queue with the marker and the attempt uncounted.
    await release({ parse_status: "pending", extraction_attempts: attempts }, true);
    return "skipped";
  }
  if (approval === "not-approved") {
    await release({ parse_status: "pending" });
    return "skipped";
  }

  const kind = extractorFor((row.mime_type as string | null) ?? null, String(row.filename ?? ""));
  if (kind === "none") {
    await release({ parse_status: "skipped", parse_error: "no-text" });
    return "empty";
  }

  const file = await db.storage.from(String(row.bucket)).download(String(row.storage_path));
  if (file.error || !file.data) {
    await release({ parse_status: "failed", parse_error: "unreadable" });
    return "failed";
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const { text, from } = await textOf(kind, bytes, String(row.filename ?? ""), (row.mime_type as string | null) ?? null);

  const outcome = text === null ? "failed" : text.trim() ? "done" : "empty";
  const fields: Row =
    outcome === "done"
      ? { parse_status: "parsed", parse_error: null, parsed_data: { text: text!.trim(), extractedFrom: from, extractedAt: new Date().toISOString() } }
      : outcome === "empty"
        ? { parse_status: "skipped", parse_error: "no-text" }
        : { parse_status: "failed", parse_error: "unreadable" };

  // Write only if the file is still confirmed and still allowed for AI.
  const { data: written, error: writeErr } = await db
    .from("documents")
    .update({ ...fields, extraction_requested_at: null, extraction_lease_until: null })
    .eq("id", id)
    .eq("parse_status", "parsing")
    .eq("extraction_attempts", attempts + 1)
    .eq("kind_confirmed", true)
    .eq("available_to_llm", true)
    .select("id")
    .maybeSingle();
  if (writeErr) log.error({ err: serializeErr(writeErr) }, "extraction result write failed");
  if (!written) {
    // Kept out (or retyped) while it waited: no text, and the queue lets go of it.
    if (!writeErr) await release({ parse_status: "pending" });
    return "skipped";
  }
  return outcome;
}

export async function recoverExtractions(log: Log): Promise<number> {
  const db = serviceClient();
  if (!db) return 0;
  const since = new Date(Date.now() - RECOVERY_WINDOW_HOURS * 3_600_000).toISOString();
  const now = new Date().toISOString();
  // Expired leases belonged to a process that crashed or hung: retry, or give up after 3 attempts.
  const { data: expired, error: expiredErr } = await db
    .from("documents")
    .select("id, extraction_attempts")
    .eq("parse_status", "parsing")
    .not("extraction_requested_at", "is", null)
    .lt("extraction_lease_until", now)
    .limit(200);
  if (expiredErr) log.warn({ err: serializeErr(expiredErr) }, "extraction lease read failed");
  for (const r of expired ?? []) {
    const verdict = leaseVerdict({ extraction_attempts: Number(r.extraction_attempts ?? 0) });
    const fields = verdict === "give-up"
      ? { parse_status: "failed", parse_error: "gave-up", extraction_requested_at: null, extraction_lease_until: null }
      : { parse_status: "pending", extraction_lease_until: null };
    await db.from("documents").update(fields).eq("id", String(r.id)).eq("parse_status", "parsing").lt("extraction_lease_until", now);
  }
  // A request for a file since kept out or retyped is over: drop its marker so it can't linger as "queued".
  const { error: strandedErr } = await db
    .from("documents")
    .update({ extraction_requested_at: null, extraction_lease_until: null })
    .eq("parse_status", "pending")
    .not("extraction_requested_at", "is", null)
    .or("kind_confirmed.eq.false,available_to_llm.eq.false");
  if (strandedErr) log.warn({ err: serializeErr(strandedErr) }, "extraction marker cleanup failed");
  const { data, error } = await db
    .from("documents")
    .select("id")
    .eq("parse_status", "pending")
    .eq("kind_confirmed", true)
    .eq("available_to_llm", true)
    .gte("extraction_requested_at", since)
    .order("extraction_requested_at")
    .limit(100);
  if (error) {
    log.warn({ err: serializeErr(error) }, "extraction recovery read failed");
    return 0;
  }
  const ids = (data ?? []).map((r) => String(r.id));
  requestExtraction(ids, log);
  return ids.length;
}

export function startExtractionRecovery(app: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  const tick = () => void recoverExtractions(app.log).catch((err) => app.log.error({ err: serializeErr(err) }, "extraction recovery failed"));
  app.addHook("onReady", async () => {
    tick();
    timer = setInterval(tick, RECOVERY_EVERY_MS);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
}

/** Text for the type guess only: first pages of a PDF (jumps the queue, gives up after 5 s), or a text file. Never stored. */
export async function guessText(bytes: Uint8Array, mimeType: string, filename: string): Promise<string | null> {
  const kind = extractorFor(mimeType, filename);
  if (kind === "pdf") {
    const r = await extractPdfText(bytes, { maxPages: GUESS_PAGES, priority: "high", waitMs: 5_000 });
    return r.ok ? r.text.slice(0, GUESS_TEXT_LIMIT) : null;
  }
  if (kind === "text") return readDocumentText(Buffer.from(bytes), filename, mimeType)?.slice(0, GUESS_TEXT_LIMIT) ?? null;
  return null;
}
