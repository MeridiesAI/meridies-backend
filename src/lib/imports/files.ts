/**
 * Starting an import and adding its files (spec §5.1, §5.2).
 *
 * The browser uploads straight to the private `imports` bucket through a
 * signed URL minted on the counselor's own token (the bucket's insert policy:
 * their folder, a draft import of theirs). Registration then downloads the
 * object on the same token, checks its size, magic bytes and sha256, parses
 * and profiles it in the capped child process, and records it through the
 * import worker (import_register_file re-checks the path and access).
 *
 * withWorkerTransaction runs here inside an approved counselor's own request
 * (app.authenticate and requireRole ran), with p_actor = that counselor; the
 * SQL re-checks private.can_manage_import, which asks the approval gate.
 */

import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { badRequest, conflict, fromPostgrest, notFound } from "../errors.js";
import { MAX_FILE_BYTES, MAX_ROWS } from "./caps.js";
import { withWorkerTransaction } from "./db.js";
import { fromImportRpc } from "./errors.js";
import { parseFailureMessage, parseInWorker } from "./parse.js";
import { profileFile, type FileProfile } from "./profile.js";

type Row = Record<string, unknown>;

export const UPLOAD_TYPES = [
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export type ImportFileDto = {
  id: string;
  filename: string;
  status: "registered" | "profiled" | "failed" | "excluded";
  error: string | null;
  detectedType: string | null;
  rowCount: number | null;
  sizeBytes: number | null;
};

export function toImportFile(r: Row): ImportFileDto {
  return {
    id: String(r.id),
    filename: String(r.filename),
    status: String(r.status) as ImportFileDto["status"],
    error: (r.error as string | null) ?? null,
    detectedType: (r.detected_type as string | null) ?? null,
    rowCount: typeof r.row_count === "number" ? r.row_count : null,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
  };
}

/** What the mapping screen shows of a file: headers (the counselor's own) and masked shapes. */
export function profileView(profile: FileProfile | null) {
  if (!profile) return null;
  return {
    fingerprint: profile.fingerprint,
    sheets: profile.sheets.map((s) => ({
      name: s.name,
      rowCount: s.rowCount,
      columns: s.columns.map((c) => ({
        index: c.index,
        header: c.header,
        samples: c.samples,
        pctEmpty: c.pctEmpty,
        sensitive: c.sensitive !== null,
        dateHints: c.dateHints,
      })),
    })),
  };
}

export async function startImport(request: FastifyRequest): Promise<{ id: string; status: string; expiresAt: string }> {
  const { data, error } = await request.db.rpc("start_import", { p_permission: true });
  if (error) throw fromImportRpc(error);
  const out = data as Row;
  return { id: String(out.id), status: String(out.status), expiresAt: String(out.expiresAt) };
}

/** The import as the caller may see it (RLS), new pipeline only. */
export async function loadImportRow(request: FastifyRequest, id: string, columns = "*"): Promise<Row> {
  const { data, error } = await request.db
    .from("roster_imports")
    .select(columns)
    .eq("id", id)
    .not("permission_confirmed_at", "is", null)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That import isn't on your account");
  return data as unknown as Row;
}

/** A file name safe for a storage path: letters, digits, dot, dash, underscore. */
export function safeName(fileName: string): string {
  const base = fileName.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "");
  return (base.length > 120 ? base.slice(base.length - 120) : base) || "file";
}

export async function createUploadUrl(
  request: FastifyRequest,
  importId: string,
  input: { fileName: string; mimeType: string; sizeBytes: number }
) {
  const imp = await loadImportRow(request, importId, "id, status, counselor_id");
  if (imp.status !== "draft") throw conflict("Files can only be added before mapping");
  if (imp.counselor_id !== request.auth.userId) throw conflict("Only the counselor who started this import can add files");
  const { count, error: countErr } = await request.db
    .from("import_files")
    .select("id", { count: "exact", head: true })
    .eq("import_id", importId)
    .neq("status", "excluded");
  if (countErr) throw fromPostgrest(countErr);
  if ((count ?? 0) >= 20) throw conflict("An import holds at most 20 files");
  const fileId = randomUUID();
  const path = `${request.auth.userId}/${importId}/${fileId}-${safeName(input.fileName)}`;
  const { data, error } = await request.db.storage.from("imports").createSignedUploadUrl(path);
  if (error || !data) throw badRequest("Couldn't start the upload. Try again.");
  return { fileId, bucket: "imports" as const, path: data.path ?? path, token: data.token, signedUrl: data.signedUrl, maxBytes: MAX_FILE_BYTES };
}

export async function registerFile(
  request: FastifyRequest,
  importId: string,
  input: { fileId: string; path: string; fileName: string }
): Promise<ImportFileDto & { profile: ReturnType<typeof profileView> }> {
  const imp = await loadImportRow(request, importId, "id, status, counselor_id");
  if (imp.status !== "draft") throw conflict("Files can only be added before mapping");
  const prefix = `${imp.counselor_id}/${importId}/${input.fileId}-`;
  if (!input.path.startsWith(prefix)) throw badRequest("That file isn't part of this import");

  const { data: blob, error: dlErr } = await request.db.storage.from("imports").download(input.path);
  if (dlErr || !blob) throw badRequest("That file hasn't finished uploading");
  const filename = input.fileName.trim().slice(0, 300) || "file";
  const base = { id: input.fileId, storagePath: input.path, filename, mimeType: blob.type || null, sizeBytes: blob.size };

  let file: Record<string, unknown>;
  let profile: FileProfile | null = null;
  if (blob.size > MAX_FILE_BYTES) {
    file = { ...base, status: "failed", error: parseFailureMessage("too-large", filename), detectedType: "unknown" };
  } else {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = await parseInWorker(bytes, filename, { maxRows: MAX_ROWS });
    if (!parsed.ok) {
      file = { ...base, sha256, status: "failed", error: parseFailureMessage(parsed.reason, filename), detectedType: parsed.detectedType };
    } else {
      profile = profileFile(parsed.sheets);
      const wide = profile.sheets.some((s) => s.wide);
      const rowCount = profile.sheets.reduce((n, s) => n + s.rowCount, 0);
      file = wide
        ? { ...base, sha256, status: "failed", error: parseFailureMessage("wide", filename), detectedType: parsed.detectedType }
        : { ...base, sha256, status: "profiled", detectedType: parsed.detectedType, profile, rowCount };
      if (wide) profile = null;
    }
  }

  const row = await withWorkerTransaction(async (c) => {
    const { rows } = await c.query("select public.import_register_file($1, $2, $3) as out", [importId, request.auth.userId, file]);
    return rows[0].out as Row;
  }).catch((err: unknown) => {
    throw fromImportRpc(err as { code?: string; message?: string });
  });
  request.log.info({ importId, fileId: input.fileId, status: row.status, rows: row.row_count ?? null }, "import file registered");
  const dto = toImportFile(row);
  return { ...dto, profile: dto.status === "profiled" ? profileView(profile) : null };
}

export async function excludeFile(request: FastifyRequest, importId: string, fileId: string): Promise<void> {
  const { error } = await request.db.rpc("import_exclude_file", { p_import: importId, p_file: fileId });
  if (error) throw fromImportRpc(error);
}
