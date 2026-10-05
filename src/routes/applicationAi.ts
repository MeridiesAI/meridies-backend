/**
 * The AxIS pieces of a student's College list and Application sections,
 * registered under /application next to routes/application.ts:
 *
 *   POST /college-list/recommendations/axis   AxIS's schools for the board's
 *                                             Recommended column (Sonnet: a
 *                                             college list, AGENTS' exception)
 *   GET/POST /coherence, POST /coherence/ask, PATCH /coherence/flags/:id
 *                                             Narrative Coherence (Sonnet)
 *   GET/POST /activities-build, PATCH /activities-build/programs/:id
 *                                             Activities Build (Sonnet, the
 *                                             concierge's rules)
 *
 * Every one authenticates, authorizes the counselor-student relationship,
 * validates with Zod, asks for structured output through runStructured(), and
 * treats what comes back as untrusted text. Anything that reads a student's
 * prose answers in bullets addressed to the counselor and passes
 * enforceNoProse() after the model responds: the essay guardrail.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DEEP_MODEL,
  FAST_MODEL,
  enforceNoProse,
  isAdviceNotProse,
  NO_PROSE_SYSTEM,
  runStructured,
} from "../lib/anthropic.js";
import { badRequest, forbidden, fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  toCoherenceReport,
  toFlag,
  toProgram,
  toRecommendation,
} from "../lib/studentApplication.js";

type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const studentQuery = z.object({ studentId: uuid.optional() });
const idParam = z.object({ id: uuid });

const BASE_SYSTEM = [
  "You support independent college counselors at Meridies.",
  "Be concrete, specific to this student, and honest about uncertainty.",
  "Never invent statistics, deadlines, or admissions outcomes. If you don't know, say so.",
  "The counselor reviews everything before a family sees it.",
].join("\n");

const PROGRAM_TYPES = ["Job", "Internship", "Summer program", "Lab", "Research", "Volunteer", "Competition", "Course", "Other"] as const;
const DURATIONS = ["Under 1 day", "1 day to 2 weeks", "2+ weeks", "Ongoing"] as const;

const isStudent = (request: FastifyRequest) => request.profile.role === "student";

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || "the student";
}

const clip = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

/** The student's majors: the student page's personal details, else the intake blob. */
async function intendedMajors(request: FastifyRequest, studentId: string, blob: Row): Promise<string[]> {
  const { data, error } = await request.db
    .from("student_personal_details")
    .select("intended_majors")
    .eq("student_id", studentId)
    .maybeSingle();
  const fromTable = !error && Array.isArray(data?.intended_majors) ? (data!.intended_majors as unknown[]).map(String) : [];
  const fromBlob = Array.isArray(blob.intendedMajors) ? (blob.intendedMajors as unknown[]).map(String) : [];
  return [...new Set([...fromTable, ...fromBlob].map((m) => m.trim()).filter((m) => m && m.toLowerCase() !== "undecided"))];
}

type Brief = { name: string; first: string; hometown: string | null; majors: string[]; json: string };

/** A prompt-sized brief of the record. Essay bodies are deliberately left out. */
async function studentBrief(request: FastifyRequest, studentId: string): Promise<Brief> {
  const db = request.db;
  const [profile, academics, activities, awards, colleges] = await Promise.all([
    db.from("profiles").select("full_name, grad_year, high_school, hometown, headline, profile").eq("id", studentId).maybeSingle(),
    db.from("student_academics").select("gpa_unweighted, gpa_weighted, sat_superscore, act_composite, rigor_count, strength_areas, strength_subjects").eq("student_id", studentId).maybeSingle(),
    db.from("activities").select("organization, name, position, category, hours_per_week, description").eq("student_id", studentId).order("sort_order").limit(30),
    db.from("awards").select("name, level, recognition_levels").eq("student_id", studentId).order("sort_order").limit(30),
    db.from("student_colleges").select("name, round, fit, status").eq("student_id", studentId).order("sort_order").limit(60),
  ]);
  if (!profile.data) throw notFound("That student isn't on your roster");
  const blob = ((profile.data.profile ?? {}) as Row) ?? {};
  const majors = await intendedMajors(request, studentId, blob);
  const name = String(profile.data.full_name ?? "Student");
  const json = JSON.stringify(
    {
      student: {
        name,
        gradYear: profile.data.grad_year,
        highSchool: profile.data.high_school,
        hometown: profile.data.hometown,
        headline: profile.data.headline,
        intendedMajors: majors,
      },
      academics: academics.data,
      activities: activities.data,
      awards: awards.data,
      collegeList: colleges.data,
    },
    null,
    1
  ).slice(0, 40_000);
  return { name, first: firstName(name), hometown: (profile.data.hometown as string | null) ?? null, majors, json };
}

// ---- Coherence: what is on file -----------------------------------------------

type CoherenceDoc = { id: string; title: string; words: number; excluded: boolean };
type CoherenceDocs = {
  statement: CoherenceDoc | null;
  groups: { key: string; heading: string; docs: CoherenceDoc[] }[];
  activities: number;
  awards: number;
};

async function coherenceDocs(request: FastifyRequest, studentId: string): Promise<{ docs: CoherenceDocs; essays: Row[] }> {
  const [essays, list, acts, honors] = await Promise.all([
    request.db
      .from("essays")
      .select("id, title, prompt, school, body, word_count, essay_kind, student_college_id, text_status, updated_at, document:documents(available_to_llm)")
      .eq("student_id", studentId)
      .order("sort_order")
      .limit(300),
    request.db.from("student_colleges").select("id, name").eq("student_id", studentId).order("sort_order").limit(200),
    request.db.from("activities").select("id", { count: "exact", head: true }).eq("student_id", studentId),
    request.db.from("awards").select("id", { count: "exact", head: true }).eq("student_id", studentId),
  ]);
  if (essays.error) throw fromPostgrest(essays.error);
  if (list.error) throw fromPostgrest(list.error);
  const rows = (essays.data ?? []) as Row[];
  const excluded = (e: Row) => (e.document as Row | null)?.available_to_llm === false;
  const words = (e: Row) => (e.text_status === "unreadable" ? 0 : Number(e.word_count ?? 0));
  const doc = (e: Row): CoherenceDoc => ({ id: String(e.id), title: String(e.title ?? ""), words: words(e), excluded: excluded(e) });

  const statements = rows
    .filter((e) => e.essay_kind === "personal-statement" && words(e) > 0)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const groups = ((list.data ?? []) as Row[])
    .map((l) => ({
      key: String(l.id),
      heading: String(l.name),
      docs: rows.filter((e) => e.student_college_id === l.id && e.essay_kind !== "personal-statement").map(doc),
    }))
    .filter((g) => g.docs.length > 0);
  return {
    docs: {
      statement: statements[0] ? doc(statements[0]) : null,
      groups,
      activities: acts.count ?? 0,
      awards: honors.count ?? 0,
    },
    essays: rows,
  };
}

const coherenceBody = z
  .object({
    studentId: uuid,
    statement: z.boolean(),
    activities: z.boolean(),
    awards: z.boolean(),
    supplementEssayIds: z.array(uuid).max(60),
  })
  .strict();

const REWRITE = /\b(rewrite|re-write|write|draft|reword|rephrase|paragraph|fix the essay|polish|edit (it|this|the essay))\b/i;

export default async function applicationAiRoutes(app: FastifyInstance) {
  const aiLimit = (name: string) =>
    limit(`ai:${name}`, 20, 60, "You're running AI tools very fast. Give it a minute.");

  // ==== AxIS recommended schools ===============================================

  app.post(
    "/college-list/recommendations/axis",
    { preHandler: [app.authenticate, aiLimit("college-recommendations")] },
    async (request) => {
      const b = z
        .object({
          studentId: uuid,
          count: z.number().int().min(1).max(8).optional(),
          steer: z.string().trim().max(400).optional(),
        })
        .strict()
        .parse(request.body);
      if (isStudent(request)) throw forbidden("Your counselor runs AxIS");
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const brief = await studentBrief(request, studentId);

      const [catalog, listed, recs] = await Promise.all([
        request.db.from("colleges").select("id, name, slug, aka, city, state").order("name").limit(500),
        request.db.from("student_colleges").select("name, college_id").eq("student_id", studentId).limit(200),
        request.db.from("student_college_recommendations").select("name, college_id, status").eq("student_id", studentId).limit(200),
      ]);
      if (catalog.error) throw fromPostgrest(catalog.error);
      const colleges = (catalog.data ?? []) as Row[];
      const taken = new Set(
        [...((listed.data ?? []) as Row[]), ...((recs.data ?? []) as Row[])].map((r) => String(r.name).trim().toLowerCase())
      );
      const takenIds = new Set(
        [...((listed.data ?? []) as Row[]), ...((recs.data ?? []) as Row[])].map((r) => r.college_id).filter(Boolean) as string[]
      );

      const result = await runStructured<{ schools: { name: string; fit: "reach" | "target" | "likely"; why: string }[] }>({
        request,
        module: "college-list",
        studentId,
        model: DEEP_MODEL,
        system: [
          BASE_SYSTEM,
          "Suggest schools to add to this student's college list. Balance reach, target and safety ('likely').",
          "Every school needs one specific 'why this student, this school' line: a generic reason is a wrong answer.",
          "Do not state acceptance rates or admissions statistics; the app sources those separately.",
          "Prefer schools in the catalog given, spelled exactly as listed. Never repeat a school already on the list.",
        ].join("\n"),
        prompt: [
          b.steer ? `Counselor's steer: ${b.steer}` : "",
          `Suggest ${b.count ?? 4} schools.`,
          `Already on the list or recommended: ${[...taken].join("; ") || "none"}`,
          `Catalog: ${colleges.map((c) => c.name).join("; ")}`,
          "",
          brief.json,
        ]
          .filter(Boolean)
          .join("\n"),
        toolName: "recommended_colleges",
        maxTokens: 2000,
        schema: {
          type: "object",
          properties: {
            schools: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", maxLength: 200 },
                  fit: { type: "string", enum: ["reach", "target", "likely"] },
                  why: { type: "string", maxLength: 300 },
                },
                required: ["name", "fit", "why"],
              },
            },
          },
          required: ["schools"],
        },
      });

      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const match = (name: string): Row | undefined => {
        const n = norm(name);
        return colleges.find(
          (c) =>
            norm(String(c.name)) === n ||
            norm(String(c.slug)) === n ||
            (Array.isArray(c.aka) && (c.aka as unknown[]).some((a) => norm(String(a)) === n))
        );
      };

      const rows: Row[] = [];
      for (const s of result.schools ?? []) {
        const name = clip(s.name, 300);
        if (!name || !["reach", "target", "likely"].includes(s.fit)) continue;
        const c = match(name);
        const finalName = c ? String(c.name) : name;
        if (taken.has(finalName.toLowerCase()) || taken.has(name.toLowerCase())) continue;
        if (c && takenIds.has(String(c.id))) continue;
        taken.add(finalName.toLowerCase());
        rows.push({
          student_id: studentId,
          college_id: c ? c.id : null,
          name: finalName,
          fit: s.fit,
          why: clip(s.why, 600) || null,
          suggested_by: "axis",
          recommended_by: request.auth.userId,
        });
      }
      if (rows.length === 0) return { recommendations: [] };
      const { data, error } = await request.db.from("student_college_recommendations").insert(rows).select("*");
      if (error) throw fromPostgrest(error);
      return { recommendations: (data ?? []).map((r) => toRecommendation(r as Row)) };
    }
  );

  // ==== Narrative Coherence ======================================================

  app.get(
    "/coherence",
    { preHandler: [app.authenticate, limit("application:coherence", 120, 60)] },
    async (request) => {
      const q = studentQuery.parse(request.query);
      if (isStudent(request)) throw forbidden("Coherence is your counselor's tool");
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const { docs } = await coherenceDocs(request, studentId);

      const { data: report } = await request.db
        .from("coherence_reports")
        .select("*")
        .eq("student_id", studentId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      let flags: Row[] = [];
      if (report) {
        const { data } = await request.db
          .from("narrative_flags")
          .select("*")
          .eq("report_id", report.id)
          .order("created_at");
        flags = (data ?? []) as Row[];
      }
      const { data: programs } = await request.db
        .from("opportunity_matches")
        .select("*")
        .eq("student_id", studentId)
        .neq("status", "dismissed")
        .order("created_at", { ascending: false })
        .limit(3);

      return {
        docs,
        report: report ? toCoherenceReport(report as Row, flags) : null,
        programs: (programs ?? []).map((r) => toProgram(r as Row)),
      };
    }
  );

  app.post(
    "/coherence",
    { preHandler: [app.authenticate, aiLimit("narrative-coherence")] },
    async (request, reply) => {
      const b = coherenceBody.parse(request.body);
      if (isStudent(request)) throw forbidden("Coherence is your counselor's tool");
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const { docs, essays } = await coherenceDocs(request, studentId);

      // Read only what is ticked AND on file AND not excluded from AI.
      const usable = (id: string) => {
        const e = essays.find((x) => x.id === id);
        return e && (e.document as Row | null)?.available_to_llm !== false && Number(e.word_count ?? 0) > 0 && e.text_status !== "unreadable" ? e : null;
      };
      const statement = b.statement && docs.statement && !docs.statement.excluded ? usable(docs.statement.id) : null;
      const supplements = b.supplementEssayIds
        .map(usable)
        .filter((e): e is Row => e !== null && e.essay_kind !== "personal-statement");
      const readActivities = b.activities && docs.activities > 0;
      const readAwards = b.awards && docs.awards > 0;

      const read: string[] = [];
      if (statement) read.push("Personal statement");
      const schools = [...new Set(supplements.map((s) => String(s.school || "Other")))];
      if (schools.length === 1) read.push(`${schools[0]} supplement${supplements.length === 1 ? "" : "s"}`);
      else if (schools.length > 1) read.push(`Supplements for ${schools.length} schools`);
      if (readActivities) read.push("Activities list");
      if (readAwards) read.push("Awards");
      if (read.length === 0) throw badRequest("No documents are ticked. Pick at least one under Documents.");

      const [profile, acts, honors] = await Promise.all([
        request.db.from("profiles").select("full_name").eq("id", studentId).maybeSingle(),
        readActivities
          ? request.db.from("activities").select("organization, position, category, grade_levels, hours_per_week, weeks_per_year, description, uc_description").eq("student_id", studentId).order("sort_order").limit(30)
          : Promise.resolve({ data: [] as Row[] }),
        readAwards
          ? request.db.from("awards").select("name, grade_levels, recognition_levels, uc_criteria, uc_earned").eq("student_id", studentId).order("sort_order").limit(30)
          : Promise.resolve({ data: [] as Row[] }),
      ]);
      const first = firstName(String(profile.data?.full_name ?? ""));

      const material = JSON.stringify(
        {
          personalStatement: statement ? clip(statement.body, 12_000) : undefined,
          supplements: supplements.map((s) => ({
            school: s.school,
            title: s.title,
            prompt: clip(s.prompt, 600),
            text: clip(s.body, 6_000),
          })),
          activities: readActivities ? acts.data : undefined,
          awards: readAwards ? honors.data : undefined,
        },
        null,
        1
      ).slice(0, 80_000);

      type Out = {
        storyline: { label: string; text: string }[];
        flags: { severity: "high" | "medium" | "low"; what: string; where: string; fix: string }[];
        next: string[];
      };
      const result = await runStructured<Out>({
        request,
        module: "narrative-coherence",
        studentId,
        model: DEEP_MODEL,
        system: [
          NO_PROSE_SYSTEM,
          "",
          "You read the parts of one college application side by side, for the student's counselor.",
          "Storyline: three short bullets labelled Origin, Through-line, Landing: where the story starts, what carries it, where it should end.",
          "Flags: contradictions and gaps between the documents (dates, roles, hours, claims that disagree), most serious first. Name both places each one sits.",
          "Fix: what the student should settle or decide, never the words to write.",
          "Next: up to three bullets on what the counselor does next.",
          `Address the counselor; the student is ${first}.`,
        ].join("\n"),
        prompt: `Read only these documents:\n${material}`,
        toolName: "coherence_report",
        maxTokens: 3000,
        schema: {
          type: "object",
          properties: {
            storyline: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", enum: ["Origin", "Through-line", "Landing"] },
                  text: { type: "string", maxLength: 240 },
                },
                required: ["label", "text"],
              },
            },
            flags: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  severity: { type: "string", enum: ["high", "medium", "low"] },
                  what: { type: "string", maxLength: 240 },
                  where: { type: "string", maxLength: 200 },
                  fix: { type: "string", maxLength: 240 },
                },
                required: ["severity", "what", "where", "fix"],
              },
            },
            next: { type: "array", maxItems: 3, items: { type: "string", maxLength: 240 } },
          },
          required: ["storyline", "flags", "next"],
        },
      });

      // The guardrail, in code: anything that reads like drafted prose is dropped.
      const storyline = (result.storyline ?? [])
        .filter((s) => ["Origin", "Through-line", "Landing"].includes(s.label) && isAdviceNotProse(s.text))
        .map((s) => `${s.label}: ${s.text.trim()}`);
      const flags = (result.flags ?? []).filter(
        (f) => isAdviceNotProse(f.what) && isAdviceNotProse(f.fix) && clip(f.where, 200).length > 0
      );
      const next = enforceNoProse(result.next ?? []).slice(0, 2);
      next.push(`Bring the report to ${first}'s next meeting and assign each fix as a task with a word budget.`);

      const { data: report, error } = await request.db
        .from("coherence_reports")
        .insert({
          student_id: studentId,
          criteria: {
            statement: Boolean(statement),
            activities: readActivities,
            awards: readAwards,
            supplementEssayIds: supplements.map((s) => s.id),
          },
          read_labels: read,
          storyline,
          next_steps: next,
          created_by: request.auth.userId,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);

      let flagRows: Row[] = [];
      if (flags.length > 0) {
        const ins = await request.db
          .from("narrative_flags")
          .insert(
            flags.map((f) => ({
              student_id: studentId,
              report_id: report.id,
              severity: f.severity,
              title: f.what.trim(),
              location: clip(f.where, 400),
              suggestion: f.fix.trim(),
              status: "open",
            }))
          )
          .select("*");
        if (ins.error) throw fromPostgrest(ins.error);
        flagRows = (ins.data ?? []) as Row[];
      }
      return reply.code(201).send(toCoherenceReport(report as Row, flagRows));
    }
  );

  /** The popup's chat: questions about the report, answered in bullets. */
  app.post(
    "/coherence/ask",
    { preHandler: [app.authenticate, aiLimit("coherence-ask")] },
    async (request) => {
      const b = z
        .object({ studentId: uuid, reportId: uuid, question: z.string().trim().min(1).max(500) })
        .strict()
        .parse(request.body);
      if (isStudent(request)) throw forbidden("Coherence is your counselor's tool");
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const { data: report } = await request.db
        .from("coherence_reports")
        .select("*")
        .eq("id", b.reportId)
        .eq("student_id", studentId)
        .maybeSingle();
      if (!report) throw notFound("That report isn't on file");
      const { data: profile } = await request.db.from("profiles").select("full_name").eq("id", studentId).maybeSingle();
      const first = firstName(String(profile?.full_name ?? ""));

      // A request for wording gets the questions to ask instead, without a model call.
      if (REWRITE.test(b.question)) {
        return {
          bullets: [
            "I won't write wording for the essays; the words have to be the student's.",
            `Ask ${first}: which moment in the statement is the true start of this interest?`,
            `Ask ${first}: what does the supplement add that the statement doesn't already say?`,
          ],
        };
      }

      const [{ data: flags }, { data: programs }] = await Promise.all([
        request.db.from("narrative_flags").select("*").eq("report_id", report.id),
        request.db.from("opportunity_matches").select("name, org, program_type, location, deadline").eq("student_id", studentId).neq("status", "dismissed").limit(5),
      ]);
      const context = JSON.stringify({
        read: report.read_labels,
        storyline: report.storyline,
        flags: ((flags ?? []) as Row[]).map((f) => toFlag(f)),
        next: report.next_steps,
        programs,
      }).slice(0, 20_000);

      const result = await runStructured<{ bullets: string[] }>({
        request,
        module: "narrative-coherence",
        studentId,
        model: FAST_MODEL,
        system: [
          NO_PROSE_SYSTEM,
          "",
          "Answer the counselor's question about this Narrative Coherence report only, in at most four bullets.",
          "If the report doesn't say, answer that it doesn't.",
        ].join("\n"),
        prompt: `Report:\n${context}\n\nQuestion: ${b.question}`,
        toolName: "coherence_answer",
        maxTokens: 800,
        schema: {
          type: "object",
          properties: { bullets: { type: "array", maxItems: 4, items: { type: "string", maxLength: 240 } } },
          required: ["bullets"],
        },
      });
      const bullets = enforceNoProse(result.bullets ?? []);
      return {
        bullets:
          bullets.length > 0 ? bullets : ["Ask about the storyline, a flag, or activities to add."],
      };
    }
  );

  /** Mark a flag resolved / dismissed, or record the task it was assigned as. */
  app.patch(
    "/coherence/flags/:id",
    { preHandler: [app.authenticate, limit("application:flag-update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          status: z.enum(["open", "resolved", "dismissed"]).optional(),
          assignedTaskId: uuid.nullable().optional(),
        })
        .strict()
        .parse(request.body);
      if (isStudent(request)) throw forbidden();
      const { data: flag } = await request.db.from("narrative_flags").select("*").eq("id", id).maybeSingle();
      if (!flag) throw notFound();
      await resolveStudentId(request, String(flag.student_id), "edit");

      const update: Row = {};
      if (b.status !== undefined) {
        update.status = b.status;
        update.resolved_by = b.status === "open" ? null : request.auth.userId;
        update.resolved_at = b.status === "open" ? null : new Date().toISOString();
      }
      if (b.assignedTaskId !== undefined) {
        if (b.assignedTaskId) {
          const { data: task } = await request.db.from("deliverables").select("student_id").eq("id", b.assignedTaskId).maybeSingle();
          if (!task || task.student_id !== flag.student_id) throw badRequest("That task belongs to a different student");
        }
        update.assigned_task_id = b.assignedTaskId;
      }
      const { data, error } = await request.db.from("narrative_flags").update(update).eq("id", id).select("*").single();
      if (error) throw fromPostgrest(error);
      return toFlag(data as Row);
    }
  );

  // ==== Activities Build ============================================================

  app.get(
    "/activities-build",
    { preHandler: [app.authenticate, limit("application:activities-build", 120, 60)] },
    async (request) => {
      const q = studentQuery.parse(request.query);
      if (isStudent(request)) throw forbidden("Activities Build is your counselor's tool");
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const { data: profile } = await request.db.from("profiles").select("hometown, profile").eq("id", studentId).maybeSingle();
      if (!profile) throw notFound("That student isn't on your roster");
      const majors = await intendedMajors(request, studentId, (profile.profile ?? {}) as Row);
      const { data: acts } = await request.db.from("activities").select("category").eq("student_id", studentId).limit(30);
      const subjects = [...new Set([...majors, ...((acts ?? []) as Row[]).map((a) => String(a.category ?? "").trim()).filter(Boolean)])];

      const { data: last } = await request.db
        .from("opportunity_requests")
        .select("id, constraints, created_at")
        .eq("student_id", studentId)
        .contains("constraints", { tool: "activities-build" })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      let programs: Row[] = [];
      if (last) {
        const { data } = await request.db
          .from("opportunity_matches")
          .select("*")
          .eq("request_id", last.id)
          .neq("status", "dismissed")
          .order("created_at");
        programs = (data ?? []) as Row[];
      }
      return {
        defaults: {
          subjects: majors.length > 0 ? majors : subjects.slice(0, 1),
          subjectOptions: subjects,
          near: (profile.hometown as string | null) ?? null,
        },
        latest: last
          ? {
              criteria: last.constraints as Row,
              lead: String((last.constraints as Row).lead ?? ""),
              programs: programs.map(toProgram),
              createdAt: String(last.created_at),
            }
          : null,
      };
    }
  );

  app.post(
    "/activities-build",
    { preHandler: [app.authenticate, aiLimit("activities-build")] },
    async (request, reply) => {
      const b = z
        .object({
          studentId: uuid,
          subjects: z.array(z.string().trim().min(1).max(80)).max(12),
          types: z.array(z.enum(PROGRAM_TYPES)).max(9),
          format: z.enum(["Either", "In person", "Online"]),
          near: z.string().trim().max(120).nullable().optional(),
          miles: z.number().int().min(10).max(600),
          durations: z.array(z.enum(DURATIONS)).max(4),
          extra: z.string().trim().max(500).optional(),
        })
        .strict()
        .parse(request.body);
      if (isStudent(request)) throw forbidden("Activities Build is your counselor's tool");
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const brief = await studentBrief(request, studentId);
      const near = b.near?.trim() || brief.hometown;
      const onlineOnly = b.format === "Online" || !near;

      const criteria = {
        tool: "activities-build",
        subjects: b.subjects,
        types: b.types,
        format: b.format,
        near: near ?? null,
        miles: b.miles,
        durations: b.durations,
        extra: b.extra ?? null,
      };

      const { data: requestRow, error: reqError } = await request.db
        .from("opportunity_requests")
        .insert({
          student_id: studentId,
          counselor_id: request.auth.userId,
          interests: b.subjects.slice(0, 12),
          directions: b.extra ?? null,
          constraints: criteria,
          status: "running",
        })
        .select("id")
        .single();
      if (reqError) throw fromPostgrest(reqError);

      // Curated programs first, when a curator has added any. Distance isn't on
      // the catalog yet, so in-person catalog rows are only kept when the
      // counselor didn't ask for online alone.
      const catalogRows: Row[] = [];
      if (b.subjects.length > 0) {
        let q = request.db
          .from("opportunities")
          .select("*")
          .eq("is_active", true)
          .overlaps("subject_tags", b.subjects)
          .limit(10);
        if (b.format === "Online") q = q.eq("format", "virtual");
        else if (b.format === "In person") q = q.in("format", ["in-person", "hybrid"]);
        const { data } = await q;
        catalogRows.push(...((data ?? []) as Row[]));
      }

      const result = await runStructured<{
        programs: {
          name: string; host: string; url?: string; type: (typeof PROGRAM_TYPES)[number];
          duration: (typeof DURATIONS)[number]; location: string; online: boolean;
          topics: string[]; deadline?: string; eligibility?: string; summary: string; whyFit: string;
        }[];
      }>({
        request,
        module: "concierge",
        studentId,
        model: DEEP_MODEL,
        system: [
          BASE_SYSTEM,
          "Recommend real, named programs, jobs, labs and volunteer roles the student can actually sign up for.",
          "If you are not confident a program currently exists and is open to high school students, leave it out. A short honest list beats a long invented one.",
          "Give the host's official https address only when you are sure of it; otherwise leave url out.",
          "Deadlines: say what the host publishes (\"Early spring\", \"Rolling\"), never a guessed date.",
          onlineOnly
            ? "Only online programs."
            : `In person within about ${b.miles} miles of ${near}, plus online ones when the format allows.`,
        ].join("\n"),
        prompt: [
          `Subjects: ${b.subjects.join(", ") || "any"}`,
          b.types.length ? `Types: ${b.types.join(", ")}` : "",
          b.durations.length ? `Duration: ${b.durations.join(", ")}` : "",
          `Format: ${b.format}`,
          b.extra ? `Counselor's note: ${b.extra}` : "",
          catalogRows.length ? `Already found in the Meridies catalog (do not repeat): ${catalogRows.map((c) => c.name).join("; ")}` : "",
          "",
          brief.json,
        ]
          .filter(Boolean)
          .join("\n"),
        toolName: "program_recommendations",
        maxTokens: 4000,
        schema: {
          type: "object",
          properties: {
            programs: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", maxLength: 200 },
                  host: { type: "string", maxLength: 200 },
                  url: { type: "string", maxLength: 500 },
                  type: { type: "string", enum: [...PROGRAM_TYPES] },
                  duration: { type: "string", enum: [...DURATIONS] },
                  location: { type: "string", maxLength: 120 },
                  online: { type: "boolean" },
                  topics: { type: "array", maxItems: 6, items: { type: "string", maxLength: 40 } },
                  deadline: { type: "string", maxLength: 60 },
                  eligibility: { type: "string", maxLength: 300 },
                  summary: { type: "string", maxLength: 400 },
                  whyFit: { type: "string", maxLength: 300 },
                },
                required: ["name", "host", "type", "duration", "location", "online", "topics", "summary", "whyFit"],
              },
            },
          },
          required: ["programs"],
        },
      }).catch(async (err: unknown) => {
        await request.db.from("opportunity_requests").update({ status: "failed" }).eq("id", requestRow.id);
        throw err;
      });

      const https = (u: unknown) => {
        const s = typeof u === "string" ? u.trim() : "";
        try {
          return s.startsWith("https://") && new URL(s).protocol === "https:" && s.length <= 500 ? s : null;
        } catch {
          return null;
        }
      };
      const iso = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null);

      const rows: Row[] = [
        ...catalogRows.map((c) => ({
          student_id: studentId,
          opportunity_id: c.id,
          request_id: requestRow.id,
          name: clip(c.name, 200),
          org: c.org ?? null,
          url: https(c.url),
          apply_url: https(c.apply_url),
          summary: clip(c.description, 500) || null,
          why_fit: null,
          deadline: (c.deadline as string | null) ?? null,
          location: c.location ?? null,
          online: c.format === "virtual",
          topics: Array.isArray(c.subject_tags) ? (c.subject_tags as string[]).slice(0, 6) : [],
          source: "catalog",
          status: "counselor-review",
        })),
        ...(result.programs ?? [])
          .filter((p) => clip(p.name, 200) && (PROGRAM_TYPES as readonly string[]).includes(p.type) && (DURATIONS as readonly string[]).includes(p.duration))
          .filter((p) => !onlineOnly || p.online)
          .map((p) => ({
            student_id: studentId,
            request_id: requestRow.id,
            name: clip(p.name, 200),
            org: clip(p.host, 200) || null,
            url: https(p.url),
            summary: clip(p.summary, 500),
            why_fit: clip(p.whyFit, 500),
            eligibility_notes: clip(p.eligibility, 400) || null,
            scheduling_notes: clip(p.deadline, 300) || null,
            deadline: iso(p.deadline),
            program_type: p.type,
            duration: p.duration,
            location: p.online ? "Online" : clip(p.location, 200),
            online: Boolean(p.online),
            topics: (p.topics ?? []).map((t) => clip(t, 40)).filter(Boolean).slice(0, 6),
            source: "axis",
            // Nothing reaches the student until the counselor approves it.
            status: "counselor-review",
          })),
      ];

      let saved: Row[] = [];
      if (rows.length > 0) {
        const ins = await request.db.from("opportunity_matches").insert(rows).select("*");
        if (ins.error) throw fromPostgrest(ins.error);
        saved = (ins.data ?? []) as Row[];
      }

      const n = saved.length;
      const where = onlineOnly ? (near ? "online" : `online (no home location on file for ${brief.first})`) : `within ${b.miles} miles of ${near}`;
      const lead =
        n === 0
          ? `Nothing ${where} AxIS is confident about yet. Widen the distance or the filters and ask again.`
          : `${n} program${n === 1 ? "" : "s"} ${where}${b.subjects.length ? ` for ${b.subjects.slice(0, 3).join(", ")}` : ""}.`;

      await request.db
        .from("opportunity_requests")
        .update({ status: "complete", constraints: { ...criteria, lead } })
        .eq("id", requestRow.id);

      return reply.code(201).send({ lead, programs: saved.map(toProgram) });
    }
  );

  app.patch(
    "/activities-build/programs/:id",
    { preHandler: [app.authenticate, limit("application:program-update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          status: z.enum(["counselor-review", "approved", "dismissed", "saved"]).optional(),
          assignedTaskId: uuid.nullable().optional(),
        })
        .strict()
        .parse(request.body);
      if (isStudent(request)) throw forbidden();
      const { data: match } = await request.db.from("opportunity_matches").select("student_id").eq("id", id).maybeSingle();
      if (!match) throw notFound();
      await resolveStudentId(request, String(match.student_id), "edit");
      const update: Row = {};
      if (b.status !== undefined) {
        update.status = b.status;
        update.reviewed_by = request.auth.userId;
        update.reviewed_at = new Date().toISOString();
      }
      if (b.assignedTaskId !== undefined) {
        if (b.assignedTaskId) {
          const { data: task } = await request.db.from("deliverables").select("student_id").eq("id", b.assignedTaskId).maybeSingle();
          if (!task || task.student_id !== match.student_id) throw badRequest("That task belongs to a different student");
        }
        update.assigned_task_id = b.assignedTaskId;
      }
      const { data, error } = await request.db.from("opportunity_matches").update(update).eq("id", id).select("*").single();
      if (error) throw fromPostgrest(error);
      return toProgram(data as Row);
    }
  );
}

