/**
 * Counselors invite students by email; students accept a tokenized link.
 *
 * The linkage (setting the student's `counselor_id`) goes through the
 * `accept_invitation` database function, not a SELECT-then-UPDATE here: that
 * column's UPDATE grant is withheld from `authenticated`, so a SECURITY DEFINER
 * function is the only writer — and the token can't be enumerated, so an invite
 * has to be *received*, not discovered.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { canConfirm, intakeItemsByInvitation, itemStatus, sendItemBack } from "../lib/newStudentIntake.js";
import {
  INVITATION_COLUMNS,
  addressStatuses,
  createInvitation,
  toInvitationDetail,
  type ReferredBy,
} from "../lib/invites.js";
import { invitationDeliveries } from "../lib/inviteDelivery.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { anonClient } from "../lib/supabase.js";
import { toInvitation, toMeridiesUser } from "../lib/serialize.js";
import { hasAnthropic } from "../env.js";
import { runStructured } from "../lib/anthropic.js";
import {
  MASS_INVITE_SCHEMA,
  MASS_INVITE_SYSTEM,
  groundModelEntries,
  isValidEmail,
  massInvitePrompt,
  needsModel,
  parseModelOutput,
  preParse,
  repairAddress,
  type PreParse,
} from "../lib/massInvite.js";

const intakeRequestSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    provided: z.boolean().default(false),
  })
  .strict();

const basicsShape = {
  fullName: z.string().trim().min(1).max(200).nullable().optional(),
  gradeLevel: z.string().trim().max(40).nullable().optional(),
  gradYear: z.number().int().min(2000).max(2100).nullable().optional(),
  timezone: z.string().trim().max(80).nullable().optional(),
  intakeRequests: z.array(intakeRequestSchema).max(30).optional(),
};

const inviteSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    // v10 sync (overview): New student and the personal note.
    note: z.string().trim().max(1000).nullable().optional(),
    source: z.enum(["single", "intake"]).optional(),
    /** "Send to student": the open requests went out with this invitation. */
    sendRequests: z.boolean().optional(),
    ...basicsShape,
  })
  .strict();

const patchInviteSchema = z
  .object({
    ...basicsShape,
    dismissed: z.boolean().optional(),
    /** New-student onboarding: tick one request received, or untick it. */
    receive: z.object({ requestId: z.string().trim().min(1).max(100), received: z.boolean() }).strict().optional(),
    /** Hand one item back to the student with what to change. */
    sendBack: z
      .object({ requestId: z.string().trim().min(1).max(100), note: z.string().trim().min(1).max(500) })
      .strict()
      .optional(),
    /** Everything received: the card becomes a student. */
    confirmed: z.literal(true).optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

/**
 * New-student onboarding, the counselor's side: receive an item, send one
 * back, or confirm the student. One at a time, on an invitation of theirs
 * the student has accepted.
 */
async function onboardingStep(
  request: FastifyRequest,
  id: string,
  body: z.infer<typeof patchInviteSchema>
) {
  const { data, error } = await request.db
    .from("invitations")
    .select(INVITATION_COLUMNS)
    .eq("id", id)
    .eq("counselor_id", request.auth.userId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("No invitation of yours matches that");
  const row = data as unknown as Record<string, unknown>;
  const inv = toInvitationDetail(row);
  if (inv.status !== "accepted" || !inv.acceptedBy) throw conflict("They haven't joined yet.");
  if (inv.confirmedAt) throw conflict("This student is already confirmed.");

  const step = body.receive ?? body.sendBack;
  if (step) {
    const req = inv.intakeRequests.find((q) => q.id === step.requestId);
    if (!req) throw notFound("That request isn't on this invitation");
    const { data: task, error: taskError } = await request.db
      .from("deliverables")
      .select("id, status, title")
      .eq("intake_invitation_id", id)
      .eq("intake_request_id", step.requestId)
      .maybeSingle();
    if (taskError) throw fromPostgrest(taskError);

    if (body.receive) {
      // `provided` drives the task through the 20261012000001 trigger.
      const requests = (Array.isArray(row.intake_requests) ? (row.intake_requests as Record<string, unknown>[]) : []).map(
        (q) => (String(q.id) === step.requestId ? { ...q, provided: body.receive!.received } : q)
      );
      const { error: updateError } = await request.db.from("invitations").update({ intake_requests: requests }).eq("id", id);
      if (updateError) throw fromPostgrest(updateError);
      if (task) {
        if (body.receive.received) {
          await request.db.from("deliverables").update({ sent_back_note: null }).eq("id", String(task.id));
        } else if (inv.submittedAt) {
          // Unticked after the student sent it: it is waiting on the counselor again.
          await request.db.from("deliverables").update({ status: "review" }).eq("id", String(task.id));
        }
      }
    } else if (body.sendBack) {
      if (!task) throw conflict("There is nothing from the student on this yet.");
      if (req.provided) {
        const requests = (row.intake_requests as Record<string, unknown>[]).map((q) =>
          String(q.id) === step.requestId ? { ...q, provided: false } : q
        );
        const { error: updateError } = await request.db.from("invitations").update({ intake_requests: requests }).eq("id", id);
        if (updateError) throw fromPostgrest(updateError);
      }
      await sendItemBack(request, { id, acceptedBy: inv.acceptedBy }, String(task.id), String(task.title), body.sendBack.note);
    }
  } else if (body.confirmed) {
    if (!canConfirm({ status: inv.status, requests: inv.intakeRequests })) {
      throw conflict("Check off everything you asked for first.");
    }
    const { error: updateError } = await request.db
      .from("invitations")
      .update({ confirmed_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) throw fromPostgrest(updateError);
  }

  const { data: fresh, error: freshError } = await request.db
    .from("invitations")
    .select(INVITATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (freshError) throw fromPostgrest(freshError);
  return toInvitationDetail(fresh as unknown as Record<string, unknown>);
}

const sortSchema = z.object({ text: z.string().max(20_000) }).strict();
const checkSchema = z
  .object({ emails: z.array(z.string().max(400)).min(1).max(200) })
  .strict();
const bulkSchema = z
  .object({
    recipients: z
      .array(
        z
          .object({
            email: z.string().trim().toLowerCase().email().max(320),
            name: z.string().trim().max(200).nullable().optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const ALREADY_JOINED = "That student has already joined your practice.";
const QUOTA_MESSAGE = "You've sent a lot of invitations today. Try again tomorrow.";

/** "Please send: transcript, resume." from the rows still open. */
function requestNote(requests: { label: string; provided: boolean }[]): string | null {
  const open = requests.filter((r) => !r.provided).map((r) => r.label.toLowerCase());
  return open.length ? `Please send: ${open.join(", ")}.` : null;
}
const revokeSchema = z.object({ id: z.string().uuid() }).strict();
const acceptSchema = z.object({ token: z.string().trim().min(10).max(200) }).strict();
const previewSchema = z.object({ token: z.string().trim().min(10).max(200) });

export default async function inviteRoutes(app: FastifyInstance) {
  // Counselor invites a student by email — creates the invitation and emails it.
  app.post(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:create", 30, 3600)] },
    async (request, reply) => {
      const body = inviteSchema.parse(request.body);
      const { email } = body;

      const already = (await addressStatuses(request, [email])).get(email);
      if (already === "accepted" || already === "joined") throw conflict(ALREADY_JOINED);

      // A real roster doesn't send 100 invites a day.
      await enforceQuota(request.auth.userId, "invites", "day", 100, QUOTA_MESSAGE);

      const requests = body.intakeRequests ?? [];
      const note =
        body.note ?? (body.sendRequests ? requestNote(requests) : null);

      // Supersedes any still-pending invite to the same address, so a resend
      // doesn't pile up duplicates — the newest link is the one that works.
      const { row, emailSent } = await createInvitation(request, {
        email,
        note,
        source: body.source ?? (requests.length || body.fullName ? "intake" : "single"),
        fullName: body.fullName ?? null,
        gradeLevel: body.gradeLevel ?? null,
        gradYear: body.gradYear ?? null,
        timezone: body.timezone ?? null,
        intakeRequests: requests,
        requestedAt: body.sendRequests ? new Date().toISOString() : null,
      });

      return reply.code(201).send({ ...toInvitationDetail(row), emailSent });
    }
  );

  // Counselor lists their invitations (pending + accepted + revoked).
  // v10 sync (overview): the full invitation, with expiry, what it asked for,
  // where it came from and which family referred it ("Referred by").
  app.get(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:list", 120, 60)] },
    async (request) => {
      const { data, error } = await request.db
        .from("invitations")
        .select(
          `${INVITATION_COLUMNS}, accepted_by_profile:profiles!invitations_accepted_by_fkey(full_name)`
        )
        .eq("counselor_id", request.auth.userId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw fromPostgrest(error);

      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      const ids = rows.map((r) => String(r.id));
      const [referredBy, deliveries] = await Promise.all([referralsFor(request, ids), invitationDeliveries(request, ids)]);
      return rows.map((row) => ({
        ...toInvitationDetail(row, referredBy.get(String(row.id)) ?? null),
        // The invite email's latest status (B5); null when none is on record.
        delivery: deliveries.get(String(row.id)) ?? null,
      }));
    }
  );

  /**
   * The "Building profile" cards on Overview: every student this counselor
   * invited (New student, the onboarding invite step, Mass invite), until the
   * counselor confirms them (new-student onboarding). Each request carries
   * where it stands: the student's file or answer, AxIS's read as advice. A
   * family invitation is the parent's link, not a student, so it stays off.
   */
  app.get(
    "/building",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:building", 120, 60)] },
    async (request) => {
      const { data, error } = await request.db
        .from("invitations")
        .select(INVITATION_COLUMNS)
        .eq("counselor_id", request.auth.userId)
        .in("source", ["intake", "single", "mass"])
        .eq("audience", "student")
        .is("dismissed_at", null)
        .is("confirmed_at", null)
        .in("status", ["pending", "accepted"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw fromPostgrest(error);
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      const [items, deliveries] = await Promise.all([
        intakeItemsByInvitation(
          request,
          rows.filter((r) => r.status === "accepted").map((r) => String(r.id))
        ),
        invitationDeliveries(request, rows.map((r) => String(r.id))),
      ]);

      return rows.map((r) => {
        const detail = toInvitationDetail(r);
        const byRequest = items.get(detail.id);
        return {
          ...detail,
          studentId: r.accepted_by ? String(r.accepted_by) : null,
          delivery: deliveries.get(detail.id) ?? null,
          intakeItems: detail.intakeRequests.map((q) => {
            const item = byRequest?.get(q.id) ?? null;
            return {
              requestId: q.id,
              taskId: item?.taskId ?? null,
              status: itemStatus(item ? { status: item.taskStatus, sentBackNote: item.sentBackNote } : null, q.provided),
              answer: item?.answer ?? null,
              sentBackNote: item?.sentBackNote ?? null,
              files: item?.files ?? [],
              axis: item?.axis ?? null,
            };
          }),
          canConfirm: canConfirm({ status: detail.status, requests: detail.intakeRequests }),
        };
      });
    }
  );

  /** Edit what a New student card says, or take it off Overview. */
  app.patch(
    "/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:patch", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchInviteSchema.parse(request.body);
      if (body.receive || body.sendBack || body.confirmed) {
        return onboardingStep(request, id, body);
      }
      const update: Record<string, unknown> = {};
      if (body.fullName !== undefined) update.full_name = body.fullName;
      if (body.gradeLevel !== undefined) update.grade_level = body.gradeLevel;
      if (body.gradYear !== undefined) update.grad_year = body.gradYear;
      if (body.timezone !== undefined) update.timezone = body.timezone;
      if (body.intakeRequests !== undefined) update.intake_requests = body.intakeRequests;
      if (body.dismissed !== undefined) update.dismissed_at = body.dismissed ? new Date().toISOString() : null;
      if (Object.keys(update).length === 0) throw badRequest("Nothing to change");

      const { data, error } = await request.db
        .from("invitations")
        .update(update)
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .select(INVITATION_COLUMNS)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("No invitation of yours matches that");
      return toInvitationDetail(data as unknown as Record<string, unknown>);
    }
  );

  /** Send it again with a fresh link, keeping everything it carried. */
  app.post(
    "/:id/resend",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:create", 30, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db
        .from("invitations")
        .select(INVITATION_COLUMNS)
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("No invitation of yours matches that");
      const old = toInvitationDetail(data as unknown as Record<string, unknown>);
      if (old.status === "accepted") throw conflict(ALREADY_JOINED);

      await enforceQuota(request.auth.userId, "invites", "day", 100, QUOTA_MESSAGE);
      const { row, emailSent } = await createInvitation(request, {
        email: old.email,
        fullName: old.fullName,
        gradeLevel: old.gradeLevel,
        gradYear: old.gradYear,
        timezone: old.timezone,
        note: old.note,
        audience: old.audience,
        source: old.source,
        intakeRequests: old.intakeRequests,
        requestedAt: old.requestedAt ? new Date().toISOString() : null,
      });
      // A referral pointing at the old invitation follows it to the new one.
      await request.db
        .from("referrals")
        .update({ invitation_id: row.id as string })
        .eq("counselor_id", request.auth.userId)
        .eq("invitation_id", id);
      return { ...toInvitationDetail(row), emailSent };
    }
  );

  // ---- Mass invite (v10) ----------------------------------------------------

  /**
   * AxIS sorts a pasted list. Rules first, then Haiku for names and the
   * repairs the rules could not make, every address it returns checked
   * against the paste. Nothing is sent here.
   */
  app.post(
    "/mass/sort",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:sort", 30, 3600)] },
    async (request) => {
      const { text } = sortSchema.parse(request.body);
      if (!text.trim()) throw badRequest("Paste some addresses first");

      const parsed = preParse(text);
      let sorted: PreParse = parsed;
      let axis: "used" | "not-needed" | "unavailable" = "not-needed";
      let axisUnavailableReason: string | null = null;

      if (needsModel(text, parsed)) {
        if (!hasAnthropic) {
          axis = "unavailable";
          axisUnavailableReason = "AxIS isn't configured on this server, so the list was sorted by rules alone.";
        } else {
          try {
            const output = await runStructured({
              request,
              module: "mass-invite",
              system: MASS_INVITE_SYSTEM,
              prompt: massInvitePrompt(text, parsed),
              schema: MASS_INVITE_SCHEMA as unknown as Record<string, unknown>,
              toolName: "sorted_addresses",
              maxTokens: 4096,
              validate: parseModelOutput,
            });
            sorted = groundModelEntries(text, parsed, output);
            axis = "used";
          } catch (err) {
            // The rules' result stands; say why AxIS did not add to it.
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 429) throw err;
            axis = "unavailable";
            axisUnavailableReason = "AxIS couldn't read the list just now, so it was sorted by rules alone.";
          }
        }
      }

      const statuses = await addressStatuses(request, sorted.ready.map((r) => r.email));
      return {
        ready: sorted.ready.map((r) => ({ ...r, already: statuses.get(r.email) ?? null })),
        unreadable: sorted.unreadable,
        duplicates: sorted.duplicates,
        axis,
        axisUnavailableReason,
      };
    }
  );

  /** Deterministic check for a row the counselor fixed by hand. */
  app.post(
    "/mass/check",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:check", 120, 60)] },
    async (request) => {
      const { emails } = checkSchema.parse(request.body);
      const repaired = emails.map((raw) => ({ raw, email: repairAddress(raw) }));
      const valid = repaired.filter((r) => isValidEmail(r.email)).map((r) => r.email);
      const statuses = await addressStatuses(request, valid);
      return repaired.map((r) => ({
        input: r.raw,
        email: r.email,
        valid: isValidEmail(r.email),
        already: statuses.get(r.email) ?? null,
      }));
    }
  );

  /**
   * Send the sorted list at once. Same daily quota as a single invite, charged
   * for what is actually sent; an address that already has a live invitation
   * or has joined is skipped, and one failed address does not stop the rest.
   */
  app.post(
    "/bulk",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:bulk", 10, 3600)] },
    async (request) => {
      const { recipients, note } = bulkSchema.parse(request.body);
      const unique = [...new Map(recipients.map((r) => [r.email, r])).values()];
      const statuses = await addressStatuses(request, unique.map((r) => r.email));
      const toSend = unique.filter((r) => !statuses.has(r.email));

      if (toSend.length > 0) {
        await enforceQuota(request.auth.userId, "invites", "day", 100, QUOTA_MESSAGE, toSend.length);
      }

      const results: {
        email: string;
        status: "sent" | "queued" | "skipped" | "failed";
        reason: string | null;
        invitationId: string | null;
      }[] = unique
        .filter((r) => statuses.has(r.email))
        .map((r) => ({
          email: r.email,
          status: "skipped" as const,
          reason: statuses.get(r.email) === "pending" ? "Already has a pending invitation" : ALREADY_JOINED,
          invitationId: null,
        }));

      for (const r of toSend) {
        try {
          const { row, emailSent } = await createInvitation(request, {
            email: r.email,
            fullName: r.name ?? null,
            note: note ?? null,
            source: "mass",
          });
          results.push({
            email: r.email,
            // Recorded but not emailed (no mail provider): say so, never "sent".
            status: emailSent ? "sent" : "queued",
            reason: emailSent ? null : "Recorded, but email isn't configured on this server",
            invitationId: String(row.id),
          });
        } catch (err) {
          request.log.error({ err }, "mass invite row failed");
          results.push({
            email: r.email,
            status: "failed",
            reason: "Could not send an invitation to this address",
            invitationId: null,
          });
        }
      }

      return {
        sent: results.filter((r) => r.status === "sent").length,
        queued: results.filter((r) => r.status === "queued").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
        results,
      };
    }
  );

  // Counselor revokes a still-pending invitation.
  app.post(
    "/revoke",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:revoke", 60, 3600)] },
    async (request) => {
      const { id } = revokeSchema.parse(request.body);
      const { data, error } = await request.db
        .from("invitations")
        .update({ status: "revoked" })
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .eq("status", "pending")
        .select("id, email, status, created_at, expires_at, accepted_at")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("No pending invitation of yours matches that");
      return toInvitation(data);
    }
  );

  // Public: the accept landing page shows who invited the student, before they
  // have an account. The token is the secret; this returns nothing an invited
  // student doesn't already know.
  app.get("/preview", async (request) => {
    const { token } = previewSchema.parse(request.query);
    const { data, error } = await anonClient().rpc("invitation_preview", { p_token: token });
    if (error) throw fromPostgrest(error);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { counselor_name?: string | null; invited_email?: string | null; valid?: boolean }
      | undefined;
    return {
      counselorName: row?.counselor_name ?? null,
      invitedEmail: row?.invited_email ?? null,
      valid: Boolean(row?.valid),
    };
  });

  // Signed-in student accepts an invitation → linked to the counselor.
  app.post(
    "/accept",
    {
      preHandler: [
        app.authenticate,
        requireRole("student"),
        limit("invites:accept", 15, 3600, "Too many attempts. Try again in an hour."),
      ],
    },
    async (request) => {
      const { token } = acceptSchema.parse(request.body);

      const { error } = await request.db.rpc("accept_invitation", { p_token: token });
      if (error) {
        const message =
          error.message?.replace(/^ERROR:\s*/i, "") || "Could not accept that invitation";
        const isConflict = /already been used|already connected/i.test(message);
        throw isConflict ? conflict(message) : badRequest(message);
      }

      const { data: profile, error: profileError } = await request.db
        .from("profiles")
        .select("*")
        .eq("id", request.auth.userId)
        .single();
      if (profileError) throw fromPostgrest(profileError);

      let counselorName: string | null = null;
      if (profile.counselor_id) {
        const { data } = await request.db
          .from("profiles")
          .select("full_name")
          .eq("id", profile.counselor_id)
          .maybeSingle();
        counselorName = data?.full_name ?? null;
      }

      return toMeridiesUser(profile as never, { counselorName });
    }
  );
}

/** Which invitations a referral became, for the "Referred by" column. */
async function referralsFor(
  request: FastifyRequest,
  invitationIds: string[]
): Promise<Map<string, ReferredBy>> {
  const out = new Map<string, ReferredBy>();
  if (invitationIds.length === 0) return out;
  const { data, error } = await request.db
    .from("referrals")
    .select("id, invitation_id, from_student_id, from_student:profiles!referrals_from_student_id_fkey(full_name)")
    .eq("counselor_id", request.auth.userId)
    .in("invitation_id", invitationIds);
  if (error) throw fromPostgrest(error);
  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    const from = r.from_student as { full_name?: string | null } | null;
    out.set(String(r.invitation_id), {
      referralId: String(r.id),
      fromStudentId: String(r.from_student_id),
      fromStudentName: from?.full_name ?? null,
    });
  }
  return out;
}
