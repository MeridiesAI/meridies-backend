/**
 * Live document activity for the task tracker.
 *
 * A document imported from Drive or OneDrive keeps a pointer to the real file
 * (`documents.external_*`). Before the tracker decides a task is stalled it
 * asks the provider when that file was last edited — Drive `modifiedTime`,
 * Graph `lastModifiedDateTime` — so a student typing in a shared Google Doc
 * does not read as someone who has done nothing.
 *
 * Only metadata is read for the activity signal. Content is re-read (Google
 * Docs only, as plain text into `parsed_data`) solely for documents left
 * available to AI, because that text exists to be compared in a prompt.
 *
 * An edit made by the connected account itself — the counselor who imported
 * the file — is not counted as the student's activity. When the provider does
 * not say who edited, the edit is counted.
 *
 * The pointer is resolved with the grant of the counselor who imported the
 * file (`documents.owner_id`): that is the account the file was shared with.
 */

import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";
import type { SuiteProvider } from "./oauth.js";
import { exportGoogleDocText, getRemoteFile } from "./suiteApi.js";

type Row = Record<string, unknown>;

export type LiveFileCheck = {
  documentId: string;
  name: string;
  provider: SuiteProvider;
  modifiedAt: string | null;
  editedBy: string | null;
  /** Whether this edit counts as the student's activity. */
  counts: boolean;
  error: string | null;
};

const MAX_LIVE_FILES = 5;

export async function checkLiveDocuments(
  request: FastifyRequest,
  docs: Row[]
): Promise<{ checks: LiveFileCheck[]; latestEdit: string | null }> {
  const linked = docs
    .filter((d) => d.external_provider && d.external_file_id)
    .slice(0, MAX_LIVE_FILES);

  const checks = await Promise.all(
    linked.map(async (doc): Promise<LiveFileCheck> => {
      const provider = doc.external_provider as SuiteProvider;
      const name = String(doc.title ?? doc.filename ?? "file");
      const base = { documentId: String(doc.id), name, provider };
      try {
        const file = await getRemoteFile(
          String(doc.owner_id),
          provider,
          String(doc.external_file_id),
          (doc.external_drive_id as string | null) ?? null,
          request.log
        );

        const previous = (doc.external_modified_at as string | null) ?? null;
        const changed = Boolean(file.modifiedAt) && file.modifiedAt !== previous;
        if (changed) {
          const update: Row = { external_modified_at: file.modifiedAt };
          if (doc.available_to_llm !== false) {
            const text = await exportGoogleDocText(String(doc.owner_id), file, request.log);
            if (text) {
              const parsed = {
                text,
                extractedFrom: "google-docs-export",
                extractedAt: new Date().toISOString(),
              };
              update.parsed_data = parsed;
              update.parse_status = "parsed";
              // The caller's in-memory row is what the tracker compares next.
              doc.parsed_data = parsed;
            }
          }
          await request.db.from("documents").update(update).eq("id", String(doc.id));
          doc.external_modified_at = file.modifiedAt;
        }

        return {
          ...base,
          modifiedAt: file.modifiedAt,
          editedBy: file.lastModifiedBy,
          counts: Boolean(file.modifiedAt) && file.lastModifiedByOwner !== true,
          error: null,
        };
      } catch (err) {
        const message =
          err instanceof HttpError ? err.message : "Couldn't reach the provider for this file.";
        return { ...base, modifiedAt: null, editedBy: null, counts: false, error: message };
      }
    })
  );

  let latest = 0;
  for (const c of checks) {
    const t = c.counts && c.modifiedAt ? new Date(c.modifiedAt).getTime() : 0;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return { checks, latestEdit: latest > 0 ? new Date(latest).toISOString() : null };
}
