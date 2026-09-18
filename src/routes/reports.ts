/**
 * Family reports and narrative flags — the review queue for the two things the
 * AI routes write as drafts.
 *
 * `/ai/family-report` and `/ai/narrative-coherence` create rows and stop. Until
 * now there was no way to resolve a flag, approve a report, or record that one
 * was sent, which meant the counselor's half of the workflow lived nowhere.
 *
 * Approving is not sending. `POST /reports/family/:id/sent` records a send that
 * happened; nothing in this API delivers a family report on its own, and the
 * `approved -> sent` step is deliberately a separate, explicit call.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toFamilyReport, toNarrativeFlag } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const studentQuery = z.object({ studentId: z.string().uuid().optional() });

const flagPatch = z
  .object({
    status: z.enum(["open", "resolved", "dismissed"]).optional(),
    sharedWithStudent: z.boolean().optional(),
  })
  .strict();

const reportPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    body: z.string().trim().max(20_000).nullable().optional(),
    highlights: z.array(z.string().trim().max(240)).max(12).optional(),
    status: z.enum(["draft", "sent", "archived"]).optional(),
  })
  .strict();

export default async function reportRoutes(app: FastifyInstance) {
  // ---- Narrative flags ------------------------------------------------------

  app.get("/flags", { preHandler: app.authenticate }, async (request) => {
    const q = studentQuery
      .extend({ status: z.enum(["open", "resolved", "dismissed"]).optional() })
      .parse(request.query);
    const student = await resolveStudentId(request, q.studentId, "view");

    let builder = request.db.from("narrative_flags").select("*").eq("student_id", student);
    if (q.status) builder = builder.eq("status", q.status);

    const { data, error } = await builder
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toNarrativeFlag(r as Row));
  });

  /**
   * Resolve, dismiss, or share a flag with the student. A counselor's call: a
   * flag is a reading of the application, and the student agreeing with it is
   * not what closes it.
   */
  app.patch(
    "/flags/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("flags:update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = flagPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");

      const owner = await ownerOf(request, "narrative_flags", id, "That flag doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const values: Record<string, unknown> = {};
      if (patch.sharedWithStudent !== undefined) values.shared_with_student = patch.sharedWithStudent;
      if (patch.status !== undefined) {
        values.status = patch.status;
        const closing = patch.status !== "open";
        values.resolved_by = closing ? request.auth.userId : null;
        values.resolved_at = closing ? new Date().toISOString() : null;
      }

      const { data, error } = await request.db
        .from("narrative_flags")
        .update(values)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toNarrativeFlag(data as Row);
    }
  );

  app.delete(
    "/flags/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("flags:delete", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "narrative_flags", id, "That flag doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const { error } = await request.db.from("narrative_flags").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  // ---- Family reports -------------------------------------------------------

  app.get("/family", { preHandler: app.authenticate }, async (request) => {
    const q = studentQuery
      .extend({ status: z.enum(["draft", "sent", "archived"]).optional() })
      .parse(request.query);
    const student = await resolveStudentId(request, q.studentId, "view");

    let builder = request.db.from("family_reports").select("*").eq("student_id", student);
    if (q.status) builder = builder.eq("status", q.status);

    const { data, error } = await builder
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toFamilyReport(r as Row));
  });

  /** Edit a draft before it goes anywhere. The counselor's words win. */
  app.patch(
    "/family/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = reportPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");

      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const values: Record<string, unknown> = {};
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.summary !== undefined) values.summary = patch.summary;
      if (patch.body !== undefined) values.body = patch.body;
      if (patch.highlights !== undefined) values.highlights = patch.highlights;
      if (patch.status !== undefined) values.status = patch.status;

      const { data, error } = await request.db
        .from("family_reports")
        .update(values)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toFamilyReport(data as Row);
    }
  );

  /**
   * Record that a report was sent. Separate from the patch above on purpose:
   * "sent" is a fact about the world, and it should take a deliberate call to
   * assert one rather than falling out of a field update.
   */
  app.post(
    "/family/:id/sent",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:sent", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const { data, error } = await request.db
        .from("family_reports")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toFamilyReport(data as Row);
    }
  );

  app.delete(
    "/family/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:delete", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const { error } = await request.db.from("family_reports").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

/** The row's real student_id — never one a client claimed. */
async function ownerOf(
  request: FastifyRequest,
  table: "narrative_flags" | "family_reports",
  id: string,
  missing: string
): Promise<string> {
  const { data, error } = await request.db
    .from(table)
    .select("student_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound(missing);
  return data.student_id as string;
}
