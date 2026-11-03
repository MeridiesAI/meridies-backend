/**
 * A college's logo: the icon its own site declares, copied into the public
 * `college-logos` bucket (migration 20261105000001, `college_logos`).
 *
 * Why the school's own icon, copied: every school with a website publishes
 * one (an apple-touch-icon is usually its 180 px seal or mark), reading it
 * goes through lib/links.ts (SSRF-safe, pinned, capped), and serving our
 * copy means a viewer's browser never calls the school's site or a
 * third-party favicon service (which would hand that service every viewer's
 * address and which schools they look at).
 *
 * Reading never fails the request it rides on: while the table is missing
 * every read is an empty map, remembered five minutes (lib/collegePhotos.ts
 * does the same).
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { fetchIconImage, type PageIcon, type PageMeta } from "./links.js";
import { onOwnHost } from "./collegeLookup.js";
import { serializeErr } from "./requestLog.js";

export const LOGO_BUCKET = "college-logos";
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIN_PX = 48;
const MISSING = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);
const MISSING_TTL_MS = 5 * 60_000;
let missingUntil = 0;

export const isMissingLogoSchema = (code: string | undefined): boolean => MISSING.has(code ?? "");

/** For tests. */
export function resetCollegeLogoCache(): void {
  missingUntil = 0;
}

export type CollegeLogoRow = {
  college_id: string;
  storage_path: string | null;
  checked_at: string;
};

export function logoPublicUrl(path: string): string {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${LOGO_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The stored logo rows for these colleges (looked-up-and-none rows included). Never throws. */
export async function loadCollegeLogos(
  db: SupabaseClient,
  ids: (string | null | undefined)[],
  log?: { warn: (o: object, m?: string) => void },
  now: number = Date.now()
): Promise<Map<string, CollegeLogoRow>> {
  const out = new Map<string, CollegeLogoRow>();
  const unique = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))];
  if (!unique.length || now < missingUntil) return out;
  for (let i = 0; i < unique.length; i += 200) {
    try {
      const { data, error } = await db
        .from("college_logos")
        .select("college_id, storage_path, checked_at")
        .in("college_id", unique.slice(i, i + 200));
      if (error) {
        if (MISSING.has(error.code ?? "")) missingUntil = now + MISSING_TTL_MS;
        else log?.warn({ err: serializeErr(error) }, "college logos: read failed");
        return new Map();
      }
      for (const r of (data ?? []) as CollegeLogoRow[]) out.set(String(r.college_id), r);
    } catch (err) {
      log?.warn({ err: serializeErr(err) }, "college logos: read failed");
      return new Map();
    }
  }
  return out;
}

/** The logo's public URL, or null. */
export const logoUrlOf = (r: CollegeLogoRow | undefined | null): string | null =>
  r?.storage_path ? logoPublicUrl(r.storage_path) : null;

/** Load and turn into `id -> logoUrl` for callers that only need the address. */
export async function collegeLogoUrls(
  db: SupabaseClient,
  ids: (string | null | undefined)[],
  log?: { warn: (o: object, m?: string) => void }
): Promise<Map<string, string>> {
  const rows = await loadCollegeLogos(db, ids, log);
  const out = new Map<string, string>();
  for (const [id, r] of rows) {
    const url = logoUrlOf(r);
    if (url) out.set(id, url);
  }
  return out;
}

// ---- Choosing and reading the icon (pure parts unit-tested) ---------------------------------

/** The largest square size an icon declares ("180x180", "16x16 32x32"), or null. */
export function declaredSize(sizes: string | null): number | null {
  if (!sizes) return null;
  let best: number | null = null;
  for (const part of sizes.split(/\s+/)) {
    const m = /^(\d{1,4})x(\d{1,4})$/.exec(part);
    if (m) best = Math.max(best ?? 0, Math.min(Number(m[1]), Number(m[2])));
  }
  return best;
}

/**
 * The icons worth trying, best first: on the school's own host (or a
 * subdomain), never SVG or ICO, apple-touch-icon first, then the largest
 * declared size; icons that declare a size under LOGO_MIN_PX are left out.
 * Then the conventional /apple-touch-icon.png at the site's root.
 */
export function iconCandidates(meta: Pick<PageMeta, "finalUrl" | "icons">, host: string): string[] {
  const ok = (meta.icons ?? []).filter((i: PageIcon) => {
    if (!onOwnHost(i.href, host)) return false;
    const path = (() => {
      try {
        return new URL(i.href).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (path.endsWith(".svg") || path.endsWith(".ico")) return false;
    if (i.type && /svg|icon|x-icon/.test(i.type)) return false;
    if (i.rel.includes("mask-icon")) return false;
    const size = declaredSize(i.sizes);
    return size === null || size >= LOGO_MIN_PX;
  });
  const score = (i: PageIcon) => (i.rel.includes("apple-touch-icon") ? 10_000 : 0) + (declaredSize(i.sizes) ?? 1);
  const out = [...ok].sort((a, b) => score(b) - score(a)).map((i) => i.href);
  try {
    const root = new URL("/apple-touch-icon.png", meta.finalUrl).toString();
    if (onOwnHost(root, host) && !out.includes(root)) out.push(root);
  } catch {
    // no root
  }
  return [...new Set(out)].slice(0, 4);
}

/** Width and height of a PNG (IHDR), a JPEG (frame header) or a WebP (VP8 / VP8L / VP8X); null if unreadable. */
export function imageSize(b: Uint8Array, type: "png" | "jpg" | "webp"): { width: number; height: number } | null {
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  if (type === "png") {
    if (b.length < 24) return null;
    const w = ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0;
    const h = ((b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!) >>> 0;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (type === "webp") {
    if (b.length < 30) return null;
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return null;
  }
  // JPEG: walk the markers to the first frame header.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Whether an icon of this size is worth showing as a logo: big enough and roughly square or wide. */
export function usableLogoSize(s: { width: number; height: number } | null): boolean {
  if (!s) return false;
  return s.width >= LOGO_MIN_PX && s.height >= LOGO_MIN_PX * 0.5 && s.width <= 4096 && s.height <= 4096 && s.height <= s.width * 1.5;
}

export function logoPath(unitid: number, sha1: string, ext: "png" | "jpg" | "webp"): string {
  if (!Number.isInteger(unitid) || unitid < 100000 || unitid > 999999) throw new Error("unitid out of range");
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error("sha1 malformed");
  return `${unitid}/logo-${sha1}.${ext}`;
}

export type LogoOutcome = { storagePath: string | null; note: string | null };

export type LogoDeps = {
  fetchIcon?: typeof fetchIconImage;
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  save: (row: { college_id: string; storage_path: string | null; source_url: string | null; width: number | null; height: number | null }) => Promise<void>;
  log?: { warn: (o: object, m?: string) => void };
};

/**
 * Find the school's icon on its site and store it. Records the attempt either
 * way (a row with no path), so the automatic lookup waits a week before trying
 * again. Never throws for a missing icon; a storage or database failure does.
 */
export async function lookUpLogo(
  college: { id: string; unitid: number | null },
  meta: Pick<PageMeta, "finalUrl" | "icons"> | null,
  host: string | null,
  d: LogoDeps
): Promise<LogoOutcome> {
  if (college.unitid === null || !meta || !host) {
    await d.save({ college_id: college.id, storage_path: null, source_url: null, width: null, height: null });
    return { storagePath: null, note: "The school's site couldn't be read." };
  }
  for (const url of iconCandidates(meta, host)) {
    try {
      const img = await (d.fetchIcon ?? fetchIconImage)(url, LOGO_MAX_BYTES);
      if (!onOwnHost(img.finalUrl, host)) continue;
      const size = imageSize(img.bytes, img.type);
      if (!usableLogoSize(size)) continue;
      const sha1 = createHash("sha1").update(img.bytes).digest("hex");
      const path = logoPath(college.unitid, sha1, img.type);
      await d.upload(path, img.bytes, img.type === "jpg" ? "image/jpeg" : `image/${img.type}`);
      await d.save({ college_id: college.id, storage_path: path, source_url: img.finalUrl, width: size!.width, height: size!.height });
      return { storagePath: path, note: null };
    } catch (err) {
      d.log?.warn({ err: err instanceof Error ? err.message : "failed" }, "college logo: icon not usable");
    }
  }
  await d.save({ college_id: college.id, storage_path: null, source_url: null, width: null, height: null });
  return { storagePath: null, note: "The school's site has no usable icon." };
}

/** The service-role store for lookUpLogo. */
export function supabaseLogoStore(svc: SupabaseClient): Pick<LogoDeps, "upload" | "save"> {
  return {
    async upload(path, bytes, contentType) {
      const { error } = await svc.storage.from(LOGO_BUCKET).upload(path, bytes, { contentType, upsert: true, cacheControl: "31536000" });
      if (error) throw new Error("logo upload failed");
    },
    async save(row) {
      const { error } = await svc
        .from("college_logos")
        .upsert({ ...row, checked_at: new Date().toISOString() }, { onConflict: "college_id" });
      if (error) throw new Error(`college_logos upsert: ${error.code ?? "error"}`);
    },
  };
}
