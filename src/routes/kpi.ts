/**
 * Time saved (monthly ROI report). Spec:
 * docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { badRequest, forbidden, fromPostgrest, notFound, unavailable, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";
import { assertOwnsSubject } from "../lib/kpi/subjects.js";
import { KPI_SCHEMA_MISSING, TASK_TYPES, type TaskType } from "../lib/kpi/types.js";
import { measuredUsual, toBaselinesDto, type BaselinesRow, type MeasuredUsual } from "../lib/kpi/defaults.js";
import { monthIn, monthsBack } from "../lib/kpi/report.js";
import { BASELINE_COLUMNS, KpiReadError, loadReport } from "../lib/kpi/load.js";

// `interrupted`: the client lost heartbeats while the consultant was working; the
// task's completion then uses the fallback figure. Still no durations.
const heartbeatBody = z
  .object({ taskType: z.enum(TASK_TYPES), subjectId: z.string().uuid(), interrupted: z.boolean().optional() })
  .strict();

const MINUTES_RULE = "Enter a whole number of minutes from 1 to 1440";
const minutes = z.number({ invalid_type_error: MINUTES_RULE }).int(MINUTES_RULE).min(1, MINUTES_RULE).max(1440, MINUTES_RULE);
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

export const kpiUnavailable = () =>
  new HttpError(503, "Time saved isn't switched on yet", "kpi_unavailable");

export default async function kpiRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  const schemaError = (error: { code?: string; message?: string }) =>
    KPI_SCHEMA_MISSING.has(error.code ?? "") ? kpiUnavailable() : fromPostgrest(error);

  /**
   * The Settings hint: the caller's measured time per task, the same rows the
   * report's median uses (measured active or capped, with time). Always keyed by
   * the caller, so no one sees another consultant's figures.
   */
  const loadMeasured = async (db: SupabaseClient, counselorId: string): Promise<MeasuredUsual> => {
    const { data, error } = await db
      .from("kpi_completions")
      .select("task_type, measured_seconds")
      .eq("counselor_id", counselorId)
      .in("measure_method", ["active", "capped"])
      .gt("measured_seconds", 0)
      .limit(20000);
    if (error) throw schemaError(error);
    return measuredUsual((data ?? []) as { task_type: string; measured_seconds: number }[]);
  };

  // Signup figures are asked during onboarding, while the account may still be
  // pending review, so these two routes are open to a pending counselor for their
  // own row only (read and written on the service client, keyed by the caller).
  app.get("/baselines", { preHandler: [...counselor, limit("kpi:baselines", 120, 60)], config: { allowPending: true } }, async (request) => {
    const db = serviceClient() ?? request.db;
    const [{ data, error }, measured] = await Promise.all([
      db.from("kpi_baselines").select(BASELINE_COLUMNS).eq("counselor_id", request.auth.userId).maybeSingle(),
      loadMeasured(db, request.auth.userId),
    ]);
    if (error) throw schemaError(error);
    return toBaselinesDto((data as BaselinesRow | null) ?? null, measured);
  });

  /**
   * Save signup / Settings figures. The table isn't client-writable, so this writes
   * the caller's own row on the service client, merged in one statement
   * (kpi_save_baselines). A figure counts as edited once the client says the
   * consultant touched it; it stays edited.
   */
  app.put("/baselines", { preHandler: [...counselor, limit("kpi:baselines:write", 30, 60)], config: { allowPending: true } }, async (request) => {
    // A refusal says what's wrong in words (e.g. whole minutes only), not a schema dump.
    const parsed = baselinesBody.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
    const body = parsed.data;
    const svc = serviceClient();
    if (!svc) throw unavailable("Saving needs the service role key");
    const pick = (field: "manual" | "meridies") =>
      Object.fromEntries(TASK_TYPES.flatMap((t) => (body.tasks?.[t]?.[field] !== undefined ? [[t, body.tasks[t]![field]]] : [])));
    const flags = (field: "manualEdited" | "meridiesEdited") =>
      Object.fromEntries(TASK_TYPES.flatMap((t) => (body.tasks?.[t]?.[field] ? [[t, true]] : [])));
    // One atomic merge in the database: overlapping saves from separate fields keep every figure.
    const { error: saveError } = await svc.rpc("kpi_save_baselines", {
      p_counselor: request.auth.userId,
      p_manual: pick("manual"),
      p_meridies: pick("meridies"),
      p_manual_edited: flags("manualEdited"),
      p_meridies_edited: flags("meridiesEdited"),
      p_rate: body.hourlyRate ?? null,
      p_rate_edited: body.rateEdited === true,
      p_hours: body.hoursPerStudentYear ?? null,
      p_hours_edited: body.hoursEdited === true,
      p_monthly_email: body.monthlyEmail ?? null,
      p_dismiss: body.dismissPrompt === true,
    });
    if (saveError) throw schemaError(saveError);
    const { data, error } = await svc
      .from("kpi_baselines")
      .select(BASELINE_COLUMNS)
      .eq("counselor_id", request.auth.userId)
      .single();
    if (error) throw schemaError(error);
    return toBaselinesDto(data as BaselinesRow, await loadMeasured(svc, request.auth.userId));
  });

  /** The caller's own month: per-task lines with their arithmetic, value or extra students, raw activity. */
  app.get("/report", { preHandler: [...counselor, limit("kpi:report", 60, 60)] }, async (request) => {
    const q = monthQuery.parse(request.query);
    const { data: profile } = await request.db.from("profiles").select("timezone").eq("id", request.auth.userId).maybeSingle();
    const tz = (profile?.timezone as string | null) ?? null; // read once per request
    const month = q.month ?? monthIn(tz);
    try {
      return await loadReport(request.db, request.auth.userId, month, tz);
    } catch (err) {
      if (err instanceof KpiReadError) throw schemaError(err.pg);
      throw err;
    }
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
    // Firm totals cover ended months only, so the default is last month.
    const month = q.month ?? monthsBack(monthIn((profile.timezone as string | null) ?? null), 1).slice(0, 7);
    const { data, error } = await request.db.rpc("kpi_firm_month", { p_firm: profile.firm_id, p_month: `${month}-01` });
    if (error) {
      if (error.code === "42501") throw forbidden("Only the firm's owners and admins see firm totals");
      throw schemaError(error);
    }
    return { month, ...(data as Record<string, unknown>) };
  });

  app.post("/heartbeat", { preHandler: [...counselor, limit("kpi:heartbeat", 120, 60)] }, async (request, reply) => {
    const { taskType, subjectId, interrupted } = heartbeatBody.parse(request.body);
    reply.code(202);
    if (env.KPI_TRACKING_ENABLED !== "true") return { tracked: false };
    await assertOwnsSubject(request, taskType, subjectId);
    const svc = serviceClient();
    if (!svc) throw unavailable("Time tracking needs the service role key");
    const { data, error } = await svc.rpc("kpi_heartbeat", {
      p_counselor: request.auth.userId,
      p_task_type: taskType,
      p_subject: subjectId,
      p_interrupted: interrupted === true,
    });
    if (error) {
      if (KPI_SCHEMA_MISSING.has(error.code ?? "")) throw kpiUnavailable();
      throw fromPostgrest(error);
    }
    return { tracked: true, result: String(data) };
  });
}
