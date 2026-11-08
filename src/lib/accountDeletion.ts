/**
 * Deleting an account: what must be true first, and the one deletion path.
 *
 * Shared by `DELETE /account` (now), `POST /account/closure` (at request time, so a counselor learns of a blocker
 * thirty days early) and the closure purge (again at purge time, since anything may have changed). One function
 * each, so the three cannot drift.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { forgetUser } from "./aiBudget.js";
import { forgetAxisTrash } from "./axisTrash.js";
import { HttpError } from "./errors.js";
import { serviceClient } from "./supabase.js";

export type DeletionSubject = { id: string; role: string; firm_id: string | null };

export type DeletionBlockCode = "caseload_not_empty" | "owns_firm" | "stripe_connected" | "signed_agreements_kept";
export type DeletionBlock = { code: DeletionBlockCode; message: string };

type Log = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

/** A table (or a relationship to one) this database doesn't have yet: the feature behind it isn't there to block. */
const NOT_APPLIED = new Set(["PGRST200", "PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"]);

function readFailed(what: string, error: { code?: string; message?: string }): Error {
  return new Error(`account deletion check: ${what} unreadable (${error.code ?? "?"})`);
}

/**
 * Why `who` can't be deleted now, or null. A counselor with students still on the roster (in a firm, archived ones
 * too: the firm can transfer them), a firm owner, a solo practice with a connected Stripe account (the families'
 * card payments and the account's Stripe link would go with it: disconnect it in Stripe first), or an account
 * that signed agreements are kept against (when this database has agreements). A student is never blocked: their
 * record goes with them. Any read error throws, so a caller refuses rather than guesses.
 */
export async function deletionBlocker(svc: SupabaseClient, who: DeletionSubject): Promise<DeletionBlock | null> {
  if (who.role !== "counselor") return null;
  const me = who.id;

  const inFirm = Boolean(who.firm_id);
  let roster = svc.from("profiles").select("id", { count: "exact", head: true }).eq("counselor_id", me);
  if (!inFirm) roster = roster.is("archived_at", null);
  const { count, error } = await roster;
  if (error) throw readFailed("roster", error);
  if ((count ?? 0) > 0) {
    const students = `${count} student${count === 1 ? "" : "s"}`;
    return {
      code: "caseload_not_empty",
      message: inFirm
        ? `You still have ${students} on your caseload. Ask a firm owner or admin to transfer them (Management › Transfer caseload).`
        : `You still have ${students} on your roster. Archive them or hand them to a colleague first.`,
    };
  }

  const firm = await svc.from("firms").select("id").eq("owner_id", me).maybeSingle();
  if (firm.error) throw readFailed("firms", firm.error);
  if (firm.data) return { code: "owns_firm", message: "You own a firm. Hand ownership to someone else before deleting your account." };

  // A firm's Stripe account is the firm's (its owner is refused above); a solo counselor's is their own practice's.
  if (!inFirm) {
    const stripe = await svc.from("practice_stripe_accounts").select("practice_id").eq("counselor_id", me).limit(1);
    if (stripe.error && !NOT_APPLIED.has(stripe.error.code ?? "")) throw readFailed("stripe", stripe.error);
    if (!stripe.error && (stripe.data ?? []).length > 0) {
      return {
        code: "stripe_connected",
        message: "Your practice takes card payments through Stripe. Disconnect Meridies in your Stripe dashboard (Settings › Connected accounts) and ask Meridies to remove the link before closing your account.",
      };
    }
  }

  // An accepted agreement is a permanent record (the agreements migration, 20261111000010, on its own branch): the
  // counselor's own, or one on a contact they created. Probed, never depended on.
  const [own, viaContact] = await Promise.all([
    svc.from("agreements").select("id").eq("counselor_id", me).eq("status", "accepted").limit(1),
    svc.from("agreements").select("id, pipeline_contacts!inner(counselor_id)").eq("status", "accepted").eq("pipeline_contacts.counselor_id", me).limit(1),
  ]);
  let signed = false;
  for (const r of [own, viaContact]) {
    if (r.error) {
      if (NOT_APPLIED.has(r.error.code ?? "")) continue;
      throw readFailed("agreements", r.error);
    }
    if ((r.data ?? []).length > 0) signed = true;
  }
  if (signed) return { code: "signed_agreements_kept", message: "Signed agreements have to be kept: ask Meridies to close the account." };

  return null;
}

/** A block as the 409 the routes answer. */
export const blockError = (b: DeletionBlock) => new HttpError(409, b.message, b.code);

/** The deletion didn't finish; `stage` says where (the account still exists). */
export class DeletionFailed extends Error {
  constructor(readonly stage: "no-service-role" | "axis-trash" | "auth-user") {
    super(`account deletion failed at ${stage}`);
  }
}

/**
 * Delete the account: the AxIS trash it made and the trash about it with the files it kept (the cascade can't reach
 * a row that only names the account, or remove a Storage object; refused rather than leave them behind), the
 * `account.deleted` audit row, the AI budget counters (best effort), then the auth user, from which the profile and
 * everything keyed to it cascades. `via` is recorded on the audit row ("request" or "closure").
 */
export async function deleteAccount(who: DeletionSubject, log: Log, via: "request" | "closure" = "request"): Promise<void> {
  const svc = serviceClient();
  if (!svc) throw new DeletionFailed("no-service-role");
  const me = who.id;
  try {
    await forgetAxisTrash(me, log);
  } catch (err) {
    log.error({ err }, "account delete: axis trash cleanup failed");
    throw new DeletionFailed("axis-trash");
  }
  await svc.from("audit_log").insert({ actor_id: null, action: "account.deleted", entity_type: "profile", entity_id: me, metadata: { role: who.role, via } });
  await forgetUser(me).catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "AI budget rows not removed"));
  const { error } = await svc.auth.admin.deleteUser(me);
  if (error) {
    log.error({ status: error.status }, "account delete failed");
    throw new DeletionFailed("auth-user");
  }
}
