/**
 * Family consent (migration 20261129000001). The form on meridiesai.com (/privacy/family-consent/<token>) calls the
 * public half; a Consultant creates and manages the links with the rest.
 *
 *   POST   /students/:id/family-consent        { guardianEmail? }  a new link (the old pending one is replaced)
 *   GET    /students/:id/family-consent        the student's requests, newest first (status only; never the token)
 *   DELETE /family-consent/:requestId          revoke a request
 *   GET    /consent/:token                     public: who is asking, and the link's state
 *   POST   /consent/:token                     public: the signed form. 404 unknown, 409 already signed, 410 expired or revoked
 *
 * The token is random (32 bytes) and only its sha256 is stored. A link lasts 30 days. Signing is atomic: the update
 * only matches a row that is still pending and unexpired, so two quick submissions cannot both win.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { badRequest, conflict, fromPostgrest, HttpError, notFound, unavailable } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

const LINK_DAYS = 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const notSwitchedOn = () => new HttpError(503, "Family consent isn't switched on yet", "family_consent_unavailable");

const idParam = z.object({ id: z.string().uuid() }).strict();
const requestParam = z.object({ requestId: z.string().uuid() }).strict();
const createBody = z.object({ guardianEmail: z.string().trim().email().max(254).optional() }).strict();

const text = (max: number) => z.string().trim().min(1).max(max);
export const submissionBody = z
  .object({
    guardianFullName: text(200),
    relationship: text(80),
    guardianEmail: z.string().trim().email().max(254),
    studentFullName: text(200),
    studentIsAdult: z.boolean(),
    studentTypedSignature: text(200).optional(),
    guardianTypedSignature: text(200),
    agreed: z.literal(true),
    consentVersion: text(40),
  })
  .strict()
  .refine((b) => !b.studentIsAdult || Boolean(b.studentTypedSignature), { message: "An adult student signs too" });

export type RequestState = "pending" | "signed" | "expired" | "revoked";

/** What a link is right now: a pending one past its time reads as expired. */
export function stateOf(row: { status: string; expires_at: string }, now: Date): RequestState {
  if (row.status === "signed") return "signed";
  if (row.status === "revoked") return "revoked";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "pending";
}

export function consentLink(token: string): string {
  return `${env.SITE_URL.replace(/\/+$/, "")}/privacy/family-consent/${token}`;
}

export default async function familyConsentRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const publicConfig = { rateLimit: { max: 30, timeWindow: "1 minute" } };

  app.post("/students/:id/family-consent", { preHandler: [...counselor, limit("consent:create", 60, 3600)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = createBody.parse(request.body ?? {});
    const studentId = await resolveStudentId(request, id, "edit");
    const svc = serviceClient();
    if (!svc) throw unavailable("Family consent needs the service role key.");

    // Replace any link still waiting: one live link per student.
    const old = await svc
      .from("family_consent_requests")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("student_id", studentId)
      .eq("status", "pending");
    if (old.error) throw isResultsNotApplied(old.error) ? notSwitchedOn() : fromPostgrest(old.error);

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000).toISOString();
    const ins = await svc
      .from("family_consent_requests")
      .insert({
        counselor_id: request.auth.userId,
        student_id: studentId,
        token_hash: hash(token),
        guardian_email: body.guardianEmail ?? null,
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (ins.error) throw isResultsNotApplied(ins.error) ? notSwitchedOn() : fromPostgrest(ins.error);
    return reply.code(201).send({ id: (ins.data as Row).id, link: consentLink(token), expiresAt, status: "pending" });
  });

  app.get("/students/:id/family-consent", { preHandler: [...counselor, limit("consent:list", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const studentId = await resolveStudentId(request, id, "view");
    const { data, error } = await request.db
      .from("family_consent_requests")
      .select("id, status, guardian_email, expires_at, signed_at, revoked_at, consent_version, created_at")
      .eq("student_id", studentId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw isResultsNotApplied(error) ? notSwitchedOn() : fromPostgrest(error);
    const now = new Date();
    return {
      requests: ((data ?? []) as Row[]).map((r) => ({
        id: r.id,
        status: stateOf({ status: String(r.status), expires_at: String(r.expires_at) }, now),
        guardianEmail: r.guardian_email ?? null,
        expiresAt: r.expires_at,
        signedAt: r.signed_at ?? null,
        revokedAt: r.revoked_at ?? null,
        consentVersion: r.consent_version ?? null,
        createdAt: r.created_at,
      })),
    };
  });

  app.delete("/family-consent/:requestId", { preHandler: [...counselor, limit("consent:revoke", 60, 3600)] }, async (request, reply) => {
    const { requestId } = requestParam.parse(request.params);
    // RLS: only the Consultant who made it, for a student still theirs. A signed consent is revoked, not deleted.
    const { data, error } = await request.db
      .from("family_consent_requests")
      .select("id, status")
      .eq("id", requestId)
      .maybeSingle();
    if (error) throw isResultsNotApplied(error) ? notSwitchedOn() : fromPostgrest(error);
    if (!data) throw notFound("No consent request of yours matches that");
    const svc = serviceClient();
    if (!svc) throw unavailable("Family consent needs the service role key.");
    const upd = await svc
      .from("family_consent_requests")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("id", requestId)
      .neq("status", "revoked");
    if (upd.error) throw fromPostgrest(upd.error);
    return reply.code(204).send();
  });

  async function find(token: string) {
    const svc = serviceClient();
    if (!svc) throw unavailable("Family consent is unavailable on this server");
    if (!TOKEN.test(token)) return { svc, row: null as Row | null };
    const { data, error } = await svc
      .from("family_consent_requests")
      .select("id, status, expires_at, counselor_id, student_id")
      .eq("token_hash", hash(token))
      .maybeSingle();
    if (error) throw isResultsNotApplied(error) ? notSwitchedOn() : unavailable("Family consent is unavailable right now");
    return { svc, row: (data as Row | null) ?? null };
  }

  app.get("/consent/:token", { config: publicConfig }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { svc, row } = await find(token);
    if (!row) throw notFound("This link isn't valid");
    const [student, consultant] = await Promise.all([
      svc.from("profiles").select("full_name").eq("id", String(row.student_id)).maybeSingle(),
      svc.from("profiles").select("full_name, firm_id").eq("id", String(row.counselor_id)).maybeSingle(),
    ]);
    const c = (consultant.data as Row | null) ?? {};
    let firmName = "";
    if (c.firm_id) {
      const firm = await svc.from("firms").select("name").eq("id", String(c.firm_id)).maybeSingle();
      firmName = String(((firm.data as Row | null) ?? {}).name ?? "");
    }
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return {
      status: stateOf({ status: String(row.status), expires_at: String(row.expires_at) }, new Date()),
      // First name only: the link is the only secret, so nothing more than the form needs is returned.
      studentFirstName: String(((student.data as Row | null) ?? {}).full_name ?? "").split(/\s+/)[0] ?? "",
      consultantName: String(c.full_name ?? ""),
      firmName,
    };
  });

  app.post("/consent/:token", { config: publicConfig }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const parsed = submissionBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("Check the form and try again");
    const { svc, row } = await find(token);
    if (!row) throw notFound("This link isn't valid");
    const state = stateOf({ status: String(row.status), expires_at: String(row.expires_at) }, new Date());
    if (state === "signed") throw conflict("This form has already been signed");
    if (state !== "pending") throw new HttpError(410, "This link is no longer active");

    const now = new Date();
    const { data, error } = await svc
      .from("family_consent_requests")
      .update({
        status: "signed",
        signed_at: now.toISOString(),
        consent_version: parsed.data.consentVersion,
        submission: parsed.data,
      })
      .eq("id", String(row.id))
      .eq("status", "pending")
      .gt("expires_at", now.toISOString())
      .select("id")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw conflict("This form has already been signed");
    return reply.code(204).send();
  });
}
