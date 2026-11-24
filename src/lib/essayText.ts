/**
 * Where an essay's text stands, and reading a linked Google Doc's text in.
 *
 * An essay row's `body` is the text Meridies has read; `word_count` is the
 * database's count of it. A row that only carries a pasted link
 * (`external_url`) has no text until something reads the Doc in (POST
 * /application/essays/sync, or a Narrative Coherence run that ticks it), so a
 * count of 0 there means "not read yet", not "empty". `text_synced_at` marks
 * the first read: a linked row with no text and no read yet is `pending`.
 *
 * A linked Doc is read only with the grant of whoever linked it
 * (`link_owner_id`, set by the database): a student can't plant a link to a
 * counselor's private file and have the counselor's read copy it into a body
 * the student can see. Reading reuses lib/supplementDocs.ts's Doc export.
 *
 * Only the essay counts. A Doc often holds a title, the prompt, notes or an
 * old draft as well, so the text is cut down to the essay the way an uploaded
 * file is (lib/applicationText.ts essayOnly: AxIS quotes where the essay starts
 * and ends, code takes that exact slice). Materials (`essay_kind` "other") are
 * counted whole.
 *
 * A Doc is read again only when Google says it changed after the last read
 * (its modified time against `text_synced_at`), so an unchanged Doc costs one
 * metadata call and no AI. Rows last read before READ_RULE_SINCE are read once
 * more, so text stored whole before the essay-only rule gets cut down.
 */
import type { FastifyRequest } from "fastify";
import { essayOnly } from "./applicationText.js";
import { documentReadableForTask, toAiDoc } from "./context/documentAi.js";
import { HttpError } from "./errors.js";
import { serializeErr } from "./requestLog.js";
import { exportDocTextResult, googleDocIdFromUrl } from "./supplementDocs.js";
import { exportGoogleDocText, getRemoteFile, type RemoteFile } from "./suiteApi.js";

type Row = Record<string, unknown>;

/**
 * - `read`: there is text (and so a word count).
 * - `pending`: linked to a Doc whose text hasn't been read in yet; the count isn't known.
 * - `unreadable`: a file Meridies can't read (a scan, an image-only PDF).
 * - `empty`: nothing is linked, or it was read and holds no words.
 */
export type EssayTextState = "read" | "pending" | "unreadable" | "empty";

/** The columns `essayTextState` reads. */
export const ESSAY_TEXT_COLUMNS =
  "student_id, essay_kind, prompt, word_count, text_status, text_synced_at, external_url, link_owner_id, document_id, supplement_doc_id";

/**
 * Text read before this moment may still be a whole Doc (before the essay-only rule), so it is read once more even
 * when the Doc hasn't changed. Set a few days after the fix ships; move it forward if it ships later.
 */
export const READ_RULE_SINCE = "2026-12-01T00:00:00Z";

/** Whether a row was read in under the essay-only rule (read at all, not waiting, at or after READ_RULE_SINCE). */
export function readUnderRule(e: Row): boolean {
  if (e.text_status === "pending" || typeof e.text_synced_at !== "string") return false;
  const read = Date.parse(e.text_synced_at);
  return Number.isFinite(read) && read >= Date.parse(READ_RULE_SINCE);
}

/** Whether a row read in under the rule is still current: Google says its Doc was last modified no later than that read. */
export function stillCurrent(e: Row, modifiedAt: string | null): boolean {
  if (!readUnderRule(e) || !modifiedAt) return false;
  const modified = Date.parse(modifiedAt);
  return Number.isFinite(modified) && modified <= Date.parse(String(e.text_synced_at));
}

export type Trim = (request: FastifyRequest, studentId: string, text: string, opts: { aiAllowed: boolean; prompt?: string | null }) => Promise<{ text: string }>;

/** The essay inside a Doc's text: materials whole, anything else cut down to the essay (lib/applicationText.ts). */
async function essayPart(request: FastifyRequest, e: Row, text: string, aiAllowed: boolean, trim: Trim = essayOnly): Promise<string> {
  if (!text || e.essay_kind === "other" || !e.student_id) return text;
  return (await trim(request, String(e.student_id), text, { aiAllowed, prompt: typeof e.prompt === "string" ? e.prompt : null })).text;
}

/** A row whose only source is a pasted link: no stored file, no supplement Doc. */
const pastedLink = (e: Row): boolean => Boolean(e.external_url) && !e.document_id && !e.supplement_doc_id;

export function essayTextState(e: Row): EssayTextState {
  if (e.text_status === "unreadable") return "unreadable";
  if (Number(e.word_count ?? 0) > 0) return "read";
  if (e.text_status === "pending") return "pending";
  if (pastedLink(e) && !e.text_synced_at) return "pending";
  return "empty";
}

export type LinkedDoc = { fileId: string } | { reason: "not-linked" | "not-google" | "not-mine" };

/** The Google Doc behind a pasted link that `userId` may read in, or why not. */
export function linkedGoogleDoc(e: Row, userId: string): LinkedDoc {
  if (!pastedLink(e)) return { reason: "not-linked" };
  const fileId = googleDocIdFromUrl(String(e.external_url));
  if (!fileId) return { reason: "not-google" };
  if (!userId || e.link_owner_id !== userId) return { reason: "not-mine" };
  return { fileId };
}

export type LinkedReadFailure = {
  ok: false;
  /**
   * not-picked: the Drive grant doesn't reach that Doc (drive.file: only Docs the app made or the person picked).
   * no-access: the caller's Google connection can't be used (not connected, or the permission isn't granted);
   * `message` says which, in the caller's own words.
   */
  reason: "not-linked" | "not-google" | "not-mine" | "not-picked" | "no-access" | "failed";
  message?: string;
};
export type LinkedRead = { ok: true; text: string; changed: boolean; row: Row | null } | LinkedReadFailure;

type Exporter = typeof exportDocTextResult;
type ModifiedAt = (userId: string, fileId: string) => Promise<string | null>;

/** A Google file's modified time, through the same Drive grant; throws when the grant can't see it. */
const driveModifiedAt =
  (request: FastifyRequest): ModifiedAt =>
  async (userId, fileId) =>
    (await getRemoteFile(userId, "google", fileId, null, request.log)).modifiedAt;

/** Store a fresh read: the text when it changed, and always the read time (so the next sync can skip it). */
async function storeRead(request: FastifyRequest, e: Row, text: string, opts: { select?: string; now?: string }) {
  const changed = text !== String(e.body ?? "");
  const now = opts.now ?? new Date().toISOString();
  const update: Row = changed ? { body: text, text_status: "read", text_synced_at: now } : { text_status: "read", text_synced_at: now };
  const { data, error } = await request.db
    .from("essays")
    .update(update)
    .eq("id", String(e.id))
    .select(opts.select ?? "id")
    .maybeSingle();
  if (error || !data) {
    if (error) request.log.warn({ err: serializeErr(error) }, "essay text write failed");
    return null;
  }
  return { changed, row: data as unknown as Row };
}

/**
 * Read a linked essay's Google Doc in, with the caller's own grant, cut it down to the essay, and store it the way
 * Essays sync does (the trigger recounts the words). A row already read under the essay-only rule whose Doc hasn't
 * changed since is left alone (one metadata call, nothing written: `row` null). Any real read stamps
 * `text_synced_at`, so an empty Doc stops reading as `pending`. `e` needs id, body and the ESSAY_TEXT_COLUMNS.
 */
export async function readLinkedEssay(
  request: FastifyRequest,
  e: Row,
  opts: { select?: string; now?: string; exportText?: Exporter; trim?: Trim; modifiedAt?: ModifiedAt } = {}
): Promise<LinkedRead> {
  const target = linkedGoogleDoc(e, request.auth.userId);
  if (!("fileId" in target)) return { ok: false, reason: target.reason };
  if (readUnderRule(e)) {
    // A Doc the grant can't see answers nothing here and goes on to the export, which says why.
    const at = await (opts.modifiedAt ?? driveModifiedAt(request))(request.auth.userId, target.fileId).catch(() => null);
    if (stillCurrent(e, at)) return { ok: true, text: String(e.body ?? ""), changed: false, row: null };
  }
  const exportText = opts.exportText ?? exportDocTextResult;
  let r: Awaited<ReturnType<Exporter>>;
  try {
    r = await exportText(request.auth.userId, target.fileId, request.log);
  } catch (err) {
    // Not connected, or the Drive permission isn't granted: our own message, written to the caller.
    if (err instanceof HttpError && err.statusCode === 409) return { ok: false, reason: "no-access", message: err.message };
    request.log.warn({ err: serializeErr(err) }, "linked essay doc export threw");
    return { ok: false, reason: "failed" };
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  // An essay body is AI-readable already; runStructured still honours the practice's document-reading switch.
  const text = await essayPart(request, e, r.text, true, opts.trim);
  const stored = await storeRead(request, e, text, opts);
  if (!stored) return { ok: false, reason: "failed" };
  return { ok: true, text, ...stored };
}

/** Why a Drive-picked essay was not read: not that kind of file or not the caller's to read (skip), or a failure. */
export type PickedRead =
  | { ok: true; changed: boolean; row: Row | null }
  | { ok: false; reason: "skip" | "no-access" | "failed"; message?: string };

/**
 * An essay filed from a document picked in Google Drive (`document_id`), read again from Drive when the Doc changed
 * after the last read. Read only by whoever picked it (`documents.owner_id`) and only for a confirmed file, the rule
 * POST /essays/from-document uses; cut down to the essay under the document AI rules. `doc` is the documents row.
 */
export async function readPickedEssay(
  request: FastifyRequest,
  e: Row,
  doc: Row,
  opts: {
    select?: string;
    now?: string;
    getFile?: (userId: string, fileId: string, driveId: string | null) => Promise<RemoteFile>;
    exportText?: (userId: string, file: RemoteFile) => Promise<string | null>;
    trim?: Trim;
  } = {}
): Promise<PickedRead> {
  const me = request.auth.userId;
  if (
    !me ||
    doc.id !== e.document_id ||
    doc.student_id !== e.student_id ||
    doc.external_provider !== "google" ||
    !doc.external_file_id ||
    doc.owner_id !== me ||
    doc.kind_confirmed === false
  ) {
    return { ok: false, reason: "skip" };
  }
  const getFile = opts.getFile ?? ((u, f, d) => getRemoteFile(u, "google", f, d, request.log));
  const exportText = opts.exportText ?? ((u, f) => exportGoogleDocText(u, f, request.log));
  let text: string | null;
  try {
    const file = await getFile(me, String(doc.external_file_id), (doc.external_drive_id as string | null) ?? null);
    if (file.mimeType !== "application/vnd.google-apps.document") return { ok: false, reason: "skip" };
    if (stillCurrent(e, file.modifiedAt)) return { ok: true, changed: false, row: null };
    text = await exportText(me, file);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409) return { ok: false, reason: "no-access", message: err.message };
    request.log.warn({ err: serializeErr(err) }, "picked essay doc read failed");
    return { ok: false, reason: "failed" };
  }
  if (text === null) return { ok: false, reason: "failed" };
  const aiAllowed = documentReadableForTask(toAiDoc(doc), true).allowed;
  const stored = await storeRead(request, e, await essayPart(request, e, text, aiAllowed, opts.trim), opts);
  return stored ? { ok: true, ...stored } : { ok: false, reason: "failed" };
}
