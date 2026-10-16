/**
 * One address, one student's held data (spec §1, §5.5: no path delivers one
 * student's data to another account).
 *
 * accept_invitation moves the new_invite items of every pending or revoked
 * invitation from the same counselor at the same address onto the account
 * that accepts. So sibling A imported at a parent's address, then sibling B
 * invited there by any route (another import, a hand invite, Mass invite, the
 * pipeline, a referral, a resend, the old roster flow), and B accepting put
 * both students' data on B's account. 20261024000062 makes the sweep move only
 * items of an invitation naming the same student; until it is applied, and
 * as a second check after, the API never creates an invitation at an address
 * whose pending or revoked invitation carries a different student's held
 * data:
 *  - staging skips such a row, with the reason;
 *  - insertInvitation (every route that invites, lib/invites.ts) refuses it
 *    with 409 `address_holds_other_student`.
 * The same student is the same full name, ignoring case and spacing, and
 * never a blank one, the rule 20261024000062 applies, so a re-import or a
 * resend (which carry the imported name) still follow the email. A nickname
 * ("Sam Lee" and "Samuel Lee") or a missing name counts as someone else: the
 * earlier invitation keeps working, and the address is free again once it is
 * accepted or its data expires.
 *
 * Read through the service role, filtered to one counselor's own invitations
 * (the caller's, or the uploader of an import the caller's client loaded),
 * because the caller's RLS hides imports they made in a firm they have since
 * left and a firm admin can't read a member's invitations; on the caller's
 * client without the service role. Every read error throws: callers refuse.
 */

import type { FastifyRequest } from "fastify";
import { HttpError, fromPostgrest } from "../errors.js";
import { serviceClient } from "../supabase.js";
import type { StageItem } from "./match.js";

type Row = Record<string, unknown>;

export type HeldAtAddress = { email: string; name: string | null; itemId: string; invitationId?: string };

export const HELD_ELSEWHERE = "Another import is already inviting this address for a different student";
export const ADDRESS_HELD_MESSAGE =
  "An invitation to this address carries another student's imported data. Invite this student at their own address, or wait until that invitation is accepted or its data expires.";

const norm = (email: string) => email.trim().toLowerCase();
const normName = (name: string | null | undefined) => (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The same student, as accept_invitation decides it (20261024000062): the same non-blank full name, ignoring case and spacing. */
export function sameStudentName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normName(a);
  return x !== "" && x === normName(b);
}

/** Would inviting `name` at `email` put their data beside another student's? Unknown names count as different. */
export function heldForSomeoneElse(email: string, name: string | null, held: readonly HeldAtAddress[], self?: string): boolean {
  const e = norm(email);
  return held.some((h) => h.itemId !== self && h.email === e && !sameStudentName(name, h.name));
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
 * pending or revoked invitation from `counselorId` (the set the acceptance
 * sweep reads). `counselorId` must be the caller or the uploader of an import
 * the caller's own client loaded. Throws on a read error.
 */
export async function heldAtAddresses(request: FastifyRequest, counselorId: string, emails: string[]): Promise<HeldAtAddress[]> {
  const wanted = [...new Set(emails.map(norm).filter((e) => e.includes("@")))];
  const db = serviceClient() ?? request.db;
  const out: HeldAtAddress[] = [];
  for (let i = 0; i < wanted.length; i += 100) {
    const { data: invs, error } = await db
      .from("invitations")
      .select("id, email")
      .eq("counselor_id", counselorId)
      .in("status", ["pending", "revoked"])
      .in("email", wanted.slice(i, i + 100));
    if (error) throw fromPostgrest(error);
    const byId = new Map(((invs ?? []) as Row[]).map((r) => [String(r.id), norm(String(r.email))]));
    const ids = [...byId.keys()];
    for (let j = 0; j < ids.length; j += 100) {
      const { data: items, error: itemErr } = await db
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
          invitationId: String(it.invitation_id),
        });
      }
    }
  }
  return out;
}

/**
 * Before the caller invites `fullName` at `email`: refuse (409) when one of
 * their invitations to that address carries another student's held import
 * data. `except.item` is the import item being invited and `except.resendOf`
 * the invitation being sent again: neither blocks itself, even with no name.
 */
export async function assertAddressFreeFor(
  request: FastifyRequest,
  email: string,
  fullName: string | null | undefined,
  except: { item?: string; resendOf?: string } = {}
): Promise<void> {
  const held = (await heldAtAddresses(request, request.auth.userId, [email])).filter(
    (h) => !except.resendOf || h.invitationId !== except.resendOf
  );
  if (heldForSomeoneElse(email, fullName ?? null, held, except.item)) {
    throw new HttpError(409, ADDRESS_HELD_MESSAGE, "address_holds_other_student");
  }
}
