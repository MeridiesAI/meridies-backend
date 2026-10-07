/**
 * AI inside the search (BACKEND_TODO §5), registered under /colleges.
 *
 *   POST /colleges/search/ai                 words -> the §3 filters -> the real search
 *   POST /colleges/research                  a cited answer from official sites; for one
 *                                            school, also proposals where a source and the
 *                                            catalog disagree
 *   GET  /colleges/proposals?status=         proposals the caller made, or all for an editor
 *   POST /colleges/proposals/:id/review      approve (applies it) or reject; editors only
 *   GET  /colleges/:id/student-summary       counselor bullets for one student, from catalog
 *                                            facts only (no model)
 *
 * The model never writes a result list and never changes the catalog: search
 * runs on validated filters, and a proposal waits for a catalog editor.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FAST_MODEL, researchDomains, runStructured, runWebResearch } from "../lib/anthropic.js";
import {
  NL_SEARCH_SCHEMA,
  NL_SEARCH_SYSTEM,
  PROPOSAL_FIELDS,
  PROPOSAL_SCHEMA,
  acceptProposals,
  nlFiltersToQuery,
  studentCollegeSummary,
  type ProposalField,
} from "../lib/collegeIntel.js";
import { searchQuery } from "../lib/collegesV10.js";
import { badRequest, forbidden, fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";
import { runSearch, studentNumbers } from "./collegesV10.js";

type Row = Record<string, unknown>;
const uuid = z.string().uuid();

export default async function collegeIntelRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  // ---- Natural-language search ----------------------------------------------------

  app.post("/search/ai", { preHandler: [...counselor, limit("colleges:search-ai", 30, 60)] }, async (request) => {
    const b = z
      .object({ text: z.string().trim().min(3).max(500), studentId: uuid.optional(), limit: z.number().int().min(1).max(100).optional() })
      .strict()
      .parse(request.body);
    const parsed = await runStructured<Record<string, unknown>>({
      request,
      module: "college-search",
      studentId: b.studentId ?? null,
      system: NL_SEARCH_SYSTEM,
      prompt: `<request>\n${b.text}\n</request>`,
      schema: NL_SEARCH_SCHEMA as unknown as Record<string, unknown>,
      toolName: "search_filters",
      model: FAST_MODEL,
      maxTokens: 800,
    });
    const asQuery = nlFiltersToQuery(parsed);
    if (b.studentId) asQuery.studentId = b.studentId;
    if (b.limit) asQuery.limit = String(b.limit);
    // The model's output is input like any other: the same validation as GET /colleges/search.
    const valid = searchQuery.safeParse(asQuery);
    if (!valid.success) throw badRequest("Couldn't turn that into search filters. Try rewording it.");
    const out = await runSearch(request, valid.data);
    const unsupported = Array.isArray(parsed.unsupported) ? (parsed.unsupported as unknown[]).map(String).slice(0, 5) : [];
    return {
      // What ran, so the counselor can see and edit it (the same keys as GET /colleges/search).
      filters: asQuery,
      unsupported,
      total: out.total,
      nextCursor: out.nextCursor,
      results: out.results,
    };
  });

  // ---- Cited research --------------------------------------------------------------

  app.post("/research", { preHandler: [...counselor, limit("colleges:research", 10, 60)] }, async (request) => {
    const b = z.object({ question: z.string().trim().min(5).max(500), collegeId: uuid.optional() }).strict().parse(request.body);

    let context = "";
    let site: string | null = null;
    let current: Partial<Record<ProposalField, string | null>> = {};
    let collegeName: string | null = null;
    if (b.collegeId) {
      const [college, pol, factors] = await Promise.all([
        request.db.from("colleges").select("id, name, website, test_policy").eq("id", b.collegeId).maybeSingle(),
        request.db.from("college_policies").select("*").eq("college_id", b.collegeId).maybeSingle(),
        request.db.from("college_admission_factors").select("test_policy, data_year").eq("college_id", b.collegeId).maybeSingle(),
      ]);
      for (const r of [college, pol, factors]) if (r.error) throw fromPostgrest(r.error);
      if (!college.data) throw notFound("That college isn't in the catalog");
      const c = college.data as Row;
      const p = (pol.data ?? {}) as Row;
      collegeName = String(c.name);
      site = (c.website as string | null) ?? null;
      const str = (v: unknown) => (v == null ? null : String(v));
      current = {
        test_policy: str(c.test_policy),
        superscore: str(p.superscore),
        self_report_scores: str(p.self_report_scores),
        css_profile_required: str(p.css_profile_required),
        stars_required: str(p.stars_required),
        fairtest_status: str(p.fairtest_status),
      };
      context = [
        `School: ${collegeName}${site ? ` (${site})` : ""}`,
        ...Object.entries(current).map(([k, v]) => `${k}: ${v ?? "unknown"}`),
        factors.data ? `IPEDS ${String((factors.data as Row).data_year)} test policy: ${String((factors.data as Row).test_policy ?? "unknown")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const result = await runWebResearch({
      request,
      module: "web-research",
      question: collegeName && !b.question.toLowerCase().includes(collegeName.toLowerCase()) ? `${collegeName}: ${b.question}` : b.question,
      context: context || undefined,
      domains: researchDomains([site]),
    });
    if (result.refused) {
      return { answer: [], sources: [], proposals: [], note: "That question couldn't be researched." };
    }

    // Where a cited source disagrees with the catalog, propose (never apply) a change.
    let proposals: { id: string | null; field: string; currentValue: string | null; proposedValue: string; sourceUrl: string }[] = [];
    const cited = new Set(result.sources.map((s) => s.url));
    if (b.collegeId && cited.size) {
      const answerText = result.parts
        .map((p) => `${p.text}${p.citations.length ? ` [sources: ${p.citations.map((c) => c.url).join(", ")}]` : ""}`)
        .join("\n");
      const raw = await runStructured<unknown>({
        request,
        module: "web-research",
        system:
          "You compare a cited research answer with a college catalog record. Propose a change only where a cited source states a different value for one of the tool's fields. Copy the source URL exactly as cited and the sentence it rests on. Propose nothing when the answer doesn't clearly state a value.",
        prompt: `<catalog>\n${context}\n</catalog>\n<answer>\n${answerText}\n</answer>`,
        schema: PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
        toolName: "propose_catalog_changes",
        model: FAST_MODEL,
        maxTokens: 1200,
      });
      const accepted = acceptProposals(raw, cited, current);
      const svc = serviceClient();
      if (svc && accepted.length) {
        // One insert per proposal: the open-proposal index is partial (pending
        // only), which an upsert can't target, so a duplicate is a 23505 to skip.
        for (const p of accepted) {
          const { data, error } = await svc
            .from("catalog_change_proposals")
            .insert({
              college_id: b.collegeId,
              field: p.field,
              current_value: current[p.field] ?? null,
              proposed_value: p.proposedValue,
              source_url: p.sourceUrl,
              evidence: p.evidence,
              proposed_by: request.auth.userId,
              ai_run_id: result.runId,
            })
            .select("id")
            .maybeSingle();
          if (error && error.code !== "23505") request.log.warn({ code: error.code }, "proposal insert failed");
          let id = (data as Row | null)?.id ? String((data as Row).id) : null;
          if (!id) {
            const { data: open } = await svc
              .from("catalog_change_proposals")
              .select("id")
              .eq("college_id", b.collegeId)
              .eq("field", p.field)
              .eq("proposed_value", p.proposedValue)
              .eq("status", "pending")
              .maybeSingle();
            id = (open as Row | null)?.id ? String((open as Row).id) : null;
          }
          proposals.push({ id, field: p.field, currentValue: current[p.field] ?? null, proposedValue: p.proposedValue, sourceUrl: p.sourceUrl });
        }
      }
    }

    return {
      // Each part with the sources it rests on; a part with none is not a sourced claim.
      answer: result.parts.map((p) => ({ text: p.text, cited: p.citations.length > 0, citations: p.citations })),
      sources: result.sources,
      proposals,
    };
  });

  // ---- Proposals --------------------------------------------------------------------

  app.get("/proposals", { preHandler: [app.authenticate, limit("colleges:proposals", 120, 60)] }, async (request) => {
    const q = z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() }).strict().parse(request.query);
    let builder = request.db
      .from("catalog_change_proposals")
      .select("id, college_id, field, current_value, proposed_value, source_url, evidence, status, created_at, reviewed_at, review_note, college:colleges(name, slug)");
    if (q.status) builder = builder.eq("status", q.status);
    const { data, error } = await builder.order("created_at", { ascending: false }).limit(200);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as Row[]).map((r) => ({
      id: String(r.id),
      collegeId: String(r.college_id),
      collegeName: String(((r.college ?? {}) as Row).name ?? ""),
      field: String(r.field),
      currentValue: (r.current_value as string | null) ?? null,
      proposedValue: String(r.proposed_value),
      sourceUrl: String(r.source_url),
      evidence: (r.evidence as string | null) ?? null,
      status: String(r.status),
      createdAt: String(r.created_at),
      reviewedAt: (r.reviewed_at as string | null) ?? null,
      reviewNote: (r.review_note as string | null) ?? null,
    }));
  });

  app.post("/proposals/:id/review", { preHandler: [app.authenticate, limit("colleges:proposals-review", 60, 60)] }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const b = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() }).strict().parse(request.body);
    const { data: editor, error: e1 } = await request.db.from("catalog_editors").select("profile_id").eq("profile_id", request.auth.userId).maybeSingle();
    if (e1) throw fromPostgrest(e1);
    if (!editor) throw forbidden("Only a Meridies catalog editor can review catalog changes");
    const svc = serviceClient();
    if (!svc) throw unavailable("Reviewing needs the service role key");

    const { data: p, error: e2 } = await svc.from("catalog_change_proposals").select("*").eq("id", id).maybeSingle();
    if (e2) throw fromPostgrest(e2);
    if (!p) throw notFound("That proposal doesn't exist");
    const row = p as Row;
    if (row.status !== "pending") throw badRequest("That proposal was already reviewed");
    const field = String(row.field) as ProposalField;
    const value = String(row.proposed_value);
    if (!(PROPOSAL_FIELDS[field] as readonly string[]).includes(value)) throw badRequest("That proposal's value isn't allowed");

    if (b.decision === "approve") {
      const now = new Date().toISOString();
      if (field === "test_policy") {
        const { error } = await svc.from("colleges").update({ test_policy: value }).eq("id", String(row.college_id));
        if (error) throw fromPostgrest(error);
      } else {
        const { data: cur } = await svc.from("college_policies").select("sources").eq("college_id", String(row.college_id)).maybeSingle();
        const sources = { ...(((cur as Row | null)?.sources as Record<string, unknown>) ?? {}), [field]: { url: row.source_url, checkedAt: now.slice(0, 10) } };
        const typed = value === "true" ? true : value === "false" ? false : value;
        const { error } = await svc
          .from("college_policies")
          .upsert({ college_id: String(row.college_id), [field]: typed, sources, updated_at: now }, { onConflict: "college_id" });
        if (error) throw fromPostgrest(error);
      }
    }
    const { error: e3 } = await svc
      .from("catalog_change_proposals")
      .update({ status: b.decision === "approve" ? "approved" : "rejected", reviewed_by: request.auth.userId, reviewed_at: new Date().toISOString(), review_note: b.note ?? null })
      .eq("id", id)
      .eq("status", "pending");
    if (e3) throw fromPostgrest(e3);
    return { id, status: b.decision === "approve" ? "approved" : "rejected" };
  });

  // ---- Per-student summary ------------------------------------------------------------

  app.get("/:id/student-summary", { preHandler: [...counselor, limit("colleges:student-summary", 240, 60)] }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { studentId } = z.object({ studentId: uuid }).strict().parse(request.query);
    const sid = await resolveStudentId(request, studentId, "view");
    const [student, college, stats, factors, policies, requirements, majorAdmits, majors, aid] = await Promise.all([
      studentNumbers(request, sid),
      request.db.from("colleges").select("id, name").eq("id", id).maybeSingle(),
      request.db.from("college_stats").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_admission_factors").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_policies").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_application_requirements").select("*").eq("college_id", id).order("cycle", { ascending: false }).limit(1),
      request.db.from("college_major_admit_rates").select("*").eq("college_id", id).order("entry_year", { ascending: false }).limit(300),
      request.db.from("college_fields_of_study").select("title").eq("college_id", id).eq("credential_level", 3).limit(400),
      request.db.from("student_aid_profiles").select("parent_agi_cents").eq("student_id", sid).maybeSingle(),
    ]);
    for (const r of [college, stats, factors, policies, requirements, majorAdmits, majors, aid]) if (r.error) throw fromPostgrest(r.error);
    if (!college.data) throw notFound("That college isn't in the catalog");
    const summary = studentCollegeSummary({
      collegeName: String((college.data as Row).name),
      student: {
        ...student.numbers,
        intendedMajors: student.intendedMajors,
        agiCents: (aid.data as Row | null)?.parent_agi_cents == null ? null : Number((aid.data as Row).parent_agi_cents),
      },
      stats: (stats.data as Row | null) ?? null,
      factors: (factors.data as Row | null) ?? null,
      policies: (policies.data as Row | null) ?? null,
      requirements: ((requirements.data ?? []) as Row[])[0] ?? null,
      majorAdmits: (majorAdmits.data ?? []) as Row[],
      majors: (majors.data ?? []) as Row[],
    });
    return { collegeId: id, studentId: sid, ...summary, fitSource: summary.fit ? "meridies-estimate" : null };
  });
}
