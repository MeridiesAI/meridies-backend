/**
 * Parent account invitations (migration 20261123000002): minting a link, the counselor's Invite / Resend, the
 * status a chip shows, and turning a good link into an account.
 *
 * Who may invite is the database's answer: `parent_invite_create` runs on the CALLER's client and accepts the
 * guardian's own student or a counselor who manages that student's parents (and refuses an address that already
 * has an account, or a parent the counselor switched off). The token is made here and only its sha256 goes to the
 * database; the delivery record keeps the email without its link (`recordText`).
 *
 * AUTHORIZATION, where the service role is used: only `redeemParentInvite`, which creates the auth user
 * for exactly the address the invitation was emailed to (the token, which only that inbox received, is the proof
 * the address is theirs) and then lets `parent_invite_redeem` (service role only) decide, in one transaction,
 * whether that brand-new account becomes a parent account. If it refuses, the user is deleted again.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { HttpError, fromPostgrest } from "./errors.js";
import { normEmail } from "./parentCopy.js";
import {
  PARENT_INVITE_TEMPLATE,
  PASSWORD_MIN,
  hashInviteToken,
  hintOf,
  newInviteToken,
  oneLine,
  parentInviteEmail,
  parentJoinUrl,
  parentLoginUrl,
  parentSchemaMissing,
  toParentAccount,
  type ParentAccount,
} from "./parentAccounts.js";
import { replyAddressFor } from "./replyRouting.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export const parentAccountsUnavailable = () =>
  new HttpError(503, "Parent accounts aren't switched on yet", "parent_accounts_unavailable");

/** What minting a link came to. `signin`: the address already has a parent account, so there is nothing to join. */
export type Minted =
  | { kind: "join"; token: string; inviteId: string; studentId: string; email: string; expiresAt: string }
  | { kind: "signin" }
  | { kind: "unavailable" }
  | { kind: "refused"; code: string; message: string };

/** A new link for one guardian row, as the caller (a student for their own parent, or their counselor). */
export async function mintParentInvite(db: SupabaseClient, guardianId: string): Promise<Minted> {
  const token = newInviteToken();
  const { data, error } = await db.rpc("parent_invite_create", { p_guardian: guardianId, p_token_hash: hashInviteToken(token) });
  if (error) {
    if (parentSchemaMissing(error)) return { kind: "unavailable" };
    const hint = hintOf(error);
    if (hint === "has_account") return { kind: "signin" };
    if (hint === "other_account") return { kind: "refused", code: "parent_email_taken", message: "That address already has a Meridies account that isn't a parent account. Ask for a different email." };
    if (hint === "guardian_off") return { kind: "refused", code: "guardian_off", message: "Switch this parent on first. A parent you've switched off can't see anything." };
    if (hint === "no_email") return { kind: "refused", code: "guardian_no_email", message: "Add an email for this parent first." };
    if (error.code === "P0002") return { kind: "refused", code: "guardian_not_found", message: "That parent isn't on file." };
    throw fromPostgrest(error);
  }
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as Row;
  return {
    kind: "join",
    token,
    inviteId: String(row.id),
    studentId: String(row.student_id),
    email: String(row.email),
    expiresAt: String(row.expires_at),
  };
}

/** Which email carried the link, so the chip can show its delivery status. Best effort. */
export async function recordInviteDelivery(db: SupabaseClient, inviteId: string, deliveryId: string | null, log?: Log): Promise<void> {
  if (!deliveryId) return;
  const { error } = await db.rpc("parent_invite_set_delivery", { p_invite: inviteId, p_delivery: deliveryId });
  if (error) log?.warn({ code: error.code }, "parent invite: delivery not linked");
}

/**
 * Each parent row's account state for these students, as the caller (a counselor) may see it. Null when the
 * migration isn't applied: the app then shows no Invite at all. Never throws for an unreadable answer: the
 * composer and the directory carry on without the field.
 */
export async function loadParentAccounts(db: SupabaseClient, studentIds: string[], log?: Log): Promise<Map<string, ParentAccount> | null> {
  const ids = [...new Set(studentIds)];
  const out = new Map<string, ParentAccount>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.rpc("parent_invite_status", { p_students: ids.slice(i, i + 200) });
    if (error) {
      if (!parentSchemaMissing(error)) log?.warn({ code: error.code }, "parent account status unreadable");
      return null;
    }
    const now = Date.now();
    for (const r of (data ?? []) as Row[]) out.set(String(r.guardian_id), toParentAccount(r, now));
  }
  return out;
}

export type CounselorInviteResult = { parentAccount: ParentAccount; emailed: boolean };

/**
 * The counselor's "Invite to Meridies" / "Resend invite" for one parent row. The caller's client decides whether
 * they may (parent_invite_create); a parent who already has an account gets the "it's on your parent view" email.
 */
export async function counselorInvite(args: {
  db: SupabaseClient;
  guardianId: string;
  counselorId: string;
  counselorName: string | null;
  counselorEmail: string | null;
  log?: Log;
  deps?: { send?: typeof sendEmail };
}): Promise<CounselorInviteResult> {
  const { db, guardianId, log } = args;
  const send = args.deps?.send ?? sendEmail;
  const { data: g, error: gErr } = await db.from("guardians").select("id, student_id, full_name, email").eq("id", guardianId).maybeSingle();
  if (gErr) throw fromPostgrest(gErr);
  if (!g) throw new HttpError(404, "That parent isn't on file", "guardian_not_found");
  const guardian = g as Row;
  const studentId = String(guardian.student_id);

  const minted = await mintParentInvite(db, guardianId);
  if (minted.kind === "unavailable") throw parentAccountsUnavailable();
  if (minted.kind === "refused") throw new HttpError(409, minted.message, minted.code);

  const { data: s } = await db.from("profiles").select("full_name").eq("id", studentId).maybeSingle();
  const studentName = oneLine((s as Row | null)?.full_name as string | null);
  const to = minted.kind === "join" ? minted.email : (normEmail(guardian.email as string | null) as string);
  const copy = parentInviteEmail({
    studentName,
    parentName: String(guardian.full_name ?? ""),
    counselorName: args.counselorName,
    kind: minted.kind,
    url: minted.kind === "join" ? parentJoinUrl(minted.token) : parentLoginUrl(),
  });
  const replyTo =
    (await replyAddressFor({ counselorId: args.counselorId, party: "parent", studentId, guardianId }, log)) ??
    normEmail(args.counselorEmail) ??
    undefined;
  const template = { heading: copy.heading, paragraphs: copy.paragraphs, cta: copy.cta, footnote: copy.footnote };
  const result = await send({
    to,
    subject: copy.subject,
    html: brandedEmail(template),
    text: brandedText(template),
    // The delivery record never keeps the link: it is the capability to make the account.
    recordText: brandedText({ ...template, cta: undefined }),
    template: PARENT_INVITE_TEMPLATE,
    fromName: args.counselorName,
    tags: [{ name: "category", value: PARENT_INVITE_TEMPLATE }],
    student_id: studentId,
    recipient_kind: "guardian",
    recipient_id: guardianId,
    ...(replyTo ? { replyTo } : {}),
    logger: log as never,
  });

  if (minted.kind === "join") {
    await recordInviteDelivery(db, minted.inviteId, result.deliveryId ?? null, log);
    const status = await loadParentAccounts(db, [studentId], log);
    const fresh = status?.get(guardianId);
    return {
      parentAccount: fresh ?? { state: "invited", invitedAt: new Date().toISOString(), expiresAt: minted.expiresAt, delivery: null },
      emailed: result.sent,
    };
  }
  return { parentAccount: { state: "joined", invitedAt: null, expiresAt: null, delivery: null }, emailed: result.sent };
}

// ---- the join page ------------------------------------------------------------------------------------------------

export type InvitePreview = {
  valid: boolean;
  /** Why not, when it isn't: invalid | expired | used | removed. */
  reason: string | null;
  email: string | null;
  studentFirstName: string | null;
  counselorName: string | null;
  /** The address already has a parent account: sign in instead. */
  hasAccount: boolean;
};

export async function previewParentInvite(anon: SupabaseClient, token: string): Promise<InvitePreview> {
  const { data, error } = await anon.rpc("parent_invite_preview", { p_token_hash: hashInviteToken(token) });
  if (error) {
    if (parentSchemaMissing(error)) throw parentAccountsUnavailable();
    throw fromPostgrest(error);
  }
  const r = ((Array.isArray(data) ? data[0] : data) ?? {}) as Row;
  return {
    valid: r.valid === true,
    reason: r.valid === true ? null : typeof r.reason === "string" ? r.reason : "invalid",
    email: r.valid === true ? ((r.email as string | null) ?? null) : null,
    studentFirstName: r.valid === true ? oneLine(r.student_first as string | null, 60) || null : null,
    counselorName: r.valid === true ? oneLine(r.counselor_name as string | null) || null : null,
    hasAccount: r.has_account === true,
  };
}

const REDEEM_WORDS: Record<string, { status: number; message: string }> = {
  invalid: { status: 404, message: "This link isn't valid. Ask for a new invitation." },
  used: { status: 409, message: "This link has already been used. Sign in instead." },
  expired: { status: 410, message: "This link has expired. Ask for a new invitation." },
  removed: { status: 410, message: "This invitation is no longer valid. Ask for a new one." },
  wrong_account: { status: 409, message: "This invitation can't be used with that account." },
};

/**
 * Create the parent's account from a good link: the auth user for the invited address (confirmed, since the link
 * only reached that inbox), then `parent_invite_redeem` in one transaction. Answers the address to sign in with.
 */
export async function redeemParentInvite(args: {
  token: string;
  fullName: string;
  password: string;
  anon: SupabaseClient;
  log?: Log;
  deps?: { svc?: SupabaseClient | null };
}): Promise<{ email: string }> {
  const svc = args.deps?.svc !== undefined ? args.deps.svc : serviceClient();
  if (!svc) throw parentAccountsUnavailable();
  if (args.password.length < PASSWORD_MIN) throw new HttpError(400, `Use at least ${PASSWORD_MIN} characters for your password.`, "weak_password");

  const preview = await previewParentInvite(args.anon, args.token);
  if (!preview.valid || !preview.email) {
    if (preview.reason === "used" || preview.hasAccount) throw new HttpError(409, "You already have a parent account. Sign in instead.", "parent_has_account");
    const w = REDEEM_WORDS[preview.reason ?? "invalid"] ?? REDEEM_WORDS.invalid!;
    throw new HttpError(w.status, w.message, `invite_${preview.reason ?? "invalid"}`);
  }
  if (preview.hasAccount) throw new HttpError(409, "You already have a parent account. Sign in instead.", "parent_has_account");
  const email = preview.email;

  const created = await svc.auth.admin.createUser({
    email,
    password: args.password,
    email_confirm: true,
    user_metadata: { full_name: oneLine(args.fullName, 120) },
  });
  if (created.error || !created.data.user) {
    const e = created.error as { status?: number; code?: string; message?: string } | null;
    if (e?.code === "email_exists" || e?.status === 422 && /already/i.test(e?.message ?? "")) {
      throw new HttpError(409, "That address already has a Meridies account. Sign in with it, or ask for a different email.", "email_taken");
    }
    if (e?.code === "weak_password" || /password/i.test(e?.message ?? "")) {
      throw new HttpError(400, oneLine(e?.message, 200) || "Choose a stronger password.", "weak_password");
    }
    args.log?.error({ status: e?.status, code: e?.code }, "parent account: create user failed");
    throw new HttpError(503, "Couldn't create your account right now. Try again in a few minutes.", "parent_signup_failed");
  }
  const userId = created.data.user.id;

  const { error } = await svc.rpc("parent_invite_redeem", { p_token_hash: hashInviteToken(args.token), p_user: userId });
  if (error) {
    // The account was made for this link only: take it back so the address isn't left holding a student account.
    const { error: delErr } = await svc.auth.admin.deleteUser(userId);
    if (delErr) args.log?.error({ status: delErr.status }, "parent account: cleanup after a refused redeem failed");
    const hint = hintOf(error);
    if (hint && REDEEM_WORDS[hint]) throw new HttpError(REDEEM_WORDS[hint]!.status, REDEEM_WORDS[hint]!.message, `invite_${hint}`);
    if (parentSchemaMissing(error)) throw parentAccountsUnavailable();
    args.log?.error({ code: error.code }, "parent account: redeem failed");
    throw new HttpError(503, "Couldn't create your account right now. Try again in a few minutes.", "parent_signup_failed");
  }
  return { email };
}

