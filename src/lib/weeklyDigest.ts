/**
 * The weekly family digest, drafted (never sent) on the dispatch cron.
 *
 * `runWeeklyDigest` rides on `POST /communication/internal/dispatch` after the students' reminders, under its own
 * `weekly-digest` lease, which it keeps for an hour on success: the content of a finished week doesn't change, so
 * there is nothing to gain from asking every few minutes (a failed run releases it, so the next cron tries again).
 * It runs on the service client and scopes everything itself: it starts from the settings rows that switched the
 * digest on, keeps only approved counselors (`approvedCounselorIds`, asked per run), and reads each one's roster by
 * `profiles.counselor_id` (students, not archived). A student is drafted when their effective setting is 'draft'
 * (the counselor-wide row, or a per-student row that wins over it either way: `digestWanted`).
 *
 * For the last completed Monday-Sunday week in the counselor's zone (`profiles.timezone`, else
 * DIGEST_DEFAULT_TIMEZONE) it writes one `family_reports` row (status 'draft', kind 'weekly', period_start/end)
 * and one `counselor_work_items` row (kind 'report', the file-as-report shape) so it shows in the Review Queue and
 * on My Work Queue. The unique index on (student_id, kind, period_start) where kind = 'weekly' makes a re-run or an
 * overlapping run a no-op: the insert's unique violation is the "already drafted" answer. A week with nothing to
 * report gets no row and is counted (it is asked again on the next hourly run). Content: lib/weeklyDigestContent.ts.
 *
 * Nothing here sends. Sending is the counselor's approve-send (routes/reports.ts).
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger } from "fastify";
import { approvedCounselorIds } from "./access.js";
import { firstNameOf, type SettingsRow } from "./inactivity.js";
import {
  addDays,
  buildWeeklyDigest,
  digestWanted,
  essayMovement,
  lastCompletedWeek,
  shortDay,
  type DigestEssay,
  type DigestWeek,
  type WordEvent,
} from "./weeklyDigestContent.js";

type Log = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
type Row = Record<string, unknown>;

export const DIGEST_LEASE = "weekly-digest";
/** Held for an hour after a clean run, so the job runs at most hourly across replicas. */
const LEASE_TTL_SECONDS = 60 * 60;
const SETTINGS_LIMIT = 5000;
const ROSTER_LIMIT = 1000;
const ID_CHUNK = 200;
const UNIQUE_VIOLATION = "23505";
/** College statuses that still have a deadline ahead of them. */
const OPEN_COLLEGE = ["not-started", "in-progress"];

export type DigestTally = {
  ran: boolean;
  reason?: string;
  counselors: number;
  drafted: number;
  alreadyDrafted: number;
  nothingToReport: number;
  failedCounselors: number;
};

export async function runWeeklyDigest(svc: SupabaseClient, log: Log, now = new Date()): Promise<DigestTally> {
  const tally: DigestTally = { ran: false, counselors: 0, drafted: 0, alreadyDrafted: 0, nothingToReport: 0, failedCounselors: 0 };
  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
    p_name: DIGEST_LEASE,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseErr) return { ...tally, reason: "lease-error" };
  if (acquired !== true) return { ...tally, reason: "locked" };

  try {
    const { data: on, error } = await svc
      .from("accountability_settings")
      .select("counselor_id")
      .eq("weekly_digest", "draft")
      .limit(SETTINGS_LIMIT);
    if (error) {
      // Before 20261111000003 the column isn't there: nothing is switched on.
      log.warn({ code: error.code }, "weekly digest: settings unreadable, skipped");
      await release(svc, holder, log);
      return { ...tally, ran: true, reason: "settings-unreadable" };
    }
    tally.ran = true;
    const counselorIds = [...new Set((on ?? []).map((r) => String(r.counselor_id)))];
    const approved = counselorIds.length ? await approvedCounselorIds(svc, counselorIds) : new Set<string>();
    for (const counselorId of counselorIds) {
      if (!approved.has(counselorId)) continue;
      tally.counselors += 1;
      try {
        await draftForCounselor(svc, log, counselorId, now, tally);
      } catch (err) {
        tally.failedCounselors += 1;
        log.error({ err, counselorId }, "weekly digest: counselor failed");
      }
    }
  } catch (err) {
    await release(svc, holder, log);
    throw err;
  }
  // A counselor that failed is tried again on the next run, not an hour later.
  if (tally.failedCounselors > 0) await release(svc, holder, log);
  log.info(tally, "weekly digest finished");
  return tally;
}

async function release(svc: SupabaseClient, holder: string, log: Log): Promise<void> {
  const { error } = await svc.rpc("release_job_lease", { p_name: DIGEST_LEASE, p_holder: holder });
  if (error) log.warn({ code: error.code }, "weekly digest: lease release failed");
}

async function draftForCounselor(svc: SupabaseClient, log: Log, counselorId: string, now: Date, tally: DigestTally): Promise<void> {
  // An errored settings read is not "no settings": throw, like loadSettings.
  const { data: rows, error: sErr } = await svc.from("accountability_settings").select("*").eq("counselor_id", counselorId);
  if (sErr) throw new Error(`settings read failed (${sErr.code ?? "unknown"})`);
  const settingsRows = (rows ?? []) as SettingsRow[];

  const { data: me, error: mErr } = await svc.from("profiles").select("timezone").eq("id", counselorId).maybeSingle();
  if (mErr) throw new Error(`counselor read failed (${mErr.code ?? "unknown"})`);
  const week = lastCompletedWeek(now, (me?.timezone as string | null) ?? null);

  const { data: roster, error: rErr } = await svc
    .from("profiles")
    .select("id, full_name")
    .eq("counselor_id", counselorId)
    .eq("role", "student")
    .is("archived_at", null)
    .order("id")
    .limit(ROSTER_LIMIT);
  if (rErr) throw new Error(`roster read failed (${rErr.code ?? "unknown"})`);
  const students = ((roster ?? []) as Row[]).filter((s) => digestWanted(settingsRows, String(s.id)));
  if (students.length === 0) return;

  const done = new Set<string>();
  for (let i = 0; i < students.length; i += ID_CHUNK) {
    const ids = students.slice(i, i + ID_CHUNK).map((s) => String(s.id));
    const { data: existing, error: eErr } = await svc
      .from("family_reports")
      .select("student_id")
      .eq("kind", "weekly")
      .eq("period_start", week.periodStart)
      .in("student_id", ids);
    if (eErr) throw new Error(`report read failed (${eErr.code ?? "unknown"})`);
    for (const r of existing ?? []) done.add(String(r.student_id));
  }

  for (const s of students) {
    const studentId = String(s.id);
    if (done.has(studentId)) {
      tally.alreadyDrafted += 1;
      continue;
    }
    const digest = buildWeeklyDigest({ fullName: (s.full_name as string | null) ?? null, week, ...(await loadWeek(svc, studentId, week)) });
    if (!digest) {
      tally.nothingToReport += 1;
      continue;
    }

    const { data: report, error: iErr } = await svc
      .from("family_reports")
      .insert({
        student_id: studentId,
        counselor_id: counselorId,
        title: digest.title,
        kind: "weekly",
        period_start: week.periodStart,
        period_end: week.periodEnd,
        summary: digest.summary,
        highlights: digest.highlights,
        body: digest.body,
        // A draft, never sent: the counselor reads it and approves the send.
        status: "draft",
      })
      .select("id")
      .single();
    if (iErr?.code === UNIQUE_VIOLATION) {
      tally.alreadyDrafted += 1; // an overlapping run drafted it a moment ago
      continue;
    }
    if (iErr) throw new Error(`report insert failed (${iErr.code ?? "unknown"})`);
    const reportId = String((report as Row).id);

    const first = firstNameOf((s.full_name as string | null) ?? null);
    const { error: wErr } = await svc.from("counselor_work_items").insert({
      counselor_id: counselorId,
      assigned_by: counselorId,
      student_id: studentId,
      kind: "report",
      title: `Approve ${first}'s weekly family update`,
      detail: `${shortDay(week.periodStart)} to ${shortDay(week.periodEnd)}`,
      due_date: week.nextMonday,
      source: "Family reports",
      family_report_id: reportId,
    });
    if (wErr) {
      // Without the work item the draft would sit unseen: take it back, so the next run drafts both.
      log.error({ code: wErr.code, studentId }, "weekly digest: work item insert failed");
      const { error: dErr } = await svc.from("family_reports").delete().eq("id", reportId);
      if (dErr) log.error({ code: dErr.code, studentId }, "weekly digest: draft cleanup failed");
      throw new Error(`work item insert failed (${wErr.code ?? "unknown"})`);
    }
    tally.drafted += 1;
  }
}

/** The week's facts for one student. Every read throws on error: a half-read week is not "nothing to report". */
async function loadWeek(svc: SupabaseClient, studentId: string, week: DigestWeek) {
  const horizon = addDays(week.nextMonday, 14);
  const fail = (what: string, code?: string) => new Error(`${what} read failed (${code ?? "unknown"})`);

  const [completed, open, colleges, essays] = await Promise.all([
    svc
      .from("deliverables")
      .select("title")
      .eq("student_id", studentId)
      .eq("visible_to_student", true)
      .eq("status", "complete")
      .gte("updated_at", week.startUtc)
      .lt("updated_at", week.endUtc)
      .order("updated_at")
      .limit(50),
    svc
      .from("deliverables")
      .select("title, due_date")
      .eq("student_id", studentId)
      .eq("visible_to_student", true)
      .neq("status", "complete")
      .not("due_date", "is", null)
      .lt("due_date", horizon)
      .order("due_date")
      .limit(50),
    svc
      .from("student_colleges")
      .select("name, deadline, custom_deadline")
      .eq("student_id", studentId)
      .in("status", OPEN_COLLEGE)
      .limit(100),
    // Kind, school and dates only: never the essay's title, prompt or text.
    svc.from("essays").select("id, essay_kind, school, created_at").eq("student_id", studentId).limit(200),
  ]);
  if (completed.error) throw fail("tasks", completed.error.code);
  if (open.error) throw fail("open tasks", open.error.code);
  if (colleges.error) throw fail("colleges", colleges.error.code);
  if (essays.error) throw fail("essays", essays.error.code);

  const deadlines = ((colleges.data ?? []) as Row[])
    .map((c) => ({ name: String(c.name), date: String(c.custom_deadline ?? c.deadline ?? "") }))
    .filter((d) => d.date >= week.nextMonday && d.date < horizon);

  const essayRows = (essays.data ?? []) as DigestEssay[];
  let before: WordEvent[] = [];
  let during: WordEvent[] = [];
  if (essayRows.length) {
    const ids = essayRows.map((e) => e.id);
    const [d, b] = await Promise.all([
      svc
        .from("progress_events")
        .select("entity_id, word_count, created_at")
        .eq("student_id", studentId)
        .eq("entity_type", "essay")
        .in("entity_id", ids)
        .not("word_count", "is", null)
        .gte("created_at", week.startUtc)
        .lt("created_at", week.endUtc)
        .order("created_at")
        .limit(2000),
      svc
        .from("progress_events")
        .select("entity_id, word_count, created_at")
        .eq("student_id", studentId)
        .eq("entity_type", "essay")
        .in("entity_id", ids)
        .not("word_count", "is", null)
        .lt("created_at", week.startUtc)
        .order("created_at", { ascending: false })
        .limit(2000),
    ]);
    if (d.error) throw fail("essay progress", d.error.code);
    if (b.error) throw fail("essay progress", b.error.code);
    during = (d.data ?? []) as WordEvent[];
    before = (b.data ?? []) as WordEvent[];
  }

  return {
    completed: ((completed.data ?? []) as Row[]).map((t) => ({ title: String(t.title) })),
    open: ((open.data ?? []) as Row[]).map((t) => ({ title: String(t.title), due_date: String(t.due_date) })),
    deadlines,
    essays: essayMovement({ week, essays: essayRows, before, during }),
  };
}
