/**
 * A college's campus photo as the API serves it (college_photos, migration
 * 20261023070001, loaded by lib/ingest/collegePhotos.ts).
 *
 * Every surface that shows a college (search cards, recommended, compare, a
 * profile, a student's college list, Events Hub, alumni) carries
 * `photo: CollegePhoto | null`. The two copies sit in the public
 * `college-photos` bucket, so the URLs need no signing; the row keeps paths,
 * not URLs, so the same data serves any Supabase project.
 *
 * A photo is decoration. Reading it never fails the request it rides on:
 * while the table is missing (code deployed before the migration) every read
 * answers an empty map and remembers that for five minutes, as
 * lib/deliveryInsert.ts does for its column; any other error is logged and
 * answered the same way.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { serializeErr } from "./requestLog.js";

export type CollegePhoto = {
  /** 1280 px wide (or the original, when narrower): the profile hero. */
  url: string;
  /** 500 px wide: cards, boards, events. */
  thumbUrl: string;
  width: number | null;
  height: number | null;
  alt: string;
  /** The author, as Commons gives it. Shown with the license wherever the photo is. */
  credit: string;
  license: string;
  /** The license deed, when Commons names one. */
  licenseUrl: string | null;
  /** The file's page on Wikimedia Commons. */
  sourceUrl: string;
  /** "File:..." on Commons. */
  title: string;
};

export type CollegePhotoRow = {
  college_id: string;
  storage_path: string;
  thumb_path: string;
  width: number | null;
  height: number | null;
  credit: string;
  license: string;
  license_url: string | null;
  source_url: string;
  commons_title: string;
};

export const PHOTO_COLUMNS =
  "college_id, storage_path, thumb_path, width, height, credit, license, license_url, source_url, commons_title";

export const MISSING_TABLE_TTL_MS = 5 * 60_000;
const CHUNK = 200;
const MISSING = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);

let missingUntil = 0;

/** The table or a column isn't there yet (the migration isn't applied). */
export const isMissingPhotoSchema = (code: string | undefined): boolean => MISSING.has(code ?? "");

/** For tests. */
export function resetCollegePhotoCache(): void {
  missingUntil = 0;
}

/** A path in the public college-photos bucket as a URL. */
export function publicUrl(path: string): string {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/college-photos/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A stored row as the DTO; alt text from the college's name as the caller has it. */
export function toCollegePhoto(r: CollegePhotoRow | undefined | null, collegeName: string): CollegePhoto | null {
  if (!r) return null;
  return {
    url: publicUrl(r.storage_path),
    thumbUrl: publicUrl(r.thumb_path),
    width: r.width ?? null,
    height: r.height ?? null,
    alt: `${collegeName} campus`,
    credit: r.credit,
    license: r.license,
    licenseUrl: r.license_url ?? null,
    sourceUrl: r.source_url,
    title: r.commons_title,
  };
}

type Warn = { warn: (o: object, m?: string) => void };

/**
 * The stored photo rows for these colleges, by college id, read as the caller
 * (RLS applies). Never throws: a missing table or a failed read is an empty map.
 */
export async function loadCollegePhotos(
  db: SupabaseClient,
  ids: (string | null | undefined)[],
  log?: Warn,
  now: number = Date.now()
): Promise<Map<string, CollegePhotoRow>> {
  const out = new Map<string, CollegePhotoRow>();
  const unique = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))];
  if (!unique.length || now < missingUntil) return out;
  for (let i = 0; i < unique.length; i += CHUNK) {
    let data: unknown;
    let error: { code?: string; message: string } | null;
    try {
      ({ data, error } = await db.from("college_photos").select(PHOTO_COLUMNS).in("college_id", unique.slice(i, i + CHUNK)));
    } catch (err) {
      log?.warn({ err: serializeErr(err) }, "college photos: read failed");
      return new Map();
    }
    if (error) {
      if (MISSING.has(error.code ?? "")) missingUntil = now + MISSING_TABLE_TTL_MS;
      else log?.warn({ err: serializeErr(error) }, "college photos: read failed");
      return new Map();
    }
    for (const r of (data ?? []) as CollegePhotoRow[]) out.set(String(r.college_id), r);
  }
  return out;
}

/** Load and serialize in one go, for callers that have the names to hand. */
export async function collegePhotosFor(
  db: SupabaseClient,
  colleges: { id: string; name: string }[],
  log?: Warn
): Promise<Map<string, CollegePhoto>> {
  const rows = await loadCollegePhotos(db, colleges.map((c) => c.id), log);
  const out = new Map<string, CollegePhoto>();
  for (const c of colleges) {
    const p = toCollegePhoto(rows.get(c.id), c.name);
    if (p) out.set(c.id, p);
  }
  return out;
}
