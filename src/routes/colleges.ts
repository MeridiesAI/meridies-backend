/**
 * The college catalog and the intelligence layered on it.
 *
 * Read-only on purpose. Every table behind these routes is maintained by
 * `service_role` and carries a SELECT-only policy — there is no client write
 * path to the catalog, and adding one here would be the wrong place to start.
 *
 * Provenance travels with the payload rather than being flattened away: a
 * curated Meridies judgement (major durability, program health, the aid
 * generosity ratings) has to be labelled differently from a sourced fact, and
 * the client can only do that if the distinction survives the API.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rankPercentile } from "../lib/classRank.js";
import { loadCollegePhotos, toCollegePhoto } from "../lib/collegePhotos.js";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { escapeIlike } from "../lib/collegesV10.js";
import { limit } from "../lib/limits.js";
import {
  toAidBandRating,
  toAidRating,
  toCdsFactor,
  toCollegeIntel,
  toCollegeMajor,
  toCourseRequirement,
  toHighSchoolRanking,
  toMajorAdmitStat,
  toRankBand,
  toRigorFlag,
} from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

export default async function collegeRoutes(app: FastifyInstance) {
  /**
   * The catalog reads that pull real volume — a scattergram is up to 2000 rows
   * — carry the DB-backed limiter as well as the in-process one. The single-row
   * lookups do not: a limiter round trip would cost more than the query it
   * guards.
   */
  const read = (name: string, max = 120) => [app.authenticate, limit(name, max, 60)];

  app.get("/colleges", { preHandler: read("colleges:list") }, async (request) => {
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
    if (q.search) builder = builder.ilike("name", `%${escapeIlike(q.search)}%`);
    if (q.state) builder = builder.eq("state", q.state.toUpperCase());

    const { data, error } = await builder.order("name").limit(q.limit ?? 50);
    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  /**
   * Everything a counselor needs on one card: the catalog row, the sourced
   * class profile, the school-level intel, what the CDS says actually counts,
   * school-wide course requirements and rigor flags, and the three curated aid
   * generosity ratings kept clearly separate from the reported aid figures.
   */
  app.get("/colleges/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);

    const [college, intel, stats, aid, rating, bandRatings, cds, requirements, flags, photos] =
      await Promise.all([
        request.db.from("colleges").select("*").eq("id", id).maybeSingle(),
        request.db.from("college_intel_profiles").select("*").eq("college_id", id).maybeSingle(),
        request.db
          .from("college_admission_stats")
          .select("*")
          .eq("college_id", id)
          .order("cohort_year", { ascending: false })
          .limit(10),
        request.db.from("college_aid_profiles").select("*").eq("college_id", id).maybeSingle(),
        request.db.from("college_aid_ratings").select("*").eq("college_id", id),
        request.db
          .from("college_aid_band_ratings")
          .select("*")
          .eq("college_id", id)
          .order("sort_order"),
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
        // Never throws: a missing table or a failed read is no photo.
        loadCollegePhotos(request.db, [id], request.log),
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
      /** The campus photo with its credit and license (lib/collegePhotos.ts); outside `college`, which is the raw row. */
      photo: toCollegePhoto(photos.get(id), String((college.data as Row).name ?? "")),
      intel: intel.data ? toCollegeIntel(intel.data as Row) : null,
      admissionStats: stats.data ?? [],
      aidProfile: aid.data ?? null,
      // Curated, and served under its own key so it cannot be mistaken for one
      // more reported statistic inside aidProfile. Three ratings, not one:
      // need-based, merit-based, and how *consistent* generosity is across
      // income bands — the third is only readable next to the band table below.
      aidRatings: (rating.data ?? []).map((r) => toAidRating(r as Row)),
      aidBandRatings: (bandRatings.data ?? []).map((r) => toAidBandRating(r as Row)),
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
  app.get("/colleges/:id/majors", { preHandler: read("colleges:majors") }, async (request) => {
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
    if (q.search) builder = builder.ilike("name", `%${escapeIlike(q.search)}%`);
    if (q.discipline) builder = builder.ilike("discipline", escapeIlike(q.discipline));
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

  app.get("/high-schools", { preHandler: read("high-schools:list") }, async (request) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        ceeb: z.string().trim().max(12).optional(),
      })
      .parse(request.query);

    let builder = request.db.from("high_schools").select("*");
    if (q.ceeb) builder = builder.eq("ceeb_code", q.ceeb);
    if (q.search) builder = builder.ilike("name", `%${escapeIlike(q.search)}%`);

    const { data, error } = await builder.order("name").limit(50);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toHighSchoolRanking(r as Row));
  });

  app.get("/high-schools/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    const [school, bands] = await Promise.all([
      request.db.from("high_schools").select("*").eq("id", id).maybeSingle(),
      request.db
        .from("high_school_rank_bands")
        .select("*")
        .eq("high_school_id", id)
        .order("min_weighted_gpa", { ascending: false }),
    ]);

    if (school.error) throw fromPostgrest(school.error);
    if (!school.data) throw notFound("That high school isn't in the catalog");

    return {
      ...toHighSchoolRanking(school.data as Row),
      rankBands: (bands.data ?? []).map((r) => toRankBand(r as Row)),
    };
  });

  /**
   * Where a weighted GPA sits, read against this school's own published bands.
   *
   * Returns `percentile: null` rather than a number whenever the school
   * publishes nothing, or the GPA falls below every band it does publish. A
   * national assumption wearing this school's name is worse than no answer,
   * because a counselor would repeat it to a family.
   */
  app.get("/high-schools/:id/rank", { preHandler: read("high-schools:rank", 240) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { weightedGpa } = z
      .object({ weightedGpa: z.coerce.number().min(0).max(20) })
      .parse(request.query);

    const [school, bands] = await Promise.all([
      request.db
        .from("high_schools")
        .select("id, name, ranking_practice, rank_transparency, reports_class_rank")
        .eq("id", id)
        .maybeSingle(),
      request.db
        .from("high_school_rank_bands")
        .select("*")
        .eq("high_school_id", id)
        .order("min_weighted_gpa", { ascending: false }),
    ]);

    if (school.error) throw fromPostgrest(school.error);
    if (!school.data) throw notFound("That high school isn't in the catalog");

    const rows = (bands.data ?? []).map((r) => toRankBand(r as Row));
    const read = rankPercentile(rows, weightedGpa);

    return {
      highSchoolId: id,
      weightedGpa,
      percentile: read?.percentile ?? null,
      band: read?.band ?? null,
      summary: read?.summary ?? null,
      // Why there is no number, in the school's own terms.
      unavailableReason: read
        ? null
        : rows.length === 0
          ? "This school publishes no GPA-to-rank bands"
          : "That GPA falls below every band this school publishes",
      rankingPractice: (school.data as Row).ranking_practice ?? null,
      rankTransparency: (school.data as Row).rank_transparency ?? null,
      rankBands: rows,
    };
  });

  // ---- The tables the scattergram reads -------------------------------------
  //
  // De-identified by construction: `scattergram_points` carries no student
  // reference at all, only a GPA, a score, an outcome and the high school it
  // came from. That is what makes it publishable inside the product.

  app.get("/colleges/:id/scattergram", { preHandler: read("colleges:scattergram") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const q = z
      .object({
        highSchoolId: z.string().uuid().optional(),
        cohortYear: z.coerce.number().int().min(1990).max(2100).optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
      })
      .parse(request.query);

    let builder = request.db.from("scattergram_points").select("*").eq("college_id", id);
    if (q.highSchoolId) builder = builder.eq("high_school_id", q.highSchoolId);
    if (q.cohortYear) builder = builder.eq("cohort_year", q.cohortYear);

    const { data, error } = await builder
      .order("cohort_year", { ascending: false })
      .limit(q.limit ?? 800);
    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  app.get("/colleges/:id/combined-programs", { preHandler: read("colleges:programs") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("combined_programs")
      .select("*")
      .eq("college_id", id)
      .order("name")
      .limit(100);
    if (error) throw fromPostgrest(error);
    return data ?? [];
  });
}
