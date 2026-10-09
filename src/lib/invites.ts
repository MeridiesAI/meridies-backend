/**
 * Invitation tokens.
 *
 * Shared by `routes/invites.ts` (one student at a time) and `routes/roster.ts`
 * (a whole imported roster), so the two cannot drift into producing links of
 * different strength.
 */

import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { sendInviteEmail } from "./email.js";
import { fromPostgrest } from "./errors.js";

/** Unguessable capability. base64url of 24 random bytes ≈ 192 bits. */
export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

export function appJoinUrl(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/join/${token}`;
}

// ---- v10 sync: overview ----------------------------------------------------
//
// One way to create an invitation, used by the single invite, New student,
// Mass invite and referrals, so every path supersedes a pending invite the same
// way and sends the same email.

type Row = Record<string, unknown>;

export type IntakeRequest = { id: string; label: string; provided: boolean };
export type InvitationSource = "single" | "intake" | "mass" | "roster" | "referral";

export type CreateInvitationInput = {
  email: string;
  fullName?: string | null;
  gradeLevel?: string | null;
  gradYear?: number | null;
  timezone?: string | null;
  note?: string | null;
  audience?: "student" | "family";
  source?: InvitationSource;
  intakeRequests?: IntakeRequest[];
  requestedAt?: string | null;
};

export const INVITATION_COLUMNS =
  "id, email, status, created_at, expires_at, accepted_at, accepted_by, full_name, grade_level, " +
  "grad_year, timezone, note, audience, source, intake_requests, requested_at, dismissed_at, " +
  "submitted_at, confirmed_at";

/**
 * Supersede any still-pending invite to the same address (the newest link is
 * the one that works), insert, and email it. Runs on the caller's client, so
 * RLS decides it is the caller's own invitation.
 */
export async function createInvitation(
  request: FastifyRequest,
  input: CreateInvitationInput
): Promise<{ row: Row; emailSent: boolean }> {
  const email = input.email.trim().toLowerCase();

  const { error: supersedeError } = await request.db
    .from("invitations")
    .update({ status: "revoked" })
    .eq("counselor_id", request.auth.userId)
    .eq("email", email)
    .eq("status", "pending");
  if (supersedeError) throw fromPostgrest(supersedeError);

  const token = newInviteToken();
  const { data, error } = await request.db
    .from("invitations")
    .insert({
      counselor_id: request.auth.userId,
      email,
      token,
      full_name: input.fullName ?? null,
      grade_level: input.gradeLevel ?? null,
      grad_year: input.gradYear ?? null,
      timezone: input.timezone ?? null,
      note: input.note ?? null,
      audience: input.audience ?? "student",
      source: input.source ?? "single",
      intake_requests: input.intakeRequests ?? [],
      requested_at: input.requestedAt ?? null,
    })
    .select(INVITATION_COLUMNS)
    .single();
  if (error) throw fromPostgrest(error);

  const { sent } = await sendInviteEmail({
    to: email,
    counselorName: request.profile.full_name ?? null,
    acceptUrl: appJoinUrl(token),
    note: input.note ?? null,
    audience: input.audience ?? "student",
    logger: request.log,
  });

  return { row: data as unknown as Row, emailSent: sent };
}

export type AddressStatus = "accepted" | "pending" | "joined";

/**
 * Which of these addresses already has a live invitation from this counselor,
 * or already sits on their roster. Pending-but-expired does not count: those
 * can be invited again.
 */
export async function addressStatuses(
  request: FastifyRequest,
  emails: string[]
): Promise<Map<string, AddressStatus>> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(Boolean);
  const out = new Map<string, AddressStatus>();
  if (wanted.length === 0) return out;

  const [invites, roster] = await Promise.all([
    request.db
      .from("invitations")
      .select("email, status, expires_at")
      .eq("counselor_id", request.auth.userId)
      .in("email", wanted)
      .in("status", ["pending", "accepted"]),
    request.db.from("profiles").select("email").eq("counselor_id", request.auth.userId).limit(5000),
  ]);
  if (invites.error) throw fromPostgrest(invites.error);
  if (roster.error) throw fromPostgrest(roster.error);

  const now = Date.now();
  for (const r of (invites.data ?? []) as Row[]) {
    const email = String(r.email).toLowerCase();
    if (r.status === "accepted") out.set(email, "accepted");
    else if (!out.has(email) && Date.parse(String(r.expires_at)) >= now) out.set(email, "pending");
  }
  const wantedSet = new Set(wanted);
  for (const p of (roster.data ?? []) as Row[]) {
    const email = String(p.email ?? "").toLowerCase();
    if (wantedSet.has(email)) out.set(email, "joined");
  }
  return out;
}

export type ReferredBy = { referralId: string; fromStudentId: string; fromStudentName: string | null };

/** The v10 invitation DTO: a superset of the original `toInvitation`. */
export function toInvitationDetail(r: Row, referredBy: ReferredBy | null = null) {
  const accepter = r.accepted_by_profile as Row | null | undefined;
  const status = String(r.status) as "pending" | "accepted" | "revoked";
  const expiresAt = r.expires_at ? String(r.expires_at) : null;
  const requests = Array.isArray(r.intake_requests) ? (r.intake_requests as Row[]) : [];
  return {
    id: String(r.id),
    email: String(r.email),
    status,
    createdAt: String(r.created_at),
    expiresAt,
    acceptedAt: r.accepted_at ? String(r.accepted_at) : null,
    acceptedByName: accepter ? String(accepter.full_name ?? "") || null : null,
    acceptedBy: r.accepted_by ? String(r.accepted_by) : null,
    /** Pending past its expiry: the link no longer works. */
    expired: status === "pending" && expiresAt !== null && Date.parse(expiresAt) < Date.now(),
    fullName: r.full_name ? String(r.full_name) : null,
    gradeLevel: r.grade_level ? String(r.grade_level) : null,
    gradYear: typeof r.grad_year === "number" ? r.grad_year : null,
    timezone: r.timezone ? String(r.timezone) : null,
    note: r.note ? String(r.note) : null,
    audience: (r.audience === "family" ? "family" : "student") as "student" | "family",
    source: (r.source ? String(r.source) : "single") as InvitationSource,
    intakeRequests: requests.map((q) => ({
      id: String(q.id),
      label: String(q.label),
      provided: q.provided === true,
    })),
    requestedAt: r.requested_at ? String(r.requested_at) : null,
    dismissedAt: r.dismissed_at ? String(r.dismissed_at) : null,
    /** The student pressed Submit on what was asked for (new-student onboarding). */
    submittedAt: r.submitted_at ? String(r.submitted_at) : null,
    /** The counselor confirmed: no longer "Building profile". */
    confirmedAt: r.confirmed_at ? String(r.confirmed_at) : null,
    referredBy,
  };
}
export type InvitationDetail = ReturnType<typeof toInvitationDetail>;
