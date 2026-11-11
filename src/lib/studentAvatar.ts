/**
 * A student's profile picture (no migration: `profiles.avatar_url` and the
 * private `student-banners` bucket already exist).
 *
 * The photo is one JPEG the browser cropped to a square, stored at
 * `<student id>/avatar-<16 hex>.jpg` in `student-banners` (the API names it,
 * never the client). `profiles.avatar_url` then holds a stored reference,
 * `storage:student-banners/<path>`, not a URL: the bucket is private, so every
 * read turns the reference into a short-lived signed URL (`signAvatarUrls`).
 * An https URL already in the column (a Google sign-in's picture) passes
 * through unchanged; anything else reads as no photo.
 *
 * A reference is honoured only when its folder is the row's own student id, so
 * a value a student wrote into their own row through PostgREST can never make
 * the API sign another student's object.
 */

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors.js";

export const AVATAR_BUCKET = "student-banners";
/** The prefix a stored reference starts with; the only place the scheme is spelled. */
export const AVATAR_REF_PREFIX = `storage:${AVATAR_BUCKET}/`;
/** The bucket's own limit; the app crops to a 512 px JPEG, far under it. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** How long a signed read URL lives. The pages re-ask on every load. */
export const AVATAR_SIGNED_TTL = 3600;
/** How long Supabase keeps a signed upload URL valid (fixed by Storage: two hours). */
export const AVATAR_UPLOAD_EXPIRES_IN = 7200;
/** An unsaved avatar upload older than this is abandoned (a signed upload URL lives two hours). */
export const AVATAR_STALE_MS = 2 * 3600 * 1000;
/** At most this many unsaved avatar uploads in a student's folder before another upload URL is minted. */
export const AVATAR_UNSAVED_MAX = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_NAME = /^avatar-[0-9a-f]{16}\.jpg$/;

/** A new object path for this student's photo. */
export function avatarObjectPath(studentId: string): string {
  if (!UUID.test(studentId)) throw new Error("avatarObjectPath: not a student id");
  return `${studentId}/avatar-${randomBytes(8).toString("hex")}.jpg`;
}

/** True when `path` is exactly the shape `avatarObjectPath(studentId)` mints. */
export function isOwnAvatarPath(path: unknown, studentId: string): path is string {
  if (typeof path !== "string" || !UUID.test(studentId)) return false;
  const slash = path.indexOf("/");
  if (slash < 0) return false;
  return path.slice(0, slash) === studentId && OBJECT_NAME.test(path.slice(slash + 1));
}

/** The value written to `profiles.avatar_url` for an uploaded photo. */
export function toAvatarRef(path: string): string {
  return `${AVATAR_REF_PREFIX}${path}`;
}

/** The object path a stored reference names, when it is this student's own photo; else null. */
export function parseAvatarRef(value: unknown, studentId: string): string | null {
  if (typeof value !== "string" || !value.startsWith(AVATAR_REF_PREFIX)) return null;
  const path = value.slice(AVATAR_REF_PREFIX.length);
  return isOwnAvatarPath(path, studentId) ? path : null;
}

/** An https URL someone else hosts (a Google picture): shown as it is. */
export function isExternalAvatarUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What a response may show for a row without signing anything: an https URL
 * as it is, null for a stored reference (or anything else). Every serializer
 * uses this as its default, so a raw `storage:` value never reaches a client.
 */
export function unsignedAvatarUrl(value: unknown): string | null {
  return isExternalAvatarUrl(value) ? value : null;
}

/**
 * Each row's displayable avatar URL, by id. Stored references are signed in
 * one `createSignedUrls` batch on the client handed in (the service role:
 * the bucket's read policy covers only the student and their primary
 * counselor). Call it only with rows the caller's own RLS query returned.
 * A failed signing reads as no photo, never an error.
 */
export async function signAvatarUrls(
  svc: SupabaseClient | null,
  rows: { id: unknown; avatar_url?: unknown }[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const toSign = new Map<string, string[]>(); // path -> ids
  for (const r of rows) {
    const id = String(r.id);
    const path = parseAvatarRef(r.avatar_url, id);
    if (path) {
      toSign.set(path, [...(toSign.get(path) ?? []), id]);
      out.set(id, null);
    } else {
      out.set(id, unsignedAvatarUrl(r.avatar_url));
    }
  }
  if (toSign.size === 0 || !svc) return out;
  try {
    const { data, error } = await svc.storage.from(AVATAR_BUCKET).createSignedUrls([...toSign.keys()], AVATAR_SIGNED_TTL);
    if (error || !data) return out;
    for (const item of data) {
      if (!item.path || item.error || !item.signedUrl) continue;
      for (const id of toSign.get(item.path) ?? []) out.set(id, item.signedUrl);
    }
  } catch {
    /* no photo beats a failed page */
  }
  return out;
}

/**
 * Which of a student's own unsaved avatar uploads to remove before minting
 * another upload URL, and how many unsaved ones stay. Only `avatar-*.jpg`
 * objects are looked at (the folder also holds the banner, which is never
 * touched); the saved photo (`keep`, a full path) is never removed.
 */
export function avatarCleanup(
  objects: { name: string; created_at?: string | null }[],
  studentId: string,
  keep: string | null,
  now: number = Date.now()
): { remove: string[]; unsaved: number } {
  const remove: string[] = [];
  let unsaved = 0;
  for (const o of objects) {
    if (!OBJECT_NAME.test(o.name)) continue;
    const path = `${studentId}/${o.name}`;
    if (path === keep) continue;
    const at = typeof o.created_at === "string" ? Date.parse(o.created_at) : NaN;
    if (Number.isFinite(at) && now - at > AVATAR_STALE_MS) remove.push(path);
    else unsaved += 1;
  }
  return { remove, unsaved };
}

export const avatarUnavailable = () =>
  new HttpError(503, "Profile pictures aren't switched on yet", "avatar_unavailable");
