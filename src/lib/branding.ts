/**
 * Practice branding: a logo, a banner and an accent colour (20261111000008).
 *
 * Two scopes, one shape. A counselor in a firm sees the firm's branding (the
 * `firms` columns, written by the firm's owners and admins); a solo counselor
 * has their own `counselor_branding` row. `GET/PUT /branding` and
 * `POST /branding/upload-url` (routes/branding.ts) pick the scope with
 * `brandingScope`, and `PATCH /firms/mine` shares the editor check and the
 * column rules below, so the two ways of saving firm branding can't drift.
 *
 * Images live in the public `branding` bucket under `<scope id>/`, as
 * `<kind>-<16 hex>.<png|jpg|webp>`: the API names every object, never the
 * client. Nothing but an API-minted signed upload URL writes there (the bucket
 * has no storage.objects policy), and a saved URL must be this project's public
 * URL of an object in the caller's own folder, of the field's own kind
 * (`ownBrandingPath`). Never SVG: a browser runs script from one.
 */

import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { forbidden, HttpError } from "./errors.js";

export const BRANDING_BUCKET = "branding";

export const BRANDING_KINDS = ["logo", "banner"] as const;
export type BrandingKind = (typeof BRANDING_KINDS)[number];

/** The only types accepted, and the extension each is stored under. */
export const BRANDING_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type BrandingType = keyof typeof BRANDING_TYPES;
const EXT_TYPES: Record<string, BrandingType> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** The bucket's own limit is the banner's 4 MB; a logo's 2 MB is held here and checked again on save. */
export const BRANDING_MAX_BYTES: Record<BrandingKind, number> = { logo: 2 * 1024 * 1024, banner: 4 * 1024 * 1024 };

/** How long Supabase keeps a signed upload URL valid (fixed by Storage: two hours). */
export const BRANDING_UPLOAD_EXPIRES_IN = 7200;

export const ACCENT_SOURCES = ["default", "logo", "banner", "manual"] as const;
export type AccentSource = (typeof ACCENT_SOURCES)[number];

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** "#RRGGBB" and nothing else: the client interpolates it into styles. */
export const hexColor = z.string().trim().regex(HEX, "Use a #RRGGBB colour");
export const accentColorSource = z.enum(ACCENT_SOURCES);

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v);
}

export const brandingUploadBody = z
  .object({
    kind: z.enum(BRANDING_KINDS),
    contentType: z.enum(Object.keys(BRANDING_TYPES) as [BrandingType, ...BrandingType[]]),
    sizeBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.sizeBytes > BRANDING_MAX_BYTES[b.kind]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizeBytes"],
        message: `A ${b.kind} can be at most ${BRANDING_MAX_BYTES[b.kind] / (1024 * 1024)} MB`,
      });
    }
  });

const imageUrl = z.string().trim().max(2000).nullable().optional();

export const brandingPutBody = z
  .object({
    accentColor: hexColor.nullable().optional(),
    accentColorSource: accentColorSource.optional(),
    logoUrl: imageUrl,
    bannerUrl: imageUrl,
  })
  .strict();

export type BrandingPut = z.infer<typeof brandingPutBody>;

export type BrandingScope = { scope: "firm" | "solo"; id: string };

/** A firm member's branding is the firm's; a solo counselor's is their own. */
export function brandingScope(profile: { id: string; firm_id?: string | null }): BrandingScope {
  return profile.firm_id ? { scope: "firm", id: profile.firm_id } : { scope: "solo", id: profile.id };
}

export function isFirmBrandingEditor(seatRole: unknown): boolean {
  return seatRole === "owner" || seatRole === "admin";
}

/**
 * The caller's seat in the firm, refused unless owner or admin. RLS restricts
 * the UPDATE to them as well; this makes a seat-holder's save a straight 403
 * rather than a silent no-op that looks like it worked.
 */
export async function assertFirmBrandingEditor(request: FastifyRequest, firmId: string): Promise<void> {
  if (!(await firmBrandingEditor(request, firmId))) {
    throw forbidden("Only a firm owner or admin can change branding");
  }
}

export async function firmBrandingEditor(request: FastifyRequest, firmId: string): Promise<boolean> {
  const { data: membership } = await request.db
    .from("firm_members")
    .select("seat_role")
    .eq("firm_id", firmId)
    .eq("profile_id", request.auth.userId)
    .maybeSingle();
  return isFirmBrandingEditor(membership?.seat_role);
}

/**
 * The columns a branding save writes, the same for a firm and a solo row. A
 * colour arriving without a stated source was typed by a person.
 */
export function brandingColumns(b: {
  logoUrl?: string | null;
  bannerUrl?: string | null;
  accentColor?: string | null;
  accentColorSource?: AccentSource;
}): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (b.logoUrl !== undefined) update.logo_url = b.logoUrl;
  if (b.bannerUrl !== undefined) update.banner_url = b.bannerUrl;
  if (b.accentColor !== undefined) {
    update.accent_color = b.accentColor;
    update.accent_color_source = b.accentColorSource ?? (b.accentColor ? "manual" : "default");
  } else if (b.accentColorSource !== undefined) {
    update.accent_color_source = b.accentColorSource;
  }
  return update;
}

/** `brandingColumns` plus the firm's `logo_updated_at`, which a new logo stamps. */
export function firmBrandingUpdate(b: Parameters<typeof brandingColumns>[0], now: string): Record<string, unknown> {
  const update = brandingColumns(b);
  if (b.logoUrl !== undefined) update.logo_updated_at = now;
  return update;
}

export function brandingObjectPath(scopeId: string, kind: BrandingKind, contentType: BrandingType): string {
  return `${scopeId}/${kind}-${randomBytes(8).toString("hex")}.${BRANDING_TYPES[contentType]}`;
}

const PUBLIC_PREFIX = `/storage/v1/object/public/${BRANDING_BUCKET}/`;
const OBJECT_PATH =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(logo|banner)-[0-9a-f]{16}\.(png|jpg|webp)$/;

function projectOrigin(base: string): string {
  return new URL(base).origin;
}

export function publicBrandingUrl(path: string, base: string = env.SUPABASE_URL): string {
  return `${projectOrigin(base)}${PUBLIC_PREFIX}${path}`;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The object a URL names, when it is exactly this project's public URL of a
 * path the API could have minted; null for anything else. Decided by
 * rebuilding the URL from the path and comparing the strings, so another host
 * (a look-alike too), port, scheme, credentials, query, fragment, dot segment
 * or percent-encoding never passes. Plain http only when the project itself is
 * a loopback (the local stack).
 */
export function parseBrandingUrl(
  url: unknown,
  base: string = env.SUPABASE_URL
): { path: string; scopeId: string; kind: BrandingKind; ext: string } | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2000) return null;
  let project: URL;
  try {
    project = new URL(base);
  } catch {
    return null;
  }
  const httpsOnly = !(project.protocol === "http:" && LOOPBACK.has(project.hostname));
  if (httpsOnly && project.protocol !== "https:") return null;
  const head = `${project.origin}${PUBLIC_PREFIX}`;
  if (!url.startsWith(head)) return null;
  const path = url.slice(head.length);
  const m = OBJECT_PATH.exec(path);
  if (!m) return null;
  if (publicBrandingUrl(path, base) !== url) return null;
  return { path, scopeId: m[1]!, kind: m[2] as BrandingKind, ext: m[3]! };
}

/** The object path when `url` is in `scopeId`'s own folder and of `kind`; else null. */
export function ownBrandingPath(url: unknown, scopeId: string, kind: BrandingKind, base: string = env.SUPABASE_URL): string | null {
  const p = parseBrandingUrl(url, base);
  return p && p.scopeId === scopeId && p.kind === kind ? p.path : null;
}

/** The type an extension stands for. */
export function typeOfPath(path: string): BrandingType | null {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return EXT_TYPES[ext] ?? null;
}

/** What the bytes are (PNG, JPEG or WebP by their magic numbers), whatever the upload claimed. */
export function sniffImageType(bytes: Uint8Array): BrandingType | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** At most this many objects in a scope's folder before another upload URL is minted. */
export const BRANDING_FOLDER_MAX = 10;
/** An unsaved upload older than this is abandoned: a signed upload URL lives two hours. */
export const BRANDING_STALE_MS = 2 * 3600 * 1000;

const OBJECT_NAME = /^(logo|banner)-[0-9a-f]{16}\.(png|jpg|webp)$/;

/**
 * Which objects in a scope's folder to remove before minting another upload
 * URL, and how many stay. Removed: our own naming scheme only, older than
 * BRANDING_STALE_MS by a readable time, and not the saved logo or banner
 * (`keep`, full paths). Anything else is left alone and still counts.
 */
export function brandingCleanup(
  objects: { name: string; created_at?: string | null }[],
  scopeId: string,
  keep: Set<string>,
  now: number = Date.now()
): { remove: string[]; remaining: number } {
  const remove: string[] = [];
  for (const o of objects) {
    if (!OBJECT_NAME.test(o.name)) continue;
    const path = `${scopeId}/${o.name}`;
    if (keep.has(path)) continue;
    const at = typeof o.created_at === "string" ? Date.parse(o.created_at) : NaN;
    if (!Number.isFinite(at) || now - at <= BRANDING_STALE_MS) continue;
    remove.push(path);
  }
  return { remove, remaining: objects.length - remove.length };
}

export const brandingUnavailable = () =>
  new HttpError(503, "Saving branding isn't switched on yet", "branding_unavailable");

export type BrandingDto = {
  scope: "firm" | "solo";
  canEdit: boolean;
  logoUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  accentColorSource: AccentSource;
};

export function toBrandingDto(scope: BrandingScope, canEdit: boolean, row: Record<string, unknown> | null): BrandingDto {
  const src = row?.accent_color_source;
  return {
    scope: scope.scope,
    canEdit,
    logoUrl: typeof row?.logo_url === "string" ? row.logo_url : null,
    bannerUrl: typeof row?.banner_url === "string" ? row.banner_url : null,
    accentColor: isHexColor(row?.accent_color) ? row.accent_color : null,
    accentColorSource: (ACCENT_SOURCES as readonly unknown[]).includes(src) ? (src as AccentSource) : "default",
  };
}
