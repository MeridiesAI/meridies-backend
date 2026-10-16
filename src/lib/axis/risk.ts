/**
 * Who on the caseload needs attention, ranked in code.
 *
 * The inputs are the ones the accountability sweep uses (open counselor-set
 * tasks the student can see, open red flags, open deadlines, the counselor's
 * own stall threshold), so "behind" means the same thing in AxIS as in
 * Management's alerts. On top of that each open item gets an urgency:
 *
 *   overdue        3 + up to 2 more as it ages (two weeks late is the cap)
 *   due in window  (1 - days left / window) x 2 x how started it is
 *   stalled        x up to 2 by days without activity past the threshold
 *
 * A student's score is their worst item plus 0.6 of the second and 0.3 of the
 * third, so one disaster outranks several mild items and a student isn't
 * ranked high just for having many tasks. Every score carries the reasons
 * that produced it, in words a counselor can check.
 */
import type { FastifyRequest } from "fastify";
import { daysSince, loadSettings } from "../accountability.js";
import { fromPostgrest } from "../errors.js";
import { plainName } from "../context/identity.js";
import { researchTaskIds } from "../research/origin.js";
import { isoDay, plain } from "./data.js";

type Row = Record<string, unknown>;

export type RiskInput = {
  kind: "task" | "deadline";
  studentId: string;
  title: string;
  due: string | null;
  status: string | null;
  lastActivityAt: string | null;
  /** The title isn't the counselor's own words (a task accepted from Research). Deadlines always count as such. */
  outside?: boolean;
};

export type StudentRisk = {
  studentId: string;
  name: string;
  score: number;
  reasons: string[];
  redFlags: number;
  /** A reason quotes a deadline's title (the student may have written it) or a Research task's: outside content for AxIS. */
  outside: boolean;
};

const STATUS_WEIGHT: Record<string, number> = { "not-started": 1, stalled: 1.2, "in-progress": 0.6, review: 0.3 };
const DAY = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY);
}

export function urgency(item: RiskInput, today: string, horizonDays: number, stallAfterDays: number): { u: number; reason: string | null } {
  if (!item.due) return { u: 0, reason: null };
  const left = daysBetween(today, item.due);
  const idle = item.kind === "task" ? daysSince(item.lastActivityAt) : null;
  const stalled = item.kind === "task" && (idle === null || idle >= stallAfterDays);
  const stallFactor = stalled ? 1 + Math.min(idle ?? 21, 21) / 21 : 1;
  const title = `"${plain(item.title, 80)}"`;
  if (left < 0) {
    const late = -left;
    const u = (3 + Math.min(late, 14) / 7) * (item.kind === "task" ? stallFactor : 1);
    return { u, reason: `${title} is ${late} day${late === 1 ? "" : "s"} overdue` };
  }
  if (left > horizonDays) return { u: 0, reason: null };
  const w = item.kind === "deadline" ? 0.8 : (STATUS_WEIGHT[item.status ?? ""] ?? 0.8);
  const u = (1 - left / (horizonDays + 1)) * 2 * w * stallFactor;
  const when = left === 0 ? "due today" : `due in ${left} day${left === 1 ? "" : "s"}`;
  const quiet = stalled ? (idle === null ? ", never started" : `, no activity for ${idle} days`) : "";
  return { u, reason: `${title} ${when}${quiet}` };
}

/** Pure ranking over loaded rows; exported for tests. */
export function rankStudents(
  roster: { id: string; name: string }[],
  items: RiskInput[],
  redFlags: Map<string, number>,
  opts: { today: string; horizonDays: number; stallAfterDays: number }
): StudentRisk[] {
  const byStudent = new Map<string, { u: number; reason: string; outside: boolean }[]>();
  for (const it of items) {
    const { u, reason } = urgency(it, opts.today, opts.horizonDays, opts.stallAfterDays);
    if (u <= 0 || !reason) continue;
    byStudent.set(it.studentId, [...(byStudent.get(it.studentId) ?? []), { u, reason, outside: it.kind === "deadline" || it.outside === true }]);
  }
  return roster
    .map((s) => {
      const scored = (byStudent.get(s.id) ?? []).sort((a, b) => b.u - a.u);
      const flags = redFlags.get(s.id) ?? 0;
      const score = (scored[0]?.u ?? 0) + 0.6 * (scored[1]?.u ?? 0) + 0.3 * (scored[2]?.u ?? 0) + flags * 1.5;
      const reasons = scored.slice(0, 3).map((x) => x.reason);
      if (flags) reasons.push(`${flags} open red flag${flags === 1 ? "" : "s"}`);
      // Tasks here are counselor-set (the query skips the student's own), a Research task aside; deadlines may be the student's.
      const outside = scored.slice(0, 3).some((x) => x.outside);
      return { studentId: s.id, name: s.name, score: Math.round(score * 100) / 100, reasons, redFlags: flags, outside };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export async function loadRosterRisk(request: FastifyRequest, horizonDays = 14): Promise<StudentRisk[]> {
  const counselorId = request.auth.userId;
  const today = isoDay();
  const horizon = isoDay(new Date(Date.now() + horizonDays * DAY));
  const [settings, students] = await Promise.all([
    loadSettings(request, counselorId),
    request.db.from("profiles").select("id, full_name").eq("counselor_id", counselorId).eq("role", "student").is("archived_at", null).limit(1000),
  ]);
  if (students.error) throw fromPostgrest(students.error);
  // Names as AxIS shows them (lib/context/identity.ts): the student writes their own.
  const roster = ((students.data ?? []) as Row[]).map((s) => ({ id: String(s.id), name: plainName(s.full_name) }));
  if (!roster.length) return [];
  const ids = roster.map((s) => s.id);
  const [tasks, deadlines, flags] = await Promise.all([
    request.db
      .from("deliverables")
      .select("id, student_id, title, status, due_date, last_activity_at")
      .in("student_id", ids)
      .neq("status", "complete")
      // As in the sweep: a student's own to-do and a counselor-only task are not the student's assigned work.
      .neq("source", "student")
      .eq("visible_to_student", true)
      .lte("due_date", horizon)
      .limit(2000),
    request.db.from("deadlines").select("student_id, title, due_date").in("student_id", ids).eq("done", false).lte("due_date", horizon).limit(2000),
    request.db.from("red_flags").select("student_id").in("student_id", ids).in("status", ["open", "escalated"]).limit(2000),
  ]);
  for (const r of [tasks, deadlines, flags]) if (r.error) throw fromPostgrest(r.error);
  const taskRows = (tasks.data ?? []) as Row[];
  const research = taskRows.length ? await researchTaskIds(request.db, { taskIds: taskRows.map((t) => String(t.id)) }) : new Set<string>();
  const items: RiskInput[] = [
    ...taskRows.map((t): RiskInput => ({
      kind: "task",
      outside: research === null || research.has(String(t.id)),
      studentId: String(t.student_id),
      title: String(t.title ?? ""),
      due: (t.due_date as string | null) ?? null,
      status: (t.status as string | null) ?? null,
      lastActivityAt: (t.last_activity_at as string | null) ?? null,
    })),
    ...((deadlines.data ?? []) as Row[]).map((d): RiskInput => ({
      kind: "deadline",
      studentId: String(d.student_id),
      title: String(d.title ?? ""),
      due: (d.due_date as string | null) ?? null,
      status: null,
      lastActivityAt: null,
    })),
  ];
  const redFlags = new Map<string, number>();
  for (const f of (flags.data ?? []) as Row[]) redFlags.set(String(f.student_id), (redFlags.get(String(f.student_id)) ?? 0) + 1);
  return rankStudents(roster, items, redFlags, { today, horizonDays, stallAfterDays: settings.stall_after_days });
}
