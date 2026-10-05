/**
 * A student's Financial aid page (demo v8-v10), under `/student-aid/:id`.
 *
 *   GET  /:id/overview                       FAFSA + CSS status and due date, family financials,
 *                                            the per-school checklist, completion
 *   PUT  /:id/checklist                      mark one cell (or drop the mark)
 *   GET  /:id/scholarships/prefs             Scholarship matching's answers
 *   PUT  /:id/scholarships/prefs
 *   GET  /:id/scholarships/scan              live matches + what timing held back
 *   PUT  /:id/scholarships/:scholarshipId/recommend   recommend to the student, or take it back
 *   POST /:id/scholarships/ask               AxIS reads a request and proposes new answers
 *
 * The forms' status, due dates and the family financials are written through
 * `PUT /aid/profile` (routes/aid.ts), which carries the v8 FAFSA rule in its
 * schema: status and due date only.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enforceNoProse, runStructured } from "../lib/anthropic.js";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  AUDIENCES,
  DEFAULT_PREFS,
  loadAidOverview,
  loadPrefs,
  scanScholarships,
  setChecklistCell,
  type ScholarshipPrefs,
} from "../lib/studentAid.js";

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });

const prefsBody = z
  .object({
    audience: z.array(z.enum(AUDIENCES)).max(AUDIENCES.length),
    otherConnection: z.string().trim().max(120).nullable(),
    homeLanguage: z.string().trim().max(60).nullable(),
    minAwardCents: z.number().int().min(0).max(10_000_000),
    essaysOk: z.boolean(),
    basis: z.enum(["any", "merit", "need"]),
    maxApplications: z.number().int().min(1).max(99),
  })
  .partial()
  .strict();

function prefsRow(p: ScholarshipPrefs) {
  return {
    audience: [...new Set(p.audience)],
    other_connection: p.otherConnection || null,
    home_language: p.homeLanguage || null,
    min_award_cents: p.minAwardCents,
    essays_ok: p.essaysOk,
    basis: p.basis,
    max_applications: p.maxApplications,
  };
}

/** What AxIS may propose: the same answers the form holds, nothing else. */
const proposalSchema = z
  .object({
    prefs: prefsBody.omit({ otherConnection: true, homeLanguage: true }).nullable().optional(),
    points: z.array(z.string()).max(4),
  })
  .passthrough();

export default async function studentAidRoutes(app: FastifyInstance) {
  app.get(
    "/:id/overview",
    { preHandler: [app.authenticate, limit("student-aid:overview", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      return loadAidOverview(request.db, student);
    }
  );

  app.put(
    "/:id/checklist",
    { preHandler: [app.authenticate, limit("student-aid:checklist", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          studentCollegeId: z.string().uuid(),
          key: z.enum(["css", "verification", "award"]),
          /** null drops the mark and returns the cell to what the file says. */
          done: z.boolean().nullable(),
          note: z.string().trim().max(1000).nullable().optional(),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");

      const { data: sc, error } = await request.db
        .from("student_colleges")
        .select("id")
        .eq("id", b.studentCollegeId)
        .eq("student_id", student)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!sc) throw notFound("That school isn't on this student's list");

      await setChecklistCell(request.db, student, b.studentCollegeId, b.key, b.done, b.note);
      return loadAidOverview(request.db, student);
    }
  );

  // ---- Scholarship matching ---------------------------------------------------

  app.get("/:id/scholarships/prefs", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    const student = await resolveStudentId(request, id, "view");
    return loadPrefs(request.db, student);
  });

  app.put(
    "/:id/scholarships/prefs",
    { preHandler: [app.authenticate, limit("student-aid:prefs", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = prefsBody.parse(request.body);
      const student = await resolveStudentId(request, id, "edit");

      const current = await loadPrefs(request.db, student);
      const next: ScholarshipPrefs = { ...current, ...patch };
      const { error } = await request.db
        .from("scholarship_match_prefs")
        .upsert(
          { ...prefsRow(next), student_id: student, updated_by: request.auth.userId },
          { onConflict: "student_id" }
        );
      if (error) throw fromPostgrest(error);
      return next;
    }
  );

  /** Re-run on every answer: the catalog is a few hundred rows at most. */
  app.get(
    "/:id/scholarships/scan",
    { preHandler: [app.authenticate, limit("student-aid:scan", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      return scanScholarships(request.db, student);
    }
  );

  /**
   * "Recommend to <student>". A recommendation is the student's match row in
   * `saved`, which is what their own scholarship list reads, so the award is on
   * their side the moment the counselor says so.
   */
  app.put(
    "/:id/scholarships/:scholarshipId/recommend",
    { preHandler: [app.authenticate, limit("student-aid:recommend", 120, 60)] },
    async (request) => {
      const { id, scholarshipId } = idParam
        .extend({ scholarshipId: z.string().uuid() })
        .parse(request.params);
      const { recommended } = z.object({ recommended: z.boolean() }).strict().parse(request.body);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const { data: award, error: awardError } = await db
        .from("scholarships")
        .select("id, name, sponsor, url, apply_url, amount_cents, deadline")
        .eq("id", scholarshipId)
        .maybeSingle();
      if (awardError) throw fromPostgrest(awardError);
      if (!award) throw notFound("That scholarship isn't in the catalog");

      const { data: existing, error: readError } = await db
        .from("scholarship_matches")
        .select("id, status")
        .eq("student_id", student)
        .eq("scholarship_id", scholarshipId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);

      if (recommended) {
        if (existing) {
          // Never downgrade a student who is already applying or has won it.
          if (existing.status === "suggested" || existing.status === "dismissed") {
            const { error } = await db
              .from("scholarship_matches")
              .update({ status: "saved" })
              .eq("id", existing.id as string);
            if (error) throw fromPostgrest(error);
          }
        } else {
          const { error } = await db.from("scholarship_matches").insert({
            student_id: student,
            scholarship_id: scholarshipId,
            name: award.name,
            sponsor: award.sponsor,
            url: award.url ?? award.apply_url,
            amount_cents: award.amount_cents,
            deadline: award.deadline,
            status: "saved",
          });
          if (error) throw fromPostgrest(error);
        }
      } else if (existing && existing.status === "saved") {
        const { error } = await db
          .from("scholarship_matches")
          .update({ status: "dismissed" })
          .eq("id", existing.id as string);
        if (error) throw fromPostgrest(error);
      } else if (existing && existing.status !== "dismissed" && existing.status !== "suggested") {
        throw badRequest("The student is already working on this one");
      }

      return { scholarshipId, recommended };
    }
  );

  /**
   * "Ask AxIS about these scholarships". The model reads the request and
   * proposes new answers for the same form, plus at most three short points
   * about the result. Nothing is saved: the page applies the proposal (with
   * an undo) through `PUT .../prefs`, so the counselor's form stays the single
   * place the answers live.
   */
  app.post(
    "/:id/scholarships/ask",
    { preHandler: [app.authenticate, limit("student-aid:ask", 20, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { question } = z
        .object({ question: z.string().trim().min(1).max(500) })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");

      const current = await scanScholarships(request.db, student);
      const summary = {
        today: current.today,
        answers: current.prefs,
        matches: current.matches.map((m) => ({
          name: m.name,
          amountCents: m.amountCents,
          deadline: m.deadline,
          basis: m.basis,
          essayRequired: m.essayRequired,
          recommended: m.recommended,
        })),
        heldBackByTiming: current.held.length,
      };

      const raw = await runStructured<unknown>({
        request,
        module: "scholarship-match",
        studentId: student,
        system: [
          "You are AxIS, the assistant inside Meridies, software for independent college counselors.",
          "The counselor is refining a scholarship search for one student. You change the search's answers; you never invent scholarships, amounts or deadlines.",
          "Answers you may set: minAwardCents (0 = any; 100000 = $1,000+; 500000 = $5,000+; 1000000 = $10,000+), essaysOk (false hides awards that ask for an essay), basis ('any' | 'merit' | 'need'), maxApplications (3, 8, 15 or 99), audience (family circumstances: " +
            AUDIENCES.join(", ") +
            ").",
          "Set prefs only to the fields the request changes; null when it changes none.",
          "points: at most three short bullet fragments for the counselor, each under 160 characters, naming only scholarships, figures and dates present in the data you were given.",
        ].join("\n"),
        prompt: [`Request: ${question}`, "", `Current search:\n${JSON.stringify(summary).slice(0, 12000)}`].join("\n"),
        toolName: "scholarship_search",
        maxTokens: 800,
        schema: {
          type: "object",
          properties: {
            prefs: {
              type: ["object", "null"],
              properties: {
                minAwardCents: { type: "integer", minimum: 0, maximum: 10000000 },
                essaysOk: { type: "boolean" },
                basis: { type: "string", enum: ["any", "merit", "need"] },
                maxApplications: { type: "integer", minimum: 1, maximum: 99 },
                audience: { type: "array", items: { type: "string", enum: [...AUDIENCES] } },
              },
            },
            points: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 3 },
          },
          required: ["points"],
        },
      });

      // Model output is untrusted: re-validate, drop what does not fit.
      const parsed = proposalSchema.safeParse(raw);
      const proposal = parsed.success ? parsed.data : { prefs: null, points: [] };
      const prefs: ScholarshipPrefs | null = proposal.prefs
        ? { ...current.prefs, ...proposal.prefs }
        : null;
      const points = enforceNoProse(proposal.points.map((p) => p.replace(/\s+/g, " ").trim()))
        .filter(Boolean)
        .slice(0, 3);

      return { prefs, points, previous: current.prefs ?? DEFAULT_PREFS };
    }
  );
}
