/**
 * Student accountability + parent communication.
 *
 * Note what is NOT here: there is no in-app inbox. Outbound goes to real email
 * or SMS via `message_deliveries`, because students don't check portals.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerCollection } from "../lib/collection.js";
import {
  alertBlockedReason,
  buildBehindList,
  DEFAULT_SETTINGS,
  inQuietHours,
  loadSettings,
  resolveAlertRecipients,
} from "../lib/accountability.js";
import { badRequest, forbidden, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { toAlertPref } from "../lib/serialize.js";

const studentQuery = z.object({ studentId: z.string().uuid().optional() });

const guardianBody = z
  .object({
    full_name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    relationship: z.string().trim().max(60).optional(),
    preferred_channel: z.enum(["email", "sms", "both"]).optional(),
    alerts_enabled: z.boolean().optional(),
    receives_reports: z.boolean().optional(),
    is_primary: z.boolean().optional(),
  })
  .partial({ full_name: true })
  .strict();

const deliverableBody = z
  .object({
    kind: z.enum([
      "essay", "common-app-section", "activity-list", "document",
      "test-registration", "recommendation", "aid-form", "custom",
    ]),
    title: z.string().trim().min(1).max(300),
    essay_id: z.string().uuid().nullable().optional(),
    student_college_id: z.string().uuid().nullable().optional(),
    target_words: z.number().int().min(0).max(100_000).nullable().optional(),
    current_words: z.number().int().min(0).max(100_000).optional(),
    progress_pct: z.number().int().min(0).max(100).optional(),
    status: z.enum(["not-started", "in-progress", "stalled", "review", "complete"]).optional(),
    due_date: z.string().date().nullable().optional(),
  })
  .partial({ kind: true, title: true })
  .strict();

export default async function accountabilityRoutes(app: FastifyInstance) {
  registerCollection(app, {
    path: "guardians", table: "guardians", body: guardianBody,
    toDto: (r) => r, orderBy: { column: "created_at", ascending: true },
  });

  registerCollection(app, {
    path: "deliverables", table: "deliverables", body: deliverableBody,
    toDto: (r) => r, orderBy: { column: "due_date", ascending: true },
  });

  /** The alert list: who is behind, and on what. */
  app.get(
    "/overview",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request) => {
      const students = await buildBehindList(request, request.auth.userId);
      const settings = await loadSettings(request, request.auth.userId);
      return { students, settings, quietHoursNow: inQuietHours(settings) };
    }
  );

  app.get(
    "/settings",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request) => {
      const { studentId } = studentQuery.parse(request.query);
      if (studentId) await resolveStudentId(request, studentId, "view");
      return loadSettings(request, request.auth.userId, studentId);
    }
  );

  app.put(
    "/settings",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("accountability:settings", 60, 60)],
    },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid().nullable().optional(),
          enabled: z.boolean().optional(),
          stallAfterDays: z.number().int().min(1).max(90).optional(),
          escalateAfterHours: z.number().int().min(1).max(720).optional(),
          minDaysBetweenAlerts: z.number().int().min(1).max(90).optional(),
          autoSendParentAlerts: z.boolean().optional(),
          alertOnLowQuality: z.boolean().optional(),
          quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
          quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
          timezone: z.string().trim().max(60).optional(),
        })
        .strict()
        .parse(request.body);

      if (b.studentId) await resolveStudentId(request, b.studentId, "edit");

      const row: Record<string, unknown> = {
        counselor_id: request.auth.userId,
        student_id: b.studentId ?? null,
      };
      if (b.enabled !== undefined) row.enabled = b.enabled;
      if (b.stallAfterDays !== undefined) row.stall_after_days = b.stallAfterDays;
      if (b.escalateAfterHours !== undefined) row.escalate_after_hours = b.escalateAfterHours;
      if (b.minDaysBetweenAlerts !== undefined) row.min_days_between_alerts = b.minDaysBetweenAlerts;
      if (b.autoSendParentAlerts !== undefined) row.auto_send_parent_alerts = b.autoSendParentAlerts;
      if (b.alertOnLowQuality !== undefined) row.alert_on_low_quality = b.alertOnLowQuality;
      if (b.quietHoursStart !== undefined) row.quiet_hours_start = b.quietHoursStart;
      if (b.quietHoursEnd !== undefined) row.quiet_hours_end = b.quietHoursEnd;
      if (b.timezone !== undefined) row.timezone = b.timezone;

      const { data, error } = await request.db
        .from("accountability_settings")
        .upsert(row, { onConflict: "counselor_id,student_id" })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return { ...DEFAULT_SETTINGS, ...(data as object) };
    }
  );

  // ---- Alert recipients ----------------------------------------------------
  //
  // Who is copied when an alert or a family update goes out. Counselor-written:
  // a student switching off the alerts about themselves is the one thing this
  // must not permit, which is why it does not use the standard student-scoped
  // policies. Readable by the student, so the arrangement is not a secret.

  app.get("/alert-prefs", { preHandler: app.authenticate }, async (request) => {
    const { studentId } = studentQuery.parse(request.query);
    const student = await resolveStudentId(request, studentId, "view");

    const { data, error } = await request.db
      .from("student_alert_prefs")
      .select("*")
      .eq("student_id", student)
      .maybeSingle();
    if (error) throw fromPostgrest(error);

    // No row means the default, not "unknown": parents on, student off.
    return data
      ? toAlertPref(data as Record<string, unknown>)
      : {
          studentId: student,
          copyParents: true,
          copyStudent: false,
          note: null,
          updatedBy: null,
          updatedAt: null,
        };
  });

  app.put(
    "/alert-prefs",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("alert-prefs:put", 120, 60)],
    },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          copyParents: z.boolean().optional(),
          copyStudent: z.boolean().optional(),
          note: z.string().trim().max(1000).nullable().optional(),
        })
        .strict()
        .parse(request.body);

      const student = await resolveStudentId(request, b.studentId, "edit");

      const row: Record<string, unknown> = {
        student_id: student,
        updated_by: request.auth.userId,
      };
      if (b.copyParents !== undefined) row.copy_parents = b.copyParents;
      if (b.copyStudent !== undefined) row.copy_student = b.copyStudent;
      if (b.note !== undefined) row.note = b.note;

      const { data, error } = await request.db
        .from("student_alert_prefs")
        .upsert(row, { onConflict: "student_id" })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toAlertPref(data as Record<string, unknown>);
    }
  );

  // ---- Red flags -----------------------------------------------------------

  app.get("/red-flags", { preHandler: app.authenticate }, async (request) => {
    const { studentId } = studentQuery.parse(request.query);

    let builder = request.db.from("red_flags").select("*");
    if (studentId || request.profile.role === "student") {
      const student = await resolveStudentId(request, studentId, "view");
      builder = builder.eq("student_id", student);
    }

    const { data, error } = await builder
      .in("status", ["open", "acknowledged", "escalated"])
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  app.post(
    "/red-flags",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("redflags:create", 60, 3600)],
    },
    async (request, reply) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          deliverableId: z.string().uuid().nullable().optional(),
          deadlineId: z.string().uuid().nullable().optional(),
          severity: z.enum(["critical", "high", "medium"]).optional(),
          title: z.string().trim().min(1).max(300),
          message: z.string().trim().min(1).max(4000),
          actionItems: z.array(z.string().trim().max(300)).max(10).optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "edit");
      const settings = await loadSettings(request, request.auth.userId, b.studentId);

      // Snapshot the word count now, so escalation can ask "did anything move?"
      let baselineWords: number | null = null;
      if (b.deliverableId) {
        const { data } = await request.db
          .from("deliverables")
          .select("current_words")
          .eq("id", b.deliverableId)
          .maybeSingle();
        baselineWords = data ? Number(data.current_words ?? 0) : null;
      }

      const escalateAt = new Date(
        Date.now() + settings.escalate_after_hours * 3_600_000
      ).toISOString();

      const { data, error } = await request.db
        .from("red_flags")
        .insert({
          student_id: b.studentId,
          deliverable_id: b.deliverableId ?? null,
          deadline_id: b.deadlineId ?? null,
          severity: b.severity ?? "critical",
          title: b.title,
          message: b.message,
          action_items: b.actionItems ?? [],
          trigger: "manual",
          issued_by: "counselor",
          issued_by_id: request.auth.userId,
          baseline_words: baselineWords,
          escalate_at: escalateAt,
        })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);

      // The student sees it immediately — that's the whole point of a red flag.
      await request.db.from("notifications").insert({
        recipient_id: b.studentId,
        student_id: b.studentId,
        kind: "red-flag",
        urgency: "critical",
        title: b.title,
        body: b.message,
        action_items: b.actionItems ?? [],
        created_by: request.auth.userId,
        href: "/dashboard/student",
      });

      return reply.code(201).send(data);
    }
  );

  /** Students acknowledge; counselors resolve or cancel. */
  app.patch(
    "/red-flags/:id",
    { preHandler: [app.authenticate, limit("redflags:update", 120, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z
        .object({ status: z.enum(["acknowledged", "resolved", "cancelled"]) })
        .strict()
        .parse(request.body);

      const { data: existing } = await request.db
        .from("red_flags")
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound();

      const isStudent = request.profile.role === "student";
      if (isStudent) {
        if (existing.student_id !== request.auth.userId) throw forbidden();
        if (b.status !== "acknowledged") {
          throw forbidden("Only your counselor can close a red flag");
        }
      } else {
        await resolveStudentId(request, existing.student_id as string, "edit");
      }

      const update: Record<string, unknown> = { status: b.status };
      if (b.status === "acknowledged") update.acknowledged_at = new Date().toISOString();
      if (b.status === "resolved") update.resolved_at = new Date().toISOString();

      const { data, error } = await request.db
        .from("red_flags")
        .update(update)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();
      return data;
    }
  );

  // ---- Parent alerts -------------------------------------------------------

  app.get(
    "/parent-alerts",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request) => {
      const { studentId } = studentQuery.parse(request.query);
      let builder = request.db.from("parent_alerts").select("*");
      if (studentId) {
        await resolveStudentId(request, studentId, "view");
        builder = builder.eq("student_id", studentId);
      }
      const { data, error } = await builder
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw fromPostgrest(error);
      return data ?? [];
    }
  );

  /**
   * Queue a parent alert. Always goes through the throttle — including the
   * manual "send now" button, unless the counselor explicitly overrides quiet
   * hours. The minimum gap between alerts is never overridable.
   */
  app.post(
    "/parent-alerts",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("parent-alerts:create", 30, 3600),
      ],
    },
    async (request, reply) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          guardianId: z.string().uuid().optional(),
          redFlagId: z.string().uuid().optional(),
          trigger: z
            .enum(["no-progress", "low-quality", "likely-ai", "missed-deadline", "manual", "escalation"])
            .optional(),
          urgency: z.enum(["critical", "high", "normal"]).optional(),
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(8000),
          actionItems: z.array(z.string().trim().max(300)).max(10).optional(),
          channel: z.enum(["email", "sms", "both"]).optional(),
          sendNow: z.boolean().optional(),
          overrideQuietHours: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "edit");

      await enforceQuota(
        request.auth.userId,
        "parent_alerts",
        "day",
        50,
        "You've queued a lot of parent alerts today."
      );

      const settings = await loadSettings(request, request.auth.userId, b.studentId);
      const blocked = await alertBlockedReason(request, b.studentId, settings, {
        ignoreQuietHours: b.overrideQuietHours === true,
      });

      // Recipients come from `student_alert_prefs` AND the guardian's own
      // opt-out. A guardian who opted out never receives anything, manual or
      // not; a counselor who switched the parents off is not overruled by a
      // guardian still marked enabled.
      const recipients = await resolveAlertRecipients(request, b.studentId, b.guardianId ?? null);
      if (recipients.blockedReason) throw badRequest(recipients.blockedReason);

      const throttled = Boolean(blocked) && !/quiet hours/i.test(blocked ?? "");
      const status = throttled
        ? "suppressed"
        : blocked
          ? "scheduled"
          : b.sendNow
            ? "queued"
            : "queued";

      const { data, error } = await request.db
        .from("parent_alerts")
        .insert({
          student_id: b.studentId,
          guardian_id: recipients.guardianId,
          copy_student: recipients.copyStudent,
          red_flag_id: b.redFlagId ?? null,
          counselor_id: request.auth.userId,
          trigger: b.trigger ?? "manual",
          urgency: b.urgency ?? "high",
          subject: b.subject,
          body: b.body,
          action_items: b.actionItems ?? [],
          channel: b.channel ?? "email",
          status,
          suppressed_reason: throttled ? blocked : null,
          scheduled_for: blocked && !throttled ? nextSendWindow(settings) : null,
        })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return reply.code(201).send({ ...data, blockedReason: blocked });
    }
  );

  /**
   * Escalation sweep. Turns red flags whose timer expired — and whose
   * deliverable hasn't moved — into queued parent alerts. Meant to be called on
   * a schedule; it only ever touches the caller's own roster.
   */
  app.post(
    "/sweep",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("accountability:sweep", 12, 3600)] },
    async (request) => {
      const now = new Date().toISOString();

      const { data: due, error } = await request.db
        .from("red_flags")
        .select("*")
        .eq("status", "open")
        .lt("escalate_at", now)
        .limit(100);

      if (error) throw fromPostgrest(error);

      const escalated: string[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const flag of due ?? []) {
        const studentId = flag.student_id as string;
        const settings = await loadSettings(request, request.auth.userId, studentId);

        // Did the student actually do the work? If so, close the flag instead.
        if (flag.deliverable_id) {
          const { data: deliverable } = await request.db
            .from("deliverables")
            .select("current_words")
            .eq("id", flag.deliverable_id as string)
            .maybeSingle();

          const moved =
            deliverable != null &&
            Number(deliverable.current_words ?? 0) > Number(flag.baseline_words ?? 0);

          if (moved) {
            await request.db
              .from("red_flags")
              .update({ status: "resolved", resolved_at: now })
              .eq("id", flag.id as string);
            skipped.push({ id: flag.id as string, reason: "student made progress" });
            continue;
          }
        }

        const blocked = await alertBlockedReason(request, studentId, settings);
        if (blocked && !/quiet hours/i.test(blocked)) {
          skipped.push({ id: flag.id as string, reason: blocked });
          continue;
        }

        const recipients = await resolveAlertRecipients(request, studentId);
        if (recipients.blockedReason) {
          skipped.push({ id: flag.id as string, reason: recipients.blockedReason });
          continue;
        }

        await request.db.from("parent_alerts").insert({
          student_id: studentId,
          guardian_id: recipients.guardianId,
          copy_student: recipients.copyStudent,
          red_flag_id: flag.id as string,
          counselor_id: request.auth.userId,
          trigger: "escalation",
          urgency: "high",
          subject: `Action needed: ${flag.title}`,
          body: String(flag.message),
          action_items: (flag.action_items as string[]) ?? [],
          channel: "email",
          status: settings.auto_send_parent_alerts ? "queued" : "scheduled",
          scheduled_for: settings.auto_send_parent_alerts ? null : nextSendWindow(settings),
        });

        await request.db
          .from("red_flags")
          .update({ status: "escalated", escalated_at: now })
          .eq("id", flag.id as string);

        escalated.push(flag.id as string);
      }

      return { escalated: escalated.length, skipped };
    }
  );
}

/** Next moment outside quiet hours, so a held alert has a real send time. */
function nextSendWindow(settings: { quiet_hours_end: number | null }): string {
  const next = new Date();
  next.setHours((settings.quiet_hours_end ?? 8) + 1, 0, 0, 0);
  if (next.getTime() < Date.now()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
