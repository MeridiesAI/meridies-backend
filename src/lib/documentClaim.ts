/**
 * Who may point a `documents` row at a Storage object, and what happens to
 * the object when the row goes.
 *
 * Storage lets anyone read an object that a documents row they can see points
 * at (student_documents_select, 20261011000001), and lets the row's owner
 * delete it. So a row is a key to its object, and registering one has to be
 * as strict as uploading there:
 *
 *   - the path's first segment is somewhere the caller could have uploaded
 *     (their own id, a student they can edit, a folder they can see, or
 *     `unfiled`), the bucket insert policy's own rule;
 *   - and when an object is already at that path, the caller uploaded it.
 *     An object with no row is normal (a counselor deleting a student's
 *     upload used to leave it behind), and a stranger who learned its path
 *     (storagePath is in the document DTO) must not claim it with a row.
 *
 * The database says the same for a client writing through PostgREST
 * (private.documents_guard_storage_path, 20261024000045); this is the rule
 * on a database without that file.
 */

import type { FastifyRequest } from "fastify";
import { badRequest, HttpError } from "./errors.js";
import { resolveStudentId } from "./guards.js";
import { serviceClient } from "./supabase.js";
import { DOCUMENTS_BUCKET, isSafeStoragePath } from "./storagePath.js";

const REFUSED = "That file path isn't one the app uploads to";

/** Whether the caller could have uploaded under this path's first segment. */
async function firstSegmentFileable(request: FastifyRequest, path: string): Promise<boolean> {
  const first = path.split("/")[0] ?? "";
  if (first === "unfiled" || first === request.auth.userId) return true;
  // A folder the caller can see (folders RLS decides).
  const { data: folder, error } = await request.db.from("folders").select("id").eq("id", first).maybeSingle();
  if (!error && folder) return true;
  // A student the caller can edit.
  try {
    await resolveStudentId(request, first, "edit");
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses (400) a path the caller may not register a row at, before the row
 * is written. Every refusal reads the same, so it says nothing about whether
 * an object is there. A Storage check that can't be made refuses with 503.
 */
export async function assertPathClaimable(request: FastifyRequest, path: string): Promise<void> {
  if (!isSafeStoragePath(path)) throw badRequest(REFUSED);
  if (!(await firstSegmentFileable(request, path))) throw badRequest(REFUSED);

  const svc = serviceClient();
  // Without the service role nothing can see past the caller's own reads;
  // the database trigger is then the only check (and the path is fileable).
  if (!svc) return;
  try {
    const there = await svc.storage.from(DOCUMENTS_BUCKET).exists(path);
    if (!there.data) return;
    // Someone's object is there: the caller may claim it only if it is theirs,
    // which their own client sees (Storage RLS lets an uploader read their object).
    const mine = await request.db.storage.from(DOCUMENTS_BUCKET).exists(path);
    if (!mine.data) throw badRequest(REFUSED);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    request.log.warn("document registration: storage check failed");
    throw new HttpError(503, "Files can't be registered just now. Try again in a minute.");
  }
}

/**
 * After a documents row is deleted, its object goes too, whoever uploaded it,
 * so a deleted file leaves nothing behind for anyone to claim. Only the
 * documents bucket and a path of the shape the app writes: an older row with
 * a crafted path ("/x", "a/../x") must not steer a service-role delete onto
 * another object. Best effort; (bucket, storage_path) is unique, so no other
 * row points at it.
 */
export async function removeDeletedDocumentObject(
  request: FastifyRequest,
  row: { bucket?: unknown; storage_path?: unknown }
): Promise<void> {
  const path = typeof row.storage_path === "string" ? row.storage_path : "";
  if (!path) return;
  const bucket = row.bucket ?? DOCUMENTS_BUCKET;
  if (bucket !== DOCUMENTS_BUCKET || !isSafeStoragePath(path)) {
    request.log.warn("document file left in storage: the row's path isn't one the app writes");
    return;
  }
  const svc = serviceClient();
  const client = svc ?? request.db;
  const removed = await client.storage.from(DOCUMENTS_BUCKET).remove([path]).catch(() => null);
  if (!removed || removed.error) request.log.warn("document file left in storage");
}
