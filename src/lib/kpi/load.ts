/**
 * Time saved: read one consultant's month from the ledger and build the report.
 * Runs on the caller's RLS client in a request, or the service client in the
 * monthly job (always filtered to one consultant by id).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { toBaselinesDto, type BaselinesRow } from "./defaults.js";
import { buildReport, monthsBack, zonedMonthStart, type ActivityCounts, type CompletionRow, type KpiReport } from "./report.js";

export const COMPLETION_COLUMNS =
  "task_type, student_id, month, manual_minutes, manual_is_estimate, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate";
export const BASELINE_COLUMNS =
  "manual, meridies, manual_edited, meridies_edited, hourly_rate, rate_edited, hours_per_student_year, hours_edited, monthly_email, prompt_dismissed_at";

export class KpiReadError extends Error {
  constructor(public readonly pg: { code?: string; message?: string }) {
    super(pg.message ?? "read failed");
  }
}

export async function loadReport(db: SupabaseClient, counselorId: string, month: string, timeZone: string | null): Promise<KpiReport> {
  const first = `${month}-01`;
  // Activity is counted within the consultant's own month, like the ledger.
  const from = zonedMonthStart(month, timeZone).toISOString();
  const to = zonedMonthStart(monthsBack(month, -1).slice(0, 7), timeZone).toISOString();
  const [rowsRes, yearRes, baseRes] = await Promise.all([
    db.from("kpi_completions").select(COMPLETION_COLUMNS).eq("counselor_id", counselorId).eq("month", first).order("completed_at").limit(5000),
    db.from("kpi_completions").select(COMPLETION_COLUMNS).eq("counselor_id", counselorId).gte("month", monthsBack(month, 11)).lte("month", first).limit(20000),
    db.from("kpi_baselines").select(BASELINE_COLUMNS).eq("counselor_id", counselorId).maybeSingle(),
  ]);
  for (const r of [rowsRes, yearRes, baseRes]) if (r.error) throw new KpiReadError(r.error);
  const rows = (rowsRes.data ?? []) as CompletionRow[];

  const ids = [...new Set(rows.map((r) => r.student_id).filter((x): x is string => !!x))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data } = await db.from("profiles").select("id, full_name").in("id", ids.slice(0, 500));
    for (const p of data ?? []) if (p.full_name) names[String(p.id)] = String(p.full_name);
  }

  // Raw usage, shown apart from savings. Unreadable → empty, never an error.
  const activity: ActivityCounts = { aiRuns: {}, researchRuns: {} };
  const [ai, research] = await Promise.all([
    db.from("ai_runs").select("module").eq("actor_id", counselorId).gte("created_at", from).lt("created_at", to).limit(10000),
    db.from("research_runs").select("feature").eq("counselor_id", counselorId).gte("created_at", from).lt("created_at", to).limit(10000),
  ]);
  for (const r of ai.data ?? []) activity.aiRuns[String(r.module)] = (activity.aiRuns[String(r.module)] ?? 0) + 1;
  for (const r of research.data ?? []) activity.researchRuns[String(r.feature)] = (activity.researchRuns[String(r.feature)] ?? 0) + 1;

  const baselines = toBaselinesDto((baseRes.data as BaselinesRow | null) ?? null);
  return buildReport(rows, (yearRes.data ?? []) as CompletionRow[], baselines.hoursPerStudentYear, activity, month, names);
}
