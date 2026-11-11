/**
 * The notice a parent gets when a student adds them (onboarding's Parents step, Settings › Parents).
 *
 * Its own sender on the same Resend account: `RESEND_PARENTS_FROM` (falling back to `INVITE_FROM_EMAIL`), template
 * `parent-added`, tagged `category=parent-added`, and recorded in `message_deliveries` like every other email, so the
 * delivery webhook moves its status. It is a courtesy and never fails the add: anything that goes wrong is logged
 * and the parent is still on file.
 *
 * Sent at most once per parent address per student (`noticeDecision`): a parent removed and added again, or a name
 * corrected, gets nothing new; a changed email is a new address and gets one. An address this student's messages
 * already bounced at (or that marked one as spam) gets none. No login link: there is no parent portal.
 *
 * AUTHORIZATION IS THE CALLER'S. The reads and the reply address use the service role; the caller has already
 * written the guardian row as the student (RLS), so the guardian is theirs and the counselor is their own.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { normEmail } from "./parentCopy.js";
import { replyAddressFor } from "./replyRouting.js";
import { serviceClient } from "./supabase.js";
import { consumeRateLimit } from "./limits.js";

type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export const PARENT_NOTICE_TEMPLATE = "parent-added";
/** Notices one student's additions may send in a day (4 parents, a few corrected addresses). */
export const PARENT_NOTICES_PER_DAY = 8;

export type NoticeOutcome = "sent" | "already_sent" | "not_sent";

const firstWord = (name: string | null | undefined): string => (name ?? "").trim().split(/\s+/)[0] ?? "";
/** A name as it goes into an email: one line, no more than 80 characters. */
const oneLine = (s: string | null | undefined, max = 80): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export type ParentNoticeCopy = {
  studentName: string;
  parentName: string;
  /** The student's counselor, null when they haven't connected one yet. */
  counselorName: string | null;
};

/** What the parent reads. Pure. */
export function parentAddedEmail(c: ParentNoticeCopy): {
  subject: string;
  heading: string;
  paragraphs: string[];
  footnote: string;
} {
  const student = oneLine(c.studentName) || "Your child";
  const studentFirst = firstWord(student) || student;
  const parentFirst = firstWord(oneLine(c.parentName));
  const counselor = oneLine(c.counselorName) || null;
  return {
    subject: `${student} added you as a parent on Meridies`,
    heading: `${studentFirst} added you on Meridies`,
    paragraphs: [
      parentFirst ? `Dear ${parentFirst},` : "Hello,",
      `${student} added you as a parent on Meridies, where they and their counselor keep track of college applications.`,
      counselor
        ? `${counselor} is ${studentFirst}'s counselor and may email you updates about ${studentFirst}'s college applications.`
        : `Once ${studentFirst} connects with a counselor on Meridies, the counselor may email you updates about ${studentFirst}'s college applications.`,
      "There's nothing to sign up for and nothing you need to do.",
    ],
    footnote: counselor
      ? `Reply to this email to reach ${counselor}. If you weren't expecting it, reply and let them know.`
      : "If you weren't expecting this email, you can ignore it.",
  };
}

export type PriorDelivery = { status: string; error: string | null };

/**
 * Whether to send: never twice to one address for one student, and never to an address that bounced or complained
 * about a message for this student. A send that failed before reaching the provider may be tried again. Pure.
 */
export function noticeDecision(prior: PriorDelivery[], priorNoticesToAddress: PriorDelivery[]): "send" | "already_sent" | "suppressed" {
  if (priorNoticesToAddress.some((d) => ["queued", "sent", "delivered", "bounced"].includes(d.status))) return "already_sent";
  if (prior.some((d) => d.status === "bounced")) return "suppressed";
  return "send";
}

/** The configured sender for parent notices. */
export function parentsFrom(): string {
  return env.RESEND_PARENTS_FROM ?? env.INVITE_FROM_EMAIL;
}

/** Postgres ILIKE with the address taken literally (an address may hold `_`). */
export const literalLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export type SendParentNoticeArgs = {
  studentId: string;
  studentName: string;
  counselorId: string | null;
  guardianId: string;
  parentName: string;
  email: string;
  log?: Log;
  /** Tests: stand-ins for the service client and the sender. */
  deps?: {
    svc?: SupabaseClient | null;
    send?: typeof sendEmail;
    replyTo?: (counselorId: string, studentId: string, guardianId: string) => Promise<string | undefined>;
    withinDailyCap?: (studentId: string) => Promise<boolean>;
  };
};

async function counselorContact(svc: SupabaseClient, counselorId: string): Promise<{ name: string | null; email: string | null }> {
  const { data, error } = await svc.from("profiles").select("full_name, email").eq("id", counselorId).maybeSingle();
  if (error || !data) return { name: null, email: null };
  return { name: oneLine(data.full_name as string | null) || null, email: normEmail(data.email as string | null) };
}

/** Send the notice once; never throws. */
export async function sendParentNotice(a: SendParentNoticeArgs): Promise<NoticeOutcome> {
  const email = normEmail(a.email);
  if (!email) return "not_sent";
  const svc = a.deps?.svc !== undefined ? a.deps.svc : serviceClient();
  const send = a.deps?.send ?? sendEmail;
  try {
    if (!svc) {
      a.log?.warn({}, "parent notice skipped: SUPABASE_SERVICE_ROLE_KEY unset, so it can't be sent only once");
      return "not_sent";
    }
    const { data, error } = await svc
      .from("message_deliveries")
      .select("status, error, template, to_email")
      .eq("student_id", a.studentId)
      .eq("channel", "email")
      .ilike("to_email", literalLike(email))
      .limit(200);
    if (error) {
      a.log?.warn({ err: error.message }, "parent notice skipped: delivery history unreadable");
      return "not_sent";
    }
    const rows = (data ?? []) as (PriorDelivery & { template: string | null })[];
    const decision = noticeDecision(rows, rows.filter((r) => r.template === PARENT_NOTICE_TEMPLATE));
    if (decision === "already_sent") return "already_sent";
    if (decision === "suppressed") return "not_sent";

    const withinCap = a.deps?.withinDailyCap
      ? await a.deps.withinDailyCap(a.studentId)
      : await consumeRateLimit(`parent-notice:${a.studentId}`, PARENT_NOTICES_PER_DAY, 86_400);
    if (!withinCap) {
      a.log?.warn({ studentId: a.studentId }, "parent notice skipped: daily cap reached");
      return "not_sent";
    }

    const counselor = a.counselorId ? await counselorContact(svc, a.counselorId) : { name: null, email: null };
    const replyTo = a.counselorId
      ? ((await (a.deps?.replyTo
          ? a.deps.replyTo(a.counselorId, a.studentId, a.guardianId)
          : replyAddressFor({ counselorId: a.counselorId, party: "parent", studentId: a.studentId, guardianId: a.guardianId }, a.log))) ??
        counselor.email ??
        undefined)
      : undefined;

    const copy = parentAddedEmail({ studentName: a.studentName, parentName: a.parentName, counselorName: counselor.name });
    const template = { heading: copy.heading, paragraphs: copy.paragraphs, footnote: copy.footnote };
    const result = await send({
      to: email,
      subject: copy.subject,
      html: brandedEmail(template),
      text: brandedText(template),
      template: PARENT_NOTICE_TEMPLATE,
      from: parentsFrom(),
      tags: [{ name: "category", value: PARENT_NOTICE_TEMPLATE }],
      student_id: a.studentId,
      recipient_kind: "guardian",
      recipient_id: a.guardianId,
      ...(replyTo ? { replyTo } : {}),
      // Two adds of one address racing each other: Resend answers the second from the first.
      idempotencyKey: `${PARENT_NOTICE_TEMPLATE}:${a.studentId}:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`,
      logger: a.log,
    });
    return result.sent ? "sent" : "not_sent";
  } catch (err) {
    a.log?.error({ err: err instanceof Error ? err.message : String(err) }, "parent notice failed");
    return "not_sent";
  }
}
