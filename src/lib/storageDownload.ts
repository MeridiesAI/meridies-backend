/**
 * A Storage object read into memory, never more than a byte cap of it.
 *
 * `documents.size_bytes` is what the client said when it registered the file
 * (POST /files/documents accepts null or any number, and the column is
 * writable through PostgREST), so it can't decide whether a download is safe.
 * `download()` buffers the whole object, up to the bucket's 50 MB limit,
 * before anything can look at its length. This streams the body instead and
 * stops reading, and cancels the transfer, as soon as it passes the cap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type CappedDownload =
  | { status: "ok"; bytes: Buffer }
  | { status: "too-large" }
  | { status: "error" };

/** Reads at most `maxBytes` of a stream: the bytes, or "too-large" past the cap. */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ status: "ok"; bytes: Buffer } | { status: "too-large" }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { status: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { status: "ok", bytes: Buffer.concat(chunks, total) };
}

/**
 * `bucket/path` on `client` (the caller's own, so Storage RLS applies, or the
 * service client where the caller has already checked the relationship),
 * read up to `maxBytes`.
 */
export async function downloadCapped(
  client: SupabaseClient,
  bucket: string,
  path: string,
  maxBytes: number
): Promise<CappedDownload> {
  try {
    const { data, error } = await client.storage.from(bucket).download(path).asStream();
    if (error || !data) return { status: "error" };
    return await readCapped(data as ReadableStream<Uint8Array>, maxBytes);
  } catch {
    return { status: "error" };
  }
}
