/**
 * A student writes to their counselor (QA round 10: "Students can't send
 * messages?"). Email-backed, not an inbox: the message is emailed to the
 * counselor's sign-in address with Reply-To the student's sign-in address, so
 * the counselor answers from their own mail. A copy is kept as an
 * `inbound_messages` row (channel email, party student), which is what the
 * counselor's student page already lists under the family's replies, and what
 * the student's own "Sent to your counselor" list reads back.
 *
 * Who is written to is never the client's word: the counselor is the student's
 * own `profiles.counselor_id`, read from the row `authenticate` loaded, and must
 * be an approved counselor (fail closed). Addresses are the two sign-in emails,
 * which no client writes. The service role is used only to read the
 * counselor's address and to write or read rows keyed by the caller's own id.
 */

import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { isCounselorApproved } from "./access.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { HttpError, unavailable } from "./errors.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;

export const STUDENT_MESSAGE_MAX = 4000;
/** provider_message_id prefix that marks a row this route wrote (not a webhook). */
const APP_PREFIX = "app-student:";

export type SentToCounselor = { id: string; body: string; sentAt: string };

function missingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/** Plain text a user typed: control characters out (newlines and tabs kept), trimmed. */
export function cleanBody(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 10 || c === 9 || c >= 32) out += ch === "\r" ? "" : ch;
  }
  return out.trim();
}

export async function sendStudentMessage(
  request: FastifyRequest,
  rawBody: string
): Promise<{ sent: SentToCounselor; emailed: boolean }> {
  const body = cleanBody(rawBody);
  if (!body) throw new HttpError(400, "Write a message first");
  if (body.length > STUDENT_MESSAGE_MAX) throw new HttpError(400, `Keep it under ${STUDENT_MESSAGE_MAX} characters`);

  const svc = serviceClient();
  if (!svc) throw unavailable("Messaging your counselor isn't switched on yet");

  const me = request.profile;
  const counselorId = me.counselor_id;
  if (!counselorId) throw new HttpError(409, "You don't have a counselor yet", "no_counselor");
  if (!(await isCounselorApproved(svc, counselorId))) {
    throw new HttpError(409, "Your counselor can't receive messages right now", "no_counselor");
  }

  const { data: counselor, error } = await svc
    .from("profiles")
    .select("email, full_name, firm_id")
    .eq("id", counselorId)
    .maybeSingle();
  if (error) throw unavailable("Couldn't reach your counselor right now. Try again.");
  const to = String((counselor as Row | null)?.email ?? "").trim();
  if (!to) throw new HttpError(409, "Your counselor has no email on file", "no_counselor");

  const studentName = (me.full_name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Your student";
  const studentEmail = String(me.email ?? request.auth.email ?? "").trim();
  const first = studentName.split(" ")[0] ?? studentName;
  const email = {
    heading: `A message from ${studentName}`,
    paragraphs: [body, studentEmail ? `Reply to this email to answer ${first}.` : ""],
  };

  const result = await sendEmail({
    to,
    subject: `Message from ${studentName.slice(0, 60)}`,
    html: brandedEmail(email),
    text: brandedText(email),
    template: "student-to-counselor",
    replyTo: studentEmail.includes("@") && !/\s/.test(studentEmail) ? studentEmail : undefined,
    fromName: studentName,
    student_id: me.id,
    recipient_kind: "counselor",
    recipient_id: counselorId,
    logger: request.log,
  });

  const sentAt = new Date().toISOString();
  const { data: row, error: insertError } = await svc
    .from("inbound_messages")
    .insert({
      channel: "email",
      counselor_id: counselorId,
      firm_id: (counselor as Row | null)?.firm_id ?? null,
      student_id: me.id,
      party: "student",
      from_addr: (studentEmail || "student").slice(0, 320),
      subject: "Sent from Meridies",
      body: body.slice(0, 20000),
      provider_message_id: `${APP_PREFIX}${randomUUID()}`,
      sender_known: true,
      authenticated: true,
      received_at: sentAt,
    })
    .select("id, received_at")
    .maybeSingle();
  if (insertError && !missingTable(insertError)) {
    request.log.warn({ code: insertError.code }, "student message copy not kept");
  }
  if (!result.sent && (insertError || !row)) {
    // Neither emailed nor kept: tell the student it didn't go.
    throw unavailable("Your message couldn't be sent. Try again in a few minutes.");
  }

  return {
    sent: { id: String((row as Row | null)?.id ?? randomUUID()), body, sentAt: String((row as Row | null)?.received_at ?? sentAt) },
    emailed: result.sent,
  };
}

/** What the caller (a student) sent their counselor from Meridies, newest first. */
export async function listSentToCounselor(request: FastifyRequest): Promise<{ available: boolean; messages: SentToCounselor[] }> {
  const svc = serviceClient();
  if (!svc) return { available: false, messages: [] };
  const { data, error } = await svc
    .from("inbound_messages")
    .select("id, body, received_at")
    .eq("student_id", request.auth.userId)
    .eq("party", "student")
    .like("provider_message_id", `${APP_PREFIX}%`)
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) {
    if (missingTable(error)) return { available: false, messages: [] };
    throw unavailable("Couldn't load your messages right now");
  }
  return {
    available: true,
    messages: ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), body: String(r.body), sentAt: String(r.received_at) })),
  };
}
