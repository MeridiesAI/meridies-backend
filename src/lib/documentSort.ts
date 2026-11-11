/**
 * Files auto-sort: which category an uploaded file goes in, from its name and its printed text
 * (`lib/documentGuess.ts`, no model). Two callers:
 *
 * - `POST /files/documents/guess` reads the bytes of a file the counselor is about to file, so the filing
 *   popup can open with its category already chosen (the counselor can still change it).
 * - `POST /files/documents` without a `kind` (a student's My documents, a hand-in, a Profile Update paperclip)
 *   reads the object it just registered, on the caller's own client, and files it under the guess.
 *
 * The bytes and the text are read in memory and dropped; only the label is kept. A file past the byte cap, or
 * one that can't be read, is sorted by its filename alone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { guessText } from "./documentExtraction.js";
import { guessKind, type KindGuess } from "./documentGuess.js";
import { downloadCapped } from "./storageDownload.js";
import { isSafeStoragePath } from "./storagePath.js";

/** The most the guess reads of one file. A resume, list, transcript or essay is far smaller. */
export const SORT_MAX_BYTES = 10 * 1024 * 1024;

/** Every documents.kind; a guess is always one of them. */
export type DocumentKind =
  | "transcript" | "resume" | "essay" | "test-report" | "award-letter" | "financial" | "common-app" | "other"
  | "recommendation-letter" | "activity-list" | "iep-504" | "counselor-only";

/** The guess for these bytes (empty: the filename alone). Never throws: an unreadable file is a filename guess. */
export async function sortBytes(bytes: Uint8Array, filename: string, mimeType: string | null): Promise<KindGuess> {
  let text: string | null = null;
  if (bytes.byteLength > 0 && bytes.byteLength <= SORT_MAX_BYTES) {
    text = await guessText(bytes, mimeType ?? "", filename).catch(() => null);
  }
  return guessKind({ filename, mimeType, text });
}

/** The guess for an object already in the documents bucket, read on `db` (the caller's client, so Storage RLS applies). */
export async function sortStoredObject(
  db: SupabaseClient,
  bucket: string,
  storagePath: string,
  filename: string,
  mimeType: string | null
): Promise<KindGuess> {
  if (!isSafeStoragePath(storagePath)) return guessKind({ filename, mimeType, text: null });
  const dl = await downloadCapped(db, bucket, storagePath, SORT_MAX_BYTES);
  return sortBytes(dl.status === "ok" ? new Uint8Array(dl.bytes.buffer, dl.bytes.byteOffset, dl.bytes.byteLength) : new Uint8Array(), filename, mimeType);
}

/** The kind a guess files under: its own, or "other" when it had none. */
export function kindOfGuess(guess: KindGuess): DocumentKind {
  return guess.kind ?? "other";
}
