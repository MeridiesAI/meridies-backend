/**
 * Accessibility & Support for colleges (migration 20261127000003), under /colleges.
 *
 *   GET   /colleges/:id/accessibility            the shared record with the caller's practice edits on top
 *   POST  /colleges/:id/accessibility/research   read the college's own pages when the record is missing or stale
 *   PATCH /colleges/:id/accessibility/override   the practice's own edits (a Consultant; never the shared row)
 *
 * The shared record is public college data, so any signed-in user may read it; a practice's edits are read only by
 * that practice (RLS), so a student sees the shared record alone. The research job is lib/collegeAccessibility.ts.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, hasAnthropic } from "../env.js";
import { FAST_MODEL, runStructured } from "../lib/anthropic.js";
import { loadWorkspace } from "../lib/crm.js";
import {
  COLUMNS, applyOverridePatch, fixtureDeps, isStale, loadOverrides, mergeOverride, mergeResearch, overriddenFields,
  overrideBody, researchAccessibility, toRecord, type AccessibilityAnswer, type ResearchDeps,
} from "../lib/collegeAccessibility.js";
import { badRequest, HttpError, fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { fetchSitePage, type SitePage } from "../lib/links.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() }).strict();
const researchBody = z.object({ force: z.literal(true).optional() }).strict();

const notSwitchedOn = () => new HttpError(503, "Accessibility & Support isn't switched on yet", "accessibility_unavailable");

/** Colleges being researched right now in this process, so a second press doesn't start a second run. */
const inFlight = new Map<string, number>();
const RUN_TTL_MS = 3 * 60_000;
const running = (id: string): boolean => {
  const at = inFlight.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > RUN_TTL_MS) {
    inFlight.delete(id);
    return false;
  }
  return true;
};

export default async function collegeAccessibilityRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  async function readShared(request: FastifyRequest, id: string): Promise<Row | null> {
    const { data, error } = await request.db.from("college_accessibility").select(COLUMNS).eq("college_id", id).maybeSingle();
    if (error) {
      if (isResultsNotApplied(error)) throw notSwitchedOn();
      throw fromPostgrest(error);
    }
    return (data as Row | null) ?? null;
  }

  async function answer(request: FastifyRequest, id: string, shared: Row | null): Promise<AccessibilityAnswer> {
    const overrides = await loadOverrides(request, [id]);
    if (overrides === null) throw notSwitchedOn();
    const fields = overrides.get(id);
    return {
      record: mergeOverride(toRecord(shared), fields),
      overriddenFields: overriddenFields(fields),
      stale: isStale(shared),
      researching: running(id),
    };
  }

  async function requireCollege(request: FastifyRequest, id: string) {
    const { data, error } = await request.db.from("colleges").select("id, name, unitid, website").eq("id", id).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That college isn't in the catalog");
    return data as Row;
  }

  app.get("/:id/accessibility", { preHandler: [app.authenticate, limit("colleges:accessibility", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    return answer(request, id, await readShared(request, id));
  });

  app.post(
    "/:id/accessibility/research",
    { preHandler: [...counselor, limit("ai:college-accessibility", 12, 3600, "You're researching a lot of schools. Give it a few minutes.")] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = researchBody.parse(request.body ?? {});
      const college = await requireCollege(request, id);
      const existing = await readShared(request, id);
      if (running(id)) return answer(request, id, existing);
      if (!body.force && !isStale(existing)) return answer(request, id, existing);

      const fake = env.ACCESSIBILITY_FAKE === "fixture";
      if (!fake && !hasAnthropic) throw unavailable("AI features aren't configured yet. Set ANTHROPIC_API_KEY.");
      const svc = serviceClient();
      if (!svc) throw unavailable("Research needs the service role key.");
      const website = typeof college.website === "string" ? college.website : "";
      if (!fake && !website) throw badRequest(`We don't have ${String(college.name)}'s website on file, so there's nowhere to look.`);

      inFlight.set(id, Date.now());
      try {
        const name = String(college.name);
        let home: SitePage;
        let deps: ResearchDeps;
        if (fake) {
          ({ home, deps } = fixtureDeps({ name }));
        } else {
          home = await fetchSitePage(website);
          deps = {
            fetchPage: (u) => fetchSitePage(u),
            log: request.log,
            // The model call is the caller's own: their AI switch and quota (module college-accessibility).
            ai: (o) =>
              runStructured({
                request,
                module: "college-accessibility",
                model: FAST_MODEL,
                system: o.system,
                prompt: o.prompt,
                schema: o.schema,
                toolName: o.toolName,
                maxTokens: o.maxTokens,
                validate: o.validate,
              }),
          };
        }
        const outcome = await researchAccessibility({ name }, home, deps);
        const row = mergeResearch(existing, outcome.found, { id, unitid: college.unitid == null ? null : Number(college.unitid) }, outcome.pageUrls, new Date());
        const { error } = await svc.from("college_accessibility").upsert(row, { onConflict: "college_id" });
        if (error) {
          if (isResultsNotApplied(error)) throw notSwitchedOn();
          throw fromPostgrest(error);
        }
      } finally {
        inFlight.delete(id);
      }
      return answer(request, id, await readShared(request, id));
    }
  );

  app.patch(
    "/:id/accessibility/override",
    { preHandler: [...counselor, limit("colleges:accessibility-override", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const parsed = overrideBody.safeParse(request.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Check the fields and try again");
      await requireCollege(request, id);
      const ws = await loadWorkspace(request);

      let q = request.db.from("college_accessibility_overrides").select("id, fields").eq("college_id", id);
      q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null).eq("counselor_id", request.auth.userId);
      const found = await q.maybeSingle();
      if (found.error) {
        if (isResultsNotApplied(found.error)) throw notSwitchedOn();
        throw fromPostgrest(found.error);
      }
      const row = found.data as Row | null;
      const next = applyOverridePatch(row?.fields as Row | undefined, parsed.data.fields as Row);

      if (Object.keys(next).length === 0) {
        if (row) {
          const del = await request.db.from("college_accessibility_overrides").delete().eq("id", String(row.id));
          if (del.error) throw fromPostgrest(del.error);
        }
      } else if (row) {
        const upd = await request.db
          .from("college_accessibility_overrides")
          .update({ fields: next, updated_by: request.auth.userId })
          .eq("id", String(row.id));
        if (upd.error) throw fromPostgrest(upd.error);
      } else {
        const ins = await request.db.from("college_accessibility_overrides").insert({
          firm_id: ws.firmId,
          counselor_id: request.auth.userId,
          college_id: id,
          fields: next,
          updated_by: request.auth.userId,
        });
        if (ins.error) {
          if (isResultsNotApplied(ins.error)) throw notSwitchedOn();
          throw fromPostgrest(ins.error);
        }
      }
      return answer(request, id, await readShared(request, id));
    }
  );
}
