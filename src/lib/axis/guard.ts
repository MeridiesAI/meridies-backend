/**
 * Defense in depth over the retrieval port. The port runs on the caller's RLS
 * client, so it can't return a file the counselor can't open; this re-applies
 * the AI rules that RLS doesn't know about (keep-out, waived letters, the
 * practice's document-reading switch, per-file access, kind defaults) using
 * the one decision function the context layer uses, and keeps a
 * student-scoped chat from quoting another student's file.
 */
import type { FastifyRequest } from "fastify";
import { documentAiDecision } from "../context/documentAi.js";
import { fromPostgrest } from "../errors.js";
import { loadPracticeSettings } from "../practiceSettings.js";
import type { RetrievedChunk } from "./ports.js";

export type DocRow = {
  id: string;
  student_id: string | null;
  kind: string;
  available_to_llm: boolean;
  ai_access: string;
  ferpa_waived: boolean;
};

export type DropReason = "not-visible" | "ai-rule" | "other-student";

/** Pure: may this chunk reach a prompt? */
export function chunkAllowed(
  chunk: RetrievedChunk,
  doc: DocRow | undefined,
  practiceReadsDocuments: boolean,
  scopeStudentId: string | null
): { ok: true } | { ok: false; reason: DropReason } {
  // Connector content that was never filed: the counselor's own mailbox or drive.
  if (!chunk.documentId) {
    if (scopeStudentId && chunk.studentId && chunk.studentId !== scopeStudentId) return { ok: false, reason: "other-student" };
    return { ok: true };
  }
  // A filed document we couldn't read back is one RLS hid, or one that was deleted. Fail closed.
  if (!doc) return { ok: false, reason: "not-visible" };
  if (scopeStudentId && doc.student_id && doc.student_id !== scopeStudentId) return { ok: false, reason: "other-student" };
  return documentAiDecision(doc, practiceReadsDocuments).allowed ? { ok: true } : { ok: false, reason: "ai-rule" };
}

export async function filterAllowedChunks(
  request: FastifyRequest,
  chunks: RetrievedChunk[],
  scopeStudentId: string | null
): Promise<{ kept: RetrievedChunk[]; dropped: Partial<Record<DropReason, number>> }> {
  const ids = [...new Set(chunks.map((c) => c.documentId).filter((id): id is string => !!id))];
  const docs = new Map<string, DocRow>();
  let practiceReads = true;
  if (ids.length) {
    const [rows, practice] = await Promise.all([
      request.db
        .from("documents")
        .select("id, student_id, kind, available_to_llm, ai_access, ferpa_waived")
        .in("id", ids),
      loadPracticeSettings(request),
    ]);
    if (rows.error) throw fromPostgrest(rows.error);
    for (const r of (rows.data ?? []) as DocRow[]) docs.set(r.id, r);
    practiceReads = practice.settings.autoParseDocuments;
  }
  const kept: RetrievedChunk[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  for (const c of chunks) {
    const verdict = chunkAllowed(c, c.documentId ? docs.get(c.documentId) : undefined, practiceReads, scopeStudentId);
    if (verdict.ok) kept.push(c);
    else dropped[verdict.reason] = (dropped[verdict.reason] ?? 0) + 1;
  }
  return { kept, dropped };
}
