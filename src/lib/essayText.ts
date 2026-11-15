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
 */
import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";
import { serializeErr } from "./requestLog.js";
import { exportDocTextResult, googleDocIdFromUrl } from "./supplementDocs.js";

type Row = Record<string, unknown>;

/**
 * - `read`: there is text (and so a word count).
 * - `pending`: linked to a Doc whose text hasn't been read in yet; the count isn't known.
 * - `unreadable`: a file Meridies can't read (a scan, an image-only PDF).
 * - `empty`: nothing is linked, or it was read and holds no words.
 */
export type EssayTextState = "read" | "pending" | "unreadable" | "empty";

/** The columns `essayTextState` reads. */
export const ESSAY_TEXT_COLUMNS = "word_count, text_status, text_synced_at, external_url, link_owner_id, document_id, supplement_doc_id";

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

/**
 * Read a linked essay's Google Doc in, with the caller's own grant, and store the text the way Essays sync does
 * (the trigger recounts the words). The first read stamps `text_synced_at` even when the text is unchanged (an
 * empty Doc), so the row stops reading as `pending`. `row` is the updated row (`select`), or null when nothing
 * was written. `e` needs id, body, text_status, text_synced_at and the columns `linkedGoogleDoc` reads.
 */
export async function readLinkedEssay(
  request: FastifyRequest,
  e: Row,
  opts: { select?: string; now?: string; exportText?: Exporter } = {}
): Promise<LinkedRead> {
  const target = linkedGoogleDoc(e, request.auth.userId);
  if (!("fileId" in target)) return { ok: false, reason: target.reason };
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

  const changed = r.text !== String(e.body ?? "");
  if (!changed && e.text_synced_at && e.text_status !== "pending") return { ok: true, text: r.text, changed: false, row: null };
  const now = opts.now ?? new Date().toISOString();
  const update: Row = changed ? { body: r.text, text_status: "read", text_synced_at: now } : { text_status: "read", text_synced_at: now };
  const { data, error } = await request.db
    .from("essays")
    .update(update)
    .eq("id", String(e.id))
    .select(opts.select ?? "id")
    .maybeSingle();
  if (error || !data) {
    if (error) request.log.warn({ err: serializeErr(error) }, "linked essay text write failed");
    return { ok: false, reason: "failed" };
  }
  return { ok: true, text: r.text, changed, row: data as unknown as Row };
}
