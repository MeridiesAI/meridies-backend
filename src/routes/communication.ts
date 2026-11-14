/**
 * A student's Communication page (demo v8-v10), under `/communication`.
 *
 *   GET  /:id/composer           who the composer writes to, the family list, the
 *                                student's contact, AxIS suggestions, quiet hours
 *   PUT  /:id/prefs              "Parent | <student>" and "Email | Text", per student
 *   POST /:id/draft              AxIS drafts subject and body from the student's data
 *   POST /:id/translate          the draft in the family's language (nothing stored); the composer
 *                                puts the English underneath and the counselor reads it over
 *   POST /:id/messages           send now, or schedule (quiet hours hold it)
 *   GET  /:id/messages           what the composer sent or scheduled
 *   GET  /:id/replies            what the family answered (email and text), newest first, each with
 *                                its English when it was written in another language
 *   POST /:id/replies/read       mark those read
 *   POST /messages/:messageId/cancel   cancel a scheduled message
 *   POST /:id/file-as-report     file the draft as a family report to approve
 *   POST /internal/dispatch      CRON_SECRET: deliver scheduled messages that are due,
 *                                then the students' own due-tomorrow task reminders, then
 *                                draft (never send) the weekly family digests
 *
 * Counselor-only throughout: the composer is the counselor's, and so is
 * everything it wrote. Family contacts are added and removed through the
 * existing `/accountability/guardians` collection.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { inQuietHours, loadSettings, nextSendWindow } from "../lib/accountability.js";
import { runStructured } from "../lib/anthropic.js";
import { hasAnthropic } from "../env.js";
import { badRequest, fromPostgrest, HttpError, notFound, tooManyRequests, unavailable } from "../lib/errors.js";
import { beat } from "../lib/heartbeat.js";
import { retryFailedTranslations } from "../lib/inboundTranslate.js";
import { isLanguageChoice, isLanguageCode, languageByCode } from "../lib/languages.js";
import { MAX_TRANSLATED_SEGMENTS, smsOverLimit } from "../lib/smsSegments.js";
import { translateFakeOn, translateMessage, TRANSLATE_BODY_MAX, TRANSLATE_SUBJECT_MAX } from "../lib/translate.js";
import { toInviteDelivery, type InviteDelivery } from "../lib/inviteDelivery.js";
import { plainName } from "../lib/context/identity.js";
import { loadFamilyVisibility } from "../lib/familyVisibility.js";
import { toFamilyVisibility } from "../lib/serialize.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { loadParentAccounts } from "../lib/parentInvites.js";
import { replyAddressFor } from "../lib/replyRouting.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
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
  loadFamilyLanguage,
  loadLanguageSuggestion,
  loadStudentContact,
  planSend,
  recordOutcome,
  recordReferralAsk,
  requireCronSecret,
  resolveRecipients,
  suggestionsFor,
  type MessageRow,
} from "../lib/studentMessages.js";
import { sendStudentReminders } from "../lib/studentReminders.js";
import { runWeeklyDigest } from "../lib/weeklyDigest.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });
const audienceEnum = z.enum(["parent", "student"]);
const channelEnum = z.enum(["email", "sms"]);
/** A language the family can be written to: a code from lib/languages.ts, never free text. */
const languageCode = z.string().refine(isLanguageCode, "That isn't a language we translate into");
const languageChoice = z.string().refine(isLanguageChoice, "That isn't a language we translate into");

/** Translation needs a model (or the test double); without one the composer hides Translate. */
const translateAvailable = (): boolean => hasAnthropic || translateFakeOn();

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

/**
 * Each attempt's status as the provider last reported it. The row's own
 * `attempts` were frozen when it went out (sent or failed); the delivery
 * webhooks move message_deliveries on to delivered or bounced, so the list
 * reads those back (counselor RLS on message_deliveries) rather than calling
 * a row delivered the provider never confirmed. Never fatal.
 */
async function liveAttemptStatus(request: FastifyRequest, rows: Row[]): Promise<Map<string, InviteDelivery>> {
  const ids = rows
    .flatMap((r) => (Array.isArray(r.attempts) ? (r.attempts as Row[]) : []))
    .map((a) => (typeof a.deliveryId === "string" ? a.deliveryId : null))
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return new Map();
  const { data, error } = await request.db
    .from("message_deliveries")
    .select("id, status, channel, error, sent_at, delivered_at, created_at")
    .in("id", ids.slice(0, 500));
  if (error) {
    request.log.warn({ code: error.code }, "message delivery status unreadable");
    return new Map();
  }
  const out = new Map<string, InviteDelivery>();
  for (const d of (data ?? []) as Row[]) {
    const mapped = toInviteDelivery(d);
    if (mapped) out.set(String(d.id), mapped);
  }
  return out;
}

function withLiveStatus(attempt: unknown, live: Map<string, InviteDelivery>) {
  const a = (attempt ?? {}) as Row;
  const d = typeof a.deliveryId === "string" ? live.get(a.deliveryId) : undefined;
  return d ? { ...a, status: d.status, deliveredAt: d.deliveredAt, error: d.reason ?? a.error ?? null } : a;
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

      const [pref, family, contact, facts, settings, familyLanguage, visibility] = await Promise.all([
        loadComposerPref(db, student),
        loadFamily(db, student),
        loadStudentContact(db, student),
        loadComposerFacts(db, student),
        loadSettings(request, request.auth.userId, student),
        loadFamilyLanguage(db, student),
        // A reminder only: the composer is written by hand and is not filtered, so an unreadable switch shows nothing
        // rather than failing the composer. What is sent on its own reads it again and fails closed.
        loadFamilyVisibility(db, student).catch(() => null),
      ]);
      if (!contact) throw notFound("That student isn't on your roster");
      // Each parent's account state for the chip's Invite / Resend (20261123000002). Absent when it can't be read
      // or the migration isn't in, which the app reads as "not switched on": no Invite at all.
      const accounts = await loadParentAccounts(db, [student], request.log);
      const familyOut = accounts
        ? family.map((g) => ({ ...g, parentAccount: accounts.get(g.id) ?? { state: "none" as const, invitedAt: null, expiresAt: null, delivery: null } }))
        : family;
      // Financial aid already knows what some families speak: offered, never copied silently.
      const languageSuggestion = familyLanguage === null ? await loadLanguageSuggestion(db, student) : null;

      const quiet = inQuietHours(settings);
      return {
        // familyLanguage: a code, "en" (English only), or null (nobody has said).
        prefs: { ...pref, familyLanguage },
        languageSuggestion,
        translateAvailable: translateAvailable(),
        translatedSmsMaxSegments: MAX_TRANSLATED_SEGMENTS,
        family: familyOut,
        student: contact,
        counselor: { name: request.profile.full_name ?? null, email: request.profile.email ?? null },
        suggestions: {
          parent: suggestionsFor("parent", facts),
          student: suggestionsFor("student", facts),
        },
        applicationsIn: facts.applicationsIn,
        quietHours: { now: quiet, resumesAt: quiet ? nextSendWindow(settings) : null },
        textLimit: TEXT_LIMIT,
        // What the parents receive from Meridies on its own (null when it couldn't be read).
        familyVisibility: visibility ? toFamilyVisibility(student, visibility) : null,
      };
    }
  );

  app.put(
    "/:id/prefs",
    { preHandler: [...counselorOnly, limit("communication:prefs", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          audience: audienceEnum.optional(),
          channel: channelEnum.optional(),
          // A code, "en" for English only, or null to say nobody knows.
          familyLanguage: languageChoice.nullable().optional(),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");

      const row: Row = { student_id: student, updated_by: request.auth.userId };
      if (b.audience) row.composer_audience = b.audience;
      if (b.channel) row.composer_channel = b.channel;
      if (b.familyLanguage !== undefined) row.family_language = b.familyLanguage;
      const { error } = await request.db.from("student_alert_prefs").upsert(row, { onConflict: "student_id" });
      if (error) {
        // Only a write that names the new column fails without its migration; the others keep working.
        if (b.familyLanguage !== undefined && isResultsNotApplied(error)) {
          throw new HttpError(503, "Saving a family's language isn't switched on yet", "family_language_unavailable");
        }
        throw fromPostgrest(error);
      }
      return { ...(await loadComposerPref(request.db, student)), familyLanguage: await loadFamilyLanguage(request.db, student) };
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
          .eq("visible_to_student", true)
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

  /**
   * The counselor's English, in the family's language. Persists nothing and sends
   * nothing: the composer puts the translation in the box with the English under
   * it, and the counselor reads it over before pressing Send. Under the practice's
   * "AI summaries" switch (a family's words and names go to the model), the AI
   * budget gate and its own limit.
   */
  app.post(
    "/:id/translate",
    { preHandler: [...counselorOnly, limit("communication:translate", 30, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          // Omitted: the student's saved family language.
          to: languageCode.optional(),
          channel: channelEnum,
          subject: z.string().trim().max(TRANSLATE_SUBJECT_MAX).optional(),
          body: z.string().trim().min(1).max(TRANSLATE_BODY_MAX),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");

      const saved = b.to ?? (await loadFamilyLanguage(request.db, student));
      if (!saved || saved === "en") throw badRequest("Pick the language the family speaks first");
      if (!isLanguageCode(saved)) throw badRequest("That isn't a language we translate into");
      if (!translateAvailable()) {
        throw new HttpError(503, "Translation isn't switched on yet", "translation_unavailable");
      }

      const contact = await loadStudentContact(request.db, student);
      if (!contact) throw notFound("That student isn't on your roster");
      const result = await translateMessage(request, student, {
        to: saved,
        channel: b.channel,
        subject: b.channel === "email" ? b.subject : undefined,
        body: b.body,
        counselorName: request.profile.full_name ?? null,
        studentFirst: firstName(contact.name),
      });

      const lang = languageByCode(saved);
      return {
        language: lang.code,
        languageName: lang.name,
        rtl: lang.rtl,
        subject: result.subject,
        body: result.body,
      };
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
          /** The body is a translation into this language, then the English (the composer's Translate). */
          translatedTo: languageCode.optional(),
        })
        .strict()
        .parse(request.body);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const kind = b.kind ?? "message";
      if (b.channel === "email" && !b.subject) throw badRequest("Add a subject first");
      if (b.translatedTo && b.audience !== "parent") throw badRequest("Only a message to the parents is translated");
      if (b.channel === "sms") {
        // A translated text is counted in segments: accented and non-Latin letters cost more (lib/smsSegments.ts).
        if (b.translatedTo ? smsOverLimit(b.body, true) : b.body.length > TEXT_LIMIT) {
          throw badRequest(
            b.translatedTo
              ? `A translated text is kept to ${MAX_TRANSLATED_SEGMENTS} message segments. Shorten it, or send it as an email.`
              : `Texts are kept under ${TEXT_LIMIT} characters`
          );
        }
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
          // Named only when set, so a message that isn't translated still sends before 20261110000001 is applied.
          ...(b.translatedTo ? { translated_to: b.translatedTo } : {}),
        })
        .select("*")
        .single();
      // 54000: the database's own daily cap on a counselor's message rows
      // (20261024000024), which sits above the route's limits.
      if (error?.code === "54000") throw tooManyRequests("You've sent a lot of family messages today.");
      if (error && b.translatedTo && isResultsNotApplied(error)) {
        throw new HttpError(503, "Sending a translated message isn't switched on yet", "translation_unavailable");
      }
      if (error) throw fromPostgrest(error);
      const row = data as Row;

      const referralTracked =
        kind === "referral"
          ? await recordReferralAsk(db, request.auth.userId, student, String(row.id), request.log)
          : false;

      if (plan.status === "scheduled") {
        return reply.code(201).send({ ...toMessage(row), referralTracked });
      }

      const studentContact = await loadStudentContact(db, student);
      const outcome = await deliverMessage(
        row as unknown as MessageRow,
        request.profile.full_name ?? null,
        request.log,
        {
          studentName: studentContact?.name ?? null,
          // A reply goes to a routed address that lands on the family's
          // thread in the app; with routing off, to the counselor's own inbox.
          replyToFor: async (r) =>
            (await replyAddressFor(
              r.kind === "guardian"
                ? { counselorId: request.auth.userId, party: "parent", studentId: student, guardianId: r.id }
                : { counselorId: request.auth.userId, party: "student", studentId: student },
              request.log
            )) ??
            request.profile.email ??
            undefined,
        }
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
      const rows = (data ?? []) as Row[];
      const live = await liveAttemptStatus(request, rows);
      return rows.map((r) => {
        const m = toMessage(r);
        return { ...m, attempts: m.attempts.map((a) => withLiveStatus(a, live)) };
      });
    }
  );

  /**
   * What the student's family has answered, newest first: replies to emails
   * (`inbound_messages`, written by the Resend webhook) and, once texting is on,
   * replies to texts. Read on the caller's own client, so RLS decides whose
   * these are. A database without the migration answers `available: false`
   * and an empty list, never an error.
   */
  app.get(
    "/:id/replies",
    { preHandler: [...counselorOnly, limit("communication:replies", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      const { data, error } = await request.db
        .from("inbound_messages")
        // `*`, not a column list: the English and the language came with 20261110000001, and a named column that
        // isn't there yet would hide every reply (the not-applied branch below).
        .select("*, guardian:guardians(full_name)")
        .eq("student_id", student)
        .order("received_at", { ascending: false })
        .limit(100);
      if (error) {
        if (isResultsNotApplied(error)) return { available: false, unread: 0, replies: [] };
        throw fromPostgrest(error);
      }
      const rows = (data ?? []) as unknown as Row[];
      const replies = rows.map((r) => ({
        id: String(r.id),
        channel: r.channel === "sms" ? ("sms" as const) : ("email" as const),
        party: r.party === "student" ? ("student" as const) : ("parent" as const),
        // Our own record of who they are when we have one, else the address they wrote from.
        fromName: ((r.guardian as { full_name?: string } | null)?.full_name ?? null) || String(r.from_addr),
        fromAddress: String(r.from_addr),
        subject: (r.subject as string | null) ?? null,
        body: String(r.body),
        senderKnown: r.sender_known === true,
        receivedAt: String(r.received_at),
        read: r.read_at != null,
        // The English of a reply written in another language, and the language it was detected as (null before the migration).
        bodyEn: typeof r.body_en === "string" ? r.body_en : null,
        detectedLanguage: typeof r.detected_language === "string" ? r.detected_language : null,
      }));
      // What the parents' replies look like, when the family's language isn't set: one click to set it.
      const looksLike = replies.find((x) => x.party === "parent" && x.detectedLanguage && x.detectedLanguage !== "en")?.detectedLanguage ?? null;
      const suggestedFamilyLanguage = looksLike && isLanguageCode(looksLike) ? looksLike : null;
      return { available: true, unread: replies.filter((x) => !x.read).length, suggestedFamilyLanguage, replies };
    }
  );

  /** The counselor has seen these replies. */
  app.post(
    "/:id/replies/read",
    { preHandler: [...counselorOnly, limit("communication:replies-read", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      const { error } = await request.db
        .from("inbound_messages")
        .update({ read_at: new Date().toISOString() })
        .eq("student_id", student)
        .eq("counselor_id", request.auth.userId)
        .is("read_at", null);
      if (error && !isResultsNotApplied(error)) throw fromPostgrest(error);
      return { ok: true };
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
      // The work item's title reaches AxIS as a counselor-written field: only a name's shape of the student's own text.
      const family = familyName(plainName(profile.full_name)) || "student";
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
        // The students' own due-date reminders ride the same cron. Their
        // failure never fails the dispatch it follows.
        const reminders = await sendStudentReminders(svc, request.log).catch((err: unknown) => {
          request.log.error({ err }, "student reminders failed");
          return { ran: false, sent: 0, skipped: 0, reason: "error" };
        });
        // A family's reply whose translation failed is tried again here (at most 3 times); never fails the dispatch.
        const translations = await retryFailedTranslations(svc, request.log).catch((err: unknown) => {
          request.log.error({ err }, "reply translation retry failed");
          return { tried: 0, done: 0 };
        });
        // The weekly family digest: drafts for the counselor to approve, never a send. Never fails the dispatch.
        const weeklyDigest = await runWeeklyDigest(svc, request.log).catch((err: unknown) => {
          request.log.error({ err }, "weekly digest failed");
          return { ran: false, reason: "error" };
        });
        return { ran: true, ...tally, reminders, translations, weeklyDigest };
      } catch (err) {
        await beat("message-dispatch", false, err instanceof Error ? err.message : "failed", request.log);
        throw err;
      }
    }
  );
}
