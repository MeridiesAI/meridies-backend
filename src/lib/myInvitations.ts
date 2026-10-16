/**
 * A student's own pending invitations, found by the address on their account
 * (the wizard's Connect step: "Accept invite").
 *
 * `invitations` has no policy a student can read, on purpose: the emailed
 * token is the capability, so a pending invite can't be discovered. This is
 * the one place that looks one up for the person it was sent to. It matches
 * only on the account's confirmed address, never returns a token, and accepts
 * by running the same `accept_invitation` the emailed link runs, as the
 * student, so every rule and trigger there still applies.
 */

import type { FastifyRequest } from "fastify";
import { approvedCounselorIds } from "./access.js";
import { badRequest, fromPostgrest, notFound } from "./errors.js";
import { serviceClient } from "./supabase.js";

export type MyInvitation = {
  id: string;
  counselorName: string | null;
  /** The name the counselor typed for this student, so the student can see it is theirs. */
  fullName: string | null;
  expiresAt: string;
};

type InviteRow = {
  id: string;
  token: string;
  counselor_id: string;
  full_name: string | null;
  expires_at: string;
};

/** The caller's confirmed account address, lowercased, or null. */
async function confirmedEmail(userId: string): Promise<string | null> {
  const svc = serviceClient();
  if (!svc) return null;
  const { data, error } = await svc.auth.admin.getUserById(userId);
  if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
  return data.user.email.trim().toLowerCase();
}

/** Pending, unexpired student invitations to this address from approved counselors. */
async function pendingFor(email: string): Promise<InviteRow[]> {
  const svc = serviceClient();
  if (!svc) return [];
  const { data, error } = await svc
    .from("invitations")
    .select("id, token, counselor_id, full_name, expires_at")
    .eq("email", email)
    .eq("status", "pending")
    .eq("audience", "student")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw fromPostgrest(error);
  const rows = (data ?? []) as InviteRow[];
  if (rows.length === 0) return [];
  const approved = await approvedCounselorIds(svc, rows.map((r) => r.counselor_id));
  return rows.filter((r) => approved.has(r.counselor_id));
}

/** Nothing for a student who already has a counselor. */
async function isUnconnected(request: FastifyRequest): Promise<boolean> {
  const { data, error } = await request.db
    .from("profiles")
    .select("counselor_id")
    .eq("id", request.auth.userId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  return Boolean(data) && !data?.counselor_id;
}

export async function listMyInvitations(request: FastifyRequest): Promise<MyInvitation[]> {
  if (!(await isUnconnected(request))) return [];
  const email = await confirmedEmail(request.auth.userId);
  if (!email) return [];
  const rows = await pendingFor(email);
  if (rows.length === 0) return [];

  const svc = serviceClient();
  const { data } = await svc!
    .from("profiles")
    .select("id, full_name")
    .in("id", [...new Set(rows.map((r) => r.counselor_id))]);
  const names = new Map((data ?? []).map((p) => [String(p.id), (p.full_name as string | null) ?? null]));
  return rows.map((r) => ({
    id: r.id,
    counselorName: names.get(r.counselor_id) ?? null,
    fullName: r.full_name,
    expiresAt: r.expires_at,
  }));
}

/** Accept one of the caller's own invitations; the token never leaves the server. */
export async function acceptMyInvitation(request: FastifyRequest, id: string): Promise<void> {
  if (!(await isUnconnected(request))) throw badRequest("You're already connected to a counselor");
  const email = await confirmedEmail(request.auth.userId);
  if (!email) throw badRequest("Confirm your email address first");
  const invite = (await pendingFor(email)).find((r) => r.id === id);
  if (!invite) throw notFound("That invitation isn't available any more");

  const { error } = await request.db.rpc("accept_invitation", { p_token: invite.token });
  if (error) throw badRequest(error.message?.replace(/^ERROR:\s*/i, "") || "Could not accept that invitation");
}
