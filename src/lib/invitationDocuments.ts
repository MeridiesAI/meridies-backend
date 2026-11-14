/**
 * Documents a counselor adds for a student who has been invited but has not joined yet
 * (`invitation_documents`, 20261124000008). The file is already in the documents bucket; a row here holds
 * it against the invitation until the student accepts, when a database trigger files it as a real
 * `documents` row in the student's folder and deletes this one.
 *
 * Without the migration every function here reads as "none" and the routes answer 503
 * `invitation_documents_unavailable`; nothing else about invitations changes. Ready is remembered for the
 * process, missing for 30 seconds (the same rule as `sequencesReady`).
 */

import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, fromPostgrest } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import { DOCUMENTS_BUCKET } from "./storagePath.js";

type Row = Record<string, unknown>;

export const MAX_STAGED_PER_INVITATION = 50;

export const INVITATION_DOCUMENT_KINDS = [
  "transcript", "resume", "essay", "test-report", "award-letter",
  "financial", "common-app", "other",
  "recommendation-letter", "activity-list", "iep-504", "counselor-only",
] as const;

export const invitationDocumentBody = z
  .object({
    storagePath: z.string().trim().min(1).max(500),
    filename: z.string().trim().min(1).max(300),
    title: z.string().trim().max(300).nullable().optional(),
    mimeType: z.string().trim().max(200).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
    kind: z.enum(INVITATION_DOCUMENT_KINDS).default("other"),
  })
  .strict();

export const INVITATION_DOCUMENT_COLUMNS =
  "id, invitation_id, bucket, storage_path, filename, title, mime_type, size_bytes, kind, created_at";

export interface InvitationDocument {
  id: string;
  invitationId: string;
  storagePath: string;
  filename: string;
  title: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  kind: string;
  createdAt: string;
}

export function toInvitationDocument(r: Row): InvitationDocument {
  return {
    id: String(r.id),
    invitationId: String(r.invitation_id),
    storagePath: String(r.storage_path),
    filename: String(r.filename),
    title: (r.title as string | null) ?? null,
    mimeType: (r.mime_type as string | null) ?? null,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    kind: String(r.kind),
    createdAt: String(r.created_at),
  };
}

/** Staged objects live at `<counselor id>/<invitation id>/<ts>-<name>`: the first segment is the uploader's own id. */
export function stagedPathPrefix(counselorId: string, invitationId: string): string {
  return `${counselorId}/${invitationId}/`;
}

export function stagedPathOk(path: string, counselorId: string, invitationId: string): boolean {
  const prefix = stagedPathPrefix(counselorId, invitationId);
  return path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes("/");
}

export function invitationDocumentsUnavailable(): HttpError {
  return new HttpError(503, "Adding documents before a student joins isn't switched on yet", "invitation_documents_unavailable");
}

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

/** A zero-row read of the table the migration adds. */
export async function invitationDocumentsReady(request: FastifyRequest): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < MISSING_RECHECK_MS) return false;
  const { error } = await request.db.from("invitation_documents").select("id").limit(0);
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw fromPostgrest(error);
}

export async function requireInvitationDocuments(request: FastifyRequest): Promise<void> {
  if (!(await invitationDocumentsReady(request))) throw invitationDocumentsUnavailable();
}

/** How many staged files each invitation holds; an empty map before the migration. Never throws for a missing table. */
export async function documentCountsByInvitation(request: FastifyRequest, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0 || !(await invitationDocumentsReady(request))) return counts;
  const { data, error } = await request.db
    .from("invitation_documents")
    .select("invitation_id")
    .in("invitation_id", ids)
    .limit(5000);
  if (error) {
    request.log.warn("invitation document counts unavailable");
    return counts;
  }
  for (const r of data ?? []) {
    const id = String((r as Row).invitation_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * A new invitation replaces the pending one to the same address (a resend, or a second send): the staged
 * files follow it, or they would stay on the revoked row where nobody looks. Best effort; the files are
 * never lost (they stay on the old invitation, which still exists).
 */
export async function moveStagedDocuments(request: FastifyRequest, fromIds: string[], toId: string): Promise<void> {
  if (fromIds.length === 0 || !(await invitationDocumentsReady(request))) return;
  const { error } = await request.db
    .from("invitation_documents")
    .update({ invitation_id: toId })
    .eq("counselor_id", request.auth.userId)
    .in("invitation_id", fromIds);
  if (error) request.log.warn("staged documents did not follow the new invitation");
}

export { DOCUMENTS_BUCKET };
