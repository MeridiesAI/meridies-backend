/**
 * Contract Hub (migration 20261130000001, lib/contractHub.ts): upload a PDF, add signers, place their fields,
 * send; each signer signs from an emailed link. A bare-minimum port of SignuDoc (github.com/NYLLON-SOFTWARE/signudoc,
 * MIT). Typed or drawn acceptance, not a certified e-signature.
 *
 * Counselor (approved; every route reads the envelope on the caller's own RLS client first, then writes with the
 * service role, because clients write nothing to these tables):
 *   POST   /contract-hub/upload-url                   { sizeBytes } -> { path, uploadUrl, token, expiresIn }
 *   POST   /contract-hub/envelopes                    { title, fileName, path, pageCount, signers } -> 201 envelope
 *   GET    /contract-hub/envelopes                    -> { envelopes }  (no field values or signatures)
 *   GET    /contract-hub/envelopes/:id                -> envelope with signers, fields and timeline
 *   GET    /contract-hub/envelopes/:id/document       -> the PDF
 *   PUT    /contract-hub/envelopes/:id/fields         { fields } replaces a draft's fields
 *   POST   /contract-hub/envelopes/:id/send           draft -> sent; emails each signer their link
 *   POST   /contract-hub/envelopes/:id/signers/:signerId/remind   a new link (the old one stops), emailed
 *   POST   /contract-hub/envelopes/:id/void           sent -> voided; every link stops
 *   DELETE /contract-hub/envelopes/:id                a draft and its PDF
 *
 * Public (the token in the path is the capability, stored as sha256 only; nobody is signed in):
 *   GET  /contract-hub/sign/:token            the document's fields and who signs what; changes nothing
 *   GET  /contract-hub/sign/:token/document   the PDF
 *   POST /contract-hub/sign/:token            { consent: true, signature?, initials?, values } -> { status }
 *   POST /contract-hub/sign/:token/decline    { reason? }
 * A link answers only while its envelope is out for signature, its signer hasn't answered, it hasn't expired and the
 * envelope's counselor is approved. Signing and declining go through contract_hub_sign / contract_hub_decline
 * (service role only), which lock the envelope.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { isCounselorApproved } from "../lib/access.js";
import { cleanIp, truncateUserAgent } from "../lib/agreements.js";
import {
  cleanMark,
  createBody,
  declineBody,
  fieldsBody,
  HUB_BUCKET,
  HUB_MAX_BYTES,
  HUB_UPLOAD_EXPIRES_IN,
  hashHubToken,
  hubObjectPath,
  hubUnavailable,
  isHubToken,
  isPdf,
  mintHubToken,
  outcomeEmail,
  ownHubPath,
  sendProblem,
  signBody,
  signedDate,
  signProblem,
  signRequestEmail,
  toEnvelopeDTO,
  toFieldDTO,
  toSignerDTO,
  uploadBody,
} from "../lib/contractHub.js";
import { sendEmail } from "../lib/email.js";
import { badRequest, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { enforceRateLimit, limit } from "../lib/limits.js";
import { downloadCapped } from "../lib/storageDownload.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;
type Pg = { code?: string; message?: string } | null;

const idParam = z.object({ id: z.string().uuid() }).strict();
const signerParam = z.object({ id: z.string().uuid(), signerId: z.string().uuid() }).strict();
const tokenParam = z.object({ token: z.string().max(100) }).strict();

// A table or function this build reads that isn't there yet: the migration isn't applied.
const MISSING = new Set(["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"]);
const err = (e: Pg) => (e?.code && MISSING.has(e.code) ? hubUnavailable() : fromPostgrest(e));

const SIGNER_COLUMNS = "id, envelope_id, sort_order, name, email, status, signature_kind, signature_text, initials_kind, initials_text, consent_at, signed_at, decline_reason, declined_at";
const SIGNER_WITH_IMAGES = `${SIGNER_COLUMNS}, signature_png, initials_png`;

const hubUrl = (id: string) => `${env.APP_URL}/dashboard/counselor/contracts/${id}`;
const signUrl = (token: string) => `${env.APP_URL}/sign/${token}`;

function svcOrUnavailable() {
  const svc = serviceClient();
  if (!svc) throw hubUnavailable();
  return svc;
}

export default async function contractHubRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  /** The caller's own envelope, read on their RLS client (404 when it isn't theirs). */
  async function ownEnvelope(request: FastifyRequest, id: string): Promise<Row> {
    const { data, error } = await request.db.from("contract_hub_envelopes").select("*").eq("id", id).maybeSingle();
    if (error) throw err(error);
    if (!data) throw notFound("No contract of yours matches that");
    return data as Row;
  }

  async function full(request: FastifyRequest, env_: Row) {
    // Signature images are read with the service role, after the caller's own read showed the envelope is theirs.
    const svc = svcOrUnavailable();
    const [s, f, ev] = await Promise.all([
      svc.from("contract_hub_signers").select(SIGNER_WITH_IMAGES).eq("envelope_id", env_.id).order("sort_order"),
      request.db.from("contract_hub_fields").select("*").eq("envelope_id", env_.id),
      request.db.from("contract_hub_events").select("at, text").eq("envelope_id", env_.id).order("at"),
    ]);
    if (s.error) throw err(s.error);
    if (f.error) throw err(f.error);
    if (ev.error) throw err(ev.error);
    return toEnvelopeDTO(env_, (s.data ?? []) as Row[], (f.data ?? []) as Row[], (ev.data ?? []) as Row[]);
  }

  async function event(envelopeId: unknown, text: string) {
    await svcOrUnavailable().from("contract_hub_events").insert({ envelope_id: envelopeId, text: text.slice(0, 300) });
  }

  async function emailLink(request: FastifyRequest, signer: Row, title: string, reminder: boolean, token: string) {
    const m = signRequestEmail({
      signerName: String(signer.name),
      senderName: request.profile.full_name ?? "Your counselor",
      title,
      url: signUrl(token),
      reminder,
    });
    const r = await sendEmail({
      to: String(signer.email),
      subject: m.subject,
      html: m.html,
      text: m.text,
      recordText: m.recordText,
      template: reminder ? "contract-hub-remind" : "contract-hub-sign",
      replyTo: request.profile.email ?? undefined,
      fromName: request.profile.full_name ?? null,
      logger: request.log,
    });
    return r;
  }

  app.post("/contract-hub/upload-url", { preHandler: [...counselor, limit("contract-hub:upload", 20, 3600)] }, async (request) => {
    uploadBody.parse(request.body);
    const probe = await request.db.from("contract_hub_envelopes").select("id").limit(1);
    if (probe.error) throw err(probe.error);
    const svc = svcOrUnavailable();
    const path = hubObjectPath(request.auth.userId);
    const { data, error } = await svc.storage.from(HUB_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      request.log.warn({ err: error }, "contract hub upload url failed");
      throw /bucket not found/i.test(error?.message ?? "") ? hubUnavailable() : badRequest("Couldn't start the upload. Try again.");
    }
    return { path, uploadUrl: data.signedUrl, token: data.token, expiresIn: HUB_UPLOAD_EXPIRES_IN, maxBytes: HUB_MAX_BYTES };
  });

  app.post("/contract-hub/envelopes", { preHandler: [...counselor, limit("contract-hub:create", 30, 3600)] }, async (request, reply) => {
    const b = createBody.parse(request.body);
    if (!ownHubPath(b.path, request.auth.userId)) throw badRequest("Upload the PDF through /contract-hub/upload-url first");
    const svc = svcOrUnavailable();
    const got = await downloadCapped(svc, HUB_BUCKET, b.path, HUB_MAX_BYTES);
    if (got.status === "error") throw badRequest("That PDF hasn't finished uploading");
    const remove = () => svc.storage.from(HUB_BUCKET).remove([b.path]).catch(() => undefined);
    if (got.status === "too-large") {
      await remove();
      throw badRequest("A PDF can be at most 10 MB");
    }
    if (!isPdf(got.bytes)) {
      await remove();
      throw badRequest("That file isn't a PDF");
    }
    const ins = await svc
      .from("contract_hub_envelopes")
      .insert({ counselor_id: request.auth.userId, title: b.title, file_name: b.fileName, storage_path: b.path, page_count: b.pageCount })
      .select("*")
      .single();
    if (ins.error) {
      if (ins.error.code === "23505") throw new HttpError(409, "That upload is already a contract", "contract_exists");
      throw err(ins.error);
    }
    const envRow = ins.data as Row;
    const signers = await svc
      .from("contract_hub_signers")
      .insert(b.signers.map((s, i) => ({ envelope_id: envRow.id, sort_order: i, name: s.name, email: s.email })))
      .select(SIGNER_COLUMNS);
    if (signers.error) {
      await svc.from("contract_hub_envelopes").delete().eq("id", envRow.id);
      throw err(signers.error);
    }
    await event(envRow.id, "Draft created");
    return reply.code(201).send(await full(request, envRow));
  });

  app.get("/contract-hub/envelopes", { preHandler: [...counselor, limit("contract-hub:read", 120, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("contract_hub_envelopes")
      .select("*")
      .eq("counselor_id", request.auth.userId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw err(error);
    const rows = (data ?? []) as Row[];
    const ids = rows.map((r) => r.id as string);
    const signers = ids.length
      ? await request.db.from("contract_hub_signers").select(SIGNER_COLUMNS).in("envelope_id", ids).order("sort_order")
      : { data: [], error: null };
    if (signers.error) throw err(signers.error);
    const by = new Map<string, Row[]>();
    for (const s of (signers.data ?? []) as Row[]) by.set(String(s.envelope_id), [...(by.get(String(s.envelope_id)) ?? []), s]);
    return { envelopes: rows.map((r) => toEnvelopeDTO(r, by.get(String(r.id)) ?? [], [])) };
  });

  app.get("/contract-hub/envelopes/:id", { preHandler: [...counselor, limit("contract-hub:read", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    return full(request, await ownEnvelope(request, id));
  });

  app.get("/contract-hub/envelopes/:id/document", { preHandler: [...counselor, limit("contract-hub:read", 120, 60)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const e = await ownEnvelope(request, id);
    return sendPdf(reply, String(e.storage_path), String(e.file_name));
  });

  app.put("/contract-hub/envelopes/:id/fields", { preHandler: [...counselor, limit("contract-hub:write", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = fieldsBody.parse(request.body);
    const e = await ownEnvelope(request, id);
    if (e.status !== "draft") throw new HttpError(409, "Fields can only change before the contract is sent", "not_draft");
    const s = await request.db.from("contract_hub_signers").select("id").eq("envelope_id", id);
    if (s.error) throw err(s.error);
    const signerIds = new Set(((s.data ?? []) as Row[]).map((r) => String(r.id)));
    if (b.fields.some((f) => !signerIds.has(f.signerId))) throw badRequest("A field names a signer who isn't on this contract");
    if (b.fields.some((f) => f.page > Number(e.page_count))) throw badRequest("A field is on a page the PDF doesn't have");
    const svc = svcOrUnavailable();
    const del = await svc.from("contract_hub_fields").delete().eq("envelope_id", id);
    if (del.error) throw err(del.error);
    if (b.fields.length) {
      const ins = await svc
        .from("contract_hub_fields")
        .insert(b.fields.map((f) => ({ envelope_id: id, signer_id: f.signerId, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h })))
        .select("*");
      if (ins.error) throw err(ins.error);
      return { fields: ((ins.data ?? []) as Row[]).map(toFieldDTO) };
    }
    return { fields: [] };
  });

  app.post("/contract-hub/envelopes/:id/send", { preHandler: [...counselor, limit("contract-hub:send", 20, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const e = await ownEnvelope(request, id);
    if (e.status !== "draft") throw new HttpError(409, "This contract was already sent", "not_draft");
    const [s, f] = await Promise.all([
      request.db.from("contract_hub_signers").select(SIGNER_COLUMNS).eq("envelope_id", id).order("sort_order"),
      request.db.from("contract_hub_fields").select("signer_id, type").eq("envelope_id", id),
    ]);
    if (s.error) throw err(s.error);
    if (f.error) throw err(f.error);
    const signers = (s.data ?? []) as Row[];
    const problem = sendProblem(
      signers.map((r) => ({ id: String(r.id), name: String(r.name) })),
      ((f.data ?? []) as Row[]).map((r) => ({ signer_id: String(r.signer_id), type: String(r.type) })),
    );
    if (problem) throw new HttpError(400, problem, "not_ready");
    const svc = svcOrUnavailable();
    // Claim the send first, so a double click emails nobody twice.
    const claim = await svc
      .from("contract_hub_envelopes")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "draft")
      .select("*")
      .maybeSingle();
    if (claim.error) throw err(claim.error);
    if (!claim.data) throw new HttpError(409, "This contract was already sent", "not_draft");
    const emailed: string[] = [];
    const failed: string[] = [];
    for (const signer of signers) {
      const t = mintHubToken();
      const up = await svc.from("contract_hub_signers").update({ token_hash: t.hash, token_expires_at: t.expiresAt }).eq("id", signer.id);
      if (up.error) throw err(up.error);
      const r = await emailLink(request, signer, String(e.title), false, t.token);
      (r.sent ? emailed : failed).push(String(signer.name));
    }
    await event(id, `Sent to ${signers.map((r) => String(r.name)).join(", ")}`);
    return { ...(await full(request, claim.data as Row)), emailed, notEmailed: failed };
  });

  app.post(
    "/contract-hub/envelopes/:id/signers/:signerId/remind",
    { preHandler: [...counselor, limit("contract-hub:remind", 30, 3600)] },
    async (request) => {
      const { id, signerId } = signerParam.parse(request.params);
      const e = await ownEnvelope(request, id);
      if (e.status !== "sent") throw new HttpError(409, "Only a contract out for signature can be reminded", "not_open");
      const s = await request.db.from("contract_hub_signers").select(SIGNER_COLUMNS).eq("id", signerId).eq("envelope_id", id).maybeSingle();
      if (s.error) throw err(s.error);
      if (!s.data) throw notFound("That signer isn't on this contract");
      const signer = s.data as Row;
      if (signer.status !== "waiting") throw new HttpError(409, `${String(signer.name)} already answered`, "not_open");
      const t = mintHubToken();
      const up = await svcOrUnavailable().from("contract_hub_signers").update({ token_hash: t.hash, token_expires_at: t.expiresAt }).eq("id", signerId).eq("status", "waiting");
      if (up.error) throw err(up.error);
      const r = await emailLink(request, signer, String(e.title), true, t.token);
      await event(id, `Reminder sent to ${String(signer.name)}`);
      return { emailed: r.sent };
    },
  );

  app.post("/contract-hub/envelopes/:id/void", { preHandler: [...counselor, limit("contract-hub:write", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await ownEnvelope(request, id);
    const svc = svcOrUnavailable();
    const up = await svc
      .from("contract_hub_envelopes")
      .update({ status: "voided", voided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "sent")
      .select("*")
      .maybeSingle();
    if (up.error) throw err(up.error);
    if (!up.data) throw new HttpError(409, "Only a contract out for signature can be voided", "not_open");
    await svc.from("contract_hub_signers").update({ token_hash: null, token_expires_at: null }).eq("envelope_id", id);
    await event(id, "Voided");
    return full(request, up.data as Row);
  });

  app.delete("/contract-hub/envelopes/:id", { preHandler: [...counselor, limit("contract-hub:write", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const e = await ownEnvelope(request, id);
    if (e.status !== "draft") throw new HttpError(409, "Only a draft can be deleted. Void a sent contract instead.", "not_draft");
    const svc = svcOrUnavailable();
    const del = await svc.from("contract_hub_envelopes").delete().eq("id", id).eq("status", "draft");
    if (del.error) throw err(del.error);
    await svc.storage.from(HUB_BUCKET).remove([String(e.storage_path)]).catch(() => undefined);
    return { deleted: true };
  });

  // ---------------------------------------------------------------------------
  // Public signing
  // ---------------------------------------------------------------------------

  const reads = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const writes = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  const gone = () => new HttpError(404, "This signing link isn't valid any more. Ask the sender for a new one.", "link_invalid");

  /** The signer and envelope a link names, only while it can still be used. */
  async function byToken(request: FastifyRequest) {
    const { token } = tokenParam.parse(request.params);
    if (!isHubToken(token)) throw gone();
    const svc = svcOrUnavailable();
    const s = await svc.from("contract_hub_signers").select("*").eq("token_hash", hashHubToken(token)).maybeSingle();
    if (s.error) throw err(s.error);
    const signer = s.data as Row | null;
    if (!signer || signer.status !== "waiting") throw gone();
    if (!signer.token_expires_at || Date.parse(String(signer.token_expires_at)) < Date.now()) throw gone();
    const e = await svc.from("contract_hub_envelopes").select("*").eq("id", signer.envelope_id).maybeSingle();
    if (e.error) throw err(e.error);
    const envRow = e.data as Row | null;
    if (!envRow || envRow.status !== "sent") throw gone();
    if (!(await isCounselorApproved(svc, String(envRow.counselor_id)))) throw gone();
    return { svc, signer, env: envRow };
  }

  app.get("/contract-hub/sign/:token", reads, async (request, reply) => {
    await enforceRateLimit(`contract-hub:sign-read:${request.ip}`, 600, 3600);
    const { svc, signer, env: e } = await byToken(request);
    const [s, f, sender] = await Promise.all([
      svc.from("contract_hub_signers").select(SIGNER_WITH_IMAGES).eq("envelope_id", e.id).order("sort_order"),
      svc.from("contract_hub_fields").select("*").eq("envelope_id", e.id),
      svc.from("profiles").select("full_name").eq("id", e.counselor_id).maybeSingle(),
    ]);
    if (s.error) throw err(s.error);
    if (f.error) throw err(f.error);
    reply.header("Cache-Control", "no-store");
    // Other signers show by name only, with what they already signed; never an email.
    const signers = ((s.data ?? []) as Row[]).map((r) => {
      const d = toSignerDTO(r);
      return { id: d.id, name: d.name, status: d.status, signature: d.signature, initials: d.initials };
    });
    return {
      title: String(e.title),
      pageCount: Number(e.page_count),
      senderName: (sender.data as Row | null)?.full_name ?? null,
      signer: { id: String(signer.id), name: String(signer.name) },
      signers,
      fields: ((f.data ?? []) as Row[]).map(toFieldDTO),
    };
  });

  app.get("/contract-hub/sign/:token/document", reads, async (request, reply) => {
    await enforceRateLimit(`contract-hub:sign-read:${request.ip}`, 600, 3600);
    const { env: e } = await byToken(request);
    return sendPdf(reply, String(e.storage_path), String(e.file_name));
  });

  app.post("/contract-hub/sign/:token", writes, async (request) => {
    await enforceRateLimit(`contract-hub:sign-write:${request.ip}`, 60, 3600);
    const b = signBody.parse(request.body);
    const { svc, signer, env: e } = await byToken(request);
    const f = await svc.from("contract_hub_fields").select("id, type").eq("signer_id", signer.id);
    if (f.error) throw err(f.error);
    const mine = ((f.data ?? []) as Row[]).map((r) => ({ id: String(r.id), type: String(r.type) }));
    const problem = signProblem(mine, b);
    if (problem) throw new HttpError(400, problem, "not_filled");
    const sig = b.signature ? cleanMark(b.signature, "signature") : null;
    const ini = b.initials ? cleanMark(b.initials, "initials") : null;
    const values = Object.fromEntries(mine.filter((m) => m.type === "name" || m.type === "text").map((m) => [m.id, b.values[m.id]!.trim()]));
    const { data, error } = await svc.rpc("contract_hub_sign", {
      p_signer: signer.id,
      p_values: values,
      p_date: signedDate(),
      p_signature_kind: sig?.kind ?? null,
      p_signature_text: sig?.text ?? null,
      p_signature_png_b64: sig?.png ?? null,
      p_initials_kind: ini?.kind ?? null,
      p_initials_text: ini?.text ?? null,
      p_initials_png_b64: ini?.png ?? null,
      p_ip: cleanIp(request.ip),
      p_user_agent: truncateUserAgent(request.headers["user-agent"]),
    });
    if (error) {
      if (/not_open/.test(error.message ?? "")) throw gone();
      throw err(error);
    }
    const status = String(data);
    if (status === "completed") void tellCounselor(request, e, "Everyone signed", `Everyone has signed ${String(e.title)}.`);
    return { status };
  });

  app.post("/contract-hub/sign/:token/decline", writes, async (request) => {
    await enforceRateLimit(`contract-hub:sign-write:${request.ip}`, 60, 3600);
    const b = declineBody.parse(request.body ?? {});
    const { svc, signer, env: e } = await byToken(request);
    const { error } = await svc.rpc("contract_hub_decline", { p_signer: signer.id, p_reason: b.reason ?? "" });
    if (error) {
      if (/not_open/.test(error.message ?? "")) throw gone();
      throw err(error);
    }
    void tellCounselor(
      request,
      e,
      `${String(signer.name)} declined`,
      `${String(signer.name)} declined to sign ${String(e.title)}${b.reason ? `: "${b.reason}"` : "."}`,
    );
    return { status: "declined" };
  });

  /** Email the envelope's counselor an outcome. Never throws: the signer's answer is already saved. */
  async function tellCounselor(request: FastifyRequest, e: Row, heading: string, line: string) {
    try {
      const svc = svcOrUnavailable();
      const p = await svc.from("profiles").select("email").eq("id", e.counselor_id).maybeSingle();
      const to = (p.data as Row | null)?.email;
      if (typeof to !== "string" || !to) return;
      const m = outcomeEmail({ title: String(e.title), heading, line, url: hubUrl(String(e.id)) });
      await sendEmail({ to, ...m, template: "contract-hub-outcome", logger: request.log, recipient_kind: "counselor", recipient_id: String(e.counselor_id) });
    } catch (error) {
      request.log.warn({ err: error }, "contract hub outcome email failed");
    }
  }

  async function sendPdf(reply: FastifyReply, path: string, fileName: string) {
    const got = await downloadCapped(svcOrUnavailable(), HUB_BUCKET, path, HUB_MAX_BYTES);
    if (got.status !== "ok") throw notFound("The PDF isn't available");
    const safe = fileName.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "contract.pdf";
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${safe}"`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(Buffer.from(got.bytes));
  }
}
