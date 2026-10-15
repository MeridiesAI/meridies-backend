/**
 * Invitations after commit (spec §5.7), a separate, retryable step.
 *
 * - Only the uploader sends: accepting an invitation makes the inviter the
 *   student's counselor, so a firm admin who committed someone else's import
 *   can't send in their name (import_claim_invites refuses, MI002).
 * - Each item is claimed first (unsent/failed -> sending, under a row lock
 *   with SKIP LOCKED), so two tabs or a double click never send twice; a
 *   claim older than ten minutes (a crash) can be taken again.
 * - The invitation row is inserted and tied to the item before the email
 *   goes out, so a quick acceptance always finds the held data.
 * - Resend gets an idempotency key per item and invitation.
 * - The daily invite quota applies (100, or 50 for a counselor account
 *   younger than 14 days, §5.1).
 * - Meridies looks before a counselor's imports send more than 50
 *   invitations in all (§5.1, `inviteReview` below): counted across every
 *   import of theirs, so neither splitting a list nor saving a small import
 *   first gets past it.
 * One bad address fails one item; the rest go.
 */

import type { FastifyRequest } from "fastify";
import { env } from "../../env.js";
import { sendEmail } from "../email.js";
import { conflict, forbidden, fromPostgrest } from "../errors.js";
import { emailInvitation, insertInvitation } from "../invites.js";
import { enforceQuota } from "../limits.js";
import { redactText, serializeErr } from "../requestLog.js";
import { serviceClient } from "../supabase.js";
import { fromImportRpc } from "./errors.js";
import { loadImportRow } from "./files.js";
import { HELD_ELSEWHERE, heldAtAddresses, heldForSomeoneElse, type HeldAtAddress } from "./heldAddresses.js";

type Row = Record<string, unknown>;

export const HELD_MESSAGE = "Waiting for a quick check from Meridies (usually within a day)";
export const UPLOADER_ONLY = "Invitations go out in the name of the counselor who uploaded this import";
const BATCH = 25;

export type InviteOutcome = { sent: number; failed: number; held: boolean; remaining: number; reason: string | null };

/** Invitations a counselor's imports may send, in all, before Meridies has looked once. */
export const REVIEW_THRESHOLD = 50;
export const HOLD_REASON = "first-import-review";

/**
 * Must this import's invitations wait for Meridies (§5.1)? Yes when Meridies
 * has approved none of the uploader's imports yet and the invitations their
 * saved imports have sent or still hold (an item tied to an invitation, or
 * waiting to be invited), with this import's, come to more than
 * REVIEW_THRESHOLD. Counted per counselor, never per import: a list split
 * into imports of 50, or a 5,000-row import saved after a 1-row one, is
 * held all the same. Items that came with a caseload transfer count too, so
 * the hold can come sooner for a receiver, never later. Read on the caller's
 * client (the uploader, or a firm admin who can view the import); a read
 * that errors throws, so nothing is sent on a guess.
 */
export async function inviteReview(request: FastifyRequest, imp: Row): Promise<{ hold: boolean; total: number }> {
  if (imp.invites_approved_at) return { hold: false, total: 0 };
  const { data: imports, error } = await request.db
    .from("roster_imports")
    .select("id, committed_at, invites_approved_at")
    .eq("counselor_id", String(imp.counselor_id))
    .not("permission_confirmed_at", "is", null);
  if (error) throw fromPostgrest(error);
  const rows = (imports ?? []) as Row[];
  if (rows.some((r) => r.invites_approved_at)) return { hold: false, total: 0 };
  const ids = [...new Set([String(imp.id), ...rows.filter((r) => r.committed_at).map((r) => String(r.id))])];
  let total = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const { count, error: countErr } = await request.db
      .from("import_items")
      .select("id", { count: "exact", head: true })
      .in("import_id", ids.slice(i, i + 100))
      .or("match_status.eq.new_invite,invitation_id.not.is.null");
    if (countErr) throw fromPostgrest(countErr);
    total += count ?? 0;
  }
  return { hold: total > REVIEW_THRESHOLD, total };
}

/**
 * Mark the import's invitations held (the client guard keeps the column from
 * the browser, so the service role writes it, for an import the caller's own
 * client just loaded). True when this call set it: the one time to tell
 * Meridies. Without the service role the hold still applies, unrecorded.
 */
async function recordHold(importId: string): Promise<boolean> {
  const svc = serviceClient();
  if (!svc) return false;
  const { data, error } = await svc
    .from("roster_imports")
    .update({ invites_held_reason: HOLD_REASON })
    .eq("id", importId)
    .is("invites_held_reason", null)
    .is("invites_approved_at", null)
    .select("id");
  if (error) throw fromPostgrest(error);
  return (data ?? []).length > 0;
}

/** One email to Meridies when an import's invitations wait for a check (§5.1). Counts only. */
export async function notifyInviteReview(request: FastifyRequest, importId: string, count: number): Promise<void> {
  const to = env.ACCESS_REVIEW_EMAIL ?? "team@meridiesai.com";
  const lines = [
    `A counselor's imports would send ${count} invitations in all, so this import's invitations are held for a check.`,
    `Counselor: ${request.profile.full_name ?? "(no name)"} <${request.profile.email ?? request.auth.email ?? ""}>`,
    `Import: ${importId}`,
    `To approve (this import and every later one of theirs), as postgres: update public.roster_imports set invites_approved_at = now() where id = '${importId}';`,
  ];
  await sendEmail({
    to,
    subject: "Import invitations waiting for a check",
    html: lines.map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`).join(""),
    text: lines.join("\n"),
    template: "import-invites-review",
    recipient_kind: "counselor",
    logger: request.log,
  }).catch((err: unknown) => request.log.warn({ err: redactText(String(err)) }, "import invite review email failed"));
}

/**
 * After a commit request: hold the invitations if the counselor-level rule
 * says so and the database (before 20261024000061) didn't, and tell Meridies
 * once. Sending re-checks the same rule, so a failure here holds nothing back.
 */
export async function holdAfterCommit(request: FastifyRequest, importId: string): Promise<void> {
  const imp = await loadImportRow(request, importId, "id, counselor_id, invites_held_reason, invites_approved_at");
  const review = await inviteReview(request, imp);
  if (!review.hold) return;
  const fresh = imp.invites_held_reason ? false : await recordHold(importId);
  if (fresh || imp.invites_held_reason === HOLD_REASON) void notifyInviteReview(request, importId, review.total);
}

async function inviteQuota(request: FastifyRequest): Promise<number> {
  const { data } = await request.db.from("profiles").select("created_at").eq("id", request.auth.userId).maybeSingle();
  const created = data?.created_at ? Date.parse(String(data.created_at)) : Date.now();
  return Date.now() - created < 14 * 86_400_000 ? 50 : 100;
}

export async function sendImportInvitations(request: FastifyRequest, importId: string): Promise<InviteOutcome> {
  const imp = await loadImportRow(request, importId, "id, status, counselor_id, invites_held_reason, invites_approved_at");
  if (imp.counselor_id !== request.auth.userId) throw forbidden(UPLOADER_ONLY);
  if (imp.status !== "committed") throw conflict("Invitations go out after the import is saved");
  if (imp.invites_held_reason && !imp.invites_approved_at) {
    return { sent: 0, failed: 0, held: true, remaining: 0, reason: HELD_MESSAGE };
  }

  const { count, error: countErr } = await request.db
    .from("import_items")
    .select("id", { count: "exact", head: true })
    .eq("import_id", importId)
    .eq("match_status", "new_invite")
    .in("invite_state", ["unsent", "failed"]);
  if (countErr) throw fromPostgrest(countErr);
  if ((count ?? 0) === 0) return { sent: 0, failed: 0, held: false, remaining: 0, reason: null };

  // The counselor-level review, asked again at every send: it holds imports
  // saved before this rule (or by a database without 20261024000061) too.
  const review = await inviteReview(request, imp);
  if (review.hold) {
    if (await recordHold(importId)) void notifyInviteReview(request, importId, review.total);
    return { sent: 0, failed: 0, held: true, remaining: count ?? 0, reason: HELD_MESSAGE };
  }

  const batch = Math.min(count ?? 0, BATCH);
  await enforceQuota(
    request.auth.userId,
    "invites",
    "day",
    await inviteQuota(request),
    "You've sent a lot of invitations today. Try again tomorrow.",
    batch
  );

  const { data: claim, error } = await request.db.rpc("import_claim_invites", { p_import: importId, p_limit: batch });
  if (error) throw fromImportRpc(error);
  const out = claim as { held: boolean; items: Array<{ itemId: string; email: string; name: string | null; gradYear: number | null }>; remaining: number };
  if (out.held) return { sent: 0, failed: 0, held: true, remaining: out.remaining, reason: HELD_MESSAGE };

  // Never invite an address whose earlier invitation carries another
  // student's held data (heldAddresses.ts): insertInvitation would revoke
  // that invitation and acceptance would put both students' data on one
  // account. A read that fails holds the whole batch back.
  let held: HeldAtAddress[] | null = null;
  try {
    held = await heldAtAddresses(request, request.auth.userId, out.items.map((it) => it.email));
  } catch (err) {
    request.log.warn({ err: serializeErr(err), importId }, "import invitations: could not read held addresses");
  }

  let sent = 0;
  let failed = 0;
  let heldElsewhere = 0;
  for (const it of out.items) {
    let ok = false;
    if (!held || heldForSomeoneElse(it.email, it.name, held, it.itemId)) {
      if (held) heldElsewhere += 1;
      const fin = await request.db.rpc("import_finish_invite", { p_item: it.itemId, p_ok: false });
      if (fin.error) request.log.warn({ code: fin.error.code, importId, itemId: it.itemId }, "import invitation: could not record the outcome");
      failed += 1;
      continue;
    }
    try {
      const input = { email: it.email, fullName: it.name, gradYear: it.gradYear, source: "roster" as const };
      const { row, token } = await insertInvitation(request, input);
      const link = await request.db.rpc("import_link_invitation", { p_item: it.itemId, p_invitation: String(row.id) });
      if (link.error) {
        // Never email a link the held data isn't tied to.
        await request.db.from("invitations").update({ status: "revoked" }).eq("id", String(row.id)).eq("status", "pending");
        throw new Error(`link failed: ${link.error.code ?? "unknown"}`);
      }
      ok = await emailInvitation(request, row as Row, token, input, `import-invite/${it.itemId}/${String(row.id)}`);
    } catch (err) {
      request.log.warn({ err: serializeErr(err), importId, itemId: it.itemId }, "import invitation failed");
      ok = false;
    }
    const fin = await request.db.rpc("import_finish_invite", { p_item: it.itemId, p_ok: ok });
    if (fin.error) request.log.warn({ code: fin.error.code, importId, itemId: it.itemId }, "import invitation: could not record the outcome");
    if (ok) sent += 1;
    else failed += 1;
  }
  request.log.info({ importId, sent, failed, heldElsewhere, remaining: out.remaining }, "import invitations sent");
  const reason = heldElsewhere > 0 ? `${heldElsewhere === 1 ? "1 invitation wasn't" : `${heldElsewhere} invitations weren't`} sent: ${HELD_ELSEWHERE.toLowerCase()}` : null;
  return { sent, failed, held: false, remaining: out.remaining, reason };
}
