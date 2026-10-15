/**
 * Staging (spec §5.4-§5.6): re-read the files, apply the confirmed plan,
 * match against the uploader's own roster and write items and changes, in
 * one request. 5,000 rows take seconds: the SQL is set-based.
 *
 * Order: import_begin_staging claims the import (mapping -> staging; a double
 * click gets 409); everything after it either ends in stage_import (-> review)
 * or in import_abort_staging (-> mapping, with the reason). A crash leaves
 * 'staging', which the sweep returns to mapping after ten minutes.
 *
 * The roster read returns names, emails and birthdays to this process for
 * matching: logs carry counts only, never values.
 *
 * withWorkerTransaction runs inside an approved counselor's own request, with
 * p_actor = that counselor; every function re-checks can_manage_import.
 */

import type { FastifyRequest } from "fastify";
import { badRequest, conflict, HttpError } from "../errors.js";
import { serializeErr } from "../requestLog.js";
import { MAX_ROWS } from "./caps.js";
import { withWorkerTransaction } from "./db.js";
import { fromImportRpc } from "./errors.js";
import { loadFields } from "./fields.js";
import { loadImportRow } from "./files.js";
import { profiledFiles } from "./mapping.js";
import { matchRecords, TooManyChangesError, toPayload, type RosterStudent } from "./match.js";
import { parseFailureMessage, parseInWorker } from "./parse.js";
import { parsePlanSchema, validatePlan } from "./plan.js";
import { applyPlan, type ParsedFile } from "./rows.js";

type Row = Record<string, unknown>;

export const DRIFT_MESSAGE = "This file looks different from your saved template. Remap?";
const FAILED_MESSAGE = "Matching didn't finish. Try again.";

const rpcError = (err: unknown) => fromImportRpc(err as { code?: string; message?: string });

export async function stageImport(request: FastifyRequest, importId: string): Promise<Record<string, unknown>> {
  const actor = request.auth.userId;
  const imp = await loadImportRow(request, importId, "id, status, plan");
  if (imp.status !== "mapping") throw conflict(imp.status === "staging" ? "This import is being matched. Try again in a moment." : "Map the columns first");
  const planParsed = parsePlanSchema.safeParse(imp.plan);
  if (!planParsed.success) throw badRequest("Map the columns first");

  const files = await profiledFiles(request, importId);
  const fields = await loadFields(request);
  const check = validatePlan(planParsed.data, files, fields);
  if (check.problems.length > 0) throw new HttpError(400, check.problems[0], "plan_incomplete");

  await withWorkerTransaction((c) => c.query("select public.import_begin_staging($1, $2)", [importId, actor])).catch((err: unknown) => {
    throw rpcError(err);
  });

  try {
    const { data: paths, error } = await request.db
      .from("import_files")
      .select("id, filename, storage_path")
      .eq("import_id", importId)
      .eq("status", "profiled");
    if (error) throw new Error("files unreadable");
    const used = new Set(check.plan.sheets.map((s) => s.fileId));
    const parsed: ParsedFile[] = [];
    for (const f of (paths ?? []) as Row[]) {
      if (!used.has(String(f.id))) continue;
      const { data: blob, error: dlErr } = await request.db.storage.from("imports").download(String(f.storage_path));
      if (dlErr || !blob) throw new HttpError(409, `${String(f.filename)} is no longer available. Start a new import.`);
      const out = await parseInWorker(new Uint8Array(await blob.arrayBuffer()), String(f.filename), { maxRows: MAX_ROWS });
      if (!out.ok) throw new HttpError(400, parseFailureMessage(out.reason, String(f.filename)));
      parsed.push({ fileId: String(f.id), filename: String(f.filename), sheets: out.sheets });
    }

    const templateFiles = new Set(check.plan.sheets.filter((s) => s.columns.some((c) => c.source === "template")).map((s) => s.fileId));
    const applied = applyPlan(check.plan, parsed, fields, templateFiles);
    if (applied.rows > MAX_ROWS) throw new HttpError(400, "An import holds at most 5,000 rows");
    if (applied.drift.length > 0) throw new HttpError(400, DRIFT_MESSAGE, "template_drift");

    const roster = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.import_roster_for_matching($1, $2) as out", [importId, actor]);
      return rows[0].out as RosterStudent[];
    });
    const items = matchRecords(applied.records, roster);
    const payload = toPayload(items, { rows: applied.rows, blocked: applied.blocked });
    const stats = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.stage_import($1, $2, $3) as out", [importId, actor, payload]);
      return rows[0].out as Record<string, unknown>;
    });
    request.log.info(
      { importId, rows: applied.rows, items: items.length, changes: payload.changes.length, blocked: applied.blocked },
      "import staged"
    );
    return stats;
  } catch (err) {
    const message =
      err instanceof HttpError ? err.message
        : err instanceof TooManyChangesError ? `${err.rowRef}: too many values for one student`
          : FAILED_MESSAGE;
    if (!(err instanceof HttpError)) request.log.error({ err: serializeErr(err), importId }, "import staging failed");
    await withWorkerTransaction((c) => c.query("select public.import_abort_staging($1, $2, $3)", [importId, actor, message])).catch(
      (e: unknown) => request.log.error({ err: serializeErr(e), importId }, "import staging: could not record the failure")
    );
    if (err instanceof HttpError) throw err;
    if (err instanceof TooManyChangesError) throw new HttpError(400, message);
    if ((err as { code?: string }).code) throw rpcError(err);
    throw new HttpError(500, FAILED_MESSAGE);
  }
}
