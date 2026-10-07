/**
 * The resource library.
 *
 *   GET    /resources?category=&state=&q=&audience=   the Meridies library plus the
 *                                                     practice's own resources
 *   POST   /resources                                 a practice resource
 *   PATCH  /resources/:id                             (practice rows only)
 *   DELETE /resources/:id                             (practice rows only)
 *   GET    /resources/pins?studentId= | ?collegeId=    what is pinned there
 *   POST   /resources/:id/pins                        pin to a student or a college
 *   DELETE /resources/pins/:pinId
 *   POST   /resources/:id/deadline                    put its closing date on a
 *                                                     student's deadlines
 *   POST   /resources/ask                             a question answered from the
 *                                                     library and the official sites
 *                                                     it points to, with citations
 *
 * The library rows are Meridies'; a practice can't edit them (RLS). Students
 * read the library rows meant for them and what is pinned to them.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { researchDomains, runWebResearch } from "../lib/anthropic.js";
import { escapeIlike, safeIlikeTerm } from "../lib/collegesV10.js";
import { loadWorkspace } from "../lib/crm.js";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { normalizeLink } from "../lib/links.js";

type Row = Record<string, unknown>;

const CATEGORIES = ["testing", "research", "applications", "aid"] as const;
const AUDIENCES = ["counselor", "student", "both"] as const;
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const COLUMNS =
  "id, category, title, url, description, opens_on, closes_on, cycle, audience, state_scope, link_only, " +
  "counselor_id, firm_id, link_status, last_status_code, last_checked_at, source_verified_at, created_at, updated_at";

export const toResource = (r: Row) => ({
  id: String(r.id),
  category: String(r.category),
  title: String(r.title),
  url: String(r.url),
  description: String(r.description ?? ""),
  opensOn: (r.opens_on as string | null) ?? null,
  closesOn: (r.closes_on as string | null) ?? null,
  cycle: (r.cycle as string | null) ?? null,
  audience: String(r.audience),
  stateScope: (r.state_scope as string | null) ?? null,
  linkOnly: r.link_only === true,
  // "meridies": the curated library; "practice": this practice's own.
  owner: r.counselor_id == null ? ("meridies" as const) : ("practice" as const),
  linkStatus: String(r.link_status ?? "unknown"),
  lastCheckedAt: (r.last_checked_at as string | null) ?? null,
});

const body = z
  .object({
    category: z.enum(CATEGORIES),
    title: z.string().trim().min(1).max(200),
    url: z.string().trim().url().max(2000),
    description: z.string().trim().max(1200),
    opensOn: isoDate.nullable(),
    closesOn: isoDate.nullable(),
    cycle: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
    audience: z.enum(AUDIENCES),
    stateScope: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).nullable(),
  })
  .strict();

function toRow(b: Partial<z.infer<typeof body>>): Row {
  const row: Row = {};
  if (b.category !== undefined) row.category = b.category;
  if (b.title !== undefined) row.title = b.title;
  if (b.url !== undefined) row.url = b.url;
  if (b.description !== undefined) row.description = b.description;
  if (b.opensOn !== undefined) row.opens_on = b.opensOn;
  if (b.closesOn !== undefined) row.closes_on = b.closesOn;
  if (b.cycle !== undefined) row.cycle = b.cycle;
  if (b.audience !== undefined) row.audience = b.audience;
  if (b.stateScope !== undefined) row.state_scope = b.stateScope;
  return row;
}

export default async function resourceRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [app.authenticate, limit("resources:list", 240, 60)] }, async (request) => {
    const q = z
      .object({
        category: z.enum(CATEGORIES).optional(),
        state: z.string().regex(/^[A-Za-z]{2}$/).optional(),
        audience: z.enum(AUDIENCES).optional(),
        q: z.string().trim().max(120).optional(),
      })
      .strict()
      .parse(request.query);
    let builder = request.db.from("library_resources").select(COLUMNS);
    if (q.category) builder = builder.eq("category", q.category);
    // A state's view: its own resources and the ones that apply everywhere.
    if (q.state) builder = builder.or(`state_scope.is.null,state_scope.eq.${q.state.toUpperCase()}`);
    if (q.audience) builder = builder.in("audience", [q.audience, "both"]);
    const term = q.q ? safeIlikeTerm(q.q) : "";
    if (term) {
      const like = `%${escapeIlike(term)}%`;
      builder = builder.or(`title.ilike.${like},description.ilike.${like}`);
    }
    const { data, error } = await builder.order("category").order("title").limit(500);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as unknown as Row[]).map(toResource);
  });

  app.post("/", { preHandler: [...counselor, limit("resources:write", 60, 60)] }, async (request, reply) => {
    const b = body.partial({ description: true, opensOn: true, closesOn: true, cycle: true, audience: true, stateScope: true }).parse(request.body);
    const { url } = await normalizeLink(b.url);
    const ws = await loadWorkspace(request);
    const { data, error } = await request.db
      .from("library_resources")
      .insert({ ...toRow({ ...b, url }), counselor_id: request.auth.userId, firm_id: ws.firmId })
      .select(COLUMNS)
      .single();
    if (error) throw fromPostgrest(error);
    return reply.code(201).send(toResource(data as unknown as Row));
  });

  app.patch("/:id", { preHandler: [...counselor, limit("resources:write", 120, 60)] }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const b = body.partial().parse(request.body);
    if (b.url) b.url = (await normalizeLink(b.url)).url;
    const row = toRow(b);
    if (!Object.keys(row).length) throw badRequest("Nothing to update");
    // RLS only lets a practice's own rows change; a library row reads as not found.
    const { data, error } = await request.db
      .from("library_resources")
      .update(row)
      .eq("id", id)
      .not("counselor_id", "is", null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That resource isn't one your practice added");
    return toResource(data as unknown as Row);
  });

  app.delete("/:id", { preHandler: [...counselor, limit("resources:write", 120, 60)] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { data, error } = await request.db
      .from("library_resources")
      .delete()
      .eq("id", id)
      .not("counselor_id", "is", null)
      .select("id");
    if (error) throw fromPostgrest(error);
    if (!data?.length) throw notFound("That resource isn't one your practice added");
    return reply.code(204).send();
  });

  // ---- Pins ------------------------------------------------------------------------

  app.get("/pins", { preHandler: [app.authenticate, limit("resources:pins", 240, 60)] }, async (request) => {
    const q = z.object({ studentId: uuid.optional(), collegeId: uuid.optional() }).strict().parse(request.query);
    if (!q.studentId === !q.collegeId) throw badRequest("Pass studentId or collegeId");
    let builder = request.db.from("library_resource_pins").select(`id, note, created_at, student_id, college_id, resource:library_resources(${COLUMNS})`);
    if (q.studentId) {
      const studentId = await resolveStudentId(request, q.studentId);
      builder = builder.eq("student_id", studentId);
    } else builder = builder.eq("college_id", q.collegeId!);
    const { data, error } = await builder.order("created_at", { ascending: false }).limit(200);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as Row[])
      .filter((p) => p.resource)
      .map((p) => ({
        pinId: String(p.id),
        note: (p.note as string | null) ?? null,
        pinnedAt: String(p.created_at),
        resource: toResource(p.resource as Row),
      }));
  });

  app.post("/:id/pins", { preHandler: [...counselor, limit("resources:pins", 120, 60)] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const b = z
      .object({ studentId: uuid.optional(), collegeId: uuid.optional(), note: z.string().trim().max(500).optional() })
      .strict()
      .parse(request.body);
    if (!b.studentId === !b.collegeId) throw badRequest("Pin to a student or a college");
    const values: Row = { resource_id: id, note: b.note ?? null, counselor_id: request.auth.userId };
    if (b.studentId) values.student_id = await resolveStudentId(request, b.studentId, "edit");
    else {
      values.college_id = b.collegeId;
      values.firm_id = (await loadWorkspace(request)).firmId;
    }
    const { data, error } = await request.db.from("library_resource_pins").insert(values).select("id").single();
    if (error) throw fromPostgrest(error);
    return reply.code(201).send({ pinId: String((data as Row).id) });
  });

  app.delete("/pins/:pinId", { preHandler: [...counselor, limit("resources:pins", 120, 60)] }, async (request, reply) => {
    const { pinId } = z.object({ pinId: uuid }).parse(request.params);
    const { data, error } = await request.db.from("library_resource_pins").delete().eq("id", pinId).select("id");
    if (error) throw fromPostgrest(error);
    if (!data?.length) throw notFound("That pin doesn't exist");
    return reply.code(204).send();
  });

  /** A dated resource (Cal Grant, the UC filing period) onto a student's deadlines. */
  app.post("/:id/deadline", { preHandler: [...counselor, limit("resources:deadline", 120, 60)] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const b = z.object({ studentId: uuid }).strict().parse(request.body);
    const studentId = await resolveStudentId(request, b.studentId, "edit");
    const { data: res, error } = await request.db.from("library_resources").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!res) throw notFound("That resource doesn't exist");
    const r = toResource(res as unknown as Row);
    if (!r.closesOn) throw badRequest("That resource has no closing date to track");
    const { data, error: e2 } = await request.db
      .from("deadlines")
      .insert({
        student_id: studentId,
        title: r.title.slice(0, 200),
        type: r.category === "aid" ? "financial" : r.category === "testing" ? "test" : "application",
        due_date: r.closesOn,
        owner: "student",
      })
      .select("id")
      .single();
    if (e2) throw fromPostgrest(e2);
    return reply.code(201).send({ deadlineId: String((data as Row).id), dueDate: r.closesOn });
  });

  /**
   * "Which form do I need for Cal Grant?" Answered by cited web research over
   * the library's own sites, with the library rows given as context; the
   * answer says which library resources it rests on.
   */
  app.post("/ask", { preHandler: [...counselor, limit("resources:ask", 10, 60)] }, async (request) => {
    const b = z
      .object({ question: z.string().trim().min(5).max(500), state: z.string().regex(/^[A-Za-z]{2}$/).optional() })
      .strict()
      .parse(request.body);
    let builder = request.db.from("library_resources").select(COLUMNS).neq("link_status", "broken");
    if (b.state) builder = builder.or(`state_scope.is.null,state_scope.eq.${b.state.toUpperCase()}`);
    const { data, error } = await builder.limit(200);
    if (error) throw fromPostgrest(error);
    const rows = ((data ?? []) as unknown as Row[]).map(toResource);
    const context = rows
      .map((r) => `- ${r.title} | ${r.url} | ${r.description}${r.closesOn ? ` | closes ${r.closesOn}` : ""}${r.opensOn ? ` | opens ${r.opensOn}` : ""}`)
      .join("\n");
    const result = await runWebResearch({
      request,
      module: "resource-qa",
      question: b.question,
      context: `Meridies resource library${b.state ? ` (${b.state.toUpperCase()} and nationwide)` : ""}:\n${context}`,
      // The library's sites (link-only ones excluded: we don't read them) plus the official allow-list.
      domains: researchDomains(rows.filter((r) => !r.linkOnly).map((r) => r.url)),
      maxSearches: 4,
    });
    const host = (u: string) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    const citedHosts = new Set(result.sources.map((s) => host(s.url)));
    return {
      answer: result.parts.map((p) => ({ text: p.text, cited: p.citations.length > 0, citations: p.citations })),
      sources: result.sources,
      // Library resources on the sites the answer cites.
      resources: rows.filter((r) => citedHosts.has(host(r.url))).slice(0, 8),
      note: result.refused ? "That question couldn't be answered." : null,
    };
  });
}
