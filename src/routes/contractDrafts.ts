/**
 * Contracts drafted in Meridies, and the consultant's saved signature (migration 20261129000001,
 * lib/contractDraftApi.ts, the model in lib/contractDraft.ts).
 *
 *   GET    /pipeline/contract-drafts            ?includeArchived=true -> { drafts, canEdit }
 *   POST   /pipeline/contract-drafts            { title, sections } -> 201 draft  (at most 100 unarchived)
 *   PUT    /pipeline/contract-drafts/:id        { title, sections } -> draft
 *   POST   /pipeline/contract-drafts/:id/duplicate -> 201 draft titled "<title> (copy)"
 *   DELETE /pipeline/contract-drafts/:id        archives it (a contract already sent from it keeps its own copy)
 *   GET    /pipeline/signature                  -> { signature: { signerName, kind, imageDataUrl, updatedAt } | null }
 *   PUT    /pipeline/signature                  { kind: "typed", signerName } | { kind: "drawn", signerName, imagePngBase64 } -> signature
 *
 * Drafts belong to the practice like uploaded contracts: everyone in it reads, only a firm owner/admin or the
 * solo counselor writes. The signature is a consultant's own (owner-only RLS, no one else reads it) and is
 * replaced in place. Everything runs on the caller's own client, so RLS stands behind each check. Without the
 * migration: 503 `contract_drafts_unavailable`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { copyTitle } from "../lib/contractDraft.js";
import {
  byteaLiteral,
  CONTRACT_DRAFT_MAX,
  contractDraftBody,
  contractDraftError as err,
  decodeSignaturePng,
  signatureBody,
  toContractDraftDTO,
  toSignatureDTO,
} from "../lib/contractDraftApi.js";
import { sha256OfBytes } from "../lib/contracts.js";
import { loadWorkspace } from "../lib/crm.js";
import { badRequest, forbidden, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

type Row = Record<string, unknown>;
const idParam = z.object({ id: z.string().uuid() }).strict();
const full = () => new HttpError(409, `A practice can keep at most ${CONTRACT_DRAFT_MAX} contract drafts. Archive one first.`, "contract_drafts_full");

export default async function contractDraftRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  /** The caller's practice, when they may write its drafts. */
  const adminPractice = async (request: FastifyRequest, what: string) => {
    const ws = await loadWorkspace(request);
    if (!ws.isAdmin) throw forbidden(`Only a firm owner or admin can ${what} contracts`);
    return { firmId: ws.firmId, practiceId: ws.firmId ?? request.auth.userId };
  };

  const assertRoom = async (request: FastifyRequest, practiceId: string) => {
    const live = await request.db.from("contract_drafts").select("id").eq("practice_id", practiceId).is("archived_at", null).limit(CONTRACT_DRAFT_MAX);
    if (live.error) throw err(live.error);
    if ((live.data ?? []).length >= CONTRACT_DRAFT_MAX) throw full();
  };

  app.get("/contract-drafts", { preHandler: [...counselor, limit("contract-drafts:read", 120, 60)] }, async (request) => {
    const q = z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict().parse(request.query);
    const ws = await loadWorkspace(request);
    let query = request.db.from("contract_drafts").select("*").eq("practice_id", ws.firmId ?? request.auth.userId);
    if (q.includeArchived !== "true") query = query.is("archived_at", null);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
    if (error) throw err(error);
    return { drafts: ((data ?? []) as Row[]).map(toContractDraftDTO), canEdit: ws.isAdmin };
  });

  app.post("/contract-drafts", { preHandler: [...counselor, limit("contract-drafts:write", 60, 60)] }, async (request, reply) => {
    const b = contractDraftBody.parse(request.body);
    const { firmId, practiceId } = await adminPractice(request, "write");
    await assertRoom(request, practiceId);
    const { data, error } = await request.db
      .from("contract_drafts")
      .insert({ firm_id: firmId, counselor_id: request.auth.userId, practice_id: practiceId, title: b.title, sections: b.sections, created_by: request.auth.userId })
      .select("*")
      .single();
    if (error) throw err(error);
    return reply.code(201).send(toContractDraftDTO(data as Row));
  });

  app.put("/contract-drafts/:id", { preHandler: [...counselor, limit("contract-drafts:write", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = contractDraftBody.parse(request.body);
    await adminPractice(request, "edit");
    const { data, error } = await request.db.from("contract_drafts").update({ title: b.title, sections: b.sections }).eq("id", id).select("*").maybeSingle();
    if (error) throw err(error);
    if (!data) throw notFound("No contract draft of yours matches that");
    return toContractDraftDTO(data as Row);
  });

  app.post("/contract-drafts/:id/duplicate", { preHandler: [...counselor, limit("contract-drafts:write", 60, 60)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { firmId, practiceId } = await adminPractice(request, "copy");
    const src = await request.db.from("contract_drafts").select("title, sections").eq("id", id).maybeSingle();
    if (src.error) throw err(src.error);
    if (!src.data) throw notFound("No contract draft of yours matches that");
    await assertRoom(request, practiceId);
    const { data, error } = await request.db
      .from("contract_drafts")
      .insert({ firm_id: firmId, counselor_id: request.auth.userId, practice_id: practiceId, title: copyTitle(String((src.data as Row).title)), sections: (src.data as Row).sections, created_by: request.auth.userId })
      .select("*")
      .single();
    if (error) throw err(error);
    return reply.code(201).send(toContractDraftDTO(data as Row));
  });

  app.delete("/contract-drafts/:id", { preHandler: [...counselor, limit("contract-drafts:write", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await adminPractice(request, "archive");
    const { data, error } = await request.db.from("contract_drafts").update({ archived_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    if (error) throw err(error);
    if (!data) throw notFound("No contract draft of yours matches that");
    return toContractDraftDTO(data as Row);
  });

  // ---- The consultant's own saved signature ---------------------------------------------------------------------

  app.get("/signature", { preHandler: [...counselor, limit("contract-signature:read", 120, 60)] }, async (request) => {
    const { data, error } = await request.db.from("counselor_signatures").select("*").eq("counselor_id", request.auth.userId).maybeSingle();
    if (error) throw err(error);
    return { signature: data ? toSignatureDTO(data as Row) : null };
  });

  app.put("/signature", { preHandler: [...counselor, limit("contract-signature:write", 30, 3600)] }, async (request) => {
    const b = signatureBody.parse(request.body);
    let png: Buffer | null = null;
    if (b.kind === "drawn") {
      png = decodeSignaturePng(b.imagePngBase64);
      if (!png) {
        throw badRequest(b.imagePngBase64.startsWith("data:") ? "Send the raw base64, without a data: prefix" : "The signature image must be a PNG of at most 60 KB, no larger than 1200 by 400 pixels");
      }
    }
    // One row per consultant. The hash is of the bytes decoded here, never a client's.
    const { data, error } = await request.db
      .from("counselor_signatures")
      .upsert(
        { counselor_id: request.auth.userId, signer_name: b.signerName, kind: b.kind, image_png: png ? byteaLiteral(png) : null, image_sha256: png ? sha256OfBytes(png) : null },
        { onConflict: "counselor_id" }
      )
      .select("*")
      .single();
    if (error) throw err(error);
    return toSignatureDTO(data as Row);
  });
}
