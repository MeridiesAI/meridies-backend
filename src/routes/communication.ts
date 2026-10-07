/**
 * A student's Communication page (demo v8-v10), under `/communication`.
 *
 *   GET  /:id/composer           who the composer writes to, the family list, the
 *                                student's contact, AxIS suggestions, quiet hours
 *   PUT  /:id/prefs              "Parent | <student>" and "Email | Text", per student
 *   POST /:id/draft              AxIS drafts subject and body from the student's data
 *   POST /:id/messages           send now, or schedule (quiet hours hold it)
 *   GET  /:id/messages           what the composer sent or scheduled
 *   POST /messages/:messageId/cancel   cancel a scheduled message
 *   POST /:id/file-as-report     file the draft as a family report to approve
 *   POST /internal/dispatch      CRON_SECRET: deliver scheduled messages that are due
 *
 * Counselor-only throughout: the composer is the counselor's, and so is
 * everything it wrote. Family contacts are added and removed through the
 * existing `/accountability/guardians` collection.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inQuietHours, loadSettings, nextSendWindow } from "../lib/accountability.js";
import { runStructured } from "../lib/anthropic.js";
import { badRequest, fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { beat } from "../lib/heartbeat.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceQuota, limit } from "../lib/limits.js";
import {
  alertThrottleReason,
  deliverMessage,
  dispatchDueMessages,
  familyName,
  firstName,
  kindFor,
  loadComposerFacts,
  loadComposerPref,
  loadFamily,
  loadStudentContact,
  planSend,
  recordOutcome,
  recordReferralAsk,
  requireCronSecret,
  resolveRecipients,
  suggestionsFor,
  type MessageRow,
} from "../lib/studentMessages.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });
const audienceEnum = z.enum(["parent", "student"]);
const channelEnum = z.enum(["email", "sms"]);

/** Text messages are kept to two segments; the composer's meter says so. */
export const TEXT_LIMIT = 320;

function toMessage(r: Row) {
  return {
    id: String(r.id),
    studentId: String(r.student_id),
    audience: r.audience as "parent" | "student",
    channel: r.channel as "email" | "sms",
    kind: r.kind as "message" | "referral" | "alert",
    recipients: (Array.isArray(r.recipients) ? r.recipients : []) as {
      kind: string;
      name: string;
      email: string | null;
      phone: string | null;
    }[],
    subject: (r.subject as string | null) ?? null,
    body: String(r.body),
    status: r.status as "scheduled" | "queued" | "sent" | "failed" | "cancelled",
    holdReason: (r.hold_reason as string | null) ?? null,
    scheduledFor: (r.scheduled_for as string | null) ?? null,
    sentAt: (r.sent_at as string | null) ?? null,
    attempts: (Array.isArray(r.attempts) ? r.attempts : []) as unknown[],
    aiDrafted: r.ai_drafted === true,
    createdAt: String(r.created_at),
  };
}

export default async function communicationRoutes(app: FastifyInstance) {
  const counselorOnly = [app.authenticate, requireRole("counselor")];

  app.get(
    "/:id/composer",
    { preHandler: [...counselorOnly, limit("communication:composer", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      const db = request.db;

      const [pref, family, contact, facts, settings] = await Promise.all([
        loadComposerPref(db, student),
        loadFamily(db, student),
        loadStudentContact(db, student),
        loadComposerFacts(db, student),
        loadSettings(request, request.auth.userId, student),
      ]);
      if (!contact) throw notFound("That student isn't on your roster");

      const quiet = inQuietHours(settings);
      return {
        prefs: pref,
        family,
        student: contact,
        counselor: { name: request.profile.full_name ?? null, email: request.profile.email ?? null },
        suggestions: {
          parent: suggestionsFor("parent", facts),
          student: suggestionsFor("student", facts),
        },
        applicationsIn: facts.applicationsIn,
        quietHours: { now: quiet, resumesAt: quiet ? nextSendWindow(settings) : null },
        textLimit: TEXT_LIMIT,
      };
    }
  );

  app.put(
    "/:id/prefs",
    { preHandler: [...counselorOnly, limit("communication:prefs", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({ audience: audienceEnum.optional(), channel: channelEnum.optional() })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");

      const row: Row = { student_id: student, updated_by: request.auth.userId };
      if (b.audience) row.composer_audience = b.audience;
      if (b.channel) row.composer_channel = b.channel;
      const { error } = await request.db.from("student_alert_prefs").upsert(row, { onConflict: "student_id" });
      if (error) throw fromPostgrest(error);
      return loadComposerPref(request.db, student);
    }
  );

  /**
   * AxIS writes the draft. Persists nothing and sends nothing: the counselor
   * reads it in the composer, edits it, and presses Send.
   */
  app.post(
    "/:id/draft",
    { preHandler: [...counselorOnly, limit("communication:draft", 20, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          audience: audienceEnum,
          channel: channelEnum,
          prompt: z.string().trim().min(1).max(600),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;
      const today = new Date().toISOString().slice(0, 10);

      const [profile, colleges, tasks, family, aid, letters, facts] = await Promise.all([
        db.from("profiles").select("full_name, grad_year, high_school").eq("id", student).maybeSingle(),
        db
          .from("student_colleges")
          .select("name, round, deadline, custom_deadline, status")
          .eq("student_id", student)
          .order("deadline", { ascending: true, nullsFirst: false })
          .limit(25),
        db
          .from("deliverables")
          .select("title, kind, status, due_date, progress_pct")
          .eq("student_id", student)
          .neq("status", "complete")
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(20),
        loadFamily(db, student),
        db
          .from("student_aid_profiles")
          .select("fafsa_status, fafsa_due_date, css_status, css_due_date")
          .eq("student_id", student)
          .maybeSingle(),
        db
          .from("award_letters")
          .select("school_name, net_price_cents, cost_of_attendance_cents")
          .eq("student_id", student)
          .limit(15),
        loadComposerFacts(db, student),
      ]);
      for (const r of [profile, colleges, tasks, aid, letters]) {
        if (r.error) throw fromPostgrest(r.error);
      }
      if (!profile.data) throw notFound("That student isn't on your roster");

      const name = String(profile.data.full_name ?? "");
      const isSms = b.channel === "sms";
      const kind = kindFor(b.prompt, b.audience);
      const greeting =
        b.audience === "parent"
          ? family
              .filter((g) => g.receivesMessages)
              .map((g) => g.name)
              .slice(0, 3)
          : [firstName(name)];

      const result = await runStructured<{ subject: string; body: string }>({
        request,
        // The communication drafter shares the parent-alert module in ai_runs.
        module: "parent-alert",
        studentId: student,
        system: [
          "You are AxIS, the assistant inside Meridies, software for independent college counselors.",
          `You draft a ${isSms ? "text message" : "short email"} the counselor will read, edit and send themselves.`,
          b.audience === "parent"
            ? `Write to the parents of ${name}, not about them. Plain English, no admissions jargon.`
            : `Write to ${firstName(name)}, the student. Warm, direct, brief.`,
          "Use only the facts in the data you are given: schools, dates, tasks and figures. Never invent one.",
          "Never predict an admissions outcome. Never threaten or guilt.",
          "Never write, quote or suggest wording for any part of the student's essays or application answers; you may say an essay is due or needs starting, nothing more.",
          "No FAFSA details beyond its status and due date. Never ask for a Social Security number or any account number.",
          isSms
            ? `This is a text: under ${TEXT_LIMIT} characters, one paragraph, no salutation, no sign-off. Subject is a three-word label.`
            : `Greet ${greeting.length ? greeting.join(" and ") : "the family"} by first name. A few short paragraphs, then a sign-off with the counselor's name: ${request.profile.full_name ?? "your counselor"}.`,
          kind === "referral"
            ? "This is the post-application referral ask: thank the family now that the applications are in, and ask whether they know a family starting the process; an introduction by email is all it takes."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        prompt: [
          `Request: ${b.prompt}`,
          `Today: ${today}`,
          "",
          `Student: ${JSON.stringify({ name, gradYear: profile.data.grad_year, highSchool: profile.data.high_school, applicationsIn: facts.applicationsIn })}`,
          `College list: ${JSON.stringify(colleges.data ?? [])}`,
          `Open tasks: ${JSON.stringify(tasks.data ?? [])}`,
          `Aid forms: ${JSON.stringify(aid.data ?? null)}`,
          `Award letters: ${JSON.stringify(letters.data ?? [])}`,
        ]
          .join("\n")
          .slice(0, 14000),
        toolName: "composer_draft",
        maxTokens: 1200,
        schema: {
          type: "object",
          properties: {
            subject: { type: "string", maxLength: 200 },
            body: { type: "string", maxLength: isSms ? 400 : 5000 },
          },
          required: ["subject", "body"],
        },
      });

      const subject = String(result.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      // Hard caps here too: a system prompt is a request.
      const body = isSms
        ? String(result.body ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT)
        : String(result.body ?? "").trim().slice(0, 5000);
      if (!body) throw unavailable("AxIS didn't return a usable draft. Try again.");

      return { subject: isSms ? "" : subject, body, kind, status: "draft" as const };
    }
  );

  app.post(
    "/:id/messages",
    {
      preHandler: [...counselorOnly, limit("communication:send", 30, 3600)],
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          audience: audienceEnum,
          channel: channelEnum,
          kind: z.enum(["message", "referral", "alert"]).optional(),
          subject: z.string().trim().max(300).optional(),
          body: z.string().trim().min(1).max(20_000),
          /** ISO time to send at; omitted sends now (or at the end of quiet hours). */
          scheduleFor: z.string().datetime({ offset: true }).nullable().optional(),
          overrideQuietHours: z.boolean().optional(),
          aiDrafted: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const kind = b.kind ?? "message";
      if (b.audience === "parent" && b.channel !== "email") throw badRequest("Messages to the parents go by email");
      if (b.channel === "email" && !b.subject) throw badRequest("Add a subject first");
      if (b.channel === "sms" && b.body.length > TEXT_LIMIT) {
        throw badRequest(`Texts are kept under ${TEXT_LIMIT} characters`);
      }
      if (kind !== "message" && b.audience !== "parent") throw badRequest("That kind of message goes to the parents");

      await enforceQuota(
        request.auth.userId,
        "parent_alerts",
        "day",
        100,
        "You've sent a lot of family messages today."
      );

      const recipients = await resolveRecipients(db, student, b.audience, b.channel);
      const settings = await loadSettings(request, request.auth.userId, student);
      if (kind === "alert") {
        const throttled = await alertThrottleReason(db, student, settings);
        if (throttled) throw badRequest(throttled);
      }
      const plan = planSend(settings, { scheduleFor: b.scheduleFor, overrideQuietHours: b.overrideQuietHours });

      const { data, error } = await db
        .from("student_messages")
        .insert({
          student_id: student,
          counselor_id: request.auth.userId,
          audience: b.audience,
          channel: b.channel,
          kind,
          recipients,
          subject: b.channel === "email" ? b.subject : null,
          body: b.body,
          status: plan.status,
          scheduled_for: plan.scheduledFor,
          hold_reason: plan.holdReason,
          ai_drafted: b.aiDrafted === true,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      const row = data as Row;

      const referralTracked =
        kind === "referral"
          ? await recordReferralAsk(db, request.auth.userId, student, String(row.id), request.log)
          : false;

      if (plan.status === "scheduled") {
        return reply.code(201).send({ ...toMessage(row), referralTracked });
      }

      const outcome = await deliverMessage(
        row as unknown as MessageRow,
        request.profile.full_name ?? null,
        request.log
      );
      const written = await recordOutcome(db, String(row.id), outcome, request.log);
      return reply.code(201).send({
        ...toMessage(written ?? { ...row, status: outcome.status, attempts: outcome.attempts }),
        referralTracked,
      });
    }
  );

  app.get(
    "/:id/messages",
    { preHandler: [...counselorOnly, limit("communication:messages", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      const { data, error } = await request.db
        .from("student_messages")
        .select("*")
        .eq("student_id", student)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw fromPostgrest(error);
      return ((data ?? []) as Row[]).map(toMessage);
    }
  );

  app.post(
    "/messages/:messageId/cancel",
    { preHandler: [...counselorOnly, limit("communication:cancel", 120, 60)] },
    async (request) => {
      const { messageId } = z.object({ messageId: z.string().uuid() }).parse(request.params);
      const { data: existing, error: readError } = await request.db
        .from("student_messages")
        .select("student_id, status")
        .eq("id", messageId)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      if (!existing) throw notFound("That message doesn't exist");
      await resolveStudentId(request, existing.student_id as string, "edit");
      if (existing.status !== "scheduled") throw badRequest("Only a scheduled message can be cancelled");

      const { data, error } = await request.db
        .from("student_messages")
        .update({ status: "cancelled", hold_reason: null })
        .eq("id", messageId)
        .eq("status", "scheduled")
        .select("*")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw badRequest("That message has already gone out");
      return toMessage(data as Row);
    }
  );

  /**
   * "File as family report": the draft goes into the family reports approval
   * queue as written, and approving it lands on My Work Queue so it is not
   * filed and forgotten.
   */
  app.post(
    "/:id/file-as-report",
    { preHandler: [...counselorOnly, limit("communication:file-report", 30, 60)] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          subject: z.string().trim().max(200).optional(),
          body: z.string().trim().min(1).max(20_000),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const { data: profile, error: profileError } = await db
        .from("profiles")
        .select("full_name")
        .eq("id", student)
        .maybeSingle();
      if (profileError) throw fromPostgrest(profileError);
      if (!profile) throw notFound("That student isn't on your roster");
      const family = familyName(String(profile.full_name ?? ""));
      const title = b.subject || "Family update";

      const { data: report, error } = await db
        .from("family_reports")
        .insert({
          student_id: student,
          counselor_id: request.auth.userId,
          title: `${title}, for the ${family} family`,
          kind: "ad-hoc",
          body: b.body,
          status: "draft",
        })
        .select("id, title")
        .single();
      if (error) throw fromPostgrest(error);

      const today = new Date().toISOString().slice(0, 10);
      const { error: queueError } = await db.from("counselor_work_items").insert({
        counselor_id: request.auth.userId,
        assigned_by: request.auth.userId,
        student_id: student,
        kind: "report",
        title: `Approve the ${family} family report`,
        detail: title,
        due_date: today,
        source: "Family reports",
        family_report_id: (report as Row).id,
      });
      // The report is filed either way; say whether the queue item made it.
      if (queueError) request.log.warn({ code: queueError.code }, "file-as-report: work item insert failed");

      return reply.code(201).send({
        familyReportId: String((report as Row).id),
        title: String((report as Row).title),
        onWorkQueue: !queueError,
      });
    }
  );

  // ---- Machine route ------------------------------------------------------------
  //
  // Railway cron, alongside the accountability sweep:
  //   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  //     "$API_URL/communication/internal/dispatch"

  app.post(
    "/internal/dispatch",
    {
      preHandler: [requireCronSecret],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const svc = serviceClient();
      if (!svc) return reply.code(503).send({ ran: false, reason: "Scheduled sends need the service role key" });
      try {
        const tally = await dispatchDueMessages(svc, request.log);
        await beat("message-dispatch", true, undefined, request.log);
        return { ran: true, ...tally };
      } catch (err) {
        await beat("message-dispatch", false, err instanceof Error ? err.message : "failed", request.log);
        throw err;
      }
    }
  );
}
