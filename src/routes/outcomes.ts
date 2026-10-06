/**
 * Admission outcomes, Close cycle and alumni (demo v7, `lib/outcomes.ts`,
 * `lib/alumni.ts`).
 *
 * Outcomes are practice data: counselor and firm, never the student. Close
 * cycle is one database transaction (`close_admission_cycle`, SECURITY
 * INVOKER, so RLS scopes it to the caller's roster): it records the decisions
 * already on each senior's college list, locks the cycle's rows, and turns the
 * seniors into alumni. It never scripts a result the way the demo does.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { assertCanEditStudent, assertCanViewStudent, requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  HOOKS,
  OUTCOME_COLUMNS,
  RESULTS,
  ROUNDS,
  cdsRanges,
  classOfCycle,
  cycleFor,
  historyLine,
  outcomesForHighSchool,
  summarize,
  toOutcome,
  unexpected,
} from "../lib/outcomes.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const cycleSchema = z.string().regex(/^\d{4}-\d{4}$/, "A cycle reads like 2026-2027");

const outcomeFields = {
  studentId: z.string().uuid().nullable(),
  studentName: z.string().trim().min(1).max(200).nullable(),
  highSchoolName: z.string().trim().min(1).max(200),
  cycle: cycleSchema,
  collegeId: z.string().uuid().nullable(),
  collegeName: z.string().trim().min(1).max(300),
  round: z.enum(ROUNDS),
  result: z.enum(RESULTS),
  enrolled: z.boolean(),
  gpaUnweighted: z.number().min(0).max(10).nullable(),
  gpaWeighted: z.number().min(0).max(10).nullable(),
  sat: z.number().int().min(400).max(1600).nullable(),
  act: z.number().int().min(1).max(36).nullable(),
  hooks: z.array(z.enum(HOOKS)).max(5),
  intendedMajor: z.string().trim().max(200).nullable(),
};

const createSchema = z
  .object(outcomeFields)
  .partial()
  .required({ collegeName: true, result: true })
  .strict();
const patchSchema = z.object(outcomeFields).partial().strict();

function toColumns(b: z.infer<typeof patchSchema>): Row {
  const u: Row = {};
  if (b.studentId !== undefined) u.student_id = b.studentId;
  if (b.studentName !== undefined) u.student_name = b.studentName;
  if (b.highSchoolName !== undefined) u.high_school_name = b.highSchoolName;
  if (b.cycle !== undefined) u.cycle = b.cycle;
  if (b.collegeId !== undefined) u.college_id = b.collegeId;
  if (b.collegeName !== undefined) u.college_name = b.collegeName;
  if (b.round !== undefined) u.round = b.round;
  if (b.result !== undefined) u.result = b.result;
  if (b.enrolled !== undefined) u.enrolled = b.enrolled;
  if (b.gpaUnweighted !== undefined) u.gpa_unweighted = b.gpaUnweighted;
  if (b.gpaWeighted !== undefined) u.gpa_weighted = b.gpaWeighted;
  if (b.sat !== undefined) u.sat = b.sat;
  if (b.act !== undefined) u.act = b.act;
  if (b.hooks !== undefined) u.hooks = b.hooks;
  if (b.intendedMajor !== undefined) u.intended_major = b.intendedMajor;
  return u;
}

/** The lock guard and the cycle function raise readable messages; keep them. */
function fromOutcomeError(error: { code?: string; message?: string }): HttpError {
  const message = error.message?.replace(/^ERROR:\s*/i, "") ?? "";
  if (/closed cycle|already closed/i.test(message)) return conflict(message);
  if (/cycle reads like/i.test(message)) return badRequest(message);
  if (error.code === "23514" && /enrolled/i.test(message)) {
    return badRequest("Only an admission can be marked enrolled");
  }
  return fromPostgrest(error);
}

async function myFirm(request: FastifyRequest): Promise<string | null> {
  const firm = (request.profile as unknown as { firm_id?: string | null }).firm_id;
  return firm ?? null;
}

export default async function outcomeRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [...counselor, limit("outcomes:list", 120, 60)] }, async (request) => {
    const q = z
      .object({ studentId: z.string().uuid().optional(), cycle: cycleSchema.optional() })
      .parse(request.query);
    if (q.studentId) await assertCanViewStudent(request, q.studentId);
    let query = request.db.from("admission_outcomes").select(OUTCOME_COLUMNS);
    if (q.studentId) query = query.eq("student_id", q.studentId);
    if (q.cycle) query = query.eq("cycle", q.cycle);
    const { data, error } = await query.order("cycle", { ascending: false }).order("college_name").limit(2000);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as unknown as Row[]).map(toOutcome);
  });

  app.post("/", { preHandler: [...counselor, limit("outcomes:write", 120, 60)] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const insert: Row = {
      ...toColumns(body),
      counselor_id: request.auth.userId,
      firm_id: await myFirm(request),
      cycle: body.cycle ?? cycleFor(),
      round: body.round ?? "RD",
    };

    // A row about a student on the roster: fill what the record already says.
    if (body.studentId) {
      await assertCanEditStudent(request, body.studentId);
      const [profile, academics] = await Promise.all([
        request.db.from("profiles").select("full_name, high_school").eq("id", body.studentId).maybeSingle(),
        request.db
          .from("student_academics")
          .select("gpa_weighted, gpa_unweighted, sat_superscore, act_composite")
          .eq("student_id", body.studentId)
          .maybeSingle(),
      ]);
      if (profile.error) throw fromPostgrest(profile.error);
      if (academics.error) throw fromPostgrest(academics.error);
      const p = profile.data as Row | null;
      const a = academics.data as Row | null;
      insert.student_name ??= p?.full_name ?? null;
      insert.high_school_name ??= p?.high_school ?? null;
      if (body.gpaWeighted === undefined) insert.gpa_weighted = a?.gpa_weighted ?? null;
      if (body.gpaUnweighted === undefined) insert.gpa_unweighted = a?.gpa_unweighted ?? null;
      if (body.sat === undefined) insert.sat = a?.sat_superscore ?? null;
      if (body.act === undefined) insert.act = a?.act_composite ?? null;
    }
    if (!insert.high_school_name) throw badRequest("Add the student's high school");

    const { data, error } = await request.db
      .from("admission_outcomes")
      .insert(insert)
      .select(OUTCOME_COLUMNS)
      .single();
    if (error) throw fromOutcomeError(error);
    return reply.code(201).send(toOutcome(data as unknown as Row));
  });

  app.patch("/:id", { preHandler: [...counselor, limit("outcomes:write", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchSchema.parse(request.body);
    if (body.studentId) await assertCanEditStudent(request, body.studentId);
    const update = toColumns(body);
    if (Object.keys(update).length === 0) throw badRequest("Nothing to change");
    const { data, error } = await request.db
      .from("admission_outcomes")
      .update(update)
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select(OUTCOME_COLUMNS)
      .maybeSingle();
    if (error) throw fromOutcomeError(error);
    if (!data) throw notFound("No outcome of yours matches that");
    return toOutcome(data as unknown as Row);
  });

  app.delete("/:id", { preHandler: [...counselor, limit("outcomes:write", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("admission_outcomes")
      .delete()
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select("id")
      .maybeSingle();
    if (error) throw fromOutcomeError(error);
    if (!data) throw notFound("No outcome of yours matches that");
    return { deleted: true };
  });

  /**
   * The current cycle, whether it is closed, and how many seniors closing it
   * would turn into alumni — the numbers the Close cycle confirm states.
   */
  app.get("/cycles", { preHandler: [...counselor, limit("outcomes:cycles", 120, 60)] }, async (request) => {
    const current = cycleFor();
    const [closed, seniors, alumni] = await Promise.all([
      request.db
        .from("admission_cycles")
        .select("cycle, closed_at, alumni_count, rows_recorded, rows_locked")
        .eq("counselor_id", request.auth.userId)
        .order("cycle", { ascending: false }),
      request.db
        .from("profiles")
        .select("id")
        .eq("counselor_id", request.auth.userId)
        .eq("role", "student")
        .is("archived_at", null)
        .eq("grad_year", classOfCycle(current)),
      request.db.from("alumni_records").select("student_id").eq("counselor_id", request.auth.userId),
    ]);
    if (closed.error) throw fromPostgrest(closed.error);
    if (seniors.error) throw fromPostgrest(seniors.error);
    if (alumni.error) throw fromPostgrest(alumni.error);
    const isAlum = new Set(((alumni.data ?? []) as Row[]).map((a) => String(a.student_id)));
    const notYetAlumni = ((seniors.data ?? []) as Row[]).filter((s) => !isAlum.has(String(s.id)));
    const cycles = ((closed.data ?? []) as Row[]).map((c) => ({
      cycle: String(c.cycle),
      closedAt: String(c.closed_at),
      alumniCount: Number(c.alumni_count),
      rowsRecorded: Number(c.rows_recorded),
      rowsLocked: Number(c.rows_locked),
    }));
    return {
      current,
      classOf: classOfCycle(current),
      currentClosed: cycles.some((c) => c.cycle === current),
      seniors: notYetAlumni.length,
      closed: cycles,
    };
  });

  app.post(
    "/close-cycle",
    { preHandler: [...counselor, limit("outcomes:close", 5, 3600)] },
    async (request) => {
      const { cycle } = z.object({ cycle: cycleSchema }).strict().parse(request.body);
      const { data, error } = await request.db.rpc("close_admission_cycle", { p_cycle: cycle });
      if (error) throw fromOutcomeError(error);
      const r = (data ?? {}) as Row;
      return {
        cycle: String(r.cycle ?? cycle),
        alumniCount: Number(r.alumniCount ?? 0),
        rowsRecorded: Number(r.rowsRecorded ?? 0),
        rowsLocked: Number(r.rowsLocked ?? 0),
      };
    }
  );

  /**
   * What AxIS reads: per college, this high school's history with the
   * practice, and the CDS-range flags. `highSchool` is the name as recorded.
   */
  app.get("/history", { preHandler: [...counselor, limit("outcomes:history", 120, 60)] }, async (request) => {
    const q = z
      .object({ highSchool: z.string().trim().min(1).max(200), collegeId: z.string().uuid().optional() })
      .parse(request.query);
    let outcomes = await outcomesForHighSchool(request.db, q.highSchool);
    if (q.collegeId) outcomes = outcomes.filter((o) => o.collegeId === q.collegeId);
    const ranges = await cdsRanges(
      request.db,
      outcomes.map((o) => o.collegeId).filter((v): v is string => Boolean(v))
    );
    const history = summarize(outcomes, ranges);
    const flags = unexpected(history);
    return {
      highSchool: q.highSchool,
      history: history.map((h) => ({ ...h, line: historyLine(q.highSchool, h) })),
      flags: flags.map((f) => ({
        ...f,
        line:
          `${f.collegeName} admits from ${q.highSchool} sit ${f.direction} its CDS middle 50% ` +
          `(median ${f.medianAdmitSat} vs ${f.cds.sat25}–${f.cds.sat75}).`,
      })),
    };
  });
}

// ---- Alumni ----------------------------------------------------------------

const ALUMNI_SELECT =
  "student_id, cycle, college_id, institution_name, program, outcome_id, created_at, " +
  "student:profiles!alumni_records_student_id_fkey(full_name, avatar_url, grad_year, high_school, email), " +
  "college:colleges(id, name, slug, initials, brand_color, city, state)";

function toAlum(r: Row) {
  const s = (r.student ?? {}) as Row;
  const c = r.college as Row | null;
  return {
    studentId: String(r.student_id),
    name: s.full_name ? String(s.full_name) : null,
    email: s.email ? String(s.email) : null,
    avatarUrl: s.avatar_url ? String(s.avatar_url) : null,
    gradYear: s.grad_year ? String(s.grad_year) : null,
    highSchool: s.high_school ? String(s.high_school) : null,
    cycle: String(r.cycle),
    /** Null = undecided. */
    institution: r.institution_name
      ? {
          collegeId: c ? String(c.id) : null,
          name: String(r.institution_name),
          slug: c?.slug ? String(c.slug) : null,
          initials: c?.initials ? String(c.initials) : null,
          brandColor: c?.brand_color ? String(c.brand_color) : null,
          city: c?.city ? String(c.city) : null,
          state: c?.state ? String(c.state) : null,
        }
      : null,
    program: r.program ? String(r.program) : null,
    outcomeId: r.outcome_id ? String(r.outcome_id) : null,
    createdAt: String(r.created_at),
  };
}

const alumPatch = z
  .object({
    collegeId: z.string().uuid().nullable(),
    institutionName: z.string().trim().min(1).max(300).nullable(),
    program: z.string().trim().max(200).nullable(),
  })
  .partial()
  .strict();

export async function alumniRoutes(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("alumni:list", 120, 60)] },
    async (request) => {
      const { data, error } = await request.db
        .from("alumni_records")
        .select(ALUMNI_SELECT)
        .eq("counselor_id", request.auth.userId)
        .order("cycle", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw fromPostgrest(error);
      return ((data ?? []) as unknown as Row[]).map(toAlum);
    }
  );

  /** One alum, with every admission result on file for them. */
  app.get("/:id", { preHandler: [app.authenticate, limit("alumni:detail", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await assertCanViewStudent(request, id);
    const { data, error } = await request.db.from("alumni_records").select(ALUMNI_SELECT).eq("student_id", id).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That student isn't an alum yet");

    let outcomes: ReturnType<typeof toOutcome>[] = [];
    if (request.profile.role === "counselor") {
      const o = await request.db
        .from("admission_outcomes")
        .select(OUTCOME_COLUMNS)
        .eq("student_id", id)
        .order("cycle", { ascending: false });
      if (o.error) throw fromPostgrest(o.error);
      outcomes = ((o.data ?? []) as unknown as Row[]).map(toOutcome);
    }
    return { ...toAlum(data as unknown as Row), outcomes };
  });

  /** Correct where an alum went (inline edit on the alumni page). */
  app.patch(
    "/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("alumni:write", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = alumPatch.parse(request.body);
      await assertCanEditStudent(request, id);
      const update: Row = {};
      if (body.collegeId !== undefined) update.college_id = body.collegeId;
      if (body.institutionName !== undefined) update.institution_name = body.institutionName;
      if (body.program !== undefined) update.program = body.program;
      if (Object.keys(update).length === 0) throw badRequest("Nothing to change");
      const { data, error } = await request.db
        .from("alumni_records")
        .update(update)
        .eq("student_id", id)
        .select(ALUMNI_SELECT)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That student isn't an alum yet");
      return toAlum(data as unknown as Row);
    }
  );
}
