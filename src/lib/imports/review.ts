/**
 * Review (spec §5.6): reads through definer functions that ask
 * can_view_import first, and one write (import_review_update) for every kind
 * of decision, in one transaction. A manual fix is cleaned and checked here
 * first, so a bad value is a 400 that names the field; the database's
 * validation trigger checks it again.
 */

import type { FastifyRequest } from "fastify";
import { badRequest, fromPostgrest } from "../errors.js";
import { fromImportRpc } from "./errors.js";
import { findField, loadFields } from "./fields.js";
import { cleanCell, valueOk, type Json } from "./values.js";

type Row = Record<string, unknown>;

export const REVIEW_SECTIONS = ["summary", "groups", "changes", "suggested", "invites", "skipped", "problems"] as const;
export type ReviewSection = (typeof REVIEW_SECTIONS)[number];

export type ReviewUpdate = {
  changes?: Record<string, "accept" | "keep_old" | "reject">;
  patterns?: Record<string, "accept" | "keep_old">;
  items?: Record<string, { action: "confirm"; studentId: string } | { action: "skip" } | { action: "invite" }>;
  fixes?: Record<string, Json>;
};

const ROW_TYPE: Record<string, string> = { test_scores: "row:test_score", courses: "row:course", activities: "row:activity" };

export async function reviewGroups(request: FastifyRequest, importId: string): Promise<unknown> {
  const { data, error } = await request.db.rpc("import_review_groups", { p_import: importId });
  if (error) throw fromImportRpc(error);
  return data ?? [];
}

export async function reviewPage(request: FastifyRequest, importId: string, section: string, offset: number, limit: number): Promise<unknown> {
  const { data, error } = await request.db.rpc("import_review_page", { p_import: importId, p_section: section, p_offset: offset, p_limit: limit });
  if (error) throw fromImportRpc(error);
  return data;
}

/** Clean each fix for its field: a string goes through the same cleanup as a cell. */
export async function cleanFixes(request: FastifyRequest, importId: string, fixes: Record<string, Json>): Promise<Record<string, Json>> {
  const ids = Object.keys(fixes);
  if (ids.length === 0) return {};
  const { data, error } = await request.db
    .from("import_changes")
    .select("id, target_table, field, op")
    .eq("import_id", importId)
    .in("id", ids);
  if (error) throw fromPostgrest(error);
  const fields = await loadFields(request);
  const out: Record<string, Json> = {};
  for (const r of (data ?? []) as Row[]) {
    const id = String(r.id);
    const value = fixes[id];
    const table = String(r.target_table);
    if (r.op === "insert_row") {
      if (!valueOk(ROW_TYPE[table] ?? "", value)) throw badRequest(`That isn't a valid ${table.replace("_", " ").replace(/s$/, "")}`);
      out[id] = value;
      continue;
    }
    const def = findField(fields, table, String(r.field));
    if (!def) throw badRequest("That value can't be fixed here");
    let v: Json = value;
    if (typeof value === "string") {
      const cleaned = cleanCell(def.valueType, value);
      if (!cleaned.ok) throw badRequest(`That isn't a valid value for ${String(r.field).replace(/_/g, " ")}`);
      v = cleaned.value;
    }
    if (!valueOk(def.valueType, v)) throw badRequest(`That isn't a valid value for ${String(r.field).replace(/_/g, " ")}`);
    out[id] = v;
  }
  // An id that isn't in this import goes to the database as given, which refuses it.
  for (const id of ids) if (!(id in out)) out[id] = fixes[id];
  return out;
}

export async function updateReview(request: FastifyRequest, importId: string, body: ReviewUpdate): Promise<Record<string, unknown>> {
  const fixes = await cleanFixes(request, importId, body.fixes ?? {});
  const { data, error } = await request.db.rpc("import_review_update", {
    p_import: importId,
    p_body: { fixes, items: body.items ?? {}, changes: body.changes ?? {}, patterns: body.patterns ?? {} },
  });
  if (error) throw fromImportRpc(error);
  return (data ?? {}) as Record<string, unknown>;
}
