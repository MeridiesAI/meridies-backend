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
 *   younger than 14 days, §5.1), and a first import over 50 invitations
 *   waits for Meridies (§5.1).
 * One bad address fails one item; the rest go.
 */

import type { FastifyRequest } from "fastify";
import { conflict, forbidden, fromPostgrest } from "../errors.js";
import { emailInvitation, insertInvitation } from "../invites.js";
import { enforceQuota } from "../limits.js";
import { serializeErr } from "../requestLog.js";
import { fromImportRpc } from "./errors.js";
import { loadImportRow } from "./files.js";

type Row = Record<string, unknown>;

export const HELD_MESSAGE = "Waiting for a quick check from Meridies (usually within a day)";
export const UPLOADER_ONLY = "Invitations go out in the name of the counselor who uploaded this import";
const BATCH = 25;

export type InviteOutcome = { sent: number; failed: number; held: boolean; remaining: number; reason: string | null };

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

  let sent = 0;
  let failed = 0;
  for (const it of out.items) {
    let ok = false;
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
  request.log.info({ importId, sent, failed, remaining: out.remaining }, "import invitations sent");
  return { sent, failed, held: false, remaining: out.remaining, reason: null };
}
