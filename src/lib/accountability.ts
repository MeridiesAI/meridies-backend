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

import type { SupabaseClient } from "@supabase/supabase-js";
import { fromPostgrest } from "./errors.js";

/**
 * Anything carrying a Supabase client. A `FastifyRequest` satisfies it (its
 * `db` is the caller's RLS-bound client), and so does `{ db: serviceClient() }`
 * for the scheduled sweep — which is why these helpers take this rather than
 * the request: the same rules run on both paths, so they cannot drift.
 */
export type DbContext = { db: SupabaseClient };

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
  request: DbContext,
  counselorId: string,
  studentId?: string
): Promise<AccountabilitySettings> {
  const { data, error } = await request.db
    .from("accountability_settings")
    .select("*")
    .eq("counselor_id", counselorId);

  // An errored read is not "no settings row": falling through to the defaults
  // would switch alerts back on for a counselor who turned them off.
  if (error) throw fromPostgrest(error);

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
  request: DbContext,
  studentId: string,
  settings: AccountabilitySettings,
  opts: { ignoreQuietHours?: boolean } = {}
): Promise<string | null> {
  if (!settings.enabled) return "Accountability alerts are turned off for this student";

  const since = new Date(
    Date.now() - settings.min_days_between_alerts * 86_400_000
  ).toISOString();

  const { data, error } = await request.db
    .from("parent_alerts")
    .select("id, sent_at")
    .eq("student_id", studentId)
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(1);

  // Fail closed: an errored throttle read must not read as "nothing sent".
  if (error) throw fromPostgrest(error);

  // v10 sync (student-aid-comms): an alert written in the Communication
  // composer (`student_messages`, kind 'alert') counts too, so the sweep and
  // the button cannot send a second alert right behind a hand-written one.
  const composed = await request.db
    .from("student_messages")
    .select("id")
    .eq("student_id", studentId)
    .eq("kind", "alert")
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(1);
  if (composed.error) throw fromPostgrest(composed.error);

  if ((data && data.length > 0) || (composed.data?.length ?? 0) > 0) {
    return `A parent alert already went out in the last ${settings.min_days_between_alerts} days`;
  }
  if (!opts.ignoreQuietHours && inQuietHours(settings)) {
    return "Inside quiet hours — this will be scheduled rather than sent now";
  }
  return null;
}

/**
 * The single definition of "stalled". The roster alert list and the per-task
 * document tracker both ask this question, and two implementations that drift
 * apart is a counselor being told a student is behind on one screen and fine on
 * the next.
 */
export function stallCutoff(settings: AccountabilitySettings, now = Date.now()): string {
  return new Date(now - settings.stall_after_days * 86_400_000).toISOString();
}

/** Never touched counts as stalled — that's the case that matters most. */
export function isStalled(
  lastActivityAt: string | null | undefined,
  settings: AccountabilitySettings,
  now = Date.now()
): boolean {
  if (!lastActivityAt) return true;
  return lastActivityAt < stallCutoff(settings, now);
}

/** Whole days since an ISO timestamp, or null when there was never one. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
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

/**
 * The alert list: every roster student with a stalled deliverable, an open red
 * flag, or an overdue deadline, most-behind first.
 */
export async function buildBehindList(
  request: DbContext,
  counselorId: string
): Promise<BehindStudent[]> {
  const settings = await loadSettings(request, counselorId);
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
    if (!isStalled(last, settings)) continue;

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

// ---------------------------------------------------------------------------
// Who an alert actually reaches.
//
// `student_alert_prefs` is the counselor's decision about recipients, and it has
// to be read on the send path or it is decoration. Both the manual send and the
// escalation sweep go through this, so the two cannot drift.
// ---------------------------------------------------------------------------

export type AlertPrefs = { copy_parents: boolean; copy_student: boolean };

/** Absent row means the default, not "unknown": parents on, student off. */
export const DEFAULT_ALERT_PREFS: AlertPrefs = { copy_parents: true, copy_student: false };

/**
 * Fails CLOSED. An absent row is the default, but a query that *errored* is not
 * an absent row: swallowing it would fall through to `copy_parents: true` and
 * copy a guardian the counselor had switched off. For a recipient preference
 * the safe direction is to refuse the send, not to guess the permissive answer.
 */
export async function loadAlertPrefs(
  request: DbContext,
  studentId: string
): Promise<AlertPrefs> {
  const { data, error } = await request.db
    .from("student_alert_prefs")
    .select("copy_parents, copy_student")
    .eq("student_id", studentId)
    .maybeSingle();

  if (error) throw fromPostgrest(error);
  if (!data) return DEFAULT_ALERT_PREFS;
  return {
    copy_parents: data.copy_parents !== false,
    copy_student: data.copy_student === true,
  };
}

export type AlertRecipients = {
  guardianId: string | null;
  copyStudent: boolean;
  /** Set when nobody would receive this. The caller refuses rather than queues. */
  blockedReason: string | null;
};

/**
 * Resolve the recipients for one alert.
 *
 * Two independent gates, and both have to pass for a guardian to be included:
 * the per-student `copy_parents` switch, and the guardian's own
 * `alerts_enabled`. A guardian who opted out never receives anything whatever
 * the counselor sets, and a counselor who switched the parents off is not
 * overruled by a guardian who is still marked enabled.
 */
export async function resolveAlertRecipients(
  request: DbContext,
  studentId: string,
  requestedGuardianId?: string | null
): Promise<AlertRecipients> {
  const prefs = await loadAlertPrefs(request, studentId);

  let guardianId: string | null = null;
  if (prefs.copy_parents) {
    if (requestedGuardianId) {
      // An explicitly named guardian still has to be this student's, and still
      // has to have alerts enabled.
      const { data, error } = await request.db
        .from("guardians")
        .select("id")
        .eq("id", requestedGuardianId)
        .eq("student_id", studentId)
        .eq("alerts_enabled", true)
        .maybeSingle();
      // Surface the failure rather than letting it read as "no guardian on
      // file" — that message would send a counselor to fix a list that is fine.
      if (error) throw fromPostgrest(error);
      guardianId = data?.id ?? null;
    } else {
      const { data, error } = await request.db
        .from("guardians")
        .select("id")
        .eq("student_id", studentId)
        .eq("alerts_enabled", true)
        .order("is_primary", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      guardianId = data?.id ?? null;
    }
  }

  if (!guardianId && !prefs.copy_student) {
    // Say which of the two reasons it is. "No recipients" sends a counselor
    // looking at the guardian list when the switch is what is off.
    const blockedReason = prefs.copy_parents
      ? "No guardian on file with alerts enabled for that student"
      : "Alerts for that student are switched off for both the parents and the student";
    return { guardianId: null, copyStudent: false, blockedReason };
  }

  return { guardianId, copyStudent: prefs.copy_student, blockedReason: null };
}

// ---------------------------------------------------------------------------
// The escalation sweep.
//
// One implementation, two callers: `POST /accountability/sweep` (a counselor's
// dashboard button, RLS-bound client, the caller's own roster) and the
// scheduled runner in `lib/sweepSchedule.ts` (service-role client, one call per
// counselor, `studentIds` restricted to students whose `counselor_id` is that
// counselor). Every gate the button respects — the anti-spam throttle, quiet
// hours, fail-closed recipient prefs — is applied here, so the schedule cannot
// be the path that skips one.
// ---------------------------------------------------------------------------

export type SweepSkip = { id: string; reason: string };
export type SweepResult = { escalated: number; skipped: SweepSkip[] };
type SweepLog = { error: (obj: unknown, msg?: string) => void };

/** Next moment outside quiet hours, so a held alert has a real send time. */
export function nextSendWindow(settings: { quiet_hours_end: number | null }): string {
  const next = new Date();
  next.setHours((settings.quiet_hours_end ?? 8) + 1, 0, 0, 0);
  if (next.getTime() < Date.now()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/**
 * Turn red flags whose timer expired — and whose deliverable hasn't moved —
 * into parent alerts.
 *
 * `studentIds` is required whenever `ctx.db` is the service-role client: RLS is
 * not there to scope the flags, so the caller must have established the
 * counselor relationship already. With a user client it may be omitted and RLS
 * scopes the read, which is how the dashboard button has always behaved.
 */
export async function runEscalationSweep(
  ctx: DbContext,
  counselorId: string,
  opts: { studentIds?: string[]; limit?: number; log?: SweepLog } = {}
): Promise<SweepResult> {
  const now = new Date().toISOString();
  if (opts.studentIds && opts.studentIds.length === 0) return { escalated: 0, skipped: [] };

  let query = ctx.db
    .from("red_flags")
    .select("*")
    .eq("status", "open")
    .lt("escalate_at", now)
    .order("escalate_at", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.studentIds) query = query.in("student_id", opts.studentIds);

  const { data: due, error } = await query;
  if (error) throw fromPostgrest(error);

  let escalated = 0;
  const skipped: SweepSkip[] = [];

  for (const flag of due ?? []) {
    const flagId = flag.id as string;
    const studentId = flag.student_id as string;
    try {
      const settings = await loadSettings(ctx, counselorId, studentId);

      // Did the student actually do the work? If so, close the flag instead.
      if (flag.deliverable_id) {
        const { data: deliverable, error: dErr } = await ctx.db
          .from("deliverables")
          .select("current_words")
          .eq("id", flag.deliverable_id as string)
          .maybeSingle();
        if (dErr) throw fromPostgrest(dErr);

        const moved =
          deliverable != null &&
          Number(deliverable.current_words ?? 0) > Number(flag.baseline_words ?? 0);

        if (moved) {
          await ctx.db
            .from("red_flags")
            .update({ status: "resolved", resolved_at: now })
            .eq("id", flagId)
            .eq("status", "open");
          skipped.push({ id: flagId, reason: "student made progress" });
          continue;
        }
      }

      // The anti-spam throttle. Quiet hours don't skip the flag — they hold the
      // alert until the next send window, below.
      const blocked = await alertBlockedReason(ctx, studentId, settings);
      if (blocked && !/quiet hours/i.test(blocked)) {
        skipped.push({ id: flagId, reason: blocked });
        continue;
      }

      // Throws on a prefs read error (fail closed) — caught below as a hold.
      const recipients = await resolveAlertRecipients(ctx, studentId);
      if (recipients.blockedReason) {
        skipped.push({ id: flagId, reason: recipients.blockedReason });
        continue;
      }

      // Claim the flag before queueing anything. A counselor's click and the
      // scheduled run can overlap; only the one whose conditional update lands
      // queues an alert, so a family never gets the same escalation twice.
      const { data: claimed, error: claimErr } = await ctx.db
        .from("red_flags")
        .update({ status: "escalated", escalated_at: now })
        .eq("id", flagId)
        .eq("status", "open")
        .select("id");
      if (claimErr) throw fromPostgrest(claimErr);
      if (!claimed || claimed.length === 0) {
        skipped.push({ id: flagId, reason: "already handled by another sweep" });
        continue;
      }

      // Auto-send never overrides quiet hours: inside them the alert is held
      // for the next window like any other.
      const sendNow = settings.auto_send_parent_alerts && !inQuietHours(settings);

      const { error: insertErr } = await ctx.db.from("parent_alerts").insert({
        student_id: studentId,
        guardian_id: recipients.guardianId,
        copy_student: recipients.copyStudent,
        red_flag_id: flagId,
        counselor_id: counselorId,
        trigger: "escalation",
        urgency: "high",
        subject: `Action needed: ${flag.title}`,
        body: String(flag.message),
        action_items: (flag.action_items as string[]) ?? [],
        channel: "email",
        status: sendNow ? "queued" : "scheduled",
        scheduled_for: sendNow ? null : nextSendWindow(settings),
      });

      if (insertErr) {
        // Put the flag back so the next sweep retries it rather than leaving
        // it marked escalated with no alert behind it.
        await ctx.db
          .from("red_flags")
          .update({ status: "open", escalated_at: null })
          .eq("id", flagId)
          .eq("status", "escalated");
        throw fromPostgrest(insertErr);
      }

      escalated += 1;
    } catch (err) {
      // Held, not sent. One student's failed read must not stop the rest of
      // the roster, and must never degrade into a permissive default.
      opts.log?.error({ err, flagId }, "accountability sweep: flag held after an error");
      skipped.push({
        id: flagId,
        reason: "Couldn't confirm this alert's settings or recipients, so it was held",
      });
    }
  }

  return { escalated, skipped };
}
