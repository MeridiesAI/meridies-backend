/**
 * The accountability engine.
 *
 * Rules that matter and are easy to get wrong, so they live in one place:
 *  - "behind" means no progress_events for a deliverable in stall_after_days
 *  - a red flag escalates to the parents only after escalate_after_hours AND
 *    only if the word count hasn't moved off `baseline_words` since
 *  - no student's guardians get two alerts inside min_days_between_alerts,
 *    whatever triggered them. That throttle is what keeps this from being spam.
 */

import type { FastifyRequest } from "fastify";

export type AccountabilitySettings = {
  enabled: boolean;
  stall_after_days: number;
  escalate_after_hours: number;
  min_days_between_alerts: number;
  auto_send_parent_alerts: boolean;
  alert_on_low_quality: boolean;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone: string;
};

export const DEFAULT_SETTINGS: AccountabilitySettings = {
  enabled: true,
  stall_after_days: 7,
  escalate_after_hours: 72,
  min_days_between_alerts: 7,
  // Off by default: an automated message to a family is the counselor's call.
  auto_send_parent_alerts: false,
  alert_on_low_quality: true,
  quiet_hours_start: 21,
  quiet_hours_end: 8,
  timezone: "America/New_York",
};

/** Student-specific row wins over the counselor default, which wins over ours. */
export async function loadSettings(
  request: FastifyRequest,
  counselorId: string,
  studentId?: string
): Promise<AccountabilitySettings> {
  const { data } = await request.db
    .from("accountability_settings")
    .select("*")
    .eq("counselor_id", counselorId);

  const rows = data ?? [];
  const forStudent = studentId ? rows.find((r) => r.student_id === studentId) : undefined;
  const forCounselor = rows.find((r) => r.student_id === null);
  const chosen = forStudent ?? forCounselor;

  return chosen ? { ...DEFAULT_SETTINGS, ...(chosen as object) } : DEFAULT_SETTINGS;
}

/** True when we're inside the counselor's configured quiet hours. */
export function inQuietHours(settings: AccountabilitySettings, now = new Date()): boolean {
  const { quiet_hours_start: start, quiet_hours_end: end } = settings;
  if (start == null || end == null) return false;

  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: settings.timezone,
      hour: "numeric",
      hour12: false,
    }).format(now)
  );

  // A window like 21 -> 8 wraps midnight.
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * The anti-spam gate. Returns a reason string when an alert must be held back,
 * or null when it may go.
 */
export async function alertBlockedReason(
  request: FastifyRequest,
  studentId: string,
  settings: AccountabilitySettings,
  opts: { ignoreQuietHours?: boolean } = {}
): Promise<string | null> {
  if (!settings.enabled) return "Accountability alerts are turned off for this student";

  const since = new Date(
    Date.now() - settings.min_days_between_alerts * 86_400_000
  ).toISOString();

  const { data } = await request.db
    .from("parent_alerts")
    .select("id, sent_at")
    .eq("student_id", studentId)
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(1);

  if (data && data.length > 0) {
    return `A parent alert already went out in the last ${settings.min_days_between_alerts} days`;
  }
  if (!opts.ignoreQuietHours && inQuietHours(settings)) {
    return "Inside quiet hours — this will be scheduled rather than sent now";
  }
  return null;
}

export type StalledDeliverable = {
  id: string;
  title: string;
  kind: string;
  progress_pct: number;
  current_words: number;
  target_words: number | null;
  due_date: string | null;
  last_activity_at: string | null;
  days_since_activity: number | null;
};

export type BehindStudent = {
  studentId: string;
  fullName: string;
  avatarUrl: string | null;
  stalled: StalledDeliverable[];
  openRedFlags: number;
  overdueDeadlines: number;
  lastActivityAt: string | null;
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * The alert list: every roster student with a stalled deliverable, an open red
 * flag, or an overdue deadline, most-behind first.
 */
export async function buildBehindList(
  request: FastifyRequest,
  counselorId: string
): Promise<BehindStudent[]> {
  const settings = await loadSettings(request, counselorId);
  const stallCutoff = new Date(
    Date.now() - settings.stall_after_days * 86_400_000
  ).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const { data: students } = await request.db
    .from("profiles")
    .select("id, full_name, avatar_url")
    .eq("counselor_id", counselorId)
    .is("archived_at", null);

  const roster = students ?? [];
  if (roster.length === 0) return [];
  const ids = roster.map((s) => s.id as string);

  const [deliverables, flags, deadlines] = await Promise.all([
    request.db
      .from("deliverables")
      .select("*")
      .in("student_id", ids)
      .neq("status", "complete"),
    request.db
      .from("red_flags")
      .select("student_id, status")
      .in("student_id", ids)
      .in("status", ["open", "escalated"]),
    request.db
      .from("deadlines")
      .select("student_id, due_date, done")
      .in("student_id", ids)
      .eq("done", false)
      .lt("due_date", today),
  ]);

  const stalledByStudent = new Map<string, StalledDeliverable[]>();
  for (const d of deliverables.data ?? []) {
    const last = (d.last_activity_at as string | null) ?? null;
    // Never touched, or untouched since the cutoff.
    const isStalled = last === null || last < stallCutoff;
    if (!isStalled) continue;

    const sid = d.student_id as string;
    if (!stalledByStudent.has(sid)) stalledByStudent.set(sid, []);
    stalledByStudent.get(sid)!.push({
      id: d.id as string,
      title: d.title as string,
      kind: d.kind as string,
      progress_pct: Number(d.progress_pct ?? 0),
      current_words: Number(d.current_words ?? 0),
      target_words: (d.target_words as number | null) ?? null,
      due_date: (d.due_date as string | null) ?? null,
      last_activity_at: last,
      days_since_activity: daysSince(last),
    });
  }

  const flagCount = new Map<string, number>();
  for (const f of flags.data ?? []) {
    const sid = f.student_id as string;
    flagCount.set(sid, (flagCount.get(sid) ?? 0) + 1);
  }

  const overdueCount = new Map<string, number>();
  for (const d of deadlines.data ?? []) {
    const sid = d.student_id as string;
    overdueCount.set(sid, (overdueCount.get(sid) ?? 0) + 1);
  }

  return roster
    .map((s) => {
      const sid = s.id as string;
      const stalled = stalledByStudent.get(sid) ?? [];
      const lastActivityAt = stalled
        .map((d) => d.last_activity_at)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1) ?? null;

      return {
        studentId: sid,
        fullName: s.full_name as string,
        avatarUrl: (s.avatar_url as string | null) ?? null,
        stalled,
        openRedFlags: flagCount.get(sid) ?? 0,
        overdueDeadlines: overdueCount.get(sid) ?? 0,
        lastActivityAt,
      };
    })
    .filter((s) => s.stalled.length > 0 || s.openRedFlags > 0 || s.overdueDeadlines > 0)
    .sort(
      (a, b) =>
        b.overdueDeadlines - a.overdueDeadlines ||
        b.openRedFlags - a.openRedFlags ||
        b.stalled.length - a.stalled.length
    );
}
