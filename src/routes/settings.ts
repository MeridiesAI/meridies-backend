/**
 * Practice settings.
 *
 *   GET   /settings/privacy   the practice's Data & privacy switches, and
 *                             whether the caller may change them
 *   PATCH /settings/privacy   change any of them (firm owner/admin, or a solo
 *                             counselor)
 *
 * What each switch enforces is in lib/practiceSettings.ts.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { forbidden, fromPostgrest } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { loadPracticeSettings, toPrivacySettings } from "../lib/practiceSettings.js";

const patchBody = z
  .object({
    aiSummaries: z.boolean(),
    autoParseDocuments: z.boolean(),
    studentsSeeSharedReports: z.boolean(),
  })
  .partial()
  .strict();

export default async function settingsRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/privacy", { preHandler: [...counselor, limit("settings:read", 120, 60)] }, async (request) => {
    const { workspace, settings } = await loadPracticeSettings(request);
    return { ...settings, canEdit: workspace.isAdmin };
  });

  app.patch("/privacy", { preHandler: [...counselor, limit("settings:write", 60, 60)] }, async (request) => {
    const b = patchBody.parse(request.body);
    const { workspace, row } = await loadPracticeSettings(request);
    if (!workspace.isAdmin) throw forbidden("Only a practice owner or admin can change these settings");

    const values: Record<string, unknown> = { updated_by: request.auth.userId };
    if (b.aiSummaries !== undefined) values.ai_summaries = b.aiSummaries;
    if (b.autoParseDocuments !== undefined) values.auto_parse_documents = b.autoParseDocuments;
    if (b.studentsSeeSharedReports !== undefined) values.students_see_shared_reports = b.studentsSeeSharedReports;

    const { data, error } = row
      ? await request.db.from("practice_settings").update(values).eq("id", String(row.id)).select("*").single()
      : await request.db
          .from("practice_settings")
          .insert({
            ...values,
            firm_id: workspace.firmId,
            counselor_id: workspace.firmId ? null : request.auth.userId,
          })
          .select("*")
          .single();
    if (error) throw fromPostgrest(error);
    return { ...toPrivacySettings(data as Record<string, unknown>), canEdit: true };
  });
}
