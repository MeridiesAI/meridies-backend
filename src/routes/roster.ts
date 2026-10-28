/**
 * Roster import.
 *
 * A CSV or a suite file becomes *invitations*, never profiles. An account only
 * exists once Supabase Auth creates it, so an import stages rows, the counselor
 * reviews the column mapping and the parsed values, and then sends. That review
 * step is the point: the demo's brief is explicit that a detected mapping must
 * always be overridable, because "which column was the weighted GPA" is the
 * question asked six months later when a number looks wrong.
 *
 * Parsing happens in the client. This route takes rows, not a file — it keeps a
 * CSV parser and its decoding quirks out of the API, and the counselor has
 * already seen the parsed values on screen by the time they get here.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { step2UsableFor } from "../lib/imports/availability.js";
import { assertAddressFreeFor } from "../lib/imports/heldAddresses.js";
import { requireRole } from "../lib/guards.js";
import { addressStatuses, createInvitation } from "../lib/invites.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { toRosterImport, toRosterImportRow } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

/**
 * The fields a column can be mapped onto. "ignore" is a real choice, not an
 * absence — a counselor deciding a column is noise is information.
 */
export const ROSTER_FIELDS = [
  "ignore", "fullName", "email", "phone", "gradeLevel", "gradYear", "highSchool",
  "gpaWeighted", "gpaUnweighted", "satTotal", "actComposite", "intendedMajor",
] as const;

const USE_IMPORT = "Rosters for your practice go through Import now. Upload this file there.";

const importRow = z
  .object({
    rowNumber: z.number().int().min(1).max(100_000),
    fullName: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    gradeLevel: z.string().trim().max(40).nullable().optional(),
    gradYear: z.number().int().min(1900).max(2200).nullable().optional(),
    highSchool: z.string().trim().max(200).nullable().optional(),
    gpaWeighted: z.number().min(0).max(20).nullable().optional(),
    gpaUnweighted: z.number().min(0).max(20).nullable().optional(),
    satTotal: z.number().int().min(400).max(1600).nullable().optional(),
    actComposite: z.number().int().min(1).max(36).nullable().optional(),
    intendedMajor: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const createBody = z
  .object({
    filename: z.string().trim().min(1).max(300),
    source: z.enum(["csv", "google", "microsoft", "manual"]).optional(),
    mapping: z.record(z.enum(ROSTER_FIELDS)),
    rows: z.array(importRow).min(1).max(500),
  })
  .strict();

export default async function rosterRoutes(app: FastifyInstance) {
  app.get(
    "/imports",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("roster:list", 120, 60)] },
    async (request) => {
      const { data, error } = await request.db
        .from("roster_imports")
        .select("*")
        .eq("counselor_id", request.auth.userId)
        // The Import page's imports (permission on record) are listed there, not here.
        .is("permission_confirmed_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => toRosterImport(r as Row));
    }
  );

  app.get(
    "/imports/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("roster:detail", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const record = await loadImport(request, id);

      const { data, error } = await request.db
        .from("roster_import_rows")
        .select("*")
        .eq("import_id", id)
        .order("row_number")
        .limit(500);
      if (error) throw fromPostgrest(error);

      return {
        ...toRosterImport(record),
        rows: (data ?? []).map((r) => toRosterImportRow(r as Row)),
      };
    }
  );

  /**
   * Stage an import. Nothing is sent here — a row with no usable email is
   * marked `skipped` with the reason rather than dropped, so the counselor can
   * see what the file did not contain.
   */
  app.post(
    "/imports",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("roster:import", 20, 3600)] },
    async (request, reply) => {
      const body = createBody.parse(request.body);

      const numbers = new Set(body.rows.map((r) => r.rowNumber));
      if (numbers.size !== body.rows.length) throw badRequest("Row numbers must be unique");

      // The id is made here and the insert returns nothing: roster_imports'
      // select policy asks can_view_import, which can't see a row inserted in
      // the same statement, so insert-and-return is refused.
      const importId = randomUUID();
      const { error: createError } = await request.db.from("roster_imports").insert({
        id: importId,
        counselor_id: request.auth.userId,
        filename: body.filename,
        source: body.source ?? "csv",
        mapping: body.mapping,
        status: "mapping",
        rows_total: body.rows.length,
      });
      if (createError) throw fromPostgrest(createError);

      // A file that lists one address twice, or a student who is already on
      // the roster, is a row the counselor should see skipped with the reason:
      // inviting it again would cancel the earlier invitation or re-invite
      // someone who joined.
      const statuses = await addressStatuses(
        request,
        body.rows.map((r) => r.email ?? "").filter(Boolean)
      );
      const firstRowFor = new Map<string, number>();
      const staged = body.rows.map((r) => {
        const email = r.email ?? null;
        const earlier = email ? firstRowFor.get(email) : undefined;
        if (email && earlier === undefined) firstRowFor.set(email, r.rowNumber);
        const status = email ? statuses.get(email) : undefined;
        const skipReason = !email
          ? "No email address in this row"
          : !r.fullName
            ? "No name in this row"
            : earlier !== undefined
              ? `Same email as row ${earlier}`
              : status === "joined" || status === "accepted"
                ? "Already on your roster"
                : null;
        return {
          import_id: importId,
          counselor_id: request.auth.userId,
          row_number: r.rowNumber,
          full_name: r.fullName ?? null,
          email: r.email ?? null,
          phone: r.phone ?? null,
          grade_level: r.gradeLevel ?? null,
          grad_year: r.gradYear ?? null,
          high_school: r.highSchool ?? null,
          gpa_weighted: r.gpaWeighted ?? null,
          gpa_unweighted: r.gpaUnweighted ?? null,
          sat_total: r.satTotal ?? null,
          act_composite: r.actComposite ?? null,
          intended_major: r.intendedMajor ?? null,
          status: skipReason ? "skipped" : "pending",
          skip_reason: skipReason,
        };
      });

      const { data: rows, error: rowsError } = await request.db
        .from("roster_import_rows")
        .insert(staged)
        .select("*");
      if (rowsError) throw fromPostgrest(rowsError);

      const skipped = staged.filter((r) => r.status === "skipped").length;
      const { data: updated, error: updateError } = await request.db
        .from("roster_imports")
        .update({ rows_skipped: skipped })
        .eq("id", importId)
        .select("*")
        .single();
      if (updateError) throw fromPostgrest(updateError);

      return reply.code(201).send({
        ...toRosterImport(updated as Row),
        rows: (rows ?? []).map((r) => toRosterImportRow(r as Row)),
      });
    }
  );

  /**
   * Send the staged rows as invitations. Runs against the same daily invite
   * quota as `/invites` — importing a file is not a way around it — and each
   * row records its own outcome, so a bad address fails one row rather than the
   * import.
   */
  app.post(
    "/imports/:id/send",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("roster:send", 10, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const record = await loadImport(request, id);
      // A practice with the Import page sends rosters through it, where
      // Meridies' per-counselor invitation review applies (lib/imports/
      // invitations.ts). This old path would be a way around it.
      if (await step2UsableFor(request)) throw new HttpError(409, USE_IMPORT, "use_import");

      const { data: pending, error: pendingError } = await request.db
        .from("roster_import_rows")
        .select("*")
        .eq("import_id", id)
        .eq("status", "pending")
        .order("row_number")
        .limit(500);
      if (pendingError) throw fromPostgrest(pendingError);

      const rows = (pending ?? []) as Row[];
      if (rows.length === 0) throw badRequest("Nothing in this import is waiting to be sent");

      await enforceQuota(
        request.auth.userId,
        "invites",
        "day",
        100,
        "You've sent a lot of invitations today. Try again tomorrow.",
        rows.length
      );

      const { error: markingError } = await request.db
        .from("roster_imports")
        .update({ status: "importing" })
        .eq("id", id);
      // Refuse before sending anything rather than emailing a roster whose
      // import row we could not move out of "mapping".
      if (markingError) throw fromPostgrest(markingError);

      let invited = 0;
      let failed = 0;
      let skippedNow = 0;

      // Checked again at send time: someone may have joined since staging.
      const sendStatuses = await addressStatuses(request, rows.map((r) => String(r.email)));

      for (const row of rows) {
        const email = String(row.email);
        const already = sendStatuses.get(email.toLowerCase());
        if (already === "joined" || already === "accepted") {
          await request.db
            .from("roster_import_rows")
            .update({ status: "skipped", skip_reason: "Already on your roster", error: null })
            .eq("id", row.id as string);
          skippedNow += 1;
          continue;
        }
        try {
          // The shared invitation path: it supersedes a pending invitation to
          // the same address (the newest link is the one that works), refuses
          // an address holding another student's held import data, and keeps
          // the row's name, grade and class year on the invitation so the
          // roster card shows who it is before they join.
          const gradYear = typeof row.grad_year === "number" && row.grad_year >= 2000 && row.grad_year <= 2100
            ? row.grad_year
            : null;
          const fullName = typeof row.full_name === "string" && row.full_name.trim() ? row.full_name.trim() : null;
          const gradeLevel = typeof row.grade_level === "string" && row.grade_level.trim() ? row.grade_level.trim() : null;
          const { row: invitation } = await createInvitation(request, {
            email,
            fullName,
            gradeLevel,
            gradYear,
            source: "roster",
          });

          await request.db
            .from("roster_import_rows")
            .update({ status: "invited", invitation_id: invitation.id, error: null })
            .eq("id", row.id as string);
          invited += 1;
        } catch (err) {
          // One bad row must not take the import down with it.
          const held = err instanceof HttpError && err.code === "address_holds_other_student";
          if (!held) request.log.error({ err, importId: id }, "roster row failed to invite");
          await request.db
            .from("roster_import_rows")
            .update({ status: "failed", error: held ? (err as HttpError).message : "Could not send an invitation to this address" })
            .eq("id", row.id as string);
          failed += 1;
        }
      }

      const { data: finished, error: finishError } = await request.db
        .from("roster_imports")
        .update({
          status: failed > 0 && invited === 0 ? "failed" : "complete",
          rows_imported: invited,
          rows_failed: failed,
          rows_skipped: Number(record.rows_skipped ?? 0) + skippedNow,
          completed_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();
      if (finishError) throw fromPostgrest(finishError);

      return toRosterImport(finished as Row);
    }
  );

  app.delete(
    "/imports/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("roster:delete", 30, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await loadImport(request, id);

      const { error } = await request.db
        .from("roster_imports")
        .delete()
        .eq("id", id)
        .eq("counselor_id", request.auth.userId);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

/**
 * The import, scoped to its owner in code as well as by RLS — so a counselor
 * asking for someone else's import gets "doesn't exist" rather than an empty
 * row list that implies it does.
 */
async function loadImport(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db
    .from("roster_imports")
    .select("*")
    .eq("id", id)
    .eq("counselor_id", request.auth.userId)
    // An Import-page import (permission on record) is never acted on here.
    .is("permission_confirmed_at", null)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That import doesn't exist");
  return data as Row;
}
