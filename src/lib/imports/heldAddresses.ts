/**
 * One address, one student's held data (spec §1, §5.5: no path delivers one
 * student's data to another account).
 *
 * Inside one import, stage_import keeps one invitation per address. Across
 * imports nothing did: sibling A invited at a parent's address in one
 * import, sibling B at the same address in a later one, and B's invitation
 * revoked A's (insertInvitation supersedes the counselor's pending invite to
 * an address). accept_invitation then moves the new_invite items of every
 * pending or revoked invitation from that counselor at that address onto the
 * account that accepted, so both siblings' data waited on one account.
 *
 * So an address whose invitation (pending or revoked, the same set the
 * acceptance sweep reads) already carries held data for a different student
 * is not invited again for another one: staging skips the row, and sending
 * refuses it (the review's "invite" or an older import could still name it).
 * The same student again (a re-import, a resend) is fine: their data is
 * meant to follow their email.
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "../errors.js";
import type { StageItem } from "./match.js";
import { namesMatch } from "./names.js";

type Row = Record<string, unknown>;

export type HeldAtAddress = { email: string; name: string | null; itemId: string };

export const HELD_ELSEWHERE = "Another import is already inviting this address for a different student";

const norm = (email: string) => email.trim().toLowerCase();

/** Would inviting `name` at `email` put their data beside another student's? Unknown names count as different. */
export function heldForSomeoneElse(email: string, name: string | null, held: readonly HeldAtAddress[], self?: string): boolean {
  const e = norm(email);
  return held.some((h) => h.itemId !== self && h.email === e && (!name || !h.name || !namesMatch(name, h.name)));
}

/** Staging: a row to invite at such an address is skipped, with the reason, and can't be invited from review. */
export function skipHeldElsewhere(items: StageItem[], held: readonly HeldAtAddress[]): number {
  let n = 0;
  for (const it of items) {
    if (it.matchStatus !== "new_invite" || !it.matchKey.email) continue;
    if (!heldForSomeoneElse(it.matchKey.email, it.importedName, held)) continue;
    Object.assign(it, { matchStatus: "skipped", confidence: null, studentId: null, candidates: [], skipReason: HELD_ELSEWHERE });
    n += 1;
  }
  return n;
}

/**
 * Held data already waiting at these addresses: new_invite items tied to a
 * pending or revoked invitation from `counselorId`. Read on the caller's
 * client, so a firm admin staging a member's import sees none of the
 * member's invitations (sending, which only the uploader does, checks again).
 * Throws on a read error: the callers fail closed.
 */
export async function heldAtAddresses(request: FastifyRequest, counselorId: string, emails: string[]): Promise<HeldAtAddress[]> {
  const wanted = [...new Set(emails.map(norm).filter((e) => e.includes("@")))];
  const out: HeldAtAddress[] = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const { data: invs, error } = await request.db
      .from("invitations")
      .select("id, email")
      .eq("counselor_id", counselorId)
      .in("status", ["pending", "revoked"])
      .in("email", wanted.slice(i, i + 100));
    if (error) throw fromPostgrest(error);
    const byId = new Map(((invs ?? []) as Row[]).map((r) => [String(r.id), norm(String(r.email))]));
    const ids = [...byId.keys()];
    for (let j = 0; j < ids.length; j += 100) {
      const { data: items, error: itemErr } = await request.db
        .from("import_items")
        .select("id, imported_name, invitation_id")
        .in("invitation_id", ids.slice(j, j + 100))
        .eq("match_status", "new_invite");
      if (itemErr) throw fromPostgrest(itemErr);
      for (const it of (items ?? []) as Row[]) {
        out.push({
          email: byId.get(String(it.invitation_id)) ?? "",
          name: typeof it.imported_name === "string" ? it.imported_name : null,
          itemId: String(it.id),
        });
      }
    }
  }
  return out;
}
