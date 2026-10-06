/**
 * The Colleges tab's AxIS calls (registered under /ai beside routes/ai.ts).
 *
 *   POST /ai/college-research    Search & research: report, presentation,
 *                                debate or another angle on one college, from
 *                                the catalog and the counselor's own filed
 *                                research. "events" and "updates" are not model
 *                                calls: they list Events Hub listings and the
 *                                catalog's published updates for the school.
 *   POST /ai/college-list-chat   "Ask AxIS to edit, add, refresh the list" on
 *                                Build College Lists: the request becomes a
 *                                change to the form's answers or the view,
 *                                which the deterministic list then re-runs on.
 *
 * Both run on Haiku: grounded summarising and intent parsing, not open-ended
 * judgement. The model is handed facts and told to use only those; numbers it
 * returns are not trusted beyond being shown as its bullets, and every Meridies
 * rating it is given is labelled as one in the prompt and in usedSources.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { runStructured } from "../lib/anthropic.js";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { roundsFrom } from "../lib/collegesV10.js";
import { isUpcoming, toHubEvent, toCollegeRef } from "../lib/eventsHub.js";
import { listCriteriaSchema, loadListSchools } from "./collegesV10.js";

type Row = Record<string, unknown>;

export type AssistantAnswer = {
  lead: string;
  sections: { heading: string; points: string[] }[];
  usedSources: string[];
};

const RESEARCH_MODES = ["report", "presentation", "debate", "other", "events", "updates"] as const;

const BASE = [
  "You are AxIS, the research assistant inside Meridies, for independent college counselors.",
  "Use ONLY the facts in the JSON you are given. Never add a statistic, deadline, program or claim that is not in it.",
  "Where a fact is missing, say it is not on file rather than estimating.",
  "Anything marked ratingKind 'meridies-curated' is a Meridies rating: always call it 'Meridies ... rating', never a statistic.",
  "Write short, plain bullets a counselor can read in session. No marketing language.",
].join("\n");

const MODE_BRIEF: Record<"report" | "presentation" | "debate" | "other", string> = {
  report:
    "Write a research report in five sections, in this order: Overview, Admissions, Academics, Cost and aid, Student life. Two to four bullets each.",
  presentation:
    "Write five slides, one idea each, headed 'Slide 1: ...' to 'Slide 5: ...': why this school, getting in, what you would study, what it costs, life there. Two or three bullets per slide.",
  debate:
    "Argue the school both ways: a 'For' section, an 'Against' section, and 'Where the two sides meet' with one bullet. Every point must rest on a given fact.",
  other:
    "Research the school for the counselor's angle only. Use one to three sections whose headings fit the angle.",
};

const answerSchema = {
  type: "object",
  properties: {
    lead: { type: "string", maxLength: 300 },
    sections: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          heading: { type: "string", maxLength: 80 },
          points: { type: "array", maxItems: 6, items: { type: "string", maxLength: 300 } },
        },
        required: ["heading", "points"],
      },
    },
  },
  required: ["lead", "sections"],
} as const;

const answerOut = z.object({
  lead: z.string().max(400),
  sections: z
    .array(z.object({ heading: z.string().max(120), points: z.array(z.string().max(400)).max(8) }))
    .max(8),
});

/** Everything on file about one school, compacted for the prompt. */
async function collegeDossier(request: FastifyRequest, collegeId: string) {
  const db = request.db;
  const [college, facts, aid, ratings, majors, intel, admitted, programs] = await Promise.all([
    db.from("colleges").select("*").eq("id", collegeId).maybeSingle(),
    db.from("college_profile_facts").select("*").eq("college_id", collegeId).maybeSingle(),
    db.from("college_aid_profiles").select("*").eq("college_id", collegeId).maybeSingle(),
    db.from("college_aid_ratings").select("kind, rating, rating_kind, label, rationale").eq("college_id", collegeId),
    db.from("college_majors").select("name, faculty_count, majors_enrolled, admission_model, durability").eq("college_id", collegeId).limit(30),
    db.from("college_intel_profiles").select("class_rank_considered, undergrad_enrollment, graduate_enrollment").eq("college_id", collegeId).maybeSingle(),
    db.from("college_admitted_profiles").select("axes, rating_kind").eq("college_id", collegeId).maybeSingle(),
    db.from("college_programs").select("kind, name").eq("college_id", collegeId).limit(30),
  ]);
  if (college.error) throw fromPostgrest(college.error);
  if (!college.data) throw notFound("That college isn't in the catalog");
  const c = college.data as Row;

  // The counselor's own research on this school, filed under Policy & research.
  const research = await filedResearch(request, String(c.name));

  const f = (facts.data ?? null) as Row | null;
  return {
    college: c,
    sourceNote: (f?.source_note as string | undefined) ?? null,
    hasRatings: (ratings.data ?? []).length > 0,
    hasResearch: research.length > 0,
    json: JSON.stringify(
      {
        name: c.name,
        aka: c.aka,
        city: c.city,
        state: c.state,
        control: c.control,
        undergraduates: c.size,
        acceptanceRatePct: c.acceptance_rate == null ? null : Number(c.acceptance_rate) * 100,
        testPolicy: c.test_policy,
        rounds: roundsFrom(c.deadlines),
        facts: f
          ? {
              founded: f.founded,
              setting: f.campus_setting,
              overview: f.overview,
              studentFacultyRatio: f.student_faculty_ratio,
              graduationRate4yrPct: f.graduation_rate_4yr,
              graduationRate6yrPct: f.graduation_rate_6yr,
              retentionRatePct: f.retention_rate,
              satRange: f.sat_range,
              actRange: f.act_range,
              gpaRange: f.gpa_range,
              popularMajors: f.popular_majors,
              studentLife: f.student_life,
              netPriceByIncomeCents: f.net_price_by_income,
              roomAndBoardCents: f.room_and_board_cents,
            }
          : null,
        aidProfile: aid.data ?? null,
        meridiesAidRatings: ratings.data ?? [],
        majors: majors.data ?? [],
        intel: intel.data ?? null,
        meridiesAdmittedShape: admitted.data ?? null,
        programs: programs.data ?? [],
        counselorResearch: research,
      },
      null,
      0
    ).slice(0, 40_000),
  };
}

/** Read links filed under Policy & research › <school>, where the counselor allowed AI to read them. */
async function filedResearch(request: FastifyRequest, schoolName: string) {
  const { data: root } = await request.db
    .from("folders")
    .select("id")
    .eq("owner_id", request.auth.userId)
    .eq("system_key", "policy-research")
    .maybeSingle();
  if (!root) return [];
  const { data: folders } = await request.db
    .from("folders")
    .select("id, name")
    .eq("owner_id", request.auth.userId)
    .eq("parent_id", (root as Row).id as string);
  const folder = ((folders ?? []) as Row[]).find(
    (f) => String(f.name).trim().toLowerCase() === schoolName.trim().toLowerCase()
  );
  if (!folder) return [];
  const { data: links } = await request.db
    .from("document_links")
    .select("title, url, summary, key_points")
    .eq("folder_id", folder.id as string)
    .eq("available_to_llm", true)
    .eq("status", "read")
    .order("created_at", { ascending: false })
    .limit(8);
  return ((links ?? []) as Row[]).map((l) => ({
    title: l.title,
    url: l.url,
    summary: typeof l.summary === "string" ? l.summary.slice(0, 1500) : null,
    keyPoints: l.key_points,
  }));
}

export default async function collegeAiRoutes(app: FastifyInstance) {
  const aiLimit = (name: string) =>
    limit(`ai:${name}`, 20, 60, "You're running AI tools very fast. Give it a minute.");

  // ---- College research ------------------------------------------------------------

  app.post(
    "/college-research",
    { preHandler: [app.authenticate, requireRole("counselor"), aiLimit("college-research")] },
    async (request): Promise<AssistantAnswer & { collegeId: string; title: string }> => {
      const b = z
        .object({
          collegeId: z.string().uuid(),
          mode: z.enum(RESEARCH_MODES),
          angle: z.string().trim().max(400).optional(),
        })
        .strict()
        .parse(request.body);

      const { data: college, error } = await request.db
        .from("colleges")
        .select("id, slug, name, aka, deadlines")
        .eq("id", b.collegeId)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!college) throw notFound("That college isn't in the catalog");
      const c = college as Row;
      const short = ((c.aka as string[] | null) ?? [])[0] ?? String(c.name);
      const label = b.mode === "other" ? b.angle?.trim() || "report" : b.mode;
      const title = `${short}: ${label}`;
      const rounds = roundsFrom(c.deadlines);

      if (b.mode === "events") {
        const { data: rows, error: e2 } = await request.db
          .from("hub_events")
          .select("*")
          .eq("college_id", b.collegeId)
          .order("start_date", { ascending: true })
          .limit(50);
        if (e2) throw fromPostgrest(e2);
        const ref = toCollegeRef(c);
        const upcoming = ((rows ?? []) as Row[])
          .filter(isUpcoming)
          .map((r) => toHubEvent(r, request.auth.userId, ref, null));
        return {
          collegeId: b.collegeId,
          title,
          lead: upcoming.length ? `What is coming up at ${c.name}.` : `Nothing from ${c.name} in the Events Hub yet.`,
          sections: [
            ...(upcoming.length
              ? [
                  {
                    heading: "Info sessions and events",
                    points: upcoming.map(
                      (e) =>
                        `${e.name}: ${e.startDate}${e.endDate ? ` to ${e.endDate}` : ""}${e.startTime ? `, ${e.startTime}${e.endTime ? `–${e.endTime}` : ""} (${e.timeZone})` : ""}, ${e.place}`
                    ),
                  },
                ]
              : []),
            ...(rounds.length ? [{ heading: "Deadlines", points: rounds.map((r) => `${r.plan}: ${r.deadline}`) }] : []),
          ],
          usedSources: ["Events Hub", ...(rounds.length ? ["College profile"] : [])],
        };
      }

      if (b.mode === "updates") {
        const { data: rows, error: e2 } = await request.db
          .from("policy_updates")
          .select("title, summary, institution, published_at, source_url")
          .eq("college_id", b.collegeId)
          .order("published_at", { ascending: false })
          .limit(12);
        if (e2) throw fromPostgrest(e2);
        const mine = (rows ?? []) as Row[];
        return {
          collegeId: b.collegeId,
          title,
          lead: mine.length ? `What changed at ${c.name}.` : `No published updates from ${c.name} on file.`,
          sections: mine.length
            ? [
                {
                  heading: "Updates",
                  points: mine.map(
                    (u) =>
                      `${u.title}.${u.summary ? ` ${u.summary}` : ""} (${u.institution ?? c.name}, ${String(u.published_at).slice(0, 10)})`
                  ),
                },
              ]
            : rounds.length
              ? [{ heading: "Deadlines, unchanged", points: rounds.map((r) => `${r.plan}: ${r.deadline}`) }]
              : [],
          usedSources: ["Published updates"],
        };
      }

      const dossier = await collegeDossier(request, b.collegeId);
      const result = await runStructured({
        request,
        module: "college-research",
        system: [BASE, MODE_BRIEF[b.mode]].join("\n"),
        prompt: [
          b.mode === "other" && b.angle ? `The counselor's angle: ${b.angle}` : "",
          `College on file (JSON):`,
          dossier.json,
        ]
          .filter(Boolean)
          .join("\n\n"),
        toolName: "college_research",
        maxTokens: 2000,
        schema: answerSchema,
        validate: (v) => answerOut.parse(v),
      });

      return {
        collegeId: b.collegeId,
        title,
        lead: result.lead,
        sections: result.sections.filter((s) => s.points.length > 0),
        usedSources: [
          "College profile",
          ...(dossier.sourceNote ? [dossier.sourceNote] : []),
          ...(dossier.hasRatings ? ["Meridies generosity rating"] : []),
          ...(dossier.hasResearch ? ["Your research in Files"] : []),
        ],
      };
    }
  );

  // ---- Build College Lists: Ask AxIS ----------------------------------------------------

  app.post(
    "/college-list-chat",
    { preHandler: [app.authenticate, requireRole("counselor"), aiLimit("college-list-chat")] },
    async (request) => {
      const view = z
        .object({
          perTier: z.number().int().min(1).max(12),
          offset: z.number().int().min(0).max(1000),
          exclude: z.array(z.string().uuid()).max(200),
        })
        .strict();
      const b = z
        .object({
          studentId: z.string().uuid(),
          criteria: listCriteriaSchema,
          view,
          message: z.string().trim().min(1).max(600),
          /** The schools on screen, so "drop Lehigh" can be resolved. */
          shown: z.array(z.object({ collegeId: z.string().uuid(), name: z.string().max(300) }).strict()).max(60).optional(),
        })
        .strict()
        .parse(request.body);
      await resolveStudentId(request, b.studentId, "view");

      const schools = await loadListSchools(request);
      const names = schools.map((s) => s.name);

      const result = await runStructured<{
        action: "refresh" | "more" | "fewer" | "closer" | "farther" | "test-optional" | "set" | "exclude" | "none";
        tier?: "reach" | "target" | "likely";
        miles?: number;
        majors?: string[];
        sizes?: string[];
        settings?: string[];
        aid?: string;
        diversity?: string;
        testOptional?: "Yes" | "No" | null;
        excludeSchools?: string[];
        points: string[];
      }>({
        request,
        module: "college-list",
        studentId: b.studentId,
        system: [
          "You turn a counselor's request about a college list into ONE structured change. You do not pick schools yourself: a deterministic filter does.",
          "Actions: refresh (show the next schools in each band), more / fewer (schools per band), closer / farther (halve or double the radius, or set miles), test-optional, set (change majors, sizes, settings, aid, diversity, testOptional), exclude (remove named schools), none (only answer).",
          `Sizes: Small, Medium, Large, Very large. Settings: Rural, Small city, Major city, Suburban, College town. Aid: No preference, Lenient, Limited. Diversity: No preference, Yes, No.`,
          "points: one to three short bullets saying what changed, addressed to the counselor. If the request can't be done with these actions, use none and say what you can do.",
        ].join("\n"),
        prompt: JSON.stringify({
          request: b.message,
          currentAnswers: b.criteria,
          view: b.view,
          schoolsOnScreen: (b.shown ?? []).map((s) => s.name),
          schoolsTheBuilderKnows: names.slice(0, 400),
        }),
        toolName: "list_change",
        maxTokens: 800,
        schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["refresh", "more", "fewer", "closer", "farther", "test-optional", "set", "exclude", "none"],
            },
            tier: { type: "string", enum: ["reach", "target", "likely"] },
            miles: { type: "integer", minimum: 50, maximum: 3000 },
            majors: { type: "array", maxItems: 12, items: { type: "string", maxLength: 120 } },
            sizes: { type: "array", maxItems: 4, items: { type: "string", enum: ["Small", "Medium", "Large", "Very large"] } },
            settings: {
              type: "array",
              maxItems: 5,
              items: { type: "string", enum: ["Rural", "Small city", "Major city", "Suburban", "College town"] },
            },
            aid: { type: "string", enum: ["No preference", "Lenient", "Limited"] },
            diversity: { type: "string", enum: ["No preference", "Yes", "No"] },
            testOptional: { type: ["string", "null"], enum: ["Yes", "No", null] },
            excludeSchools: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
            points: { type: "array", maxItems: 3, items: { type: "string", maxLength: 240 } },
          },
          required: ["action", "points"],
        },
      });

      // Apply the change here, validated, rather than trusting the model's shape.
      const criteria = { ...b.criteria };
      const next = { ...b.view, exclude: [...b.view.exclude] };
      switch (result.action) {
        case "refresh":
          next.offset = b.view.offset + b.view.perTier;
          break;
        case "more":
          next.perTier = Math.min(12, b.view.perTier + 2);
          break;
        case "fewer":
          next.perTier = Math.max(1, b.view.perTier - 2);
          break;
        case "closer":
          criteria.miles = result.miles ?? Math.max(50, Math.round(b.criteria.miles / 2 / 50) * 50);
          break;
        case "farther":
          criteria.miles = result.miles ?? Math.min(3000, b.criteria.miles * 2);
          break;
        case "test-optional":
          criteria.testOptional = "Yes";
          break;
        case "set":
          if (result.majors) criteria.majors = result.majors;
          if (result.sizes) criteria.sizes = result.sizes;
          if (result.settings) criteria.settings = result.settings as typeof criteria.settings;
          if (result.aid) criteria.aid = result.aid as typeof criteria.aid;
          if (result.diversity) criteria.diversity = result.diversity as typeof criteria.diversity;
          if (result.testOptional !== undefined) criteria.testOptional = result.testOptional;
          if (result.miles) criteria.miles = result.miles;
          break;
        case "exclude":
          for (const n of result.excludeSchools ?? []) {
            const hit = schools.find((s) => s.name.toLowerCase() === n.trim().toLowerCase());
            if (hit && !next.exclude.includes(hit.collegeId)) next.exclude.push(hit.collegeId);
          }
          break;
        default:
          break;
      }

      const checked = listCriteriaSchema.safeParse(criteria);
      return {
        action: result.action,
        criteria: checked.success ? checked.data : b.criteria,
        view: next,
        points: result.points.map((p) => p.slice(0, 240)),
      };
    }
  );
}
