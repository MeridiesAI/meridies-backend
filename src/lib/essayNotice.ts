/**
 * Tell the counselor a student worked on an essay.
 *
 * Called after `logEssayProgress` (routes/application.ts) when the caller is the student and the essay's
 * body really changed. The bell notice is always made; the email only when the counselor's
 * `notify_on_essay` is on. Both are written on the service client: RLS `notifications_insert_counselor`
 * forbids a student's insert. Only the student's own counselor (`request.profile.counselor_id`, the row
 * `authenticate` loaded) hears, and only while approved (fail closed). At most one notice per essay per
 * six hours and twenty per student per day (`consumeRateLimit`).
 *
 * The essay's text is never read here and never goes into a notice, an email or a log line: the notice
 * says who and links to their page, nothing more. Never throws.
 */

import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { isCounselorApproved } from "./access.js";
import { loadSettings } from "./accountability.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { ESSAY_NOTICE_PER_ESSAY_SECONDS, ESSAY_NOTICES_PER_STUDENT_DAY, essayNoticeTitle, firstNameOf } from "./inactivity.js";
import { consumeRateLimit } from "./limits.js";
import { serviceClient } from "./supabase.js";

export async function noticeEssayEdit(request: FastifyRequest, studentId: string, essayId: string): Promise<void> {
  try {
    if (request.profile.role !== "student" || request.auth.userId !== studentId) return;
    const counselorId = request.profile.counselor_id;
    if (!counselorId) return;
    const svc = serviceClient();
    if (!svc) return;
    if (!(await isCounselorApproved(svc, counselorId))) return;

    const perEssay = await consumeRateLimit(`essay-notice:essay:${essayId}`, 1, ESSAY_NOTICE_PER_ESSAY_SECONDS, request.log);
    const perStudent = perEssay && (await consumeRateLimit(`essay-notice:student:${studentId}`, ESSAY_NOTICES_PER_STUDENT_DAY, 86_400, request.log));
    if (!perEssay || !perStudent) return;

    const title = essayNoticeTitle(request.profile.full_name);
    const href = `/dashboard/counselor/students/${studentId}`;
    const { error } = await svc.from("notifications").insert({
      recipient_id: counselorId,
      student_id: studentId,
      kind: "system",
      urgency: "low",
      title,
      body: null,
      href,
      action_items: [],
      created_by: studentId,
    });
    if (error) request.log.error({ code: error.code }, "essay notice: notification insert failed");

    // An unreadable settings row means no email (the bell is already there).
    const settings = await loadSettings({ db: svc }, counselorId, studentId).catch(() => null);
    if (!settings?.notify_on_essay) return;
    const { data: counselor } = await svc.from("profiles").select("email").eq("id", counselorId).maybeSingle();
    const to = (counselor?.email as string | null) ?? null;
    if (!to) return;
    const first = firstNameOf(request.profile.full_name);
    const template = {
      heading: title,
      paragraphs: [`${first} changed one of their essays. Open their page to read it.`, "You get these emails because essay notices are on in Settings."],
      cta: { label: `Open ${first}'s page`, url: `${env.APP_URL}${href}` },
    };
    await sendEmail({
      to,
      subject: title,
      html: brandedEmail(template),
      text: brandedText(template),
      template: "essay-notice",
      student_id: studentId,
      recipient_id: counselorId,
      recipient_kind: "counselor",
      logger: request.log,
    });
  } catch (err) {
    // The error, never the request body: the essay is in it.
    request.log.error({ msg: err instanceof Error ? err.message : "unknown" }, "essay notice failed");
  }
}
