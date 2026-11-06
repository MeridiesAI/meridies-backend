/**
 * A family answers an email: decode who it was for, keep what they wrote, and
 * put it where the counselor will see it.
 *
 * Mail the counselor sends carries `Reply-To: r-<token>@<REPLY_DOMAIN>`
 * (`lib/replyRouting.ts`). Resend receives mail for that domain and calls
 * `POST /webhooks/resend` with `email.received`, which carries metadata only;
 * the body is fetched here from Resend's receiving API. The token is the whole
 * routing decision: 96 random bits that only the people the email went to have.
 *
 * What a reply is allowed to do is small on purpose. It is recorded
 * (`inbound_messages`), shown on the contact's timeline, and a copy goes to the
 * counselor's inbox. It never changes a contact, never sends anything back to
 * the sender, and a sender we don't recognise is shown as such rather than
 * trusted. Text a family wrote is data: it is stored and displayed, never
 * interpreted.
 *
 * The pure helpers at the top are unit-tested (`test/unit/inbound-email.test.ts`);
 * `handleInboundEmail` is covered by `test/integration/inbound-email.test.mjs`.
 * Callers hand in the service client, so this file is not itself an elevated
 * call site.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { env, resendBase } from "../env.js";
import { isCounselorApproved } from "./access.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { pgFailure } from "./errors.js";
import { translateStoredReply } from "./inboundTranslate.js";
import { consumeRateLimit } from "./limits.js";
import { extractText } from "./links.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

const TOKEN_LEN = 24;
const BODY_CAP = 20_000;
/** pipeline_activities.body is capped at 4000. */
const TIMELINE_CAP = 3_800;
/** A reply address per family member takes at most this many replies a day. */
const REPLIES_PER_DAY = 40;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function replyAddress(token: string, domain: string): string {
  return `r-${token}@${domain}`;
}

/** The address inside `Name <a@b>`, or a bare address, lowercased; null when it isn't one. */
export function bareAddress(value: string | null | undefined): string | null {
  const raw = String(value ?? "").slice(0, 700);
  const lt = raw.lastIndexOf("<");
  const gt = raw.lastIndexOf(">");
  const inner = (lt >= 0 && gt > lt ? raw.slice(lt + 1, gt) : raw).trim().toLowerCase();
  if (inner.length === 0 || inner.length > 320) return null;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner) ? inner : null;
}

/**
 * Our routing token out of a message's recipients, or null. The domain must be
 * exactly ours (not a longer one that merely ends or begins with it), and the
 * token exactly the shape we mint.
 */
export function tokenFromRecipients(recipients: string[], domain: string): string | null {
  const want = domain.trim().toLowerCase();
  for (const r of recipients) {
    const addr = bareAddress(r);
    if (!addr) continue;
    const at = addr.lastIndexOf("@");
    if (addr.slice(at + 1) !== want) continue;
    const local = addr.slice(0, at);
    if (local.length !== TOKEN_LEN + 2 || !local.startsWith("r-")) continue;
    const token = local.slice(2);
    if (/^[0-9a-f]+$/.test(token)) return token;
  }
  return null;
}

const first = (s: string, n = 300) => s.slice(0, n);

/**
 * The part of a reply the person wrote: everything above the quoted history
 * (Gmail/Apple "On ... wrote:", Outlook's headers and "Original Message", ">"
 * quoting) and above a "-- " signature. If that leaves nothing, the whole
 * message is kept: showing a quote is better than showing a blank.
 *
 * Works line by line with bounded slices, never a regular expression over the
 * whole text, so a hostile message can't make it slow.
 */
export function stripQuotedReply(text: string): string {
  const whole = text.trim();
  if (!whole) return "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = first(lines[i] as string);
    const t = line.trim();
    const lower = t.toLowerCase();

    if (t.startsWith(">")) { cut = i; break; }
    if (line.trimEnd() === "--" || line === "-- ") { cut = i; break; }
    if (lower.startsWith("-----") && lower.includes("original message")) { cut = i; break; }
    if (lower.startsWith("on ")) {
      // The attribution may wrap over a couple of lines: try one, two, three.
      let joined = lower;
      let hit = joined.endsWith("wrote:");
      for (let k = 1; k <= 2 && !hit; k++) {
        joined = `${joined} ${first((lines[i + k] ?? "").trim()).toLowerCase()}`.trimEnd();
        hit = joined.endsWith("wrote:");
      }
      if (hit) { cut = i; break; }
    }
    if (lower.startsWith("from:")) {
      // Outlook: From/Sent/To/Subject block.
      const near = [1, 2, 3, 4, 5].map((k) => first((lines[i + k] ?? "").trim()).toLowerCase());
      if (near.some((l) => l.startsWith("subject:")) && near.some((l) => l.startsWith("sent:") || l.startsWith("date:"))) {
        cut = i;
        break;
      }
    }
  }

  const kept = lines.slice(0, cut).join("\n").trimEnd();
  return kept.trim() ? kept.trimStart() : whole;
}

/**
 * Mail no person wrote to the counselor: out-of-office replies, bounces, bulk.
 * Recording these would put "I'm away until Monday" on a family's timeline and,
 * worse, let two auto-responders answer each other.
 */
export function isAutomatedMail(headers: Record<string, string | undefined>, from: string): boolean {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v ?? "").toLowerCase()]));
  const autoSubmitted = h.get("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted.trim() !== "no") return true;
  const precedence = h.get("precedence");
  if (precedence && ["bulk", "junk", "auto_reply", "auto-reply"].includes(precedence.trim())) return true;
  if (h.has("x-autoreply") || h.has("x-autorespond")) return true;
  const local = (bareAddress(from) ?? from).split("@")[0]?.toLowerCase() ?? "";
  return ["mailer-daemon", "postmaster", "noreply", "no-reply", "donotreply", "do-not-reply"].includes(local);
}

// ---------------------------------------------------------------------------
// Fetching what Resend received
// ---------------------------------------------------------------------------

export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  receivedFor: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  authentication: { spf?: string; dkim?: string; dmarc?: string } | null;
};

/** `email.received` carries metadata only; this reads the message. Throws on any failure so the webhook is retried. */
export async function fetchReceivedEmail(id: string): Promise<ReceivedEmail> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY unset");
  const res = await fetch(`${resendBase}/emails/receiving/${encodeURIComponent(id)}?html_format=cid`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend receiving API returned ${res.status}`);
  const j = (await res.json()) as Row;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const auth = j.authentication && typeof j.authentication === "object" ? (j.authentication as Record<string, string>) : null;
  const headers: Record<string, string> = {};
  if (j.headers && typeof j.headers === "object") {
    for (const [k, v] of Object.entries(j.headers as Record<string, unknown>)) if (typeof v === "string") headers[k] = v;
  }
  return {
    id: String(j.id ?? id),
    from: typeof j.from === "string" ? j.from : "",
    to: strs(j.to),
    receivedFor: strs(j.received_for),
    subject: typeof j.subject === "string" ? j.subject : null,
    text: typeof j.text === "string" ? j.text : null,
    html: typeof j.html === "string" ? j.html : null,
    headers,
    authentication: auth ? { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc } : null,
  };
}

// ---------------------------------------------------------------------------
// Handling one received email
// ---------------------------------------------------------------------------

export type InboundResult =
  | { status: "stored"; inboundId: string; onTimeline: boolean; forwarded: boolean }
  | { status: "ignored"; reason: "no-route" | "unapproved" | "not-an-address" | "automated" | "rate-limited" | "duplicate" | "empty" };

/** Who a route stands for, as our own records name them. */
async function describeRoute(
  svc: SupabaseClient,
  route: Row
): Promise<{ name: string; known: string[]; firmId: string | null; studentName: string | null }> {
  const known: string[] = [];
  let name = "";
  let studentName: string | null = null;
  let firmId: string | null = null;
  const party = route.party === "student" ? "student" : "parent";

  if (route.contact_id) {
    const { data } = await svc
      .from("pipeline_contacts")
      .select("firm_id, student_name, parent_name, student_email, parent_email")
      .eq("id", String(route.contact_id))
      .maybeSingle();
    const c = (data ?? {}) as Row;
    firmId = (c.firm_id as string | null) ?? null;
    studentName = (c.student_name as string | null) ?? null;
    const email = party === "parent" ? c.parent_email : c.student_email;
    if (typeof email === "string") known.push(email);
    name = String((party === "parent" ? c.parent_name : c.student_name) ?? "") || (party === "parent" ? "A parent" : "The student");
  }
  if (route.guardian_id) {
    const { data } = await svc
      .from("guardians")
      .select("full_name, email, student_id")
      .eq("id", String(route.guardian_id))
      .maybeSingle();
    const g = (data ?? {}) as Row;
    // A guardian row of another student never lends its address to this route.
    if (!route.student_id || g.student_id === route.student_id) {
      if (typeof g.email === "string") known.push(g.email);
      if (!name) name = String(g.full_name ?? "");
    }
  }
  if (route.student_id) {
    const { data } = await svc.from("profiles").select("full_name, email").eq("id", String(route.student_id)).maybeSingle();
    const p = (data ?? {}) as Row;
    studentName = studentName ?? ((p.full_name as string | null) ?? null);
    if (party === "student") {
      if (typeof p.email === "string") known.push(p.email);
      if (!name) name = String(p.full_name ?? "");
    }
  }
  return {
    name: name || (party === "parent" ? "A parent" : "The student"),
    known: known.map((k) => k.trim().toLowerCase()).filter(Boolean),
    firmId,
    studentName,
  };
}

export async function handleInboundEmail(
  svc: SupabaseClient,
  email: ReceivedEmail,
  domain: string,
  log: Log
): Promise<InboundResult> {
  const token = tokenFromRecipients([...email.to, ...email.receivedFor], domain);
  if (!token) return { status: "ignored", reason: "no-route" };

  const { data: routeRow, error: routeErr } = await svc.from("messaging_routes").select("*").eq("token", token).maybeSingle();
  if (routeErr) throw pgFailure(routeErr, "route lookup failed");
  if (!routeRow) return { status: "ignored", reason: "no-route" };
  const route = routeRow as Row;
  const counselorId = String(route.counselor_id);

  // Decided now, failing closed: a revoked counselor receives nothing.
  if (!(await isCounselorApproved(svc, counselorId))) return { status: "ignored", reason: "unapproved" };

  const sender = bareAddress(email.from);
  if (!sender) return { status: "ignored", reason: "not-an-address" };
  if (isAutomatedMail(email.headers, sender)) return { status: "ignored", reason: "automated" };

  if (!(await consumeRateLimit(`inbound-email:${token}`, REPLIES_PER_DAY, 86_400))) {
    return { status: "ignored", reason: "rate-limited" };
  }

  const raw = email.text?.trim() ? email.text : email.html ? extractText(email.html).text : "";
  const body = stripQuotedReply(raw).slice(0, BODY_CAP);
  if (!body.trim()) return { status: "ignored", reason: "empty" };

  const who = await describeRoute(svc, route);
  const party = route.party === "student" ? "student" : "parent";
  const senderKnown = who.known.includes(sender);
  const auth = email.authentication;
  const authenticated = auth ? auth.dmarc === "pass" || auth.dkim === "pass" || auth.spf === "pass" : null;
  const subject = email.subject ? email.subject.slice(0, 500) : null;

  // The unique provider id makes a retried webhook write nothing twice.
  const ins = await svc
    .from("inbound_messages")
    .upsert(
      {
        channel: "email",
        counselor_id: counselorId,
        firm_id: who.firmId,
        contact_id: route.contact_id ?? null,
        student_id: route.student_id ?? null,
        guardian_id: route.guardian_id ?? null,
        party,
        from_addr: sender,
        subject,
        body,
        provider_message_id: `resend:${email.id}`,
        sender_known: senderKnown,
        authenticated,
      },
      { onConflict: "provider_message_id", ignoreDuplicates: true }
    )
    .select("id");
  if (ins.error) throw pgFailure(ins.error, "inbound insert failed");
  const inboundId = (ins.data?.[0] as Row | undefined)?.id as string | undefined;
  if (!inboundId) return { status: "ignored", reason: "duplicate" };

  let onTimeline = false;
  if (route.contact_id) {
    const { error } = await svc.from("pipeline_activities").insert({
      contact_id: String(route.contact_id),
      kind: "email",
      body: body.slice(0, TIMELINE_CAP),
      meta: { direction: "in", channel: "email", party, senderKnown, authenticated, inboundId },
    });
    if (error) log.warn({ code: error.code }, "inbound email: could not add it to the contact timeline");
    else onTimeline = true;
    await stopSequencesOnReply(svc, String(route.contact_id), log);
  }

  // The English of a reply in another language, written on the row; never throws, never slows the webhook past its deadline.
  const translation = await translateStoredReply(svc, {
    inboundId,
    counselorId,
    studentId: route.student_id ? String(route.student_id) : null,
    body,
    log,
  });

  const forwarded = await forwardToCounselor(svc, counselorId, {
    channel: "email",
    fromName: who.name,
    sender,
    senderKnown,
    studentName: who.studentName,
    subject,
    body,
    bodyEn: translation.bodyEn,
    contactId: route.contact_id ? String(route.contact_id) : null,
    studentId: route.student_id ? String(route.student_id) : null,
    log,
  });

  return { status: "stored", inboundId, onTimeline, forwarded };
}

/**
 * A family that answers has seen the drip; the next scheduled email would talk
 * past them. Stops the contact's running enrollment with the reason `replied`
 * (the counselor can enroll them again). A database without sequences, or any
 * error, changes nothing: the reply is already safely recorded.
 */
export async function stopSequencesOnReply(svc: SupabaseClient, contactId: string, log: Log): Promise<void> {
  const { error } = await svc
    .from("pipeline_sequence_enrollments")
    .update({ status: "stopped", stop_reason: "replied", claimed_at: null })
    .eq("contact_id", contactId)
    .eq("status", "active");
  if (error && !isResultsNotApplied(error)) log.warn({ code: error.code }, "inbound: could not stop the contact's sequence after a reply");
}

export type CounselorNotice = {
  channel: "email" | "sms";
  fromName: string;
  /** An email address, or a phone number for a text. */
  sender: string;
  senderKnown: boolean;
  studentName: string | null;
  subject: string | null;
  body: string;
  /** The English of a reply in another language, shown under the original. */
  bodyEn?: string | null;
  contactId: string | null;
  studentId: string | null;
  log: Log;
};

/**
 * A copy in the counselor's own inbox, so a reply is seen even when the app is
 * closed. For an email, replying to it answers the family directly (Reply-To is
 * the sender); for a text it only points back at the app, where they can text.
 */
export async function forwardToCounselor(svc: SupabaseClient, counselorId: string, m: CounselorNotice): Promise<boolean> {
  const { data } = await svc.from("profiles").select("email").eq("id", counselorId).maybeSingle();
  const to = bareAddress((data as Row | null)?.email as string | undefined);
  if (!to) return false;

  const base = env.APP_URL.replace(/\/+$/, "");
  const link = m.studentId
    ? `${base}/dashboard/counselor/students/${m.studentId}`
    : `${base}/dashboard/counselor/contact-pipeline${m.contactId ? `?contact=${m.contactId}` : ""}`;
  const about = m.studentName ? ` about ${m.studentName}` : "";
  const isText = m.channel === "sms";
  const template = {
    heading: `${m.fromName} replied${isText ? " by text" : ""}${about}`,
    paragraphs: [
      ...(m.senderKnown
        ? []
        : [`This came from ${m.sender}, which isn't ${isText ? "a number" : "an address"} you have on file for them. Check it's who you expect.`]),
      ...m.body
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 12),
      ...(m.bodyEn
        ? [
            "In English:",
            ...m.bodyEn
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean)
              .slice(0, 12),
          ]
        : []),
    ],
    cta: { label: "Open in Meridies", url: link },
    footnote: isText
      ? `It's on their timeline in Meridies, where you can text ${m.fromName} back.`
      : `You can reply to this email to answer ${m.fromName} directly. It's also on their timeline in Meridies.`,
  };
  const res = await sendEmail({
    to,
    subject: isText
      ? `${m.fromName} texted you${about}`.slice(0, 300)
      : `Re: ${m.subject ?? `Your message${about}`}`.slice(0, 300),
    html: brandedEmail(template),
    text: brandedText(template),
    template: isText ? "family-text-forward" : "family-reply-forward",
    recipient_kind: "counselor",
    recipient_id: counselorId,
    ...(isText ? {} : { replyTo: m.sender }),
    fromName: m.fromName,
    logger: m.log,
  });
  return res.sent;
}
