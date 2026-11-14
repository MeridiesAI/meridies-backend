/**
 * A counselor's own profile picture (Settings › Customize). Rules and storage are the student picture's
 * (lib/studentAvatar.ts, routes/studentAvatar.ts; no migration): one JPEG the browser cropped to a square, in the
 * caller's own folder of the private `student-banners` bucket, `profiles.avatar_url` holding a stored reference
 * that every read turns into a short-lived signed URL (GET /auth/me).
 *
 *   POST /profile/avatar/upload-url  { contentType?: "image/jpeg", sizeBytes }
 *                                    -> { bucket, path, token, uploadUrl, expiresIn, maxBytes, contentType }
 *   PUT  /profile/avatar             { path: string | null } -> { avatarUrl: string | null }
 *
 * Counselors only, and only their own row: there is no id in the address, the folder is the caller's id and the
 * write runs on the caller's own client. The service client does what the student route's does, inside that one
 * folder: mints the signed upload URL (the bucket's insert policy is student-self only), reads back the object a
 * save names (it must be there and really a JPEG; anything else is removed and refused), and removes the photo a
 * save replaced or cleared, plus abandoned uploads.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sniffImageType } from "../lib/branding.js";
import { badRequest, forbidden, fromPostgrest, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
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

const uploadBody = z
  .object({
    contentType: z.literal("image/jpeg").optional(),
    sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES, "A photo can be at most 5 MB"),
  })
  .strict();

const putBody = z.object({ path: z.string().max(300).nullable() }).strict();

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

export default async function counselorAvatarRoutes(app: FastifyInstance) {
  app.post(
    "/upload-url",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("avatar:upload", 20, 3600)] },
    async (request) => {
      const b = uploadBody.parse(request.body);
      const me = request.auth.userId;
      const { data: row, error: rowErr } = await request.db.from("profiles").select("id, avatar_url").eq("id", me).maybeSingle();
      if (rowErr) throw fromPostgrest(rowErr);
      if (!row) throw forbidden("Only you can change your photo");
      const svc = serviceClient();
      if (!svc) throw avatarUnavailable();

      // Abandoned uploads (older than a signed URL lives, not the saved photo) go first, and the unsaved ones
      // are capped, so the folder can't become free storage.
      const { data: listed, error: listErr } = await svc.storage
        .from(AVATAR_BUCKET)
        .list(me, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
      if (listErr) {
        request.log.warn({ err: listErr }, "counselor avatar folder list failed");
        throw avatarUnavailable();
      }
      const { remove, unsaved } = avatarCleanup(listed ?? [], me, parseAvatarRef(row.avatar_url, me));
      if (remove.length) await svc.storage.from(AVATAR_BUCKET).remove(remove).catch(() => undefined);
      if (unsaved >= AVATAR_UNSAVED_MAX) {
        throw new HttpError(429, "Too many unsaved photos. Try again in a couple of hours.", "avatar_folder_full");
      }

      const path = avatarObjectPath(me);
      const { data, error } = await svc.storage.from(AVATAR_BUCKET).createSignedUploadUrl(path);
      if (error || !data) {
        if (/bucket not found/i.test(error?.message ?? "")) throw avatarUnavailable();
        request.log.warn({ err: error }, "counselor avatar upload url failed");
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

  app.put(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("avatar:save", 60, 3600)] },
    async (request) => {
      const { path } = putBody.parse(request.body);
      const me = request.auth.userId;
      const { data: before, error: beforeErr } = await request.db.from("profiles").select("id, avatar_url").eq("id", me).maybeSingle();
      if (beforeErr) throw fromPostgrest(beforeErr);
      if (!before) throw forbidden("Only you can change your photo");

      if (path !== null) {
        if (!isOwnAvatarPath(path, me)) throw badRequest("Upload the photo through /profile/avatar/upload-url first");
        await assertUploaded(path);
      }

      const { data, error } = await request.db
        .from("profiles")
        .update({ avatar_url: path === null ? null : toAvatarRef(path) })
        .eq("id", me)
        .select("id, avatar_url")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw forbidden("Only you can change your photo");

      // The photo this replaced or cleared goes, best effort, and only from the caller's own folder.
      const svc = serviceClient();
      const old = parseAvatarRef(before.avatar_url, me);
      if (svc && old && old !== path) await svc.storage.from(AVATAR_BUCKET).remove([old]).catch(() => undefined);

      const urls = await signAvatarUrls(svc, [data]);
      return { avatarUrl: urls.get(me) ?? null };
    }
  );
}
