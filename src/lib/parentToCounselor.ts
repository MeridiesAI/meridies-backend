/**
 * A parent writes to their child's counselor from the Parent view (20261123000002). The same shape as a student's
 * message (lib/studentToCounselor.ts): emailed to the counselor's sign-in address with Reply-To the parent's proven
 * address (`profiles.parent_email`), and a copy kept as an `inbound_messages` row (channel email, party parent, the
 * guardian row) so it shows on the counselor's Communication page under "From the family" (GET
 * /communication/:id/replies). Email-backed, not an inbox.
 *
 * Who is written to is never the client's word: `parent_children` (the caller's own client, the live link) names
 * the student's counselor and whether this parent may write. A parent may write only once the counselor has
 * switched them on (`alerts_enabled`): a parent the student added and the counselor hasn't accepted yet can view
 * but not write, so nobody unvetted puts words in front of the counselor as "the family".
 *
 * AUTHORIZATION IS THE CALLER'S: the service role reads the counselor's address and approval for a counselor
 * `parent_children` just returned for this caller, and writes or reads rows keyed by the caller's own id.
 */

import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { isCounselorApproved } from "./access.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { HttpError, fromPostgrest, unavailable } from "./errors.js";
import { PARENT_MESSAGE_MAX, oneLine, parentSchemaMissing } from "./parentAccounts.js";
import { parentAccountsUnavailable } from "./parentInvites.js";
import { cleanBody } from "./studentToCounselor.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;

/** provider_message_id prefix of a row this route wrote, with the parent's id, so their own list reads it back. */
const prefix = (parentId: string) => `app-parent:${parentId}:`;

export type SentByParent = { id: string; body: string; sentAt: string };

function missingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/** This parent's link to one student, as the database answers it for the caller. Throws 404 when there is none. */
export async function linkedChild(request: FastifyRequest, studentId: string): Promise<Row> {
  const { data, error } = await request.db.rpc("parent_children");
  if (error) {
    if (parentSchemaMissing(error)) throw parentAccountsUnavailable();
    throw fromPostgrest(error);
  }
  const row = ((data ?? []) as Row[]).find((r) => String(r.student_id) === studentId);
  if (!row) throw new HttpError(404, "That student isn't on your parent view", "not_linked");
  return row;
}

export async function sendParentMessage(request: FastifyRequest, studentId: string, rawBody: string): Promise<{ sent: SentByParent; emailed: boolean }> {
  const body = cleanBody(rawBody);
  if (!body) throw new HttpError(400, "Write a message first");
  if (body.length > PARENT_MESSAGE_MAX) throw new HttpError(400, `Keep it under ${PARENT_MESSAGE_MAX} characters`);

  const child = await linkedChild(request, studentId);
  const counselorId = (child.counselor_id as string | null) ?? null;
  if (!counselorId || child.counselor_ready !== true) {
    throw new HttpError(409, "There's no counselor to write to yet", "no_counselor");
  }
  if (child.can_message !== true) {
    throw new HttpError(409, "The counselor hasn't switched on messages from you yet", "parent_not_switched_on");
  }

  const svc = serviceClient();
  if (!svc) throw unavailable("Messaging the counselor isn't switched on yet");
  if (!(await isCounselorApproved(svc, counselorId))) throw new HttpError(409, "The counselor can't receive messages right now", "no_counselor");
  const { data: counselor, error } = await svc.from("profiles").select("email, firm_id").eq("id", counselorId).maybeSingle();
  if (error) throw unavailable("Couldn't reach the counselor right now. Try again.");
  const to = String((counselor as Row | null)?.email ?? "").trim();
  if (!to) throw new HttpError(409, "The counselor has no email on file", "no_counselor");

  // The proven address (no client writes it), read here: `authenticate` doesn't load it, so a database without the
  // migration still signs everyone in.
  const { data: mine } = await request.db.from("profiles").select("parent_email").eq("id", request.auth.userId).maybeSingle();
  const parentEmail = String((mine as Row | null)?.parent_email ?? "").trim();
  const parentName = oneLine(request.profile.full_name ?? "") || "A parent";
  const studentName = oneLine(String(child.full_name ?? "")) || "your student";
  const parentFirst = parentName.split(" ")[0] ?? parentName;
  const email = {
    heading: `A message from ${parentName}`,
    paragraphs: [`${parentName} wrote about ${studentName} from their Meridies parent view:`, body, parentEmail ? `Reply to this email to answer ${parentFirst}.` : ""],
  };
  const result = await sendEmail({
    to,
    subject: `Message from ${parentName.slice(0, 60)} about ${studentName.slice(0, 60)}`,
    html: brandedEmail(email),
    text: brandedText(email),
    template: "parent-to-counselor",
    replyTo: parentEmail.includes("@") && !/\s/.test(parentEmail) ? parentEmail : undefined,
    fromName: parentName,
    student_id: studentId,
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
      student_id: studentId,
      guardian_id: (child.guardian_id as string | null) ?? null,
      party: "parent",
      from_addr: (parentEmail || "parent").slice(0, 320),
      subject: "Sent from the Meridies parent view",
      body: body.slice(0, 20000),
      provider_message_id: `${prefix(request.auth.userId)}${randomUUID()}`,
      sender_known: true,
      authenticated: true,
      received_at: sentAt,
    })
    .select("id, received_at")
    .maybeSingle();
  if (insertError && !missingTable(insertError)) request.log.warn({ code: insertError.code }, "parent message copy not kept");
  if (!result.sent && (insertError || !row)) throw unavailable("Your message couldn't be sent. Try again in a few minutes.");
  return {
    sent: { id: String((row as Row | null)?.id ?? randomUUID()), body, sentAt: String((row as Row | null)?.received_at ?? sentAt) },
    emailed: result.sent,
  };
}

/** What the caller (a parent) sent about this student from the Parent view, newest first. */
export async function listSentByParent(request: FastifyRequest, studentId: string): Promise<{ available: boolean; messages: SentByParent[] }> {
  await linkedChild(request, studentId);
  const svc = serviceClient();
  if (!svc) return { available: false, messages: [] };
  const { data, error } = await svc
    .from("inbound_messages")
    .select("id, body, received_at")
    .eq("student_id", studentId)
    .eq("party", "parent")
    .like("provider_message_id", `${prefix(request.auth.userId)}%`)
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

/**
 * A parent account's own data export (GET /account/export): their profile row, the students on their Parent view
 * right now (names and counselors, as `parent_children` answers the caller) and every message they sent from it.
 * Nothing about a student beyond that: the student's record is the student's export.
 */
export async function exportParentData(request: FastifyRequest): Promise<{ profile: Row | null; children: Row[] | null; messagesSent: Row[] | null }> {
  const me = request.auth.userId;
  const [profile, children] = await Promise.all([
    request.db.from("profiles").select("*").eq("id", me).maybeSingle(),
    request.db.rpc("parent_children"),
  ]);
  if (profile.error) throw fromPostgrest(profile.error);
  const svc = serviceClient();
  let messagesSent: Row[] | null = null;
  if (svc) {
    const { data, error } = await svc
      .from("inbound_messages")
      .select("id, student_id, body, received_at")
      .eq("party", "parent")
      .like("provider_message_id", `${prefix(me)}%`)
      .order("received_at", { ascending: false })
      .limit(5000);
    messagesSent = error ? null : ((data ?? []) as Row[]);
  }
  return {
    profile: (profile.data as Row | null) ?? null,
    children: children.error
      ? null
      : ((children.data ?? []) as Row[]).map((r) => ({ studentId: r.student_id, name: r.full_name, classYear: r.grad_year, counselorName: r.counselor_name })),
    messagesSent,
  };
}
