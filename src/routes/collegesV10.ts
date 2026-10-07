/**
 * Colleges, v8-v10 (registered under /colleges beside routes/colleges.ts).
 *
 *   GET    /colleges/search?q=            Search & research: ranked as the demo
 *                                          ranks it ("Co" -> Colgate, Columbia,
 *                                          Cornell), aliases included
 *   GET    /colleges/recommended          "Recommended based on your roster":
 *                                          schools on the caller's students'
 *                                          lists, with who put them there
 *   GET    /colleges/slug/:slug           a card by slug (the logo/photo key)
 *   GET    /colleges/compare?ids=a,b,...  Let's Compare: any number of schools
 *   GET    /colleges/:id/extras           profile facts, the curated admitted
 *                                          shape, CDS, rounds, programs, webinar
 *                                          advice
 *   GET    /colleges/:id/webinar-tips
 *   POST   /colleges/:id/webinar-tips
 *   PATCH  /colleges/webinar-tips/:tipId
 *   DELETE /colleges/webinar-tips/:tipId
 *   POST   /colleges/research/folder      where a pasted link or file goes:
 *                                          Policy & research › <School>
 *   GET    /colleges/list-builder/schools the schools the builder knows (map marks)
 *   POST   /colleges/list-builder         Build College Lists: Reach / Target /
 *                                          Safety for one student
 *
 * Catalog reads are open to any signed-in user, like routes/colleges.ts. The
 * roster, the research folder, tips and the list builder are counselor-only.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { findOrCreateChild, practiceFolder } from "../lib/practiceFolders.js";
import { toAidBandRating, toAidRating } from "../lib/serialize.js";
import {
  AID_FLOOR,
  AID_OPTIONS,
  COLLEGE_CARD_COLUMNS,
  DIVERSITY_OPTIONS,
  LIST_MILES,
  LOCATION_TYPES,
  SCHOOL_SIZES,
  buildList,
  decodeCursor,
  encodeCursor,
  roundsFrom,
  searchFilters,
  searchQuery,
  safeIlikeTerm,
  schoolIn,
  searchRank,
  sizeLabel,
  toAdmittedProfile,
  toCdsEdition,
  toCollegeCard,
  toAdmissionFactors,
  toApplicationRequirements,
  toCollegePolicies,
  toCollegeProgram,
  toFieldOfStudy,
  toListSchool,
  toMajorAdmitRate,
  toOfficialStats,
  toSearchStats,
  toProfileFacts,
  toWebinarTip,
  type Fit,
  type ListCriteria,
  type ListSchool,
} from "../lib/collegesV10.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const tipParam = z.object({ tipId: z.string().uuid() });

const tipBody = z
  .object({
    source: z.string().trim().min(1).max(200),
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    tip: z.string().trim().min(1).max(600),
    sourceUrl: z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u)).nullable().optional(),
    share: z.enum(["firm", "me"]).optional(),
  })
  .strict();

export const listCriteriaSchema = z
  .object({
    majors: z.array(z.string().trim().min(1).max(120)).max(12),
    sizes: z.array(z.enum(SCHOOL_SIZES.map((s) => s.label) as [string, ...string[]])).max(4),
    settings: z.array(z.enum(LOCATION_TYPES)).max(5),
    testOptional: z.enum(["Yes", "No"]).nullable(),
    miles: z.number().int().min(LIST_MILES.min).max(LIST_MILES.max),
    /** Where distance is measured from; null leaves distance out entirely. */
    origin: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        label: z.string().trim().min(1).max(120),
      })
      .strict()
      .nullable(),
    aid: z.enum(AID_OPTIONS),
    diversity: z.enum(DIVERSITY_OPTIONS),
  })
  .strict();

/** Every school with a list profile, joined to its catalog row and Meridies need rating. */
export async function loadListSchools(request: FastifyRequest): Promise<ListSchool[]> {
  const { data: lists, error } = await request.db.from("college_list_profiles").select("*").limit(5000);
  if (error) throw fromPostgrest(error);
  const listRows = (lists ?? []) as Row[];
  if (!listRows.length) return [];
  const ids = listRows.map((r) => String(r.college_id));
  const [colleges, ratings] = await Promise.all([
    request.db.from("colleges").select(COLLEGE_CARD_COLUMNS).in("id", ids),
    request.db.from("college_aid_ratings").select("college_id, rating").eq("kind", "need-based").in("college_id", ids),
  ]);
  if (colleges.error) throw fromPostgrest(colleges.error);
  if (ratings.error) throw fromPostgrest(ratings.error);
  const byId = new Map(((colleges.data ?? []) as unknown as Row[]).map((c) => [String(c.id), c]));
  const need = new Map(((ratings.data ?? []) as Row[]).map((r) => [String(r.college_id), Number(r.rating)]));
  return listRows
    .filter((l) => byId.has(String(l.college_id)))
    .map((l) => toListSchool(byId.get(String(l.college_id))!, l, need.get(String(l.college_id)) ?? null));
}

/** The student's own numbers the fit model reads: SAT (superscore, else the sum) and unweighted GPA. */
export async function studentNumbers(request: FastifyRequest, studentId: string) {
  const [academics, profile] = await Promise.all([
    request.db
      .from("student_academics")
      .select("gpa_unweighted, sat_superscore, sat_ebrw, sat_math")
      .eq("student_id", studentId)
      .maybeSingle(),
    request.db.from("profiles").select("id, full_name, profile, high_school").eq("id", studentId).maybeSingle(),
  ]);
  if (academics.error) throw fromPostgrest(academics.error);
  if (profile.error) throw fromPostgrest(profile.error);
  if (!profile.data) throw notFound("That student isn't on your roster");
  const a = (academics.data ?? {}) as Row;
  const sat =
    a.sat_superscore != null
      ? Number(a.sat_superscore)
      : a.sat_ebrw != null && a.sat_math != null
        ? Number(a.sat_ebrw) + Number(a.sat_math)
        : null;
  const p = ((profile.data as Row).profile ?? {}) as Record<string, unknown>;
  const majors = [
    ...(Array.isArray(p.intendedMajors) ? (p.intendedMajors as unknown[]).map(String) : []),
    ...(typeof p.intendedMajor === "string" ? [p.intendedMajor] : []),
  ]
    .map((m) => m.trim())
    .filter((m) => m && m.toLowerCase() !== "undecided");
  return {
    numbers: { sat, gpaUnweighted: a.gpa_unweighted != null ? Number(a.gpa_unweighted) : null },
    fullName: String((profile.data as Row).full_name ?? ""),
    intendedMajors: [...new Set(majors)],
  };
}


/** Income band the cards quote, as the demo's cards do. */
const CARD_BAND = "$75k–110k";

/**
 * What a college card shows beyond the catalog row: net price at the card's
 * band (sourced), the two curated generosity ratings, and for a school with no
 * profile, the list builder's SAT middle (estimated).
 */
async function cardExtras(request: FastifyRequest, ids: string[]) {
  const out = new Map<
    string,
    {
      netPrice: { band: string; priceCents: number } | null;
      needRating: number | null;
      meritRating: number | null;
      satMid: number | null;
    }
  >();
  if (!ids.length) return out;
  const [facts, ratings, lists] = await Promise.all([
    request.db.from("college_profile_facts").select("college_id, net_price_by_income").in("college_id", ids),
    request.db.from("college_aid_ratings").select("college_id, kind, rating").in("college_id", ids),
    request.db.from("college_list_profiles").select("college_id, sat_mid").in("college_id", ids),
  ]);
  for (const r of [facts, ratings, lists]) if (r.error) throw fromPostgrest(r.error);
  for (const id of ids) out.set(id, { netPrice: null, needRating: null, meritRating: null, satMid: null });
  for (const f of (facts.data ?? []) as Row[]) {
    const bands = Array.isArray(f.net_price_by_income) ? (f.net_price_by_income as { band: string; priceCents: number }[]) : [];
    out.get(String(f.college_id))!.netPrice = bands.find((b) => b.band === CARD_BAND) ?? bands[0] ?? null;
  }
  for (const r of (ratings.data ?? []) as Row[]) {
    const e = out.get(String(r.college_id))!;
    if (r.kind === "need-based") e.needRating = Number(r.rating);
    if (r.kind === "merit-based") e.meritRating = Number(r.rating);
  }
  for (const l of (lists.data ?? []) as Row[]) {
    out.get(String(l.college_id))!.satMid = l.sat_mid == null ? null : Number(l.sat_mid);
  }
  return out;
}

const PER_TIER_MAX = 12;

export default async function collegeV10Routes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  // ---- Search & research --------------------------------------------------------

  app.get("/search", { preHandler: [app.authenticate, limit("colleges:search", 240, 60)] }, async (request, reply) => {
    const q = searchQuery.parse(request.query);
    const term = safeIlikeTerm(q.q);
    const filters = searchFilters(q);
    // Unchanged from before: no words and no filters is no search.
    if (!term && Object.keys(filters).length === 0) return [];

    if (q.studentId || q.fit) {
      if (!q.studentId) throw badRequest("fit needs studentId");
      if (request.profile.role !== "counselor") throw badRequest("Only counselors can rank schools for a student");
      const { numbers } = await studentNumbers(request, q.studentId);
      filters.student = { sat: numbers.sat, gpa: numbers.gpaUnweighted };
    }

    const offset = q.cursor ? decodeCursor(q.cursor) : 0;
    const pageSize = q.limit ?? 48;
    const { data, error } = await request.db.rpc("search_colleges", {
      p_q: term,
      p_filters: filters,
      p_sort: q.sort ?? null,
      p_limit: pageSize,
      p_offset: offset,
    });
    if (error) throw fromPostgrest(error);
    const hits = (data ?? []) as Row[];
    const total = hits.length ? Number(hits[0].total_count) : 0;
    reply.header("X-Total-Count", String(total));
    if (offset + hits.length < total) reply.header("X-Next-Cursor", encodeCursor(offset + hits.length));
    if (!hits.length) return [];

    const ids = hits.map((h) => String(h.college_id));
    const [cards, withFacts, stats] = await Promise.all([
      request.db.from("colleges").select(COLLEGE_CARD_COLUMNS).in("id", ids),
      request.db.from("college_profile_facts").select("college_id").in("college_id", ids),
      request.db
        .from("college_stats")
        .select("college_id, admit_rate, sat_total_25, sat_total_75, act_25, act_75, avg_net_price, net_price_by_income, undergrad_enrollment, source_verified_at, data_year")
        .in("college_id", ids),
    ]);
    for (const r of [cards, withFacts, stats]) if (r.error) throw fromPostgrest(r.error);
    const byId = new Map(((cards.data ?? []) as unknown as Row[]).map((r) => [String(r.id), r]));
    const profiled = new Set(((withFacts.data ?? []) as Row[]).map((r) => String(r.college_id)));
    const statsById = new Map(((stats.data ?? []) as Row[]).map((r) => [String(r.college_id), r]));
    const extras = await cardExtras(request, ids);

    return hits
      .filter((h) => byId.has(String(h.college_id)))
      .map((h) => {
        const id = String(h.college_id);
        const card = toCollegeCard(byId.get(id)!);
        const st = statsById.get(id);
        return {
          ...card,
          ...extras.get(id)!,
          profiled: profiled.has(id),
          // How it matched: 0 exact, 1 name prefix, 2 word prefix, 3 close spelling, 4 text, 5 major, 6 browse.
          matchTier: Number(h.match_tier),
          miles: h.miles == null ? null : Number(h.miles),
          // A Meridies estimate from the student's numbers against the school's
          // published ranges, never a published figure.
          fit: (h.fit as Fit | null) ?? null,
          odds: h.odds == null ? null : Number(h.odds),
          fitSource: h.fit == null ? null : ("meridies-estimate" as const),
          official: st ? toSearchStats(st) : null,
        };
      });
  });

  /** Filter values and how many schools have each, for the search panel. */
  app.get("/filters", { preHandler: [app.authenticate, limit("colleges:filters", 60, 60)] }, async (request) => {
    const { data, error } = await request.db.rpc("college_search_facets");
    if (error) throw fromPostgrest(error);
    return data;
  });

  /**
   * Schools on the roster's lists, most-listed first, with who put them there.
   * Profiled schools nobody lists yet follow, so a new practice still sees the
   * catalog rather than an empty page.
   */
  app.get("/recommended", { preHandler: [...counselor, limit("colleges:recommended", 60, 60)] }, async (request) => {
    const [students, profiled] = await Promise.all([
      request.db.from("profiles").select("id, full_name").eq("role", "student").eq("counselor_id", request.auth.userId).limit(2000),
      request.db.from("college_profile_facts").select("college_id").limit(500),
    ]);
    if (students.error) throw fromPostgrest(students.error);
    if (profiled.error) throw fromPostgrest(profiled.error);

    const names = new Map(((students.data ?? []) as Row[]).map((s) => [String(s.id), String(s.full_name ?? "")]));
    // Only this roster's lists, by student id, rather than every list RLS lets through.
    const rosterIds = [...names.keys()];
    const listRows: Row[] = [];
    for (let i = 0; i < rosterIds.length; i += 200) {
      const { data, error } = await request.db
        .from("student_colleges")
        .select("student_id, college_id, name")
        .in("student_id", rosterIds.slice(i, i + 200))
        .limit(5000);
      if (error) throw fromPostgrest(error);
      listRows.push(...((data ?? []) as Row[]));
    }

    // Rows a counselor typed by hand carry no college_id: match just those names
    // in Postgres (exact name or alias first, then close spelling).
    const typed = [...new Set(listRows.filter((r) => !r.college_id && r.name).map((r) => String(r.name)))].slice(0, 500);
    const byName = new Map<string, string>();
    if (typed.length) {
      const { data: matches, error } = await request.db.rpc("match_college_names", { p_names: typed });
      if (error) throw fromPostgrest(error);
      for (const m of (matches ?? []) as Row[]) if (m.college_id) byName.set(String(m.name).toLowerCase(), String(m.college_id));
    }

    const byCollege = new Map<string, { id: string; name: string }[]>();
    for (const r of listRows) {
      const cid = (r.college_id as string | null) ?? byName.get(String(r.name ?? "").toLowerCase()) ?? null;
      if (!cid) continue;
      const list = byCollege.get(cid) ?? [];
      const sid = String(r.student_id);
      if (!list.some((s) => s.id === sid)) list.push({ id: sid, name: names.get(sid) ?? "" });
      byCollege.set(cid, list);
    }
    for (const p of (profiled.data ?? []) as Row[]) {
      if (!byCollege.has(String(p.college_id))) byCollege.set(String(p.college_id), []);
    }
    const ids = [...byCollege.keys()];
    if (!ids.length) return [];
    const { data: cards, error: e2 } = await request.db.from("colleges").select(COLLEGE_CARD_COLUMNS).in("id", ids);
    if (e2) throw fromPostgrest(e2);
    const profiledIds = new Set(((profiled.data ?? []) as Row[]).map((p) => String(p.college_id)));
    const extras = await cardExtras(request, ids);
    return ((cards ?? []) as unknown as Row[])
      .map((r) => {
        const card = toCollegeCard(r);
        return {
          ...card,
          ...extras.get(card.id)!,
          profiled: profiledIds.has(card.id),
          students: byCollege.get(card.id) ?? [],
        };
      })
      .sort((a, b) => b.students.length - a.students.length || a.name.localeCompare(b.name));
  });

  app.get("/slug/:slug", { preHandler: app.authenticate }, async (request) => {
    const { slug } = z.object({ slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/) }).parse(request.params);
    const { data, error } = await request.db.from("colleges").select(COLLEGE_CARD_COLUMNS).eq("slug", slug).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That college isn't in the catalog");
    return toCollegeCard(data as unknown as Row);
  });

  // ---- Compare -------------------------------------------------------------------

  app.get("/compare", { preHandler: [app.authenticate, limit("colleges:compare", 120, 60)] }, async (request) => {
    const { ids } = z.object({ ids: z.string().trim().min(1).max(2000) }).parse(request.query);
    const list = [...new Set(ids.split(",").map((s) => s.trim()).filter(Boolean))];
    if (list.length > 12) throw badRequest("Compare up to 12 schools at a time");
    if (list.some((id) => !z.string().uuid().safeParse(id).success)) throw badRequest("ids takes college ids");

    const [colleges, facts, aid, ratings, bands, admitted, lists] = await Promise.all([
      request.db.from("colleges").select("*").in("id", list),
      request.db.from("college_profile_facts").select("*").in("college_id", list),
      request.db.from("college_aid_profiles").select("*").in("college_id", list),
      request.db.from("college_aid_ratings").select("*").in("college_id", list),
      request.db.from("college_aid_band_ratings").select("*").in("college_id", list).order("sort_order"),
      request.db.from("college_admitted_profiles").select("*").in("college_id", list),
      request.db.from("college_list_profiles").select("college_id, campus_setting").in("college_id", list),
    ]);
    for (const r of [colleges, facts, aid, ratings, bands, admitted, lists]) if (r.error) throw fromPostgrest(r.error);

    const by = (rows: unknown) => {
      const m = new Map<string, Row[]>();
      for (const r of (rows ?? []) as Row[]) {
        const k = String(r.college_id);
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return m;
    };
    const f = by(facts.data);
    const a = by(aid.data);
    const rt = by(ratings.data);
    const bd = by(bands.data);
    const ad = by(admitted.data);
    const ls = by(lists.data);
    const rows = new Map(((colleges.data ?? []) as Row[]).map((c) => [String(c.id), c]));

    // In the order asked, so the columns stay where the counselor put them.
    return list
      .filter((id) => rows.has(id))
      .map((id) => {
        const c = rows.get(id)!;
        return {
          college: { ...toCollegeCard(c), applicationFeeCents: c.application_fee_cents ?? null },
          facts: f.get(id)?.[0] ? toProfileFacts(f.get(id)![0]) : null,
          campusSetting: (f.get(id)?.[0]?.campus_setting as string | undefined) ?? (ls.get(id)?.[0]?.campus_setting as string | undefined) ?? null,
          aidProfile: a.get(id)?.[0] ?? null,
          // Curated, kept apart from the reported aid figures above.
          aidRatings: (rt.get(id) ?? []).map(toAidRating),
          aidBandRatings: (bd.get(id) ?? []).map(toAidBandRating),
          admittedProfile: ad.get(id)?.[0] ? toAdmittedProfile(ad.get(id)![0]) : null,
          rounds: roundsFrom(c.deadlines),
        };
      });
  });

  // ---- Profile extras ---------------------------------------------------------------

  app.get("/:id/extras", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    const counselorView = request.profile.role === "counselor";
    const [college, facts, admitted, cds, programs, tips, listProfile, supplements, stats, factors, majors, policies, requirements, majorAdmits] = await Promise.all([
      request.db.from("colleges").select("id, name, website, deadlines").eq("id", id).maybeSingle(),
      request.db.from("college_profile_facts").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_admitted_profiles").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_cds_editions").select("*").eq("college_id", id).order("edition", { ascending: false }).limit(5),
      request.db.from("college_programs").select("*").eq("college_id", id).order("kind").order("sort_order").limit(100),
      counselorView
        ? request.db
            .from("college_webinar_tips")
            .select("*")
            .eq("college_id", id)
            .order("session_date", { ascending: false, nullsFirst: false })
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] as Row[], error: null }),
      request.db.from("college_list_profiles").select("campus_setting").eq("college_id", id).maybeSingle(),
      // The school's published prompts (student-application's catalog table),
      // newest cycle first; only the latest cycle is shown.
      request.db
        .from("college_supplements")
        .select("admission_cycle, title, prompt, word_limit, required, sort_order, source_url")
        .eq("college_id", id)
        .order("admission_cycle", { ascending: false })
        .order("sort_order")
        .limit(40),
      request.db.from("college_stats").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_admission_factors").select("*").eq("college_id", id).maybeSingle(),
      // Bachelor's programs, most awarded first.
      request.db
        .from("college_fields_of_study")
        .select("cip_code, title, credential_level, awards, earnings_4yr, median_debt")
        .eq("college_id", id)
        .eq("credential_level", 3)
        .order("awards", { ascending: false, nullsFirst: false })
        .limit(150),
      request.db.from("college_policies").select("*").eq("college_id", id).maybeSingle(),
      request.db.from("college_application_requirements").select("*").eq("college_id", id).order("cycle", { ascending: false }).limit(1),
      request.db
        .from("college_major_admit_rates")
        .select("*")
        .eq("college_id", id)
        .order("entry_year", { ascending: false })
        .order("major")
        .limit(300),
    ]);
    if (college.error) throw fromPostgrest(college.error);
    if (!college.data) throw notFound("That college isn't in the catalog");
    for (const r of [facts, admitted, cds, programs, tips, listProfile, supplements, stats, factors, majors, policies, requirements, majorAdmits]) {
      if (r.error) throw fromPostgrest(r.error);
    }
    const supplementRows = (supplements.data ?? []) as Row[];
    const latestCycle = supplementRows[0]?.admission_cycle ?? null;

    const c = college.data as Row;
    const programRows = ((programs.data ?? []) as Row[]).map(toCollegeProgram);
    const editions = ((cds.data ?? []) as Row[]).map(toCdsEdition);
    const site = String(c.website ?? "").replace(/^https?:\/\//, "").split("/")[0];
    return {
      collegeId: id,
      // Federal figures (College Scorecard, IPEDS), each with its data year and
      // a stale flag; kept apart from the curated facts below.
      official: {
        stats: stats.data ? toOfficialStats(stats.data as Row) : null,
        admissionFactors: factors.data ? toAdmissionFactors(factors.data as Row) : null,
        majors: ((majors.data ?? []) as Row[]).map(toFieldOfStudy),
      },
      // Curated by Meridies from College Board, Common App, UC/CSU and the
      // schools' own pages, each field with its source.
      policies: policies.data ? toCollegePolicies(policies.data as Row) : null,
      applicationRequirements: ((requirements.data ?? []) as Row[])[0] ? toApplicationRequirements((requirements.data as Row[])[0]) : null,
      majorAdmitRates: ((majorAdmits.data ?? []) as Row[]).map(toMajorAdmitRate),
      facts: facts.data ? toProfileFacts(facts.data as Row) : null,
      campusSetting:
        ((facts.data as Row | null)?.campus_setting as string | undefined) ??
        ((listProfile.data as Row | null)?.campus_setting as string | undefined) ??
        null,
      // Curated Meridies shape, labelled by ratingKind.
      admittedProfile: admitted.data ? toAdmittedProfile(admitted.data as Row) : null,
      cds: editions[0] ?? null,
      cdsEditions: editions,
      // No published address on file: a search of the school's own site, which
      // the UI says it is rather than presenting as the CDS itself.
      cdsSearchUrl: editions[0]
        ? null
        : `https://www.google.com/search?q=${encodeURIComponent(`${c.name} common data set${site ? ` site:${site}` : ""}`)}`,
      rounds: roundsFrom(c.deadlines),
      programs: {
        combined: programRows.filter((p) => p.kind === "combined"),
        special: programRows.filter((p) => p.kind === "special"),
      },
      webinarTips: ((tips.data ?? []) as Row[]).map((t) => toWebinarTip(t, request.auth.userId)),
      supplementCycle: latestCycle == null ? null : String(latestCycle),
      supplements: supplementRows
        .filter((r) => r.admission_cycle === latestCycle)
        .map((r) => ({
          title: String(r.title),
          prompt: String(r.prompt),
          wordLimit: r.word_limit == null ? null : Number(r.word_limit),
          required: Boolean(r.required),
          sourceUrl: (r.source_url as string | null) ?? null,
        })),
    };
  });

  // ---- Webinar advice ------------------------------------------------------------

  app.get("/:id/webinar-tips", { preHandler: [...counselor, limit("colleges:tips", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("college_webinar_tips")
      .select("*")
      .eq("college_id", id)
      .order("session_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as Row[]).map((t) => toWebinarTip(t, request.auth.userId));
  });

  app.post("/:id/webinar-tips", { preHandler: [...counselor, limit("colleges:tips:create", 60, 60)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = tipBody.parse(request.body);
    const share = b.share ?? (request.profile.firm_id ? "firm" : "me");
    if (share === "firm" && !request.profile.firm_id) throw badRequest("You aren't in a firm, so keep it to yourself");

    const { data: college } = await request.db.from("colleges").select("id").eq("id", id).maybeSingle();
    if (!college) throw notFound("That college isn't in the catalog");

    const { data, error } = await request.db
      .from("college_webinar_tips")
      .insert({
        college_id: id,
        source: b.source,
        session_date: b.sessionDate ?? null,
        tip: b.tip,
        source_url: b.sourceUrl ?? null,
        firm_id: share === "firm" ? request.profile.firm_id : null,
        created_by: request.auth.userId,
      })
      .select("*")
      .single();
    if (error) throw fromPostgrest(error);
    return reply.code(201).send(toWebinarTip(data as Row, request.auth.userId));
  });

  app.patch("/webinar-tips/:tipId", { preHandler: [...counselor, limit("colleges:tips:update", 240, 60)] }, async (request) => {
    const { tipId } = tipParam.parse(request.params);
    const b = tipBody.partial().parse(request.body);
    const update: Row = {};
    if (b.source !== undefined) update.source = b.source;
    if (b.sessionDate !== undefined) update.session_date = b.sessionDate;
    if (b.tip !== undefined) update.tip = b.tip;
    if (b.sourceUrl !== undefined) update.source_url = b.sourceUrl;
    if (b.share !== undefined) {
      if (b.share === "firm" && !request.profile.firm_id) throw badRequest("You aren't in a firm");
      update.firm_id = b.share === "firm" ? request.profile.firm_id : null;
    }
    const { data, error } = await request.db
      .from("college_webinar_tips")
      .update(update)
      .eq("id", tipId)
      .eq("created_by", request.auth.userId)
      .select("*")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That note isn't yours to edit");
    return toWebinarTip(data as Row, request.auth.userId);
  });

  app.delete("/webinar-tips/:tipId", { preHandler: [...counselor, limit("colleges:tips:delete", 120, 60)] }, async (request) => {
    const { tipId } = tipParam.parse(request.params);
    const { data, error } = await request.db
      .from("college_webinar_tips")
      .delete()
      .eq("id", tipId)
      .eq("created_by", request.auth.userId)
      .select("id");
    if (error) throw fromPostgrest(error);
    if (!data || data.length === 0) throw notFound("That note isn't yours to delete");
    return { deleted: true };
  });

  // ---- Research filing -------------------------------------------------------------

  /**
   * Context management (v8): a counselor's own research goes into Files ›
   * Policy & research, in a folder for the school it is about ("General" when
   * no school is named). This resolves the folder; the client then adds the
   * link (POST /files/links) or uploads the file (POST /files/documents) into
   * it, so the existing read, LLM-availability and storage rules apply.
   */
  app.post("/research/folder", { preHandler: [...counselor, limit("colleges:research:file", 60, 60)] }, async (request) => {
    const b = z
      .object({
        url: z.string().trim().min(4).max(2000).optional(),
        filename: z.string().trim().min(1).max(300).optional(),
      })
      .strict()
      .refine((x) => x.url || x.filename, "Give a link or a file name")
      .parse(request.body);

    const { data: catalog, error } = await request.db.from("colleges").select("id, name, aka, website").limit(5000);
    if (error) throw fromPostgrest(error);
    const school = schoolIn(
      b.url ?? b.filename ?? "",
      ((catalog ?? []) as Row[]).map((c) => ({
        id: String(c.id),
        name: String(c.name),
        aka: (c.aka as string[] | null) ?? [],
        website: (c.website as string | null) ?? null,
      }))
    );

    const root = await practiceFolder(request, "policy-research");
    const { folder, created } = await findOrCreateChild(request, String(root.id), school?.name ?? "General");
    return {
      school: school?.name ?? "General",
      collegeId: school?.id ?? null,
      folderId: String(folder.id),
      folderName: String(folder.name),
      parentFolderId: String(root.id),
      parentFolderName: String(root.name),
      created,
    };
  });

  // ---- Build College Lists ------------------------------------------------------------

  app.get("/list-builder/schools", { preHandler: [...counselor, limit("colleges:list-schools", 60, 60)] }, async (request) => {
    const schools = await loadListSchools(request);
    return schools.map((s) => ({
      collegeId: s.collegeId,
      slug: s.slug,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
    }));
  });

  /** The form's starting answers for one student: their own majors, nothing else assumed. */
  app.get("/list-builder/defaults", { preHandler: [...counselor, limit("colleges:list-defaults", 120, 60)] }, async (request) => {
    const { studentId } = z.object({ studentId: z.string().uuid() }).parse(request.query);
    await resolveStudentId(request, studentId, "view");
    const s = await studentNumbers(request, studentId);
    const criteria: ListCriteria = {
      majors: s.intendedMajors,
      sizes: [],
      settings: [],
      testOptional: null,
      miles: 500,
      origin: null,
      aid: "No preference",
      diversity: "No preference",
    };
    return { criteria, student: { id: studentId, fullName: s.fullName, ...s.numbers } };
  });

  /**
   * Reach / Target / Safety for one student, re-run on every answer. The fit
   * is the school's published admit rate moved by where this student's SAT and
   * unweighted GPA sit against the school's middle; a school with no published
   * rate has no odds and sits under Reach. Constraints are loosened in a fixed
   * order when nothing matches, and the response says which.
   */
  app.post("/list-builder", { preHandler: [...counselor, limit("colleges:list-builder", 240, 60)] }, async (request) => {
    const b = z
      .object({
        studentId: z.string().uuid(),
        criteria: listCriteriaSchema,
        perTier: z.number().int().min(1).max(PER_TIER_MAX).optional(),
        offset: z.number().int().min(0).max(1000).optional(),
        exclude: z.array(z.string().uuid()).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    await resolveStudentId(request, b.studentId, "view");

    const [student, schools] = await Promise.all([studentNumbers(request, b.studentId), loadListSchools(request)]);
    const excluded = new Set(b.exclude ?? []);
    const { picks, relaxed } = buildList(
      student.numbers,
      schools.filter((s) => !excluded.has(s.collegeId)),
      b.criteria as ListCriteria
    );

    const perTier = b.perTier ?? 4;
    const tiers = (["reach", "target", "likely"] as const).map((fit) => {
      const all = picks.filter((p) => p.fit === fit);
      const start = all.length > perTier ? (b.offset ?? 0) % all.length : 0;
      const shown = [...all.slice(start), ...all.slice(0, start)].slice(0, perTier);
      return {
        fit,
        heading: fit === "likely" ? "Safety" : fit === "reach" ? "Reach" : "Target",
        total: all.length,
        schools: shown.map((p) => ({
          collegeId: p.school.collegeId,
          slug: p.school.slug,
          name: p.school.name,
          initials: p.school.initials,
          brandColor: p.school.brandColor,
          city: p.school.city,
          state: p.school.state,
          website: p.school.website,
          miles: p.miles,
          size: sizeLabel(p.school.undergrads),
          setting: p.school.setting,
          testPolicy: p.school.testPolicy,
          regularDeadline: p.school.regularDeadline,
          fit: p.fit,
        })),
      };
    });

    return {
      student: { id: b.studentId, fullName: student.fullName },
      matched: picks.length,
      relaxed,
      aidNote:
        b.criteria.aid in AID_FLOOR && !relaxed.includes("Financial aid")
          ? `Aid is read from the Meridies need-based rating (${AID_FLOOR[b.criteria.aid]} or higher).`
          : null,
      distanceApplied: b.criteria.origin !== null,
      tiers,
    };
  });
}
