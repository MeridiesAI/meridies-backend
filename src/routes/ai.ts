/**
 * Anthropic-backed routes.
 *
 * Every one of these authenticates, authorizes the counselor-student
 * relationship, validates input with Zod, asks for structured output, and
 * treats what comes back as untrusted text.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEEP_MODEL,
  enforceNoProse,
  NO_PROSE_SYSTEM,
  runStructured,
} from "../lib/anthropic.js";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

const BASE_SYSTEM = [
  "You support independent college counselors at MeridiesAI.",
  "Be concrete, specific to this student, and honest about uncertainty.",
  "Never invent statistics, deadlines, or admissions outcomes. If you don't know, say so.",
  "The counselor reviews everything before a family sees it.",
].join("\n");

const studentBody = z.object({ studentId: z.string().uuid() }).strict();

/** Compact the student's record into a prompt-sized brief. */
async function studentBrief(
  request: import("fastify").FastifyRequest,
  studentId: string
): Promise<string> {
  const db = request.db;
  const [profile, academics, activities, awards, essays, colleges, intake] = await Promise.all([
    db.from("profiles").select("full_name, grad_year, high_school, hometown, headline, profile").eq("id", studentId).maybeSingle(),
    db.from("student_academics").select("*").eq("student_id", studentId).maybeSingle(),
    db.from("activities").select("name, position, organization, category, hours_per_week, description").eq("student_id", studentId).order("sort_order").limit(30),
    db.from("awards").select("name, level, year").eq("student_id", studentId).order("sort_order").limit(30),
    db.from("essays").select("title, prompt, school, status, word_count").eq("student_id", studentId).limit(30),
    db.from("student_colleges").select("name, round, fit, status").eq("student_id", studentId).order("sort_order").limit(40),
    db.from("intake_responses").select("answers").eq("student_id", studentId).maybeSingle(),
  ]);

  if (!profile.data) throw notFound("That student isn't on your roster");

  // Essay *bodies* are deliberately excluded — these routes advise, they don't
  // read drafts back to the model unless a route explicitly needs to.
  return JSON.stringify(
    {
      student: profile.data,
      academics: academics.data,
      activities: activities.data,
      awards: awards.data,
      essays: essays.data,
      colleges: colleges.data,
      intake: intake.data?.answers ?? {},
    },
    null,
    1
  ).slice(0, 60_000);
}

const bulletSchema = {
  type: "object",
  properties: {
    bullets: {
      type: "array",
      maxItems: 12,
      items: { type: "string", maxLength: 240 },
    },
  },
  required: ["bullets"],
} as const;

export default async function aiRoutes(app: FastifyInstance) {
  // AI is the expensive surface: a much tighter limiter than the rest of the API.
  const aiLimit = (name: string) =>
    limit(`ai:${name}`, 20, 60, "You're running AI tools very fast. Give it a minute.");

  // ---- Profile summary -----------------------------------------------------

  app.post(
    "/profile-summary",
    { preHandler: [app.authenticate, aiLimit("profile-summary")] },
    async (request) => {
      const { studentId } = studentBody.parse(request.body);
      await resolveStudentId(request, studentId, "view");
      const brief = await studentBrief(request, studentId);

      const result = await runStructured<{ aiSummary: string; aiSuggestions: string[] }>({
        request,
        module: "profile-summary",
        studentId,
        system: BASE_SYSTEM,
        prompt: `Summarize this student for their counselor, then list next actions.\n\n${brief}`,
        toolName: "profile_summary",
        schema: {
          type: "object",
          properties: {
            aiSummary: { type: "string", maxLength: 1500 },
            aiSuggestions: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
          },
          required: ["aiSummary", "aiSuggestions"],
        },
      });

      await request.db
        .from("profiles")
        .update({
          profile: {
            ...(request.profile.profile ?? {}),
            aiSummary: result.aiSummary,
            aiSuggestions: result.aiSuggestions,
          },
        })
        .eq("id", studentId);

      return result;
    }
  );

  // ---- Narrative coherence -------------------------------------------------

  app.post(
    "/narrative-coherence",
    { preHandler: [app.authenticate, aiLimit("narrative-coherence")] },
    async (request) => {
      const { studentId } = studentBody.parse(request.body);
      await resolveStudentId(request, studentId, "edit");
      const brief = await studentBrief(request, studentId);

      const result = await runStructured<{ flags: Record<string, unknown>[] }>({
        request,
        module: "narrative-coherence",
        studentId,
        model: DEEP_MODEL,
        system: `${BASE_SYSTEM}\n\nYou compare an application's parts for contradictions. Cite the two sources that disagree. Do not rewrite anything.`,
        prompt: `Find inconsistencies across this student's activities, essays and stated goals.\n\n${brief}`,
        toolName: "narrative_flags",
        maxTokens: 3000,
        schema: {
          type: "object",
          properties: {
            flags: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  severity: { type: "string", enum: ["high", "medium", "low"] },
                  title: { type: "string", maxLength: 200 },
                  detail: { type: "string", maxLength: 800 },
                  sourceA: { type: "string", maxLength: 200 },
                  sourceB: { type: "string", maxLength: 200 },
                  suggestion: { type: "string", maxLength: 400 },
                },
                required: ["severity", "title", "detail", "sourceA", "sourceB", "suggestion"],
              },
            },
          },
          required: ["flags"],
        },
      });

      const rows = result.flags.map((f) => ({
        student_id: studentId,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        source_a: f.sourceA,
        source_b: f.sourceB,
        suggestion: f.suggestion,
        status: "open",
      }));

      if (rows.length > 0) {
        const { error } = await request.db.from("narrative_flags").insert(rows);
        if (error) throw fromPostgrest(error);
      }
      return { flags: result.flags };
    }
  );

  // ---- Family report -------------------------------------------------------

  app.post(
    "/family-report",
    { preHandler: [app.authenticate, aiLimit("family-report")] },
    async (request) => {
      const { studentId } = studentBody.parse(request.body);
      await resolveStudentId(request, studentId, "edit");
      const brief = await studentBrief(request, studentId);

      const result = await runStructured<{
        title: string; summary: string; highlights: string[]; body: string;
      }>({
        request,
        module: "family-report",
        studentId,
        system: `${BASE_SYSTEM}\n\nWrite for a parent with no admissions jargon. Plain English. Warm, factual, never alarmist.`,
        prompt: `Draft a progress report a parent can read in two minutes.\n\n${brief}`,
        toolName: "family_report",
        maxTokens: 2500,
        schema: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 200 },
            summary: { type: "string", maxLength: 1200 },
            highlights: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
            body: { type: "string", maxLength: 6000 },
          },
          required: ["title", "summary", "highlights", "body"],
        },
      });

      const { data, error } = await request.db
        .from("family_reports")
        .insert({
          student_id: studentId,
          counselor_id: request.auth.userId,
          title: result.title,
          kind: "progress",
          summary: result.summary,
          highlights: result.highlights,
          body: result.body,
          // Draft, never sent: a counselor reads it first.
          status: "draft",
        })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return { report: data };
    }
  );

  // ---- School reframing ----------------------------------------------------

  app.post(
    "/school-reframing",
    { preHandler: [app.authenticate, aiLimit("school-reframing")] },
    async (request) => {
      const b = z
        .object({ studentId: z.string().uuid(), school: z.string().trim().min(1).max(200) })
        .strict()
        .parse(request.body);
      await resolveStudentId(request, b.studentId, "edit");
      const brief = await studentBrief(request, b.studentId);

      const result = await runStructured<{
        likes: { point: string }[]; reframeFrom: string; reframeTo: string; note: string;
      }>({
        request,
        module: "school-reframing",
        studentId: b.studentId,
        system: `${BASE_SYSTEM}\n\nExplain what a specific institution says it values, and how to present this student in that language without changing the facts.`,
        prompt: `School: ${b.school}\n\nStudent:\n${brief}`,
        toolName: "school_reframing",
        schema: {
          type: "object",
          properties: {
            likes: {
              type: "array", maxItems: 6,
              items: {
                type: "object",
                properties: { point: { type: "string", maxLength: 240 } },
                required: ["point"],
              },
            },
            reframeFrom: { type: "string", maxLength: 300 },
            reframeTo: { type: "string", maxLength: 300 },
            note: { type: "string", maxLength: 600 },
          },
          required: ["likes", "reframeFrom", "reframeTo", "note"],
        },
      });

      const { data, error } = await request.db
        .from("school_reframing")
        .insert({
          student_id: b.studentId,
          school: b.school,
          likes: result.likes,
          reframe_from: result.reframeFrom,
          reframe_to: result.reframeTo,
          note: result.note,
          created_by: request.auth.userId,
        })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return { insight: data };
    }
  );

  // ---- Essay advice — bullets only, never prose ----------------------------

  app.post(
    "/essay-advice",
    { preHandler: [app.authenticate, aiLimit("essay-advice")] },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          essayId: z.string().uuid(),
          focus: z.string().trim().max(300).optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "view");

      const { data: essay, error } = await request.db
        .from("essays")
        .select("title, prompt, school, body, word_count, word_limit")
        .eq("id", b.essayId)
        .eq("student_id", b.studentId)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!essay) throw notFound("That essay isn't on file");

      const result = await runStructured<{ bullets: string[] }>({
        request,
        module: "essay-advice",
        studentId: b.studentId,
        system: NO_PROSE_SYSTEM,
        prompt: [
          `Prompt: ${essay.prompt ?? "(none recorded)"}`,
          `School: ${essay.school ?? "(general)"}`,
          `Word count: ${essay.word_count} of ${essay.word_limit ?? "no stated limit"}`,
          b.focus ? `Counselor's focus: ${b.focus}` : "",
          "",
          "Draft:",
          String(essay.body ?? "").slice(0, 20_000),
          "",
          "Give the counselor bullets on what to work on. Do not write any of it for them.",
        ]
          .filter(Boolean)
          .join("\n"),
        toolName: "essay_advice",
        schema: bulletSchema as unknown as Record<string, unknown>,
        // Enforced in code, not just asked for in the prompt.
        validate: (value) => {
          const parsed = z.object({ bullets: z.array(z.string()) }).parse(value);
          return { bullets: enforceNoProse(parsed.bullets) };
        },
      });

      return result;
    }
  );

  // ---- Draft quality (feeds the accountability engine) ---------------------

  app.post(
    "/draft-quality",
    { preHandler: [app.authenticate, aiLimit("draft-quality")] },
    async (request) => {
      const b = z
        .object({ studentId: z.string().uuid(), essayId: z.string().uuid() })
        .strict()
        .parse(request.body);
      await resolveStudentId(request, b.studentId, "edit");

      const { data: essay } = await request.db
        .from("essays")
        .select("body, word_count")
        .eq("id", b.essayId)
        .eq("student_id", b.studentId)
        .maybeSingle();
      if (!essay) throw notFound("That essay isn't on file");

      const result = await runStructured<{
        verdict: "ok" | "low-effort" | "likely-ai" | "needs-review";
        aiLikelihood: number; qualityScore: number; findings: string[];
      }>({
        request,
        module: "draft-quality",
        studentId: b.studentId,
        system: [
          BASE_SYSTEM,
          "You assess whether a draft shows genuine student effort.",
          "Signals of machine generation are indicative, never proof — say so, and never accuse.",
          "This is a prompt for a counselor conversation, not a verdict on the student.",
        ].join("\n"),
        prompt: `Word count: ${essay.word_count}\n\nDraft:\n${String(essay.body ?? "").slice(0, 20_000)}`,
        toolName: "draft_quality",
        schema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["ok", "low-effort", "likely-ai", "needs-review"] },
            aiLikelihood: { type: "number", minimum: 0, maximum: 1 },
            qualityScore: { type: "number", minimum: 0, maximum: 1 },
            findings: { type: "array", maxItems: 8, items: { type: "string", maxLength: 240 } },
          },
          required: ["verdict", "aiLikelihood", "qualityScore", "findings"],
        },
      });

      await request.db.from("draft_quality_checks").insert({
        student_id: b.studentId,
        essay_id: b.essayId,
        word_count: essay.word_count,
        ai_likelihood: result.aiLikelihood,
        quality_score: result.qualityScore,
        verdict: result.verdict,
        findings: result.findings,
      });

      return result;
    }
  );

  // ---- College list --------------------------------------------------------

  app.post(
    "/college-list",
    { preHandler: [app.authenticate, aiLimit("college-list")] },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          strategy: z.string().trim().max(400).optional(),
          variants: z.number().int().min(1).max(3).optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "edit");
      const brief = await studentBrief(request, b.studentId);

      const result = await runStructured<{
        variants: {
          name: string; strategy: string; rationale: string;
          schools: { name: string; fit: "reach" | "target" | "likely"; round?: string; whyFit: string }[];
        }[];
      }>({
        request,
        module: "college-list",
        studentId: b.studentId,
        model: DEEP_MODEL,
        system: [
          BASE_SYSTEM,
          "Build balanced reach/target/likely lists. Every school needs a specific 'why this student, this school' — a generic reason is a wrong answer.",
          "Do not state acceptance rates or admissions statistics as fact; the app sources those separately.",
        ].join("\n"),
        prompt: `${b.strategy ? `Counselor's steer: ${b.strategy}\n\n` : ""}Build ${b.variants ?? 2} distinct list variants.\n\n${brief}`,
        toolName: "college_lists",
        maxTokens: 4000,
        schema: {
          type: "object",
          properties: {
            variants: {
              type: "array", maxItems: 3,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", maxLength: 120 },
                  strategy: { type: "string", maxLength: 200 },
                  rationale: { type: "string", maxLength: 800 },
                  schools: {
                    type: "array", maxItems: 20,
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string", maxLength: 200 },
                        fit: { type: "string", enum: ["reach", "target", "likely"] },
                        round: { type: "string", maxLength: 20 },
                        whyFit: { type: "string", maxLength: 400 },
                      },
                      required: ["name", "fit", "whyFit"],
                    },
                  },
                },
                required: ["name", "strategy", "rationale", "schools"],
              },
            },
          },
          required: ["variants"],
        },
      });

      const saved = [];
      for (const variant of result.variants) {
        const { data: row, error } = await request.db
          .from("college_list_variants")
          .insert({
            student_id: b.studentId,
            name: variant.name,
            strategy: variant.strategy,
            rationale: variant.rationale,
            generated_by: "ai",
            created_by: request.auth.userId,
          })
          .select("*")
          .single();
        if (error) throw fromPostgrest(error);

        const items = variant.schools.map((s, i) => ({
          variant_id: row.id,
          student_id: b.studentId,
          name: s.name,
          fit: s.fit,
          round: s.round ?? null,
          note: s.whyFit,
          sort_order: i,
        }));
        if (items.length > 0) await request.db.from("college_list_items").insert(items);

        saved.push({ ...row, items });
      }

      return { variants: saved };
    }
  );

  // ---- Opportunity concierge ----------------------------------------------

  app.post(
    "/concierge",
    { preHandler: [app.authenticate, aiLimit("concierge")] },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          targetAxisKey: z.string().trim().max(40).optional(),
          interests: z.array(z.string().trim().max(60)).max(15).optional(),
          directions: z.string().trim().max(1000).optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "edit");
      const brief = await studentBrief(request, b.studentId);

      const { data: axes } = await request.db
        .from("student_polygon_axes")
        .select("key, label, score, max_score")
        .eq("student_id", b.studentId);

      const { data: requestRow } = await request.db
        .from("opportunity_requests")
        .insert({
          student_id: b.studentId,
          counselor_id: request.auth.userId,
          target_axis_key: b.targetAxisKey ?? null,
          interests: b.interests ?? [],
          directions: b.directions ?? null,
          status: "running",
        })
        .select("id")
        .single();

      const result = await runStructured<{
        matches: {
          name: string; org?: string; url?: string; applyUrl?: string; summary: string;
          whyFit: string; eligibilityNotes?: string; schedulingNotes?: string;
          costNote?: string; deadline?: string;
        }[];
      }>({
        request,
        module: "concierge",
        studentId: b.studentId,
        model: DEEP_MODEL,
        system: [
          BASE_SYSTEM,
          "Recommend real, named programs the student can actually sign up for.",
          "Work from their STATED interests. Do not collapse them into one academic theme.",
          "Every recommendation needs: what it is, why it fits THIS student, eligibility, rough timing, and where to apply.",
          "If you are not confident a program currently exists and is open, leave it out. A short honest list beats a long invented one.",
        ].join("\n"),
        prompt: [
          b.targetAxisKey ? `Improve this axis of their profile: ${b.targetAxisKey}` : "",
          b.directions ? `Counselor's direction: ${b.directions}` : "",
          b.interests?.length ? `Interests to honour: ${b.interests.join(", ")}` : "",
          `Current profile shape: ${JSON.stringify(axes ?? [])}`,
          "",
          brief,
        ]
          .filter(Boolean)
          .join("\n"),
        toolName: "opportunity_matches",
        maxTokens: 4000,
        schema: {
          type: "object",
          properties: {
            matches: {
              type: "array", maxItems: 12,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", maxLength: 200 },
                  org: { type: "string", maxLength: 200 },
                  url: { type: "string", maxLength: 500 },
                  applyUrl: { type: "string", maxLength: 500 },
                  summary: { type: "string", maxLength: 500 },
                  whyFit: { type: "string", maxLength: 500 },
                  eligibilityNotes: { type: "string", maxLength: 400 },
                  schedulingNotes: { type: "string", maxLength: 300 },
                  costNote: { type: "string", maxLength: 200 },
                  deadline: { type: "string", maxLength: 30 },
                },
                required: ["name", "summary", "whyFit"],
              },
            },
          },
          required: ["matches"],
        },
      });

      const rows = result.matches.map((m) => ({
        student_id: b.studentId,
        request_id: requestRow?.id ?? null,
        target_axis_key: b.targetAxisKey ?? null,
        name: m.name,
        org: m.org ?? null,
        url: m.url ?? null,
        apply_url: m.applyUrl ?? null,
        summary: m.summary,
        why_fit: m.whyFit,
        eligibility_notes: m.eligibilityNotes ?? null,
        scheduling_notes: m.schedulingNotes ?? null,
        cost_note: m.costNote ?? null,
        deadline: parseLooseDate(m.deadline),
        // Nothing reaches the student until the counselor approves it.
        status: "counselor-review",
      }));

      if (rows.length > 0) {
        const { error } = await request.db.from("opportunity_matches").insert(rows);
        if (error) throw fromPostgrest(error);
      }
      if (requestRow) {
        await request.db
          .from("opportunity_requests")
          .update({ status: "complete" })
          .eq("id", requestRow.id);
      }

      return { matches: rows };
    }
  );

  // ---- Award appeal — draft only ------------------------------------------

  app.post(
    "/award-appeal",
    { preHandler: [app.authenticate, aiLimit("award-appeal")] },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          awardLetterId: z.string().uuid().optional(),
          schoolName: z.string().trim().min(1).max(300),
          circumstances: z.string().trim().max(4000).optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "edit");

      const { data: letters } = await request.db
        .from("award_letters")
        .select("school_name, cost_of_attendance_cents, grants_cents, scholarships_cents, net_price_cents")
        .eq("student_id", b.studentId);

      const result = await runStructured<{ draftBody: string; basis: string[] }>({
        request,
        module: "award-appeal",
        studentId: b.studentId,
        system: [
          BASE_SYSTEM,
          "Draft a financial aid appeal letter for the counselor to review and edit.",
          "Cite only figures given to you. Never invent a competing offer or a hardship.",
          "Respectful, specific, and short. This is a draft — say nothing that commits the family to a claim they haven't made.",
        ].join("\n"),
        prompt: [
          `Appealing to: ${b.schoolName}`,
          b.circumstances ? `Family circumstances: ${b.circumstances}` : "",
          `Offers on file: ${JSON.stringify(letters ?? [])}`,
        ]
          .filter(Boolean)
          .join("\n"),
        toolName: "award_appeal",
        maxTokens: 2000,
        schema: {
          type: "object",
          properties: {
            draftBody: { type: "string", maxLength: 8000 },
            basis: { type: "array", maxItems: 6, items: { type: "string", maxLength: 120 } },
          },
          required: ["draftBody", "basis"],
        },
      });

      const { data, error } = await request.db
        .from("award_appeals")
        .insert({
          student_id: b.studentId,
          award_letter_id: b.awardLetterId ?? null,
          school_name: b.schoolName,
          basis: result.basis,
          circumstances: b.circumstances ?? null,
          draft_body: result.draftBody,
          status: "counselor-review",
        })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return { appeal: data };
    }
  );
}

/** Model deadlines come back as "Nov 1" or "2026-11-01"; keep only real dates. */
function parseLooseDate(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}
