/**
 * Agreements (migration 20261111000010, lib/agreements.ts): a counselor attaches
 * a plain-text agreement to a Contact Pipeline contact and emails the family a
 * private link; the family accepts on a public page by typing their name and
 * ticking a consent box. THIS IS TYPED-NAME ACCEPTANCE, NOT A CERTIFIED
 * ELECTRONIC SIGNATURE, and every certificate says so.
 *
 * Switched OFF unless AGREEMENTS_ENABLED=true: every route below answers 404
 * `agreements_off` (the public page a plain "not available" page) before
 * authentication or anything else runs. Without the migration they answer 503
 * `agreements_unavailable`. Text only: no PDF attachment yet (`storage_path`
 * stays null).
 *
 * Counselor (approved; RLS: `private.crm_can_bill` on the contact):
 *   POST /agreements                 a draft for a contact
 *   GET  /agreements?contactId=      the contact's agreements (no body text)
 *   GET  /agreements/:id             one, with its acceptance if any
 *   POST /agreements/:id/send        mint a link (caller's client), email it; draft|sent -> sent
 *   POST /agreements/:id/void        draft|sent -> void
 *
 * Public (the token in the path is the capability, stored as sha256 only):
 *   GET  /agree/:token   the agreement and the form. Changes nothing (mail scanners prefetch links).
 *   POST /agree/:token   `signerName` + `consent=yes`: one transaction (`accept_agreement`) records the
 *                        acceptance and its certificate, marks the agreement accepted, writes audit_log and
 *                        moves the contact to "Contract signed" when that stage is ahead of it. Then both
 *                        parties are emailed a copy. A second submit shows "already accepted", never a second row.
 * The public routes use the service role: nobody is signed in. They read only the agreement the token names,
 * its contact's email and its practice's name, refuse when its counselor isn't approved, and write only
 * through `accept_agreement`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { approvedCounselorIds } from "../lib/access.js";
import { AGREEMENT_CONSENT_VERSION } from "../lib/agreementConsent.js";
import {
  AGREEMENT_COLUMNS,
  AGREEMENT_TOKEN,
  acceptanceEmails,
  agreementBodyText,
  agreementForToken,
  agreementsError,
  agreementsOff,
  agreementsUnavailable,
  agreementTitle,
  agreementPageBody,
  agreementSentEmail,
  agreementsEnabled,
  buildCertificate,
  cleanIp,
  hashAgreementToken,
  mintAgreementLink,
  parseAcceptForm,
  truncateUserAgent,
  type TokenLookup,
  isOpenAgreement,
  OPEN_AGREEMENT_STATUSES,
} from "../lib/agreements.js";
import { crmError } from "../lib/crm.js";
import { sendEmail } from "../lib/email.js";
import { HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { enforceRateLimit, limit } from "../lib/limits.js";
import { serializeErr } from "../lib/requestLog.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;
type PgError = { code?: string; message?: string } | null;

const unavailable = agreementsUnavailable;

// ---- DTOs ----------------------------------------------------------------------------

function acceptanceDto(a: Row | null | undefined) {
  if (!a) return null;
  return {
    id: String(a.id),
    signerName: String(a.signer_name),
    signerEmail: (a.signer_email as string | null) ?? null,
    acceptedAt: String(a.accepted_at),
    ip: (a.ip as string | null) ?? null,
    userAgent: (a.user_agent as string | null) ?? null,
    bodySha256: String(a.body_sha256),
    consentVersion: String(a.consent_version),
    certificateText: String(a.certificate_text),
  };
}

function agreementDto(r: Row, opts: { withBody: boolean; acceptance?: Row | null }) {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    counselorId: String(r.counselor_id),
    title: String(r.title),
    ...(opts.withBody ? { bodyText: String(r.body_text) } : {}),
    bodySha256: String(r.body_sha256),
    consentVersion: String(r.consent_version),
    status: String(r.status) as "draft" | "sent" | "accepted" | "void",
    createdAt: String(r.created_at),
    sentAt: (r.sent_at as string | null) ?? null,
    acceptedAt: (r.accepted_at as string | null) ?? null,
    voidedAt: (r.voided_at as string | null) ?? null,
    acceptance: acceptanceDto(opts.acceptance),
  };
}

// ---- The public page -----------------------------------------------------------------

// No script source at all: the page is a plain form post.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(reply: FastifyReply, status: number, body: string) {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex")
    .header("Content-Security-Policy", CSP)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agreement</title></head>
<body style="font-family:Arial,sans-serif;max-width:680px;margin:48px auto;padding:0 16px;color:#1f2937">${body}</body></html>`);
}

const NOT_AVAILABLE = "<h1>This page is not available</h1>";
const INVALID = "<h1>This link isn't valid</h1><p>Use the link in the email you received, or ask your counselor to send it again.</p>";
const EXPIRED = "<h1>This link has expired</h1><p>Ask your counselor to send the agreement again.</p>";
const VOID = "<h1>This agreement was withdrawn</h1><p>There's nothing to accept. Ask your counselor if you have questions.</p>";
const UNAVAILABLE = "<h1>Agreements aren't available right now</h1><p>Try again later.</p>";
const TOO_MANY = "<h1>Too many tries</h1><p>Wait a few minutes and try again.</p>";
const FORM_ERROR = "Type your full name (2 to 120 characters) and tick the box to accept.";

// ---- Routes ----------------------------------------------------------------------------

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid }).strict();
const createBody = z.object({ contactId: uuid, title: agreementTitle, bodyText: agreementBodyText }).strict();

export default async function agreementRoutes(app: FastifyInstance) {
  // The accept form is the only body the public page takes; kept raw for the strict parse.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 4096 }, (_r, body, done) => done(null, body));

  // The OFF switch, before authentication, body parsing or anything else.
  app.addHook("onRequest", async (request, reply) => {
    if (agreementsEnabled()) return;
    if ((request.routeOptions.url ?? "").startsWith("/agree/")) return page(reply, 404, NOT_AVAILABLE);
    const off = agreementsOff();
    return reply.code(off.statusCode).send({ error: off.message, code: off.code });
  });

  const counselor = [app.authenticate, requireRole("counselor")];

  async function loadAgreement(request: FastifyRequest, id: string): Promise<Row> {
    const { data, error } = await request.db.from("agreements").select(AGREEMENT_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw agreementsError(error);
    if (!data) throw notFound("No agreement of yours matches that");
    return data as unknown as Row;
  }

  async function loadAcceptance(db: FastifyRequest["db"], agreementId: string): Promise<Row | null> {
    const { data, error } = await db.from("agreement_acceptances").select("*").eq("agreement_id", agreementId).maybeSingle();
    if (error) throw agreementsError(error);
    return (data as Row | null) ?? null;
  }

  app.post("/agreements", { preHandler: [...counselor, limit("agreements:write", 60, 60)] }, async (request, reply) => {
    const b = createBody.parse(request.body);
    const contact = await request.db.from("pipeline_contacts").select("id").eq("id", b.contactId).maybeSingle();
    if (contact.error) throw crmError(contact.error);
    if (!contact.data) throw notFound("That contact isn't in your pipeline");
    const { data, error } = await request.db
      .from("agreements")
      .insert({
        counselor_id: request.auth.userId,
        contact_id: b.contactId,
        title: b.title,
        body_text: b.bodyText,
        consent_version: AGREEMENT_CONSENT_VERSION,
      })
      .select(AGREEMENT_COLUMNS)
      .single();
    if (error) throw agreementsError(error);
    return reply.code(201).send(agreementDto(data as unknown as Row, { withBody: true }));
  });

  app.get("/agreements", { preHandler: [...counselor, limit("agreements:read", 120, 60)] }, async (request) => {
    const { contactId } = z.object({ contactId: uuid }).strict().parse(request.query);
    const { data, error } = await request.db
      .from("agreements")
      .select(AGREEMENT_COLUMNS)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw agreementsError(error);
    const rows = (data ?? []) as unknown as Row[];
    const accepted = rows.filter((r) => r.status === "accepted").map((r) => String(r.id));
    const byAgreement = new Map<string, Row>();
    if (accepted.length > 0) {
      const acc = await request.db.from("agreement_acceptances").select("*").in("agreement_id", accepted);
      if (acc.error) throw agreementsError(acc.error);
      for (const a of (acc.data ?? []) as Row[]) byAgreement.set(String(a.agreement_id), a);
    }
    return { agreements: rows.map((r) => agreementDto(r, { withBody: false, acceptance: byAgreement.get(String(r.id)) ?? null })) };
  });

  app.get("/agreements/:id", { preHandler: [...counselor, limit("agreements:read", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const row = await loadAgreement(request, id);
    const acceptance = row.status === "accepted" ? await loadAcceptance(request.db, id) : null;
    return agreementDto(row, { withBody: true, acceptance });
  });

  app.post(
    "/agreements/:id/send",
    { preHandler: [...counselor, limit("agreements:send", 20, 3600, "You've sent a lot of agreements this hour. Give it a moment.")] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const row = await loadAgreement(request, id);
      if (!isOpenAgreement(row.status)) {
        throw new HttpError(409, "This agreement was already accepted or withdrawn", "agreement_closed");
      }
      const c = await request.db
        .from("pipeline_contacts")
        .select("id, student_name, parent_name, parent_email, student_email")
        .eq("id", String(row.contact_id))
        .maybeSingle();
      if (c.error) throw crmError(c.error);
      const contact = c.data as Row | null;
      if (!contact) throw notFound("That contact isn't in your pipeline");
      const toParent = Boolean(String(contact.parent_email ?? "").trim());
      const to = String((toParent ? contact.parent_email : contact.student_email) ?? "").trim();
      if (!to) throw new HttpError(400, "Add an email address to the contact's card first", "contact_no_email");
      if (!env.PUBLIC_API_URL) throw unavailable();

      let url: string;
      try {
        ({ url } = await mintAgreementLink(request.db, id, { publicApiUrl: env.PUBLIC_API_URL }));
      } catch (err) {
        throw agreementsError(err as PgError);
      }
      const mail = agreementSentEmail({
        title: String(row.title),
        url,
        senderName: request.profile.full_name ?? null,
        recipientName: String((toParent ? contact.parent_name : contact.student_name) ?? "").trim(),
      });
      const sent = await sendEmail({
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        recordText: mail.recordText,
        template: "agreement-sent",
        recipient_kind: toParent ? "guardian" : "student",
        fromName: request.profile.full_name ?? null,
        ...(request.profile.email ? { replyTo: request.profile.email } : {}),
        logger: request.log,
      });
      return { agreement: agreementDto(await loadAgreement(request, id), { withBody: true }), sentTo: to, emailSent: sent.sent };
    }
  );

  app.post("/agreements/:id/void", { preHandler: [...counselor, limit("agreements:write", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const row = await loadAgreement(request, id);
    if (!isOpenAgreement(row.status)) {
      throw new HttpError(409, "Only a draft or a sent agreement can be voided", "agreement_closed");
    }
    const { data, error } = await request.db
      .from("agreements")
      .update({ status: "void" })
      .eq("id", id)
      .in("status", [...OPEN_AGREEMENT_STATUSES])
      .select(AGREEMENT_COLUMNS)
      .maybeSingle();
    if (error) throw agreementsError(error);
    if (!data) throw new HttpError(409, "Only a draft or a sent agreement can be voided", "agreement_closed");
    return agreementDto(data as unknown as Row, { withBody: true });
  });

  // ---- Public ----------------------------------------------------------------------------

  /** Per address and per link. Answers false when over. */
  async function withinLimits(request: FastifyRequest, token: string, kind: "view" | "accept"): Promise<boolean> {
    try {
      await enforceRateLimit(`agree:ip:${request.ip}`, 30, 60);
      await enforceRateLimit(`agree:${kind}:${hashAgreementToken(token)}`, kind === "accept" ? 10 : 60, 3600);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 429) return false;
      throw err;
    }
  }

  type Opened = { svc: NonNullable<ReturnType<typeof serviceClient>>; lookup: TokenLookup } | { status: number; body: string };

  /** The link, then the counselor's approval. */
  async function open(request: FastifyRequest, token: string): Promise<Opened> {
    if (!AGREEMENT_TOKEN.test(token)) return { status: 404, body: INVALID };
    const svc = serviceClient();
    if (!svc) return { status: 503, body: UNAVAILABLE };
    let lookup: TokenLookup;
    try {
      lookup = await agreementForToken(svc, token);
    } catch (err) {
      if (!isResultsNotApplied(err as PgError)) request.log.error({ err: serializeErr(err) }, "agree: could not read the agreement");
      return { status: 503, body: UNAVAILABLE };
    }
    if (lookup.state === "invalid") return { status: 404, body: INVALID };
    const counselorId = String(lookup.agreement.counselor_id);
    if (!(await approvedCounselorIds(svc, [counselorId])).has(counselorId)) return { status: 503, body: UNAVAILABLE };
    if (lookup.state === "void") return { status: 410, body: VOID };
    return { svc, lookup };
  }

  async function acceptedPage(svc: NonNullable<ReturnType<typeof serviceClient>>, agreement: Row): Promise<string> {
    const acc = await svc.from("agreement_acceptances").select("signer_name, accepted_at, body_sha256").eq("agreement_id", String(agreement.id)).maybeSingle();
    if (acc.error || !acc.data) throw new Error(`read acceptance: ${acc.error?.code ?? "missing"}`);
    const a = acc.data as Row;
    return agreementPageBody({
      title: String(agreement.title),
      bodyText: String(agreement.body_text),
      error: null,
      accepted: { signerName: String(a.signer_name), acceptedAt: new Date(String(a.accepted_at)).toISOString(), bodySha256: String(a.body_sha256) },
    });
  }

  app.get("/agree/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      if (!(await withinLimits(request, token, "view"))) return page(reply, 429, TOO_MANY);
      const o = await open(request, token);
      if ("status" in o) return page(reply, o.status, o.body);
      const { svc, lookup } = o;
      if (lookup.state === "expired") return page(reply, 410, EXPIRED);
      if (lookup.state === "accepted") return page(reply, 200, await acceptedPage(svc, lookup.agreement));
      if (lookup.state !== "open") return page(reply, 404, INVALID);
      return page(reply, 200, agreementPageBody({ title: String(lookup.agreement.title), bodyText: String(lookup.agreement.body_text), error: null }));
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "agree: could not show the agreement");
      return page(reply, 503, UNAVAILABLE);
    }
  });

  app.post("/agree/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      if (!(await withinLimits(request, token, "accept"))) return page(reply, 429, TOO_MANY);
      const o = await open(request, token);
      if ("status" in o) return page(reply, o.status, o.body);
      const { svc, lookup } = o;
      if (lookup.state === "expired") return page(reply, 410, EXPIRED);
      if (lookup.state === "accepted") return page(reply, 409, `<h2>Already accepted</h2>${await acceptedPage(svc, lookup.agreement)}`);
      if (lookup.state !== "open") return page(reply, 404, INVALID);
      const agreement = lookup.agreement;

      const form = parseAcceptForm(typeof request.body === "string" ? request.body : "");
      if (!form.ok) {
        return page(reply, 400, agreementPageBody({ title: String(agreement.title), bodyText: String(agreement.body_text), error: FORM_ERROR }));
      }

      const [contactRes, counselorRes, firmRes] = await Promise.all([
        svc.from("pipeline_contacts").select("parent_email, student_email").eq("id", String(agreement.contact_id)).maybeSingle(),
        svc.from("profiles").select("full_name, email").eq("id", String(agreement.counselor_id)).maybeSingle(),
        agreement.firm_id
          ? svc.from("firms").select("name").eq("id", String(agreement.firm_id)).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      const readError = contactRes.error ?? counselorRes.error ?? firmRes.error;
      if (readError) throw new Error(`read for acceptance: ${readError.code ?? "unknown"}`);
      const contact = (contactRes.data as Row | null) ?? {};
      const counselor = (counselorRes.data as Row | null) ?? {};
      const practiceName =
        String((firmRes.data as Row | null)?.name ?? "").trim() || String(counselor.full_name ?? "").trim() || "the practice";
      const signerEmail = String(contact.parent_email || contact.student_email || "").trim() || null;

      const acceptedAt = new Date();
      const ip = cleanIp(request.ip);
      const userAgent = truncateUserAgent(request.headers["user-agent"]);
      const certificate = buildCertificate({
        title: String(agreement.title),
        bodySha256: String(agreement.body_sha256),
        signerName: form.signerName,
        signerEmail,
        acceptedAt,
        ip,
        userAgent,
        consentVersion: AGREEMENT_CONSENT_VERSION,
        practiceName,
      });

      const { data, error } = await svc.rpc("accept_agreement", {
        p_token_hash: hashAgreementToken(token),
        p_signer_name: form.signerName,
        p_signer_email: signerEmail,
        p_ip: ip,
        p_user_agent: userAgent,
        p_consent_version: AGREEMENT_CONSENT_VERSION,
        p_body_sha256: String(agreement.body_sha256),
        p_accepted_at: acceptedAt.toISOString(),
        p_certificate: certificate,
      });
      if (error) {
        if (!isResultsNotApplied(error)) request.log.error({ code: error.code }, "agree: accept_agreement failed");
        return page(reply, 503, UNAVAILABLE);
      }
      const result = String((data as Row | null)?.result ?? "");
      if (result === "already") return page(reply, 409, `<h2>Already accepted</h2>${await acceptedPage(svc, agreement)}`);
      if (result === "expired") return page(reply, 410, EXPIRED);
      if (result === "void") return page(reply, 410, VOID);
      if (result !== "accepted") return page(reply, 404, INVALID);

      // The record is committed; the copies are best effort and never undo it.
      const mails = acceptanceEmails({
        title: String(agreement.title),
        bodyText: String(agreement.body_text),
        certificate,
        signerName: form.signerName,
        senderName: (counselor.full_name as string | null) ?? null,
      });
      const counselorEmail = String(counselor.email ?? "").trim();
      const sends: Promise<unknown>[] = [];
      if (signerEmail) {
        sends.push(
          sendEmail({
            to: signerEmail,
            ...mails.signer,
            template: "agreement-accepted",
            recipient_kind: contact.parent_email ? "guardian" : "student",
            fromName: (counselor.full_name as string | null) ?? null,
            ...(counselorEmail ? { replyTo: counselorEmail } : {}),
            logger: request.log,
          })
        );
      }
      if (counselorEmail) {
        sends.push(
          sendEmail({
            to: counselorEmail,
            ...mails.counselor,
            template: "agreement-accepted-counselor",
            recipient_kind: "counselor",
            recipient_id: String(agreement.counselor_id),
            logger: request.log,
          })
        );
      }
      for (const r of await Promise.allSettled(sends)) {
        if (r.status === "rejected") request.log.warn({ err: serializeErr(r.reason) }, "agree: a copy of the acceptance didn't go out");
      }

      const thanks = `<h2>Thank you. Your acceptance is recorded.</h2>${signerEmail ? "<p>A copy is on its way to your email.</p>" : ""}`;
      const recorded = agreementPageBody({
        title: String(agreement.title),
        bodyText: String(agreement.body_text),
        error: null,
        accepted: { signerName: form.signerName, acceptedAt: acceptedAt.toISOString(), bodySha256: String(agreement.body_sha256) },
      });
      return page(reply, 200, thanks + recorded);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "agree: could not record the acceptance");
      return page(reply, 503, UNAVAILABLE);
    }
  });
}
