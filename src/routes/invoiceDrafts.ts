/**
 * Saved and scheduled invoices (migration 20261124000004, lib/invoiceDrafts.ts). A draft is not an invoice:
 * nothing is numbered or billed until it is sent, by the `/internal/invoice-drafts/dispatch` cron (which
 * re-checks everything at send time, so a draft is never trusted).
 *
 *   GET    /pipeline/invoice-drafts?contactId=&state=   { drafts }       (a family's drafts, newest first)
 *   POST   /pipeline/invoice-drafts                     { contactId, payload, state?: "draft"|"scheduled", repeatYearly? } -> 201 draft
 *   PUT    /pipeline/invoice-drafts/:id                 { payload?, state?, repeatYearly? } -> draft  (not once sent or cancelled)
 *   DELETE /pipeline/invoice-drafts/:id                 cancels it -> draft (409 once sent)
 *
 * Whoever may bill the contact (`crm_can_bill`, enforced by RLS) writes them; the send time comes from the
 * payload's schedule in the counselor's time zone (UTC without one). Without the migration: 503
 * `invoice_drafts_unavailable`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { crmError, todayIn } from "../lib/crm.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { checkInvoiceAgreement } from "../lib/invoiceAgreement.js";
import { DRAFT_COLUMNS, draftPayload, draftProblem, draftStates, sendAtFor, toDraftDTO, type DraftPayload } from "../lib/invoiceDrafts.js";
import { textingAvailable, textingUnavailable } from "../lib/invoiceTexting.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";

type Row = Record<string, unknown>;
const idParam = z.object({ id: z.string().uuid() }).strict();
const unavailable = () => new HttpError(503, "Saved and scheduled invoices aren't switched on yet", "invoice_drafts_unavailable");
const dbError = (e: { code?: string; message?: string } | null) => (isResultsNotApplied(e) ? unavailable() : crmError(e));
/** The cron holds a claim for up to ten minutes (the blasts' rule); an edit or cancel waits for it. */
const CLAIM_MS = 10 * 60_000;
const notClaimed = () => `claimed_at.is.null,claimed_at.lt.${new Date(Date.now() - CLAIM_MS).toISOString()}`;
const sending = () => new HttpError(409, "This invoice is being sent right now. Try again in a minute.", "draft_sending");

export default async function invoiceDraftRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const read = [...counselor, limit("invoice-drafts:read", 120, 60)];
  const write = [...counselor, limit("invoice-drafts:write", 60, 60)];

  /** The contact, read on the caller's client (404 when it isn't theirs to see). */
  async function contactOf(request: FastifyRequest, id: string): Promise<Row> {
    const { data, error } = await request.db.from("pipeline_contacts").select("id, parent_email, student_email, parent_phone, student_phone").eq("id", id).maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("That contact isn't in your pipeline");
    return data as Row;
  }

  /** The checks a draft must pass to be saved at all (the cron checks again when it sends). */
  async function check(request: FastifyRequest, contact: Row, payload: DraftPayload, state: "draft" | "scheduled", repeatYearly: boolean) {
    const tz = request.profile.timezone;
    const problem = draftProblem(payload, state, { tz, now: Date.now(), today: todayIn(tz) });
    if (problem) throw new HttpError(problem.status, problem.message, problem.code);
    if (repeatYearly && state !== "scheduled") throw badRequest("Only a scheduled invoice can repeat every year");
    checkInvoiceAgreement(payload.agreement, { to: payload.to || String(contact.parent_email || contact.student_email || ""), send: true });
    if (payload.channel === "text") {
      if (!String(contact.parent_phone || contact.student_phone || "").trim()) throw new HttpError(400, "Add a phone number to the contact's card first", "contact_no_phone");
      if (!(await textingAvailable(request.auth.userId))) throw textingUnavailable();
    }
  }

  app.get("/invoice-drafts", { preHandler: read }, async (request) => {
    const q = z.object({ contactId: z.string().uuid(), state: z.enum(draftStates).optional() }).strict().parse(request.query);
    let query = request.db.from("pipeline_invoice_drafts").select(DRAFT_COLUMNS).eq("contact_id", q.contactId);
    if (q.state) query = query.eq("state", q.state);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
    if (error) throw dbError(error);
    return { drafts: ((data ?? []) as unknown as Row[]).map(toDraftDTO) };
  });

  app.post("/invoice-drafts", { preHandler: write }, async (request, reply) => {
    const b = z
      .object({ contactId: z.string().uuid(), payload: draftPayload, state: z.enum(["draft", "scheduled"]).default("draft"), repeatYearly: z.boolean().default(false) })
      .strict()
      .parse(request.body);
    const contact = await contactOf(request, b.contactId);
    await check(request, contact, b.payload, b.state, b.repeatYearly);
    const { data, error } = await request.db
      .from("pipeline_invoice_drafts")
      .insert({
        contact_id: b.contactId,
        payload: b.payload,
        state: b.state,
        send_at: sendAtFor(b.payload, b.state, { tz: request.profile.timezone, now: Date.now() }),
        repeat_yearly: b.repeatYearly,
        created_by: request.auth.userId,
      })
      .select(DRAFT_COLUMNS)
      .single();
    if (error) throw dbError(error);
    return reply.code(201).send(toDraftDTO(data as unknown as Row));
  });

  app.put("/invoice-drafts/:id", { preHandler: write }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({ payload: draftPayload.optional(), state: z.enum(["draft", "scheduled"]).optional(), repeatYearly: z.boolean().optional() })
      .strict()
      .parse(request.body);
    const cur = await request.db.from("pipeline_invoice_drafts").select(DRAFT_COLUMNS).eq("id", id).maybeSingle();
    if (cur.error) throw dbError(cur.error);
    if (!cur.data) throw notFound("No saved invoice of yours matches that");
    const row = cur.data as unknown as Row;
    if (row.state === "sent" || row.state === "cancelled") throw new HttpError(409, "This invoice was already sent or cancelled", "draft_closed");
    const payload = b.payload ?? (row.payload as DraftPayload);
    const state = b.state ?? (row.state === "scheduled" ? "scheduled" : "draft");
    const repeatYearly = b.repeatYearly ?? row.repeat_yearly === true;
    const contact = await contactOf(request, String(row.contact_id));
    await check(request, contact, payload, state, repeatYearly);
    const { data, error } = await request.db
      .from("pipeline_invoice_drafts")
      .update({
        payload,
        state,
        send_at: sendAtFor(payload, state, { tz: request.profile.timezone, now: Date.now() }),
        repeat_yearly: repeatYearly,
      })
      .eq("id", id)
      .in("state", ["draft", "scheduled", "failed"])
      .or(notClaimed())
      .select(DRAFT_COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) {
      const now = await request.db.from("pipeline_invoice_drafts").select("state").eq("id", id).maybeSingle();
      const st = String((now.data as Row | null)?.state ?? "");
      throw st === "scheduled" ? sending() : new HttpError(409, "This invoice was just sent or cancelled", "draft_closed");
    }
    return toDraftDTO(data as unknown as Row);
  });

  app.delete("/invoice-drafts/:id", { preHandler: write }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("pipeline_invoice_drafts")
      .update({ state: "cancelled" })
      .eq("id", id)
      .in("state", ["draft", "scheduled", "failed"])
      .or(notClaimed())
      .select(DRAFT_COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) {
      const exists = await request.db.from("pipeline_invoice_drafts").select("state").eq("id", id).maybeSingle();
      if (!exists.data) throw notFound("No saved invoice of yours matches that");
      const state = String((exists.data as Row).state);
      if (state === "scheduled") throw sending();
      if (state === "cancelled") return toDraftDTO((await request.db.from("pipeline_invoice_drafts").select(DRAFT_COLUMNS).eq("id", id).single()).data as unknown as Row);
      throw new HttpError(409, "This invoice was already sent", "draft_closed");
    }
    return toDraftDTO(data as unknown as Row);
  });
}
