/**
 * Practice branding, persisted (20261111000008; rules in lib/branding.ts).
 *
 *   GET  /branding             { scope: "firm"|"solo", canEdit, logoUrl, bannerUrl, accentColor, accentColorSource }
 *   PUT  /branding             { accentColor?, accentColorSource?, logoUrl?, bannerUrl? } -> the same shape
 *   POST /branding/upload-url  { kind: "logo"|"banner", contentType, sizeBytes }
 *                              -> { bucket, path, token, uploadUrl, publicUrl, expiresIn, maxBytes, contentType }
 *
 * Counselors only (approved: authenticate refuses a pending one). A firm member
 * reads the firm's branding and only an owner or admin changes it (the check
 * PATCH /firms/mine uses); a solo counselor reads and writes their own row.
 * Reads and writes of rows run on the caller's client. The service client does
 * three things, each only after those checks and only inside the caller's own
 * folder of the branding bucket: mint the signed upload URL (the bucket has no
 * client write policy), read back an uploaded object before it is saved (size
 * and real type: a PNG label on SVG bytes is refused and removed), and remove
 * the object a save replaced or cleared.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BRANDING_BUCKET,
  BRANDING_MAX_BYTES,
  BRANDING_TYPES,
  BRANDING_FOLDER_MAX,
  BRANDING_UPLOAD_EXPIRES_IN,
  brandingCleanup,
  assertFirmBrandingEditor,
  brandingColumns,
  brandingObjectPath,
  brandingPutBody,
  brandingScope,
  brandingUnavailable,
  brandingUploadBody,
  firmBrandingEditor,
  firmBrandingUpdate,
  ownBrandingPath,
  publicBrandingUrl,
  sniffImageType,
  toBrandingDto,
  typeOfPath,
  type BrandingKind,
  type BrandingScope,
} from "../lib/branding.js";
import { HttpError, badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";

const COLUMNS = "logo_url, banner_url, accent_color, accent_color_source";
/** PostgREST's and Postgres's "that table isn't there": the migration isn't applied. */
const NOT_APPLIED = new Set(["PGRST205", "PGRST204", "42P01", "42703"]);

type Row = Record<string, unknown>;

async function readRow(request: FastifyRequest, scope: BrandingScope): Promise<Row | null> {
  if (scope.scope === "firm") {
    const { data, error } = await request.db.from("firms").select(COLUMNS).eq("id", scope.id).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That firm isn't on file");
    return data as Row;
  }
  const { data, error } = await request.db.from("counselor_branding").select(COLUMNS).eq("counselor_id", scope.id).maybeSingle();
  if (error) {
    if (NOT_APPLIED.has(error.code ?? "")) throw brandingUnavailable();
    throw fromPostgrest(error);
  }
  return (data as Row | null) ?? null;
}

/** Owner/admin for a firm (403 otherwise); a solo counselor always edits their own. */
async function assertCanEdit(request: FastifyRequest, scope: BrandingScope) {
  if (scope.scope === "firm") await assertFirmBrandingEditor(request, scope.id);
}

/**
 * The uploaded object a save names, read back before it is saved: it must be
 * there, within its kind's size, and really the type its name says. A file
 * that isn't is removed (it is in the caller's own folder) and refused.
 */
async function assertUploaded(path: string, kind: BrandingKind) {
  const svc = serviceClient();
  if (!svc) throw brandingUnavailable();
  const { data, error } = await svc.storage.from(BRANDING_BUCKET).download(path);
  if (error || !data) {
    // Not there yet is the client's to fix; a missing bucket or a Storage fault is ours.
    const status = Number((error as { status?: number; statusCode?: string } | null)?.status ?? (error as { statusCode?: string } | null)?.statusCode);
    if (/bucket not found/i.test(error?.message ?? "") || !(status >= 400 && status < 500)) throw brandingUnavailable();
    throw badRequest("That image hasn't finished uploading");
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  const real = sniffImageType(bytes.subarray(0, 16));
  if (bytes.length > BRANDING_MAX_BYTES[kind] || !real || real !== typeOfPath(path)) {
    await svc.storage.from(BRANDING_BUCKET).remove([path]).catch(() => undefined);
    throw badRequest(
      bytes.length > BRANDING_MAX_BYTES[kind]
        ? `A ${kind} can be at most ${BRANDING_MAX_BYTES[kind] / (1024 * 1024)} MB`
        : "That file isn't a PNG, JPEG or WebP image"
    );
  }
}

export default async function brandingRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: counselor }, async (request) => {
    const scope = brandingScope(request.profile);
    const row = await readRow(request, scope);
    const canEdit = scope.scope === "solo" || (await firmBrandingEditor(request, scope.id));
    return toBrandingDto(scope, canEdit, row);
  });

  app.put("/", { preHandler: [...counselor, limit("branding:save", 60, 60)] }, async (request) => {
    const b = brandingPutBody.parse(request.body);
    const scope = brandingScope(request.profile);
    await assertCanEdit(request, scope);
    // The row and Storage first, so a missing table, bucket or key is a 503, not "hasn't finished uploading".
    const before = await readRow(request, scope);
    const svc = serviceClient();
    if (!svc && (b.logoUrl || b.bannerUrl)) throw brandingUnavailable();

    // A URL is accepted only as this project's public URL of an upload in the
    // caller's own folder, of the field's own kind; never anything else.
    const fields: [BrandingKind, string | null | undefined][] = [
      ["logo", b.logoUrl],
      ["banner", b.bannerUrl],
    ];
    for (const [kind, url] of fields) {
      if (url === undefined || url === null) continue;
      const path = ownBrandingPath(url, scope.id, kind);
      if (!path) throw badRequest(`Upload the ${kind} through /branding/upload-url first`);
      await assertUploaded(path, kind);
    }

    let saved: Row | null;
    if (scope.scope === "firm") {
      const { data, error } = await request.db
        .from("firms")
        .update(firmBrandingUpdate(b, new Date().toISOString()))
        .eq("id", scope.id)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That firm isn't on file");
      saved = data as Row;
    } else {
      const { data, error } = await request.db
        .from("counselor_branding")
        .upsert({ counselor_id: scope.id, ...brandingColumns(b) }, { onConflict: "counselor_id" })
        .select(COLUMNS)
        .single();
      if (error) {
        if (NOT_APPLIED.has(error.code ?? "")) throw brandingUnavailable();
        throw fromPostgrest(error);
      }
      saved = data as Row;
    }

    // A replaced or cleared image goes, best effort, and only from the caller's
    // own folder: a row the API didn't write (or an old firm URL elsewhere) is
    // never followed out of it.
    if (svc) {
      const gone: string[] = [];
      for (const [kind, column] of [["logo", "logo_url"], ["banner", "banner_url"]] as const) {
        const old = before?.[column];
        if (typeof old !== "string" || old === saved?.[column]) continue;
        const path = ownBrandingPath(old, scope.id, kind);
        if (path) gone.push(path);
      }
      if (gone.length) await svc.storage.from(BRANDING_BUCKET).remove(gone).catch(() => undefined);
    }

    return toBrandingDto(scope, true, saved);
  });

  app.post("/upload-url", { preHandler: [...counselor, limit("branding:upload", 20, 3600)] }, async (request) => {
    const b = brandingUploadBody.parse(request.body);
    const scope = brandingScope(request.profile);
    await assertCanEdit(request, scope);
    // The saved images (kept by the cleanup); a solo counselor's save needs the table, so this also refuses
    // the upload up front rather than strand the file.
    const row = await readRow(request, scope);
    const svc = serviceClient();
    if (!svc) throw brandingUnavailable();

    // The folder cleans itself and is capped, so unsaved uploads can't become free public hosting: abandoned
    // uploads (our naming scheme, older than a signed URL lives, not the saved logo or banner) go first.
    const { data: listed, error: listErr } = await svc.storage
      .from(BRANDING_BUCKET)
      .list(scope.id, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
    // Fail closed: a folder we can't count gets no new upload (a missing bucket lands here too).
    if (listErr) {
      request.log.warn({ err: listErr }, "branding folder list failed");
      throw brandingUnavailable();
    }
    const keep = new Set(
      (["logo", "banner"] as const)
        .map((kind) => ownBrandingPath(row?.[`${kind}_url`], scope.id, kind))
        .filter((p): p is string => p !== null)
    );
    const { remove, remaining } = brandingCleanup(listed ?? [], scope.id, keep);
    let left = remaining;
    if (remove.length) {
      const { error: rmErr } = await svc.storage.from(BRANDING_BUCKET).remove(remove);
      if (rmErr) {
        request.log.warn({ err: rmErr }, "branding folder cleanup failed");
        left += remove.length;
      }
    }
    if (left >= BRANDING_FOLDER_MAX) {
      throw new HttpError(
        429,
        "Too many unsaved images. Save one, or try again in a couple of hours.",
        "branding_folder_full"
      );
    }
    const path = brandingObjectPath(scope.id, b.kind, b.contentType);
    const { data, error } = await svc.storage.from(BRANDING_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      if (/bucket not found/i.test(error?.message ?? "")) throw brandingUnavailable();
      request.log.warn({ err: error }, "branding upload url failed");
      throw badRequest("Couldn't start the upload. Try again.");
    }
    return {
      bucket: BRANDING_BUCKET,
      path,
      token: data.token,
      uploadUrl: data.signedUrl,
      publicUrl: publicBrandingUrl(path),
      expiresIn: BRANDING_UPLOAD_EXPIRES_IN,
      maxBytes: BRANDING_MAX_BYTES[b.kind],
      contentType: b.contentType satisfies keyof typeof BRANDING_TYPES,
    };
  });
}
