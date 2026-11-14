/**
 * The practice's contract library (migration 20261124000005, lib/contracts.ts). PDF and DOCX, 10 MB.
 *
 *   POST   /pipeline/contracts/upload-url   { contentType, sizeBytes } -> { bucket, path, token, uploadUrl, expiresIn, maxBytes, contentType }
 *   POST   /pipeline/contracts              { path, name } -> 201 contract  (registers an uploaded object)
 *   GET    /pipeline/contracts              ?includeArchived=true -> { contracts, canEdit }
 *   GET    /pipeline/contracts/:id/url      -> { url, expiresIn }  (a 60-second signed link to view the file)
 *   DELETE /pipeline/contracts/:id          archives it (agreements made from it keep working)
 *
 * Counselors only; everyone in the practice reads, only a firm owner/admin or the solo counselor uploads and
 * archives. The bucket is private with no client policy: the API signs an upload URL for an object it named in
 * the practice's own folder (the service client does that only after those checks), reads the object back
 * before registering it (size, the type its BYTES show, and the SHA-256) and removes a file that isn't a real
 * PDF or DOCX. Attaching a contract to an invoice is `agreement: { contractId }` on the invoice routes.
 * Without the migration: 503 `contracts_unavailable`.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadWorkspace } from "../lib/crm.js";
import {
  CONTRACT_BUCKET,
  CONTRACT_LIBRARY_MAX,
  CONTRACT_MAX_BYTES,
  CONTRACT_UPLOAD_EXPIRES_IN,
  contractObjectPath,
  contractRegisterBody,
  contractsUnavailable,
  contractUploadBody,
  ownContractPath,
  sha256OfBytes,
  sniffContract,
  toContractDTO,
} from "../lib/contracts.js";
import { badRequest, forbidden, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { downloadCapped } from "../lib/storageDownload.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;
const idParam = z.object({ id: z.string().uuid() }).strict();
const err = (e: { code?: string; message?: string } | null) => (isResultsNotApplied(e) ? contractsUnavailable() : fromPostgrest(e));
const ABANDONED_AFTER_MS = 3 * 3_600_000;
/** Objects listed per page, pages walked (5,000 objects), and fresh unregistered uploads allowed at once. */
// (50 names keep the registered-names lookup well inside a request URL.)
const LIST_PAGE = 50;
const LIST_MAX_PAGES = 100;
const UNSAVED_MAX = 100;

export default async function contractRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/contracts", { preHandler: [...counselor, limit("contracts:read", 120, 60)] }, async (request) => {
    const q = z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict().parse(request.query);
    const ws = await loadWorkspace(request);
    let query = request.db.from("contract_files").select("*").eq("practice_id", ws.firmId ?? request.auth.userId);
    if (q.includeArchived !== "true") query = query.is("archived_at", null);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
    if (error) throw err(error);
    return { contracts: ((data ?? []) as Row[]).map(toContractDTO), canEdit: ws.isAdmin };
  });

  app.post("/contracts/upload-url", { preHandler: [...counselor, limit("contracts:upload", 20, 3600)] }, async (request) => {
    const b = contractUploadBody.parse(request.body);
    const ws = await loadWorkspace(request);
    if (!ws.isAdmin) throw forbidden("Only a firm owner or admin can add contracts");
    const practiceId = ws.firmId ?? request.auth.userId;
    const live = await request.db.from("contract_files").select("storage_path").eq("practice_id", practiceId).is("archived_at", null).limit(CONTRACT_LIBRARY_MAX + 1);
    if (live.error) throw err(live.error);
    if ((live.data ?? []).length >= CONTRACT_LIBRARY_MAX) throw new HttpError(409, `A practice can keep at most ${CONTRACT_LIBRARY_MAX} contracts. Archive one first.`, "contracts_full");
    const svc = serviceClient();
    if (!svc) throw contractsUnavailable();

    // The folder cleans itself: an object nobody registered within a few hours is removed, so unsaved uploads can't pile up.
    // The listing is walked a page at a time and each page asks which of ITS names are registered (registered or archived,
    // so a file a contract agreement is bound to is never taken for abandoned); only unregistered objects are counted.
    const now = Date.now();
    const stale: string[] = [];
    let unsaved = 0;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const listed = await svc.storage.from(CONTRACT_BUCKET).list(practiceId, { limit: LIST_PAGE, offset: page * LIST_PAGE, sortBy: { column: "created_at", order: "asc" } });
      if (listed.error) {
        if (!/bucket not found/i.test(listed.error.message)) request.log.warn({ err: listed.error }, "contracts folder list failed");
        throw contractsUnavailable();
      }
      const objects = listed.data ?? [];
      if (objects.length === 0) break;
      const paths = objects.map((o) => `${practiceId}/${o.name}`);
      const known = await request.db.from("contract_files").select("storage_path").eq("practice_id", practiceId).in("storage_path", paths);
      if (known.error) throw err(known.error);
      const registered = new Set(((known.data ?? []) as Row[]).map((r) => String(r.storage_path)));
      objects.forEach((o, i) => {
        const path = paths[i] as string;
        if (registered.has(path)) return;
        if (now - Date.parse(String(o.created_at ?? "")) > ABANDONED_AFTER_MS) stale.push(path);
        else unsaved += 1;
      });
      if (objects.length < LIST_PAGE) break;
    }
    if (stale.length) await svc.storage.from(CONTRACT_BUCKET).remove(stale).catch(() => undefined);
    if (unsaved >= UNSAVED_MAX) throw new HttpError(429, "Too many unsaved uploads. Save one, or try again in a few hours.", "contracts_folder_full");

    const path = contractObjectPath(practiceId, b.contentType);
    const { data, error } = await svc.storage.from(CONTRACT_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      request.log.warn({ err: error }, "contract upload url failed");
      throw badRequest("Couldn't start the upload. Try again.");
    }
    return { bucket: CONTRACT_BUCKET, path, token: data.token, uploadUrl: data.signedUrl, expiresIn: CONTRACT_UPLOAD_EXPIRES_IN, maxBytes: CONTRACT_MAX_BYTES, contentType: b.contentType };
  });

  app.post("/contracts", { preHandler: [...counselor, limit("contracts:register", 30, 3600)] }, async (request, reply) => {
    const b = contractRegisterBody.parse(request.body);
    const ws = await loadWorkspace(request);
    if (!ws.isAdmin) throw forbidden("Only a firm owner or admin can add contracts");
    const practiceId = ws.firmId ?? request.auth.userId;
    const declared = ownContractPath(b.path, practiceId);
    if (!declared) throw badRequest("Upload the file through /pipeline/contracts/upload-url first");
    const svc = serviceClient();
    if (!svc) throw contractsUnavailable();

    const got = await downloadCapped(svc, CONTRACT_BUCKET, b.path, CONTRACT_MAX_BYTES);
    if (got.status === "error") throw badRequest("That file hasn't finished uploading");
    const remove = () => svc.storage.from(CONTRACT_BUCKET).remove([b.path]).catch(() => undefined);
    if (got.status === "too-large") {
      await remove();
      throw badRequest("A contract can be at most 10 MB");
    }
    const real = sniffContract(got.bytes);
    if (!real || real !== declared) {
      await remove();
      throw badRequest("That file isn't a PDF or Word (.docx) document");
    }
    const { data, error } = await request.db
      .from("contract_files")
      .insert({
        firm_id: ws.firmId,
        counselor_id: request.auth.userId,
        practice_id: practiceId,
        name: b.name,
        storage_path: b.path,
        mime: real,
        size_bytes: got.bytes.length,
        sha256: sha256OfBytes(got.bytes),
        created_by: request.auth.userId,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") throw new HttpError(409, "That file is already in your contracts", "contract_exists");
      throw err(error);
    }
    return reply.code(201).send(toContractDTO(data as Row));
  });

  app.get("/contracts/:id/url", { preHandler: [...counselor, limit("contracts:view", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db.from("contract_files").select("storage_path, name").eq("id", id).maybeSingle();
    if (error) throw err(error);
    if (!data) throw notFound("No contract of yours matches that");
    const svc = serviceClient();
    if (!svc) throw contractsUnavailable();
    const signed = await svc.storage.from(CONTRACT_BUCKET).createSignedUrl(String((data as Row).storage_path), 60);
    if (signed.error || !signed.data) throw contractsUnavailable();
    return { url: signed.data.signedUrl, expiresIn: 60 };
  });

  app.delete("/contracts/:id", { preHandler: [...counselor, limit("contracts:write", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const ws = await loadWorkspace(request);
    if (!ws.isAdmin) throw forbidden("Only a firm owner or admin can archive contracts");
    const { data, error } = await request.db.from("contract_files").update({ archived_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    if (error) throw err(error);
    if (!data) throw notFound("No contract of yours matches that");
    return toContractDTO(data as Row);
  });
}
