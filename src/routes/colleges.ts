/**
 * The college catalog and the intelligence layered on it.
 *
 * Read-only on purpose. Every table behind these routes is maintained by
 * `service_role` and carries a SELECT-only policy — there is no client write
 * path to the catalog, and adding one here would be the wrong place to start.
 *
 * Provenance travels with the payload rather than being flattened away: a
 * curated Meridies judgement (major durability, program health, the aid
 * generosity rating) has to be labelled differently from a sourced fact, and
 * the client can only do that if the distinction survives the API.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import {
  toAidRating,
  toCdsFactor,
  toCollegeIntel,
  toCollegeMajor,
  toCourseRequirement,
  toHighSchoolRanking,
  toMajorAdmitStat,
  toRigorFlag,
} from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

export default async function collegeRoutes(app: FastifyInstance) {
  app.get("/colleges", { preHandler: app.authenticate }, async (request) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        state: z.string().trim().max(2).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(request.query);

    let builder = request.db
      .from("colleges")
      .select("id, name, slug, initials, brand_color, city, state, control, size, acceptance_rate, test_policy, website");
    if (q.search) builder = builder.ilike("name", `%${q.search}%`);
    if (q.state) builder = builder.eq("state", q.state.toUpperCase());

    const { data, error } = await builder.order("name").limit(q.limit ?? 50);
    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  /**
   * Everything a counselor needs on one card: the catalog row, the sourced
   * class profile, the school-level intel, what the CDS says actually counts,
   * school-wide course requirements and rigor flags, and the curated aid
   * generosity rating kept clearly separate from the reported aid figures.
   */
  app.get("/colleges/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);

    const [college, intel, stats, aid, rating, cds, requirements, flags] = await Promise.all([
      request.db.from("colleges").select("*").eq("id", id).maybeSingle(),
      request.db.from("college_intel_profiles").select("*").eq("college_id", id).maybeSingle(),
      request.db
        .from("college_admission_stats")
        .select("*")
        .eq("college_id", id)
        .order("cohort_year", { ascending: false })
        .limit(10),
      request.db.from("college_aid_profiles").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_aid_ratings").select("*").eq("college_id", id).maybeSingle(),
      request.db
        .from("college_cds_factors")
        .select("*")
        .eq("college_id", id)
        .order("cds_year", { ascending: false })
        .limit(60),
      request.db
        .from("college_course_requirements")
        .select("*")
        .eq("college_id", id)
        .is("college_major_id", null)
        .order("subject")
        .limit(100),
      request.db
        .from("college_rigor_flags")
        .select("*")
        .eq("college_id", id)
        .is("college_major_id", null)
        .order("severity")
        .limit(50),
    ]);

    if (college.error) throw fromPostgrest(college.error);
    if (!college.data) throw notFound("That college isn't in the catalog");

    const cdsRows = (cds.data ?? []) as Row[];
    const latestCdsYear = cdsRows.length
      ? Math.max(...cdsRows.map((r) => Number(r.cds_year ?? 0)))
      : null;
    const latestCds = cdsRows.filter((r) => Number(r.cds_year ?? 0) === latestCdsYear);

    return {
      college: college.data,
      intel: intel.data ? toCollegeIntel(intel.data as Row) : null,
      admissionStats: stats.data ?? [],
      aidProfile: aid.data ?? null,
      // Curated, and served under its own key so it cannot be mistaken for one
      // more reported statistic inside aidProfile.
      aidRating: rating.data ? toAidRating(rating.data as Row) : null,
      cdsFactors: latestCds.map((r) => toCdsFactor(r)),
      /** The two the brief singles out, pulled forward for the UI. */
      apWeight: latestCds.find((r) => r.factor === "ap-coursework")?.weight ?? null,
      ibWeight: latestCds.find((r) => r.factor === "ib-coursework")?.weight ?? null,
      classRankWeight: latestCds.find((r) => r.factor === "class-rank")?.weight ?? null,
      courseRequirements: (requirements.data ?? []).map((r) => toCourseRequirement(r as Row)),
      rigorFlags: (flags.data ?? []).map((r) => toRigorFlag(r as Row)),
    };
  });

  /**
   * Majors, with the per-major admit profile, requirements and rigor flags.
   * The university-wide acceptance rate is the number that misleads; this is
   * the one that answers "can this student get into THIS program".
   */
  app.get("/colleges/:id/majors", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        discipline: z.string().trim().max(100).optional(),
        admissionModel: z
          .enum(["direct-admit", "pre-major", "secondary-admission", "open"])
          .optional(),
      })
      .parse(request.query);

    let builder = request.db
      .from("college_majors")
      .select("*")
      .eq("college_id", id)
      .eq("is_active", true);
    if (q.search) builder = builder.ilike("name", `%${q.search}%`);
    if (q.discipline) builder = builder.ilike("discipline", q.discipline);
    if (q.admissionModel) builder = builder.eq("admission_model", q.admissionModel);

    const { data, error } = await builder.order("name").limit(300);
    if (error) throw fromPostgrest(error);

    const majors = (data ?? []) as Row[];
    if (majors.length === 0) return [];
    const majorIds = majors.map((m) => m.id as string);

    const [stats, requirements, flags] = await Promise.all([
      request.db
        .from("college_major_admit_stats")
        .select("*")
        .in("college_major_id", majorIds)
        .order("cohort_year", { ascending: false }),
      request.db
        .from("college_course_requirements")
        .select("*")
        .in("college_major_id", majorIds),
      request.db.from("college_rigor_flags").select("*").in("college_major_id", majorIds),
    ]);

    const group = <T>(rows: Row[], map: (r: Row) => T) => {
      const out = new Map<string, T[]>();
      for (const row of rows) {
        const key = row.college_major_id as string;
        if (!out.has(key)) out.set(key, []);
        out.get(key)!.push(map(row));
      }
      return out;
    };

    const statsBy = group((stats.data ?? []) as Row[], toMajorAdmitStat);
    const reqBy = group((requirements.data ?? []) as Row[], toCourseRequirement);
    const flagBy = group((flags.data ?? []) as Row[], toRigorFlag);

    return majors.map((m) => ({
      ...toCollegeMajor(m),
      admitStats: statsBy.get(m.id as string) ?? [],
      courseRequirements: reqBy.get(m.id as string) ?? [],
      rigorFlags: flagBy.get(m.id as string) ?? [],
    }));
  });

  // ---- High schools ---------------------------------------------------------
  //
  // The other half of the class-rank question. A college that calls class rank
  // "important" means something different for a student whose school ranks
  // internally and never tells the family.

  app.get("/high-schools", { preHandler: app.authenticate }, async (request) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        ceeb: z.string().trim().max(12).optional(),
      })
      .parse(request.query);

    let builder = request.db.from("high_schools").select("*");
    if (q.ceeb) builder = builder.eq("ceeb_code", q.ceeb);
    if (q.search) builder = builder.ilike("name", `%${q.search}%`);

    const { data, error } = await builder.order("name").limit(50);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toHighSchoolRanking(r as Row));
  });

  app.get("/high-schools/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("high_schools")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That high school isn't in the catalog");
    return toHighSchoolRanking(data as Row);
  });
}
