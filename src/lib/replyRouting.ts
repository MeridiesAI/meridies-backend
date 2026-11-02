/**
 * The address a family replies to.
 *
 * Every email a counselor sends a family member can carry
 * `Reply-To: r-<24 hex>@<REPLY_DOMAIN>`. The 24 hex digits are a random token
 * kept in `messaging_routes` against (counselor, which side of the family, and
 * the contact / student / guardian it stands for). When Resend receives a mail
 * for that address, `lib/inboundEmail.ts` reads the token back and knows whose
 * reply it is. One address per target, so a thread keeps one reply address.
 *
 * This only ever returns a courtesy: when `REPLY_DOMAIN` is unset, the
 * migration isn't applied, or anything fails, the caller falls back to the
 * counselor's own address and the email still goes. It never throws.
 *
 * AUTHORIZATION IS THE CALLER'S. This writes with the service role, so the
 * caller must already have shown the signed-in counselor may write to that
 * contact / student (an RLS-bound read, `resolveStudentId`) and that the
 * guardian belongs to that student. Never pass an id a client supplied.
 */

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { replyAddress } from "./inboundEmail.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import { serviceClient } from "./supabase.js";

type Log = { warn: (obj: unknown, msg?: string) => void };

export type ReplyTarget = {
  counselorId: string;
  party: "parent" | "student";
  contactId?: string | null;
  studentId?: string | null;
  guardianId?: string | null;
};

const MISSING_RECHECK_MS = 30_000;
let missingAt = 0;

function find(svc: SupabaseClient, t: ReplyTarget) {
  let q = svc.from("messaging_routes").select("token").eq("counselor_id", t.counselorId).eq("party", t.party);
  q = t.contactId ? q.eq("contact_id", t.contactId) : q.is("contact_id", null);
  q = t.studentId ? q.eq("student_id", t.studentId) : q.is("student_id", null);
  q = t.guardianId ? q.eq("guardian_id", t.guardianId) : q.is("guardian_id", null);
  return q.maybeSingle();
}

/** The reply address for this target, minted on first use; undefined when routing isn't available. */
export async function replyAddressFor(t: ReplyTarget, log?: Log): Promise<string | undefined> {
  const domain = env.REPLY_DOMAIN;
  if (!domain) return undefined;
  if (!t.contactId && !t.studentId) return undefined;
  const svc = serviceClient();
  if (!svc) return undefined;
  if (Date.now() - missingAt < MISSING_RECHECK_MS) return undefined;

  try {
    const existing = await find(svc, t);
    if (existing.error) {
      if (isResultsNotApplied(existing.error)) {
        missingAt = Date.now();
        return undefined;
      }
      throw existing.error;
    }
    if (existing.data) return replyAddress(String((existing.data as { token: string }).token), domain);

    const token = randomBytes(12).toString("hex");
    const ins = await svc.from("messaging_routes").insert({
      token,
      counselor_id: t.counselorId,
      party: t.party,
      contact_id: t.contactId ?? null,
      student_id: t.studentId ?? null,
      guardian_id: t.guardianId ?? null,
    });
    if (!ins.error) return replyAddress(token, domain);
    if (ins.error.code !== "23505") throw ins.error;
    // Lost a race to mint the same target's address: read the winner's.
    const again = await find(svc, t);
    if (again.error || !again.data) throw again.error ?? new Error("route vanished");
    return replyAddress(String((again.data as { token: string }).token), domain);
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : String(err) }, "reply routing unavailable; falling back to the counselor's address");
    return undefined;
  }
}
