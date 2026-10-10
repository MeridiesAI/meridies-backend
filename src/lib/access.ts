/**
 * Counselor approval: the one definition.
 *
 * A counselor account is pending until Meridies approves it
 * (profiles.counselor_approved_at). The request gate in plugins/supabaseAuth.ts
 * and every background job ask here, so "approved" cannot drift between them.
 * When billing arrives, a paid subscription becomes another way to satisfy
 * these functions and private.is_counselor in the database; nothing else moves.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "./serialize.js";

export type AccessStatus = "approved" | "pending";

type Approval = { role: Role; counselor_approved_at: string | null };

/** null for students: approval is a counselor concept. */
export function accessStatusOf(p: Approval): AccessStatus | null {
  if (p.role !== "counselor") return null;
  return p.counselor_approved_at ? "approved" : "pending";
}

/** A route is closed to pending counselors unless it sets `config: { allowPending: true }`. */
export function blockedAsPending(p: Approval, allowPending: boolean | undefined): boolean {
  return accessStatusOf(p) === "pending" && allowPending !== true;
}

const ID_CHUNK = 200;

/**
 * Which of these counselors are approved right now. For work on the service
 * client, which RLS does not scope. Throws on a read error: the caller decides
 * what an unreadable answer means, and for anything that sends it means "hold".
 */
export async function approvedCounselorIds(svc: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const approved = new Set<string>();
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const { data, error } = await svc
      .from("profiles")
      .select("id")
      .in("id", unique.slice(i, i + ID_CHUNK))
      .eq("role", "counselor")
      .not("counselor_approved_at", "is", null);
    if (error) throw new Error(`approval read failed (${error.code ?? "unknown"})`);
    for (const row of data ?? []) approved.add(String(row.id));
  }
  return approved;
}

export async function isCounselorApproved(svc: SupabaseClient, id: string): Promise<boolean> {
  return (await approvedCounselorIds(svc, [id])).has(id);
}
