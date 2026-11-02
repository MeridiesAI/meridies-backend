/**
 * A family answers a text.
 *
 * Each consultant texts from a number of their own (`consultant_phone_numbers`,
 * bought through `lib/twilioNumbers.ts`). Twilio calls
 * `POST /webhooks/twilio/inbound` when someone texts that number. The number
 * dialled says whose reply it is; the number it came from says which family
 * member, found among that consultant's own guardians, students and pipeline
 * contacts. The reply is recorded (`inbound_messages`), put on the contact's
 * timeline and mailed to the consultant.
 *
 * STOP and START are honoured here as well as by the carrier: Twilio blocks a
 * number that answered STOP, but we also record it (`sms_opt_outs`) so nothing
 * is attempted, and so the consultant sees on the timeline that they must not
 * text that number again.
 *
 * Callers hand in the service client (routes/webhooks.ts, after the Twilio
 * signature is verified), so this file is not itself an elevated call site.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isCounselorApproved } from "./access.js";
import { toE164 } from "./email.js";
import { pgFailure } from "./errors.js";
import { forwardToCounselor, stopSequencesOnReply } from "./inboundEmail.js";
import { consumeRateLimit } from "./limits.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

const BODY_CAP = 1600;
const TIMELINE_CAP = 1600;
const MAX_TARGETS = 5;
/** One number can text one consultant this many times a day before we stop recording. */
const TEXTS_PER_DAY = 200;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "yes", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);

/** The whole message is a carrier keyword (a sentence that contains one is just a message). */
export function smsKeyword(body: string): "stop" | "start" | "help" | null {
  const w = body.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (!w) return null;
  if (STOP_WORDS.has(w)) return "stop";
  if (START_WORDS.has(w)) return "start";
  if (HELP_WORDS.has(w)) return "help";
  return null;
}

export type PhoneOwner = {
  kind: "guardian" | "student" | "contact-parent" | "contact-student";
  id: string;
  phone: string | null;
  studentId?: string | null;
  contactId?: string | null;
  name?: string | null;
};

/** Every record whose phone, however it was typed, is this E.164 number. */
export function matchPhoneOwners<T extends { phone: string | null }>(e164: string, owners: T[]): T[] {
  return owners.filter((o) => (o.phone ? toE164(o.phone) === e164 : false));
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What Twilio is answered with: nothing, unless a message is given. */
export function twiml(message?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${xmlEscape(message)}</Message>` : ""}</Response>`;
}

// ---------------------------------------------------------------------------
// Who a number belongs to
// ---------------------------------------------------------------------------

async function loadOwners(svc: SupabaseClient, counselorId: string): Promise<PhoneOwner[]> {
  const owners: PhoneOwner[] = [];

  const students = await svc.from("profiles").select("id, full_name, phone").eq("counselor_id", counselorId).limit(3000);
  if (students.error) throw pgFailure(students.error, "students");
  const roster = (students.data ?? []) as Row[];
  for (const st of roster) {
    owners.push({ kind: "student", id: String(st.id), studentId: String(st.id), phone: (st.phone as string | null) ?? null, name: (st.full_name as string | null) ?? null });
  }

  const ids = roster.map((r) => String(r.id));
  for (let i = 0; i < ids.length; i += 200) {
    const g = await svc.from("guardians").select("id, student_id, full_name, phone").in("student_id", ids.slice(i, i + 200));
    if (g.error) throw pgFailure(g.error, "guardians");
    for (const r of (g.data ?? []) as Row[]) {
      owners.push({ kind: "guardian", id: String(r.id), studentId: String(r.student_id), phone: (r.phone as string | null) ?? null, name: (r.full_name as string | null) ?? null });
    }
  }

  // The consultant's workspace: their firm's board, or their own when solo.
  const me = await svc.from("profiles").select("firm_id").eq("id", counselorId).maybeSingle();
  if (me.error) throw pgFailure(me.error, "profile");
  const firmId = ((me.data as Row | null)?.firm_id as string | null) ?? null;
  let q = svc.from("pipeline_contacts").select("id, student_name, parent_name, parent_phone, student_phone").limit(5000);
  q = firmId ? q.eq("firm_id", firmId) : q.is("firm_id", null).eq("counselor_id", counselorId);
  const contacts = await q;
  if (contacts.error) throw pgFailure(contacts.error, "contacts");
  for (const c of (contacts.data ?? []) as Row[]) {
    owners.push({ kind: "contact-parent", id: String(c.id), contactId: String(c.id), phone: (c.parent_phone as string | null) ?? null, name: (c.parent_name as string | null) ?? null });
    owners.push({ kind: "contact-student", id: String(c.id), contactId: String(c.id), phone: (c.student_phone as string | null) ?? null, name: (c.student_name as string | null) ?? null });
  }
  return owners;
}

// ---------------------------------------------------------------------------
// Handling one inbound text
// ---------------------------------------------------------------------------

export type InboundSmsResult =
  | { status: "stored"; targets: number; keyword: "stop" | "start" | "help" | null }
  | { status: "ignored"; reason: "no-number" | "unapproved" | "bad-sender" | "rate-limited" | "duplicate" | "empty" };

export async function handleInboundSms(
  svc: SupabaseClient,
  p: { from: string; to: string; body: string; sid: string },
  log: Log
): Promise<InboundSmsResult> {
  const to = toE164(p.to);
  const from = toE164(p.from);
  if (!to) return { status: "ignored", reason: "no-number" };
  if (!from) return { status: "ignored", reason: "bad-sender" };
  const body = p.body.trim().slice(0, BODY_CAP);
  if (!body) return { status: "ignored", reason: "empty" };

  const num = await svc.from("consultant_phone_numbers").select("counselor_id").eq("phone_e164", to).eq("status", "active").maybeSingle();
  if (num.error) throw pgFailure(num.error, "number lookup failed");
  if (!num.data) return { status: "ignored", reason: "no-number" };
  const counselorId = String((num.data as Row).counselor_id);

  if (!(await isCounselorApproved(svc, counselorId))) return { status: "ignored", reason: "unapproved" };
  if (!(await consumeRateLimit(`inbound-sms:${counselorId}:${from}`, TEXTS_PER_DAY, 86_400))) {
    return { status: "ignored", reason: "rate-limited" };
  }

  const keyword = smsKeyword(body);
  if (keyword === "stop") {
    const { error } = await svc.from("sms_opt_outs").upsert({ counselor_id: counselorId, phone_e164: from }, { onConflict: "counselor_id,phone_e164" });
    if (error) throw pgFailure(error, "opt-out write failed");
  } else if (keyword === "start") {
    const { error } = await svc.from("sms_opt_outs").delete().eq("counselor_id", counselorId).eq("phone_e164", from);
    if (error) throw pgFailure(error, "opt-in write failed");
  }

  const owners = matchPhoneOwners(from, await loadOwners(svc, counselorId)).slice(0, MAX_TARGETS);
  const me = await svc.from("profiles").select("firm_id").eq("id", counselorId).maybeSingle();
  const firmId = ((me.data as Row | null)?.firm_id as string | null) ?? null;

  // One row per place this number is on file; none at all when it is on file nowhere.
  const targets: Array<{ owner: PhoneOwner | null; key: string }> = owners.length
    ? owners.map((o) => ({ owner: o, key: `${o.kind}:${o.id}` }))
    : [{ owner: null, key: "unmatched" }];

  let stored = 0;
  let notified = false;
  for (const { owner, key } of targets) {
    const party: "parent" | "student" | null = !owner ? null : owner.kind === "guardian" || owner.kind === "contact-parent" ? "parent" : "student";
    const contactId = owner?.contactId ?? null;
    const studentId = owner?.studentId ?? null;
    const guardianId = owner?.kind === "guardian" ? owner.id : null;

    const ins = await svc
      .from("inbound_messages")
      .upsert(
        {
          channel: "sms",
          counselor_id: counselorId,
          firm_id: contactId ? firmId : null,
          contact_id: contactId,
          student_id: studentId,
          guardian_id: guardianId,
          party,
          from_addr: from,
          subject: null,
          body,
          provider_message_id: `twilio:${p.sid}:${key}`,
          sender_known: owner !== null,
          authenticated: true, // Twilio's signature was verified by the route
        },
        { onConflict: "provider_message_id", ignoreDuplicates: true }
      )
      .select("id");
    if (ins.error) throw pgFailure(ins.error, "inbound insert failed");
    const inboundId = (ins.data?.[0] as Row | undefined)?.id as string | undefined;
    if (!inboundId) continue; // a retried webhook

    stored += 1;
    if (contactId) {
      const { error } = await svc.from("pipeline_activities").insert({
        contact_id: contactId,
        kind: "sms",
        body: (keyword === "stop" ? `${body} (they opted out: don't text this number again unless they reply START)` : body).slice(0, TIMELINE_CAP),
        meta: { direction: "in", channel: "sms", party, senderKnown: true, authenticated: true, inboundId },
      });
      if (error) log.warn({ code: error.code }, "inbound sms: could not add it to the contact timeline");
      await stopSequencesOnReply(svc, contactId, log);
    }

    // One alert per text, however many places the number is on file.
    if (!notified) {
      notified = true;
      await forwardToCounselor(svc, counselorId, {
        channel: "sms",
        fromName: owner?.name || from,
        sender: from,
        senderKnown: owner !== null,
        studentName: owner?.kind === "student" ? (owner.name ?? null) : null,
        subject: null,
        body: keyword === "stop" ? `${body}\n\nThey opted out. Meridies will not text this number again unless they reply START.` : body,
        contactId,
        studentId,
        log,
      });
    }
  }

  if (stored === 0) return { status: "ignored", reason: "duplicate" };
  return { status: "stored", targets: stored, keyword };
}
