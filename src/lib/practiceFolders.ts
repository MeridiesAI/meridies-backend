/**
 * The practice-wide folders every counselor's drive starts with (Demo
 * `lib/files.ts` OWN_SEED): "Practice templates" and "Policy & research".
 *
 * The migration backfills them for counselors who existed then; anyone newer
 * gets them here, on their first Files read. Upsert with ignore-duplicates on
 * (owner_id, system_key), so this is idempotent and never renames a folder
 * the counselor already renamed.
 *
 * `findOrCreateChild` is the demo's `ensureFolder(name, parentId)`: the
 * Colleges tab's research filing asks for "Policy & research › <School>" and
 * gets the same folder every time, created the first time.
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest, notFound } from "./errors.js";

type Row = Record<string, unknown>;

export const PRACTICE_FOLDERS = [
  { key: "practice-templates", name: "Practice templates", sortOrder: 1 },
  { key: "policy-research", name: "Policy & research", sortOrder: 2 },
] as const;

export type PracticeFolderKey = (typeof PRACTICE_FOLDERS)[number]["key"];
export const PRACTICE_FOLDER_KEYS = PRACTICE_FOLDERS.map((f) => f.key) as [
  PracticeFolderKey,
  ...PracticeFolderKey[],
];

/** Make sure the caller (a counselor) has every practice folder. */
export async function ensurePracticeFolders(request: FastifyRequest): Promise<void> {
  if (request.profile.role !== "counselor") return;
  const { error } = await request.db.from("folders").upsert(
    PRACTICE_FOLDERS.map((f) => ({
      owner_id: request.auth.userId,
      name: f.name,
      kind: "custom",
      is_system: true,
      sort_order: f.sortOrder,
      system_key: f.key,
    })),
    { onConflict: "owner_id,system_key", ignoreDuplicates: true }
  );
  if (error) throw fromPostgrest(error);
}

/** The caller's practice folder for `key`, created if it is missing. */
export async function practiceFolder(request: FastifyRequest, key: PracticeFolderKey): Promise<Row> {
  await ensurePracticeFolders(request);
  const { data, error } = await request.db
    .from("folders")
    .select("*")
    .eq("owner_id", request.auth.userId)
    .eq("system_key", key)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That folder isn't on file");
  return data as Row;
}

/**
 * A folder called `name` directly under `parentId` (case-insensitive), made
 * when there isn't one. The parent must already be the caller's own folder.
 */
export async function findOrCreateChild(
  request: FastifyRequest,
  parentId: string,
  name: string
): Promise<{ folder: Row; created: boolean }> {
  const trimmed = name.trim();
  const { data: siblings, error } = await request.db
    .from("folders")
    .select("*")
    .eq("owner_id", request.auth.userId)
    .eq("parent_id", parentId)
    .limit(1000);
  if (error) throw fromPostgrest(error);
  const match = ((siblings ?? []) as Row[]).find(
    (f) => String(f.name).trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (match) return { folder: match, created: false };

  const { data, error: insErr } = await request.db
    .from("folders")
    .insert({
      owner_id: request.auth.userId,
      parent_id: parentId,
      name: trimmed,
      kind: "custom",
      is_system: false,
      sort_order: 0,
    })
    .select("*")
    .single();
  if (insErr) throw fromPostgrest(insErr);
  return { folder: data as Row, created: true };
}
