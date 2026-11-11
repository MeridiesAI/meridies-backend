/**
 * A student's profile picture (rules in lib/studentAvatar.ts; no migration).
 *
 *   POST /students/:id/avatar/upload-url  { contentType?: "image/jpeg", sizeBytes }
 *                                         -> { bucket, path, token, uploadUrl, expiresIn, maxBytes, contentType }
 *   PUT  /students/:id/avatar             { path: string | null } -> { avatarUrl: string | null }
 *
 * The student (their own) or their primary counselor. `resolveStudentId(...,
 * "edit")` runs first; a counselor who only shares the student (even with
 * write access) is refused, because `profiles` lets only the primary counselor
 * update the row and the write runs on the caller's own client.
 *
 * The service client does three things, each only after those checks and only
 * inside this student's own folder of the private `student-banners` bucket:
 * mint the signed upload URL (the bucket's insert policy is student-self only,
 * so a counselor can't upload as themselves), read back the object a save names
 * (it must be there and really a JPEG; anything else is removed and refused),
 * and remove the photo a save replaced or cleared, plus abandoned uploads.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sniffImageType } from "../lib/branding.js";
import { badRequest, forbidden, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  AVATAR_UNSAVED_MAX,
  AVATAR_UPLOAD_EXPIRES_IN,
  avatarCleanup,
  avatarObjectPath,
  avatarUnavailable,
  isOwnAvatarPath,
  parseAvatarRef,
  signAvatarUrls,
  toAvatarRef,
} from "../lib/studentAvatar.js";
import { serviceClient } from "../lib/supabase.js";

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });

const uploadBody = z
  .object({
    contentType: z.literal("image/jpeg").optional(),
    sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES, "A photo can be at most 5 MB"),
  })
  .strict();

const putBody = z.object({ path: z.string().max(300).nullable() }).strict();

/** The student's row as the caller's own client reads it, refused unless the caller may change the photo. */
async function loadTarget(request: FastifyRequest, studentId: string): Promise<{ avatar_url: unknown }> {
  const { data, error } = await request.db
    .from("profiles")
    .select("id, role, counselor_id, avatar_url")
    .eq("id", studentId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data || data.role !== "student") throw notFound("That student isn't on your roster");
  if (request.auth.userId !== studentId && data.counselor_id !== request.auth.userId) {
    throw forbidden("Only the student and their own counselor can change their photo");
  }
  return data;
}

/** The uploaded object a save names: there, within the limit, and really a JPEG. Otherwise removed and refused. */
async function assertUploaded(path: string) {
  const svc = serviceClient();
  if (!svc) throw avatarUnavailable();
  const { data, error } = await svc.storage.from(AVATAR_BUCKET).download(path);
  if (error || !data) {
    const status = Number(
      (error as { status?: number; statusCode?: string } | null)?.status ?? (error as { statusCode?: string } | null)?.statusCode
    );
    if (/bucket not found/i.test(error?.message ?? "") || !(status >= 400 && status < 500)) throw avatarUnavailable();
    throw badRequest("That photo hasn't finished uploading");
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.length > AVATAR_MAX_BYTES || sniffImageType(bytes.subarray(0, 16)) !== "image/jpeg") {
    await svc.storage.from(AVATAR_BUCKET).remove([path]).catch(() => undefined);
    throw badRequest(bytes.length > AVATAR_MAX_BYTES ? "A photo can be at most 5 MB" : "That file isn't a JPEG image");
  }
}

export default async function studentAvatarRoutes(app: FastifyInstance) {
  app.post(
    "/:id/avatar/upload-url",
    { preHandler: [app.authenticate, limit("avatar:upload", 20, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = uploadBody.parse(request.body);
      const studentId = await resolveStudentId(request, id, "edit");
      const row = await loadTarget(request, studentId);
      const svc = serviceClient();
      if (!svc) throw avatarUnavailable();

      // Abandoned uploads (older than a signed URL lives, not the saved photo) go first, and the unsaved ones
      // are capped, so the folder can't become free storage. The banner and anything else is never touched.
      const { data: listed, error: listErr } = await svc.storage
        .from(AVATAR_BUCKET)
        .list(studentId, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
      if (listErr) {
        request.log.warn({ err: listErr }, "avatar folder list failed");
        throw avatarUnavailable();
      }
      const { remove, unsaved } = avatarCleanup(listed ?? [], studentId, parseAvatarRef(row.avatar_url, studentId));
      if (remove.length) await svc.storage.from(AVATAR_BUCKET).remove(remove).catch(() => undefined);
      if (unsaved >= AVATAR_UNSAVED_MAX) {
        throw new HttpError(429, "Too many unsaved photos. Try again in a couple of hours.", "avatar_folder_full");
      }

      const path = avatarObjectPath(studentId);
      const { data, error } = await svc.storage.from(AVATAR_BUCKET).createSignedUploadUrl(path);
      if (error || !data) {
        if (/bucket not found/i.test(error?.message ?? "")) throw avatarUnavailable();
        request.log.warn({ err: error }, "avatar upload url failed");
        throw badRequest("Couldn't start the upload. Try again.");
      }
      return {
        bucket: AVATAR_BUCKET,
        path,
        token: data.token,
        uploadUrl: data.signedUrl,
        expiresIn: AVATAR_UPLOAD_EXPIRES_IN,
        maxBytes: AVATAR_MAX_BYTES,
        contentType: b.contentType ?? "image/jpeg",
      };
    }
  );

  app.put("/:id/avatar", { preHandler: [app.authenticate, limit("avatar:save", 60, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { path } = putBody.parse(request.body);
    const studentId = await resolveStudentId(request, id, "edit");
    const before = await loadTarget(request, studentId);

    if (path !== null) {
      if (!isOwnAvatarPath(path, studentId)) throw badRequest("Upload the photo through /students/:id/avatar/upload-url first");
      await assertUploaded(path);
    }

    const { data, error } = await request.db
      .from("profiles")
      .update({ avatar_url: path === null ? null : toAvatarRef(path) })
      .eq("id", studentId)
      .select("id, avatar_url")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw forbidden("Only the student and their own counselor can change their photo");

    // The photo this replaced or cleared goes, best effort, and only from this student's own folder.
    const svc = serviceClient();
    const old = parseAvatarRef(before.avatar_url, studentId);
    if (svc && old && old !== path) await svc.storage.from(AVATAR_BUCKET).remove([old]).catch(() => undefined);

    const urls = await signAvatarUrls(svc, [data]);
    return { avatarUrl: urls.get(studentId) ?? null };
  });
}
