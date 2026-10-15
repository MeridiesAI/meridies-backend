/**
 * Import pipeline, step 1 routes (spec §5.7–§5.9).
 *
 * The browser never runs a save, undo or apply: it requests one through an
 * RLS-checked function, and the job runs on the import_worker connection.
 * Upload, mapping and review routes arrive in step 2.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasImportWorker } from "../env.js";
import { fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { fromImportRpc } from "../lib/imports/errors.js";
import { kickImportJob } from "../lib/imports/jobs.js";
import { namesMatch, normalizeName } from "../lib/imports/names.js";
import { limit } from "../lib/limits.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ itemId: z.string().uuid() });
const applyBody = z
  .object({
    decisions: z.record(z.string().uuid(), z.enum(["accept", "keep_old", "reject"])),
    confirmName: z.string().trim().max(200).optional(),
  })
  .strict();

type HeldChange = {
  id: string;
  targetTable: string;
  field: string;
  op: "set_field" | "insert_row";
  newValue: unknown;
  currentValue: unknown;
  /** "intake" when the current value is still what the student's questionnaire wrote (20261023010003). */
  currentSource?: "intake" | null;
  defaultDecision: "accept" | "keep_old";
};

type HeldEntry = {
  itemId: string;
  importId: string;
  importedName: string | null;
  studentId: string;
  studentName: string;
  studentEmail: string;
  heldUntil: string;
  jobError: unknown;
  changes: HeldChange[];
  nameMismatch: boolean;
};

function requireWorker(): void {
  if (!hasImportWorker) throw unavailable("Imports aren't set up on this server yet");
}

async function heldQueue(request: FastifyRequest): Promise<HeldEntry[]> {
  const { data, error } = await request.db.rpc("import_held_queue");
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Omit<HeldEntry, "nameMismatch">[]).map((e) => ({
    ...e,
    nameMismatch: e.importedName ? !namesMatch(e.importedName, e.studentName) : false,
  }));
}

function toImportStatus(r: Row) {
  return {
    id: String(r.id),
    status: String(r.status),
    committedAt: (r.committed_at as string | null) ?? null,
    undoUntil: (r.undo_until as string | null) ?? null,
    undoneAt: (r.undone_at as string | null) ?? null,
    jobError: r.job_error ?? null,
    jobResult: r.job_result ?? null,
  };
}

export default async function importRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/held", { preHandler: [...counselor, limit("imports:held", 120, 60)] }, async (request) =>
    heldQueue(request)
  );

  app.get("/:id", { preHandler: [...counselor, limit("imports:status", 600, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("roster_imports")
      .select("id, status, committed_at, undo_until, undone_at, job_error, job_result")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That import isn't on your account");
    return toImportStatus(data as Row);
  });

  app.post("/:id/commit", { preHandler: [...counselor, limit("imports:commit", 20, 3600)] }, async (request, reply) => {
    requireWorker();
    const { id } = idParam.parse(request.params);
    const { error } = await request.db.rpc("request_import_commit", { p_import: id });
    if (error) throw fromImportRpc(error);
    kickImportJob("commit", id, request.auth.userId, request.log);
    return reply.code(202).send({ status: "committing" });
  });

  app.post("/:id/undo", { preHandler: [...counselor, limit("imports:undo", 20, 3600)] }, async (request, reply) => {
    requireWorker();
    const { id } = idParam.parse(request.params);
    const { error } = await request.db.rpc("request_import_undo", { p_import: id });
    if (error) throw fromImportRpc(error);
    kickImportJob("undo", id, request.auth.userId, request.log);
    return reply.code(202).send({ status: "undoing" });
  });

  app.post(
    "/held/:itemId/apply",
    { preHandler: [...counselor, limit("imports:apply", 120, 3600)] },
    async (request, reply) => {
      requireWorker();
      const { itemId } = itemParam.parse(request.params);
      const body = applyBody.parse(request.body);

      const entry = (await heldQueue(request)).find((e) => e.itemId === itemId);
      if (!entry) throw notFound("That data is no longer waiting to be applied");
      if (entry.nameMismatch) {
        // A guard against mistakes, not a security boundary: request_held_apply
        // is also reachable directly by the same authorized manager.
        const want = normalizeName(entry.studentName);
        const typed = want ? normalizeName(body.confirmName ?? "") : (body.confirmName ?? "").trim().toLocaleLowerCase();
        const expected = want || entry.studentName.trim().toLocaleLowerCase();
        if (typed === "" || typed !== expected) {
          return reply.code(409).send({
            code: "name-confirmation-required",
            message: `The account is ${entry.studentName}, but the file says ${entry.importedName}. Type ${entry.studentName} to confirm.`,
          });
        }
      }

      const { error } = await request.db.rpc("request_held_apply", { p_item: itemId, p_decisions: body.decisions });
      if (error) throw fromImportRpc(error);
      kickImportJob("apply", itemId, request.auth.userId, request.log);
      return reply.code(202).send({ status: "applying" });
    }
  );
}
