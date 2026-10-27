/**
 * Time saved (monthly ROI report). Spec:
 * docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { forbidden, fromPostgrest, notFound, unavailable, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";
import { assertOwnsSubject } from "../lib/kpi/subjects.js";
import { KPI_SCHEMA_MISSING, TASK_TYPES, type TaskType } from "../lib/kpi/types.js";
import { toBaselinesDto, type BaselinesRow } from "../lib/kpi/defaults.js";
import { buildReport, monthIn, monthsBack, type ActivityCounts, type CompletionRow } from "../lib/kpi/report.js";

const heartbeatBody = z.object({ taskType: z.enum(TASK_TYPES), subjectId: z.string().uuid() }).strict();

const minutes = z.number().int().min(1).max(1440);
const taskPatch = z
  .object({ manual: minutes.optional(), meridies: minutes.optional(), manualEdited: z.boolean().optional(), meridiesEdited: z.boolean().optional() })
  .strict();
const baselinesBody = z
  .object({
    tasks: z.object(Object.fromEntries(TASK_TYPES.map((t) => [t, taskPatch.optional()])) as Record<TaskType, z.ZodOptional<typeof taskPatch>>).strict().optional(),
    hourlyRate: z.number().min(1).max(2000).optional(),
    rateEdited: z.boolean().optional(),
    hoursPerStudentYear: z.number().min(1).max(500).optional(),
    hoursEdited: z.boolean().optional(),
    monthlyEmail: z.boolean().optional(),
    dismissPrompt: z.literal(true).optional(),
  })
  .strict();

const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional() }).strict();
const COMPLETION_COLUMNS =
  "task_type, student_id, month, manual_minutes, manual_is_estimate, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate";

const BASELINE_COLUMNS =
  "manual, meridies, manual_edited, meridies_edited, hourly_rate, rate_edited, hours_per_student_year, hours_edited, monthly_email, prompt_dismissed_at";

export const kpiUnavailable = () =>
  new HttpError(503, "Time saved isn't switched on yet", "kpi_unavailable");

export default async function kpiRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  const schemaError = (error: { code?: string; message?: string }) =>
    KPI_SCHEMA_MISSING.has(error.code ?? "") ? kpiUnavailable() : fromPostgrest(error);

  app.get("/baselines", { preHandler: [...counselor, limit("kpi:baselines", 120, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("kpi_baselines")
      .select(BASELINE_COLUMNS)
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (error) throw schemaError(error);
    return toBaselinesDto((data as BaselinesRow | null) ?? null);
  });

  /**
   * Save signup / Settings figures. The table isn't client-writable, so this writes
   * the caller's own row on the service client. A figure counts as edited once the
   * client says the consultant touched it; it stays edited.
   */
  app.put("/baselines", { preHandler: [...counselor, limit("kpi:baselines:write", 30, 60)] }, async (request) => {
    const body = baselinesBody.parse(request.body);
    const svc = serviceClient();
    if (!svc) throw unavailable("Saving needs the service role key");
    const { data: current, error: readError } = await svc
      .from("kpi_baselines")
      .select(BASELINE_COLUMNS)
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (readError) throw schemaError(readError);
    const row = (current as BaselinesRow | null) ?? null;
    const manual = { ...(row?.manual ?? {}) };
    const meridies = { ...(row?.meridies ?? {}) };
    const manualEdited = { ...(row?.manual_edited ?? {}) };
    const meridiesEdited = { ...(row?.meridies_edited ?? {}) };
    for (const t of TASK_TYPES) {
      const p = body.tasks?.[t];
      if (!p) continue;
      if (p.manual !== undefined) manual[t] = p.manual;
      if (p.meridies !== undefined) meridies[t] = p.meridies;
      if (p.manualEdited) manualEdited[t] = true;
      if (p.meridiesEdited) meridiesEdited[t] = true;
    }
    const next = {
      counselor_id: request.auth.userId,
      manual,
      meridies,
      manual_edited: manualEdited,
      meridies_edited: meridiesEdited,
      hourly_rate: body.hourlyRate ?? row?.hourly_rate ?? null,
      rate_edited: (row?.rate_edited ?? false) || body.rateEdited === true,
      hours_per_student_year: body.hoursPerStudentYear ?? row?.hours_per_student_year ?? null,
      hours_edited: (row?.hours_edited ?? false) || body.hoursEdited === true,
      monthly_email: body.monthlyEmail ?? row?.monthly_email ?? true,
      prompt_dismissed_at: body.dismissPrompt ? new Date().toISOString() : (row?.prompt_dismissed_at ?? null),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await svc
      .from("kpi_baselines")
      .upsert(next, { onConflict: "counselor_id" })
      .select(BASELINE_COLUMNS)
      .single();
    if (error) throw schemaError(error);
    return toBaselinesDto(data as BaselinesRow);
  });

  /** The caller's own month: per-task lines with their arithmetic, value or extra students, raw activity. */
  app.get("/report", { preHandler: [...counselor, limit("kpi:report", 60, 60)] }, async (request) => {
    const q = monthQuery.parse(request.query);
    const me = request.auth.userId;
    const { data: profile } = await request.db.from("profiles").select("timezone").eq("id", me).maybeSingle();
    const month = q.month ?? monthIn((profile?.timezone as string | null) ?? null);
    const first = `${month}-01`;
    const next = monthsBack(month, -1);

    const [rowsRes, yearRes, baseRes] = await Promise.all([
      request.db.from("kpi_completions").select(COMPLETION_COLUMNS).eq("counselor_id", me).eq("month", first).order("completed_at").limit(5000),
      request.db.from("kpi_completions").select(COMPLETION_COLUMNS).eq("counselor_id", me).gte("month", monthsBack(month, 11)).lte("month", first).limit(20000),
      request.db.from("kpi_baselines").select(BASELINE_COLUMNS).eq("counselor_id", me).maybeSingle(),
    ]);
    for (const r of [rowsRes, yearRes, baseRes]) if (r.error) throw schemaError(r.error);
    const rows = (rowsRes.data ?? []) as CompletionRow[];

    const ids = [...new Set(rows.map((r) => r.student_id).filter((x): x is string => !!x))];
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data } = await request.db.from("profiles").select("id, full_name").in("id", ids.slice(0, 500));
      for (const p of data ?? []) if (p.full_name) names[String(p.id)] = String(p.full_name);
    }

    // Raw usage, shown separately from savings. Unreadable → empty, never an error.
    const activity: ActivityCounts = { aiRuns: {}, researchRuns: {} };
    const [ai, research] = await Promise.all([
      request.db.from("ai_runs").select("module").eq("actor_id", me).gte("created_at", first).lt("created_at", next).limit(10000),
      request.db.from("research_runs").select("feature").eq("counselor_id", me).gte("created_at", first).lt("created_at", next).limit(10000),
    ]);
    for (const r of ai.data ?? []) activity.aiRuns[String(r.module)] = (activity.aiRuns[String(r.module)] ?? 0) + 1;
    for (const r of research.data ?? []) activity.researchRuns[String(r.feature)] = (activity.researchRuns[String(r.feature)] ?? 0) + 1;

    const baselines = toBaselinesDto((baseRes.data as BaselinesRow | null) ?? null);
    return buildReport(rows, (yearRes.data ?? []) as CompletionRow[], baselines.hoursPerStudentYear, activity, month, names);
  });

  /** Firm totals for the caller's firm (owners and admins), only with 3+ active consultants. */
  app.get("/firm", { preHandler: [...counselor, limit("kpi:firm", 60, 60)] }, async (request) => {
    const q = monthQuery.parse(request.query);
    const { data: profile, error: pErr } = await request.db
      .from("profiles")
      .select("firm_id, timezone")
      .eq("id", request.auth.userId)
      .maybeSingle();
    if (pErr) throw fromPostgrest(pErr);
    if (!profile?.firm_id) throw notFound("You're not in a firm");
    const month = q.month ?? monthIn((profile.timezone as string | null) ?? null);
    const { data, error } = await request.db.rpc("kpi_firm_month", { p_firm: profile.firm_id, p_month: `${month}-01` });
    if (error) {
      if (error.code === "42501") throw forbidden("Only the firm's owners and admins see firm totals");
      throw schemaError(error);
    }
    return { month, ...(data as Record<string, unknown>) };
  });

  app.post("/heartbeat", { preHandler: [...counselor, limit("kpi:heartbeat", 120, 60)] }, async (request, reply) => {
    const { taskType, subjectId } = heartbeatBody.parse(request.body);
    reply.code(202);
    if (env.KPI_TRACKING_ENABLED !== "true") return { tracked: false };
    await assertOwnsSubject(request, taskType, subjectId);
    const svc = serviceClient();
    if (!svc) throw unavailable("Time tracking needs the service role key");
    const { data, error } = await svc.rpc("kpi_heartbeat", {
      p_counselor: request.auth.userId,
      p_task_type: taskType,
      p_subject: subjectId,
    });
    if (error) {
      if (KPI_SCHEMA_MISSING.has(error.code ?? "")) throw kpiUnavailable();
      throw fromPostgrest(error);
    }
    return { tracked: true, result: String(data) };
  });
}
