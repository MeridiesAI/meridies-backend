/**
 * What the Import page lists (history) and what GET /imports/:id adds for a
 * new-pipeline import. Reads on the caller's client: RLS (can_view_import)
 * decides what is listed. The old roster flow's rows (no permission on
 * record) never appear here, and step 2's never appear under /roster.
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "../errors.js";
import { toImportFile, profileView } from "./files.js";
import type { FileProfile } from "./profile.js";
import { HELD_MESSAGE } from "./invitations.js";

type Row = Record<string, unknown>;

export type InviteCounts = { toSend: number; sending: number; sent: number; failed: number; joined: number };
const NO_INVITES: InviteCounts = { toSend: 0, sending: 0, sent: 0, failed: 0, joined: 0 };

const LIST_COLUMNS =
  "id, status, filename, source, source_system, created_at, committed_at, undo_until, undone_at, expires_at, counselor_id, stats, job_result, job_error, invites_held_reason, invites_approved_at";

function invitationsOf(r: Row, counts: InviteCounts | undefined, me: string) {
  const held = Boolean(r.invites_held_reason) && !r.invites_approved_at;
  return {
    ...(counts ?? NO_INVITES),
    held,
    heldReason: held ? HELD_MESSAGE : null,
    canSend: r.counselor_id === me,
  };
}

export function toImportSummary(r: Row, counts: InviteCounts | undefined, me: string, names: Map<string, string>) {
  return {
    id: String(r.id),
    status: String(r.status),
    filename: String(r.filename),
    source: String(r.source),
    sourceSystem: String(r.source_system),
    createdAt: String(r.created_at),
    committedAt: (r.committed_at as string | null) ?? null,
    undoUntil: (r.undo_until as string | null) ?? null,
    undoneAt: (r.undone_at as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
    mine: r.counselor_id === me,
    counselorName: names.get(String(r.counselor_id)) ?? null,
    stats: (r.stats as Record<string, unknown> | null) ?? null,
    jobResult: r.job_result ?? null,
    jobError: r.job_error ?? null,
    invitations: invitationsOf(r, counts, me),
  };
}

async function inviteCounts(request: FastifyRequest, ids: string[]): Promise<Record<string, InviteCounts>> {
  if (ids.length === 0) return {};
  const { data, error } = await request.db.rpc("import_invite_counts", { p_imports: ids });
  if (error) throw fromPostgrest(error);
  return (data ?? {}) as Record<string, InviteCounts>;
}

export async function listImports(request: FastifyRequest) {
  const { data, error } = await request.db
    .from("roster_imports")
    .select(LIST_COLUMNS)
    .not("permission_confirmed_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw fromPostgrest(error);
  const rows = (data ?? []) as unknown as Row[];
  const counts = await inviteCounts(request, rows.map((r) => String(r.id)));
  const others = [...new Set(rows.map((r) => String(r.counselor_id)).filter((id) => id !== request.auth.userId))];
  const names = new Map<string, string>([[request.auth.userId, request.profile.full_name ?? ""]]);
  if (others.length > 0) {
    const { data: people } = await request.db.from("profiles").select("id, full_name").in("id", others);
    for (const p of (people ?? []) as Row[]) names.set(String(p.id), String(p.full_name ?? ""));
  }
  return rows.map((r) => toImportSummary(r, counts[String(r.id)], request.auth.userId, names));
}

export async function listTemplates(request: FastifyRequest) {
  const { data, error } = await request.db
    .from("import_templates")
    .select("id, name, source_system, use_count, last_used_at, created_at")
    .eq("counselor_id", request.auth.userId)
    .order("last_used_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).map((t) => ({
    id: String(t.id),
    name: String(t.name),
    sourceSystem: String(t.source_system),
    useCount: Number(t.use_count ?? 0),
    lastUsedAt: (t.last_used_at as string | null) ?? null,
    createdAt: String(t.created_at),
  }));
}

/** GET /imports/:id's extra fields for a new-pipeline import. */
export async function importDetail(request: FastifyRequest, r: Row) {
  const id = String(r.id);
  const { data: files, error } = await request.db
    .from("import_files")
    .select("id, filename, status, error, detected_type, row_count, size_bytes, profile")
    .eq("import_id", id)
    .order("created_at");
  if (error) throw fromPostgrest(error);
  const counts = await inviteCounts(request, [id]);
  return {
    filename: String(r.filename),
    sourceSystem: String(r.source_system),
    expiresAt: (r.expires_at as string | null) ?? null,
    stats: (r.stats as Record<string, unknown> | null) ?? null,
    plan: r.plan ?? null,
    aiSpendCents: Number(r.ai_spend_cents ?? 0),
    mine: r.counselor_id === request.auth.userId,
    files: ((files ?? []) as Row[]).map((f) => ({ ...toImportFile(f), profile: profileView((f.profile as FileProfile | null) ?? null) })),
    invitations: invitationsOf(r, counts[id], request.auth.userId),
  };
}
