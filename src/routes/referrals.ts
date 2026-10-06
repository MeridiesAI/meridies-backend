/**
 * Post-application referrals (demo v6, `lib/referrals.ts`).
 *
 *   asked       the counselor has asked; nobody is named yet
 *   introduced  the family named someone and gave an email
 *   invited     that family has an intake invitation
 *   signed      they accepted it and joined the practice
 *
 * The stored status is the counselor's last move. From "invited" on, the
 * invitation decides: accepted reads "signed", and a revoked or expired one
 * falls back to "introduced" so it can be invited again. Derived here, so the
 * referral and the invitation can never disagree.
 *
 * The *ask* is written from the student's Communication popup (another v10
 * area); it calls `POST /referrals`, optionally with the id of the message
 * that carried the ask.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { assertCanEditStudent, requireRole } from "../lib/guards.js";
import { addressStatuses, createInvitation } from "../lib/invites.js";
import { enforceQuota, limit } from "../lib/limits.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

const SELECT =
  "id, from_student_id, family_name, contact_email, status, invitation_id, ask_message_id, " +
  "asked_at, introduced_at, invited_at, created_at, updated_at, " +
  "from_student:profiles!referrals_from_student_id_fkey(full_name), " +
  "invitation:invitations!referrals_invitation_id_fkey(id, status, expires_at, accepted_by)";

export type ReferralStatus = "asked" | "introduced" | "invited" | "signed";

export function toReferral(r: Row) {
  const inv = r.invitation as Row | null;
  const stored = String(r.status) as "asked" | "introduced" | "invited";
  let status: ReferralStatus = stored;
  if (stored === "invited") {
    if (!inv) status = r.contact_email ? "introduced" : "asked";
    else if (inv.status === "accepted") status = "signed";
    else if (inv.status === "revoked" || Date.parse(String(inv.expires_at)) < Date.now()) status = "introduced";
  }
  const fromName = (r.from_student as Row | null)?.full_name;
  const surname = typeof fromName === "string" ? fromName.trim().split(/\s+/).slice(-1)[0] : null;
  return {
    id: String(r.id),
    fromStudentId: String(r.from_student_id),
    fromStudentName: typeof fromName === "string" ? fromName : null,
    /** "Chen family", the way a counselor says it. */
    referrerLabel: surname ? `${surname} family` : "A family",
    familyName: r.family_name ? String(r.family_name) : null,
    contactEmail: r.contact_email ? String(r.contact_email) : null,
    status,
    invitationId: inv ? String(inv.id) : null,
    joinedStudentId: inv?.accepted_by ? String(inv.accepted_by) : null,
    askMessageId: r.ask_message_id ? String(r.ask_message_id) : null,
    askedAt: String(r.asked_at),
    introducedAt: r.introduced_at ? String(r.introduced_at) : null,
    invitedAt: r.invited_at ? String(r.invited_at) : null,
    updatedAt: String(r.updated_at),
  };
}

const askSchema = z
  .object({
    studentId: z.string().uuid(),
    familyName: z.string().trim().max(200).optional(),
    contactEmail: z.string().trim().max(320).optional(),
    askMessageId: z.string().uuid().optional(),
  })
  .strict();

const introduceSchema = z
  .object({ familyName: z.string().max(200), contactEmail: z.string().max(320) })
  .strict();

const EMAIL = z.string().email();

function cleanIntro(familyName: string, contactEmail: string) {
  const name = familyName.trim().replace(/\s+family$/i, "").trim();
  const email = contactEmail.trim().toLowerCase();
  if (!name) throw badRequest("Add the family's name.");
  if (!EMAIL.safeParse(email).success) throw badRequest("Enter a valid email address.");
  return { name, email };
}

export default async function referralRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [...counselor, limit("referrals:list", 120, 60)] }, async (request) => {
    const q = z.object({ studentId: z.string().uuid().optional() }).parse(request.query);
    let query = request.db.from("referrals").select(SELECT).eq("counselor_id", request.auth.userId);
    if (q.studentId) query = query.eq("from_student_id", q.studentId);
    const { data, error } = await query.order("updated_at", { ascending: false }).limit(200);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as unknown as Row[]).map(toReferral);
  });

  /**
   * Record that the family was asked. A second ask while one is still open
   * refreshes its date instead of adding a row. With a name and email it is
   * recorded as already introduced.
   */
  app.post("/", { preHandler: [...counselor, limit("referrals:write", 120, 60)] }, async (request, reply) => {
    const body = askSchema.parse(request.body);
    await assertCanEditStudent(request, body.studentId);
    const me = request.auth.userId;
    const now = new Date().toISOString();

    if (body.familyName || body.contactEmail) {
      const { name, email } = cleanIntro(body.familyName ?? "", body.contactEmail ?? "");
      const { data, error } = await request.db
        .from("referrals")
        .insert({
          counselor_id: me,
          from_student_id: body.studentId,
          family_name: name,
          contact_email: email,
          status: "introduced",
          introduced_at: now,
          ask_message_id: body.askMessageId ?? null,
        })
        .select(SELECT)
        .single();
      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toReferral(data as unknown as Row));
    }

    const { data: open, error: openError } = await request.db
      .from("referrals")
      .update({ asked_at: now, ...(body.askMessageId ? { ask_message_id: body.askMessageId } : {}) })
      .eq("counselor_id", me)
      .eq("from_student_id", body.studentId)
      .eq("status", "asked")
      .select(SELECT)
      .maybeSingle();
    if (openError) throw fromPostgrest(openError);
    if (open) return toReferral(open as unknown as Row);

    const { data, error } = await request.db
      .from("referrals")
      .insert({
        counselor_id: me,
        from_student_id: body.studentId,
        ask_message_id: body.askMessageId ?? null,
      })
      .select(SELECT)
      .single();
    if (error) throw fromPostgrest(error);
    return reply.code(201).send(toReferral(data as unknown as Row));
  });

  /** The family named someone: their surname and an email to invite. */
  app.patch("/:id", { preHandler: [...counselor, limit("referrals:write", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = introduceSchema.parse(request.body);
    const { name, email } = cleanIntro(body.familyName, body.contactEmail);
    const { data, error } = await request.db
      .from("referrals")
      .update({
        family_name: name,
        contact_email: email,
        status: "introduced",
        introduced_at: new Date().toISOString(),
        invitation_id: null,
        invited_at: null,
      })
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select(SELECT)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("No referral of yours matches that");
    return toReferral(data as unknown as Row);
  });

  /**
   * Send the referred family an intake invitation. Already invited by hand:
   * the referral joins that invitation rather than sending a second one.
   */
  app.post(
    "/:id/invite",
    { preHandler: [...counselor, limit("referrals:invite", 30, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const me = request.auth.userId;
      const { data: referral, error } = await request.db
        .from("referrals")
        .select("id, contact_email, family_name")
        .eq("id", id)
        .eq("counselor_id", me)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!referral) throw notFound("No referral of yours matches that");
      const email = referral.contact_email ? String(referral.contact_email) : "";
      if (!email) throw badRequest("Add the family's email first.");

      const status = (await addressStatuses(request, [email])).get(email);
      if (status === "joined") throw conflict("That family has already joined your practice.");

      let invitationId: string | null = null;
      if (status === "pending" || status === "accepted") {
        const { data: live, error: liveError } = await request.db
          .from("invitations")
          .select("id")
          .eq("counselor_id", me)
          .eq("email", email)
          .in("status", ["pending", "accepted"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (liveError) throw fromPostgrest(liveError);
        invitationId = live ? String(live.id) : null;
      }
      if (!invitationId) {
        await enforceQuota(
          me,
          "invites",
          "day",
          100,
          "You've sent a lot of invitations today. Try again tomorrow."
        );
        const { row } = await createInvitation(request, {
          email,
          fullName: referral.family_name ? `${String(referral.family_name)} family` : null,
          audience: "family",
          source: "referral",
        });
        invitationId = String(row.id);
      }

      const { data, error: updateError } = await request.db
        .from("referrals")
        .update({ status: "invited", invitation_id: invitationId, invited_at: new Date().toISOString() })
        .eq("id", id)
        .eq("counselor_id", me)
        .select(SELECT)
        .single();
      if (updateError) throw fromPostgrest(updateError);
      return toReferral(data as unknown as Row);
    }
  );

  app.delete("/:id", { preHandler: [...counselor, limit("referrals:write", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("referrals")
      .delete()
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select("id")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("No referral of yours matches that");
    return { deleted: true };
  });
}
