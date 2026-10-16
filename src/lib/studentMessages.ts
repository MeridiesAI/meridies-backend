/**
 * The Communication composer (demo v6-v10), made real.
 *
 * The demo hands a mailto: or sms: link to the counselor's own app. Here the
 * message goes out through the API's delivery path (`lib/email.ts`: Resend
 * and Twilio, every attempt audited in `message_deliveries`), behind the same
 * gates parent alerts use:
 *
 *  - recipient prefs fail CLOSED (`loadAlertPrefs` throws on a read error).
 *    The parents are written to only while `copy_parents` is on, and a
 *    guardian who switched alerts off receives nothing from the composer
 *    either;
 *  - quiet hours hold a send to the next window unless the counselor
 *    overrides them, exactly like `POST /accountability/parent-alerts`;
 *  - an *alert* (the composer's "Alert the family about overdue work") also
 *    passes the anti-spam throttle, counting both parent_alerts and earlier
 *    composer alerts, and is refused when accountability alerts are off;
 *  - recipients are frozen on the row when it is written, so a scheduled
 *    message reaches the people the counselor saw in the To line.
 *
 * AxIS writes drafts only (`POST /communication/:id/draft`); nothing the model
 * returns is sent without the counselor pressing Send.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import {
  inQuietHours,
  loadAlertPrefs,
  loadSettings,
  nextSendWindow,
  type AccountabilitySettings,
} from "./accountability.js";
import { brandedEmail, brandedText, sendEmail, sendSms } from "./email.js";
import { badRequest, fromPostgrest, unauthorized, unavailable } from "./errors.js";
import { isCounselorApproved } from "./access.js";
import { consumeRateLimit } from "./limits.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export type Audience = "parent" | "student";
export type Channel = "email" | "sms";
export type MessageKind = "message" | "referral" | "alert";

export type Recipient = {
  kind: "guardian" | "student";
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
export function familyName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

// ---------------------------------------------------------------------------
// Composer preference
// ---------------------------------------------------------------------------

export type ComposerPref = { audience: Audience; channel: Channel };

export async function loadComposerPref(db: SupabaseClient, studentId: string): Promise<ComposerPref> {
  const { data, error } = await db
    .from("student_alert_prefs")
    .select("composer_audience, composer_channel")
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  const row = (data ?? {}) as Row;
  return {
    audience: row.composer_audience === "student" ? "student" : "parent",
    channel: row.composer_channel === "sms" ? "sms" : "email",
  };
}

// ---------------------------------------------------------------------------
// Who is on the To line
// ---------------------------------------------------------------------------

export type FamilyContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  isPrimary: boolean;
  /** False when the guardian opted out: listed, never written to. */
  receivesMessages: boolean;
};

export async function loadFamily(db: SupabaseClient, studentId: string): Promise<FamilyContact[]> {
  const { data, error } = await db
    .from("guardians")
    .select("id, full_name, email, phone, relationship, is_primary, alerts_enabled, created_at")
    .eq("student_id", studentId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).map((g) => ({
    id: String(g.id),
    name: String(g.full_name),
    email: s(g.email),
    phone: s(g.phone),
    relationship: s(g.relationship),
    isPrimary: g.is_primary === true,
    receivesMessages: g.alerts_enabled !== false,
  }));
}

const normEmail = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim().toLowerCase();
  return t ? t : null;
};
const normPhone = (v: string | null | undefined): string | null => {
  const t = (v ?? "").replace(/[^\d+]/g, "");
  return t ? t : null;
};

export type StudentContact = { id: string; name: string; email: string | null; phone: string | null };

/**
 * The student as a composer recipient. Email goes to their sign-in address
 * (`profiles.email`, which no client can write), never
 * `student_personal_details.contact_email`: the student can write that row
 * through PostgREST, so following it would let them send every message their
 * counselor writes them, scheduled ones included, to any address from
 * Meridies' domain. The same rule as meeting invites and the due-tomorrow
 * reminders; the info card's email stays a recorded detail.
 */
export async function loadStudentContact(db: SupabaseClient, studentId: string): Promise<StudentContact | null> {
  const profile = await db.from("profiles").select("id, full_name, email, phone").eq("id", studentId).maybeSingle();
  if (profile.error) throw fromPostgrest(profile.error);
  if (!profile.data) return null;
  return studentContactFrom(profile.data as Row);
}

/** Pure: a profiles row as the composer's student recipient. */
export function studentContactFrom(p: Row): StudentContact {
  return {
    id: String(p.id),
    name: String(p.full_name ?? ""),
    email: s(p.email),
    phone: s(p.phone),
  };
}

/**
 * A scheduled message to the student leaves only for the address still on
 * file: an email recipient frozen before this rule (when the contact email
 * was followed) or before a sign-in email change is dropped.
 */
export function studentRecipientsStillAllowed(recipients: Recipient[], channel: unknown, loginEmail: unknown): Recipient[] {
  if (channel !== "email") return recipients;
  const login = typeof loginEmail === "string" ? loginEmail.trim().toLowerCase() : "";
  return recipients.filter((r) => r.kind === "student" && !!login && (r.email ?? "").trim().toLowerCase() === login);
}

/**
 * The recipients a send may go to, decided on the server from what is on
 * file. A client never supplies an address: the composer writes to the
 * family and the student the record names, nobody else.
 */
export async function resolveRecipients(
  db: SupabaseClient,
  studentId: string,
  audience: Audience,
  channel: Channel
): Promise<Recipient[]> {
  if (audience === "parent") {
    if (channel !== "email") throw badRequest("Messages to the parents go by email");
    // Fails closed: an errored read throws rather than defaulting to "on".
    const prefs = await loadAlertPrefs({ db }, studentId);
    if (!prefs.copy_parents) {
      throw badRequest("Messages to the parents are switched off for this student");
    }
    const family = await loadFamily(db, studentId);
    const reachable = family.filter((g) => g.receivesMessages && g.email);
    if (reachable.length === 0) {
      throw badRequest(
        family.length === 0
          ? "Add a parent or guardian with an email address first"
          : "No parent on file with an email address who receives messages"
      );
    }
    return reachable.map((g) => ({ kind: "guardian", id: g.id, name: g.name, email: g.email, phone: g.phone }));
  }

  const student = await loadStudentContact(db, studentId);
  if (!student) throw badRequest("That student isn't on your roster");
  if (channel === "email" && !student.email) throw badRequest("No email address on file for the student");
  // The same reading of a number the database guard and dispatch use: "n/a"
  // is no phone at all.
  if (channel === "sms" && !normPhone(student.phone)) throw badRequest("Add the student's phone number to text them");
  return [{ kind: "student", id: student.id, name: student.name, email: student.email, phone: student.phone }];
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * The anti-spam gate for alerts. Counts parent alerts and composer alerts
 * alike, so writing the alert by hand is not a way around the throttle.
 * Throws on a read error (fail closed).
 */
export async function alertThrottleReason(
  db: SupabaseClient,
  studentId: string,
  settings: AccountabilitySettings
): Promise<string | null> {
  if (!settings.enabled) return "Accountability alerts are turned off for this student";
  const since = new Date(Date.now() - settings.min_days_between_alerts * 86_400_000).toISOString();
  const [alerts, messages] = await Promise.all([
    db
      .from("parent_alerts")
      .select("id")
      .eq("student_id", studentId)
      .eq("status", "sent")
      .gte("sent_at", since)
      .limit(1),
    db
      .from("student_messages")
      .select("id")
      .eq("student_id", studentId)
      .eq("kind", "alert")
      .eq("status", "sent")
      .gte("sent_at", since)
      .limit(1),
  ]);
  if (alerts.error) throw fromPostgrest(alerts.error);
  if (messages.error) throw fromPostgrest(messages.error);
  if ((alerts.data?.length ?? 0) + (messages.data?.length ?? 0) > 0) {
    return `An alert already went to this family in the last ${settings.min_days_between_alerts} days`;
  }
  return null;
}

export type SendPlan =
  | { status: "queued"; scheduledFor: null; holdReason: null }
  | { status: "scheduled"; scheduledFor: string; holdReason: string };

export function planSend(
  settings: AccountabilitySettings,
  opts: { scheduleFor?: string | null; overrideQuietHours?: boolean },
  now: Date = new Date()
): SendPlan {
  if (opts.scheduleFor) {
    const at = new Date(opts.scheduleFor);
    if (Number.isNaN(at.getTime())) throw badRequest("That isn't a valid time");
    if (at.getTime() > now.getTime() + 60_000) {
      if (at.getTime() > now.getTime() + 180 * 86_400_000) throw badRequest("Schedule within six months");
      return { status: "scheduled", scheduledFor: at.toISOString(), holdReason: "Scheduled by the counselor" };
    }
  }
  if (!opts.overrideQuietHours && inQuietHours(settings, now)) {
    return {
      status: "scheduled",
      scheduledFor: nextSendWindow(settings),
      holdReason: "Inside quiet hours — it goes out when they end",
    };
  }
  return { status: "queued", scheduledFor: null, holdReason: null };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type MessageRow = {
  id: string;
  student_id: string;
  counselor_id: string;
  audience: Audience;
  channel: Channel;
  kind: MessageKind;
  recipients: Recipient[];
  subject: string | null;
  body: string;
};

export type Attempt = {
  recipient: string;
  recipientKind: "guardian" | "student";
  channel: Channel;
  status: "sent" | "queued" | "failed" | "unavailable";
  deliveryId: string | null;
  error: string | null;
};

export type DeliveryOutcome = { status: "sent" | "queued" | "failed"; attempts: Attempt[] };

/**
 * Carry a message to the recipients frozen on its row. The status is the
 * truth: `sent` when at least one provider accepted it, `queued` when a text
 * waits on an SMS provider that is not configured, `failed` otherwise.
 */
export async function deliverMessage(
  row: MessageRow,
  counselorName: string | null,
  logger?: Log
): Promise<DeliveryOutcome> {
  const attempts: Attempt[] = [];
  const paragraphs = row.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const template = {
    heading: row.subject ?? "A note from your counselor",
    paragraphs,
    footnote: counselorName
      ? `Sent by ${counselorName} through Meridies. Reply to your counselor directly with any questions.`
      : "Sent by your counselor through Meridies. Reply to your counselor directly with any questions.",
  };

  for (const r of row.recipients) {
    const columns = {
      student_id: row.student_id,
      recipient_kind: r.kind,
      recipient_id: r.id,
      template: "student-message",
      logger,
    } as const;

    if (row.channel === "email") {
      if (!r.email) {
        attempts.push({ recipient: r.name, recipientKind: r.kind, channel: "email", status: "unavailable", deliveryId: null, error: "no email address on file" });
        continue;
      }
      const res = await sendEmail({
        ...columns,
        to: r.email,
        subject: template.heading,
        html: brandedEmail(template),
        text: brandedText(template),
      });
      attempts.push({
        recipient: r.name,
        recipientKind: r.kind,
        channel: "email",
        status: res.sent ? "sent" : "failed",
        deliveryId: res.deliveryId,
        error: res.sent ? null : res.error,
      });
    } else {
      if (!r.phone) {
        attempts.push({ recipient: r.name, recipientKind: r.kind, channel: "sms", status: "unavailable", deliveryId: null, error: "no phone number on file" });
        continue;
      }
      const res = await sendSms({ ...columns, to: r.phone, body: row.body });
      attempts.push({
        recipient: r.name,
        recipientKind: r.kind,
        channel: "sms",
        status: res.status,
        deliveryId: res.deliveryId,
        error: res.error,
      });
    }
  }

  const status = attempts.some((a) => a.status === "sent")
    ? "sent"
    : attempts.some((a) => a.status === "queued")
      ? "queued"
      : "failed";
  return { status, attempts };
}

/** Write the outcome back. Never throws: the send already happened. */
export async function recordOutcome(
  db: SupabaseClient,
  id: string,
  outcome: DeliveryOutcome,
  logger?: Log
): Promise<Row | null> {
  const { data, error } = await db
    .from("student_messages")
    .update({
      status: outcome.status,
      attempts: outcome.attempts,
      sent_at: outcome.status === "sent" ? new Date().toISOString() : null,
      hold_reason: null,
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) logger?.error({ code: error.code }, "student message: outcome write failed");
  return (data as Row | null) ?? null;
}

// ---------------------------------------------------------------------------
// Referrals: the ask is tracked under Invitations (overview's `referrals`)
// ---------------------------------------------------------------------------

/**
 * A referral ask that went out (or is scheduled) refreshes the family's open
 * ask, or opens one. Best effort: the message is the thing the counselor
 * asked for, and a tracking hiccup must not fail it.
 */
export async function recordReferralAsk(
  db: SupabaseClient,
  counselorId: string,
  studentId: string,
  messageId: string,
  logger?: Log
): Promise<boolean> {
  const { data: open, error } = await db
    .from("referrals")
    .select("id")
    .eq("counselor_id", counselorId)
    .eq("from_student_id", studentId)
    .eq("status", "asked")
    .maybeSingle();
  if (error) {
    logger?.warn({ code: error.code }, "referral ask: lookup failed");
    return false;
  }
  const now = new Date().toISOString();
  const res = open
    ? await db.from("referrals").update({ asked_at: now, ask_message_id: messageId }).eq("id", open.id as string)
    : await db.from("referrals").insert({
        counselor_id: counselorId,
        from_student_id: studentId,
        status: "asked",
        asked_at: now,
        ask_message_id: messageId,
      });
  if (res.error) {
    logger?.warn({ code: res.error.code }, "referral ask: write failed");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Suggestions the AxIS bar cycles through
// ---------------------------------------------------------------------------

export type ComposerFacts = {
  studentName: string;
  applicationsIn: boolean;
  behind: boolean;
  hasAid: boolean;
  parentFirstName: string | null;
  /** `custom` when it is the counselor's own internal date ("Your deadline"). */
  nextDeadline: { school: string; round: string | null; date: string; custom: boolean } | null;
  unstartedEssay: string | null;
  month: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${SHORT[(m ?? 1) - 1]} ${d}`;
}

const SUBMITTED = new Set(["submitted", "accepted", "denied", "waitlisted", "deferred", "enrolled"]);

export async function loadComposerFacts(db: SupabaseClient, studentId: string, now: Date = new Date()): Promise<ComposerFacts> {
  const today = now.toISOString().slice(0, 10);
  const [profile, colleges, overdue, flags, aid, letters, essays, guardian] = await Promise.all([
    db.from("profiles").select("full_name").eq("id", studentId).maybeSingle(),
    db
      .from("student_colleges")
      .select("name, round, deadline, custom_deadline, status")
      .eq("student_id", studentId),
    db
      .from("deliverables")
      .select("id")
      .eq("student_id", studentId)
      .eq("visible_to_student", true)
      .neq("status", "complete")
      .lt("due_date", today)
      .limit(1),
    db
      .from("red_flags")
      .select("id")
      .eq("student_id", studentId)
      .in("status", ["open", "escalated"])
      .limit(1),
    db.from("student_aid_profiles").select("student_id").eq("student_id", studentId).maybeSingle(),
    db.from("award_letters").select("id").eq("student_id", studentId).limit(1),
    db.from("essays").select("title, status").eq("student_id", studentId).eq("status", "not-started").limit(1),
    db
      .from("guardians")
      .select("full_name")
      .eq("student_id", studentId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  for (const r of [profile, colleges, overdue, flags, aid, letters, essays, guardian]) {
    if (r.error) throw fromPostgrest(r.error);
  }

  const list = ((colleges.data ?? []) as Row[]).filter((c) => c.status !== "withdrawn");
  const applicationsIn = list.length > 0 && list.every((c) => SUBMITTED.has(String(c.status)));
  const next = list
    .filter((c) => !SUBMITTED.has(String(c.status)))
    .map((c) => {
      const custom = s(c.custom_deadline);
      const date = custom ?? s(c.deadline);
      return { c, date, custom: custom !== null };
    })
    .filter((x): x is { c: Row; date: string; custom: boolean } => !!x.date && x.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const parent = s((guardian.data as Row | null)?.full_name);
  return {
    studentName: String((profile.data as Row | null)?.full_name ?? ""),
    applicationsIn,
    behind: (overdue.data?.length ?? 0) + (flags.data?.length ?? 0) > 0,
    hasAid: Boolean(aid.data) || (letters.data?.length ?? 0) > 0,
    parentFirstName: parent ? firstName(parent) : null,
    nextDeadline: next
      ? { school: String(next.c.name), round: s(next.c.round), date: next.date, custom: next.custom }
      : null,
    unstartedEssay: s(((essays.data ?? []) as Row[])[0]?.title),
    month: MONTHS[now.getUTCMonth()],
  };
}

export function suggestionsFor(audience: Audience, f: ComposerFacts): string[] {
  const first = firstName(f.studentName);
  const family = familyName(f.studentName);
  const list: string[] = [];
  if (audience === "parent") {
    if (f.applicationsIn) list.push(`Ask the ${family} family for a referral`);
    list.push(`Update the ${family} family on ${f.month} progress`);
    if (f.behind) list.push("Alert the family about overdue work");
    if (f.hasAid) list.push(`Explain the aid checklist to ${f.parentFirstName ?? `the ${family} family`}`);
    list.push(`Ask the ${family} family for a time to meet`);
    return list;
  }
  if (f.nextDeadline) {
    const round = f.nextDeadline.round ? ` ${f.nextDeadline.round}` : "";
    list.push(
      f.nextDeadline.custom
        ? `Remind ${first} the ${f.nextDeadline.school}${round} draft is due ${shortDate(f.nextDeadline.date)}`
        : `Remind ${first} the ${f.nextDeadline.school}${round} deadline is ${shortDate(f.nextDeadline.date)}`
    );
  }
  if (f.behind) list.push(`Nudge ${first} about overdue work`);
  list.push(`Send ${first} this week's open tasks`);
  if (f.unstartedEssay) list.push(`Ask ${first} to start the ${f.unstartedEssay} essay`);
  return list;
}

/** What a typed request is, for the parts of the product that track it. */
export function kindFor(prompt: string, audience: Audience): MessageKind {
  const t = prompt.toLowerCase();
  if (audience === "parent" && /\brefer/.test(t)) return "referral";
  if (audience === "parent" && /\b(alert|overdue|behind|late|missed|slipp)/.test(t)) return "alert";
  return "message";
}

// ---------------------------------------------------------------------------
// The scheduled sender
// ---------------------------------------------------------------------------

function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Same rule as routes/internal.ts: a shared secret, compared in constant time. */
export async function requireCronSecret(request: FastifyRequest): Promise<void> {
  const expected = env.CRON_SECRET;
  if (!expected) throw unavailable("Scheduled jobs are not configured");
  const header = request.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  const presented = scheme?.toLowerCase() === "bearer" ? (value ?? "").trim() : "";
  if (!presented || !secretMatches(presented, expected)) throw unauthorized();
}

/** Scheduled messages the dispatch cron sends for one counselor in 24 hours. */
export const DISPATCH_DAILY_CAP = 100;
export const DISPATCH_CAP_HOLD = "Held: the day's sending limit was reached. It goes out within the next day";
export const dispatchCapKey = (counselorId: string): string => `communication:dispatch:${counselorId}`;

/**
 * Deliver every scheduled message whose time has come. Service-role client:
 * the recipients come from the row (frozen when the counselor wrote it), never
 * from a caller, and each one is checked again against the student and the
 * guardians on file before anything goes out (`allowedRecipients`), because a
 * row is not proof the composer route wrote it. Each row is claimed with a conditional scheduled -> queued
 * update first, so two runs cannot send it twice. A row that falls inside its
 * counselor's quiet hours waits for the next window.
 */
export async function dispatchDueMessages(
  svc: SupabaseClient,
  logger: Log,
  max = 200
): Promise<{ sent: number; queued: number; failed: number; held: number }> {
  const now = new Date();
  const { data, error } = await svc
    .from("student_messages")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(max);
  if (error) throw fromPostgrest(error);

  const tally = { sent: 0, queued: 0, failed: 0, held: 0 };
  const names = new Map<string, string | null>();
  const settingsByKey = new Map<string, AccountabilitySettings>();

  for (const raw of (data ?? []) as Row[]) {
    const row = raw as unknown as MessageRow & { scheduled_for: string; hold_reason: string | null };
    const key = `${row.counselor_id}:${row.student_id}`;
    let settings = settingsByKey.get(key);
    if (!settings) {
      try {
        settings = await loadSettings({ db: svc }, row.counselor_id, row.student_id);
      } catch {
        tally.held += 1; // fail closed: an unreadable setting holds the send
        continue;
      }
      settingsByKey.set(key, settings);
    }
    if (inQuietHours(settings, now)) {
      await svc
        .from("student_messages")
        .update({ scheduled_for: nextSendWindow(settings), hold_reason: "Inside quiet hours — it goes out when they end" })
        .eq("id", row.id)
        .eq("status", "scheduled");
      tally.held += 1;
      continue;
    }

    // The recipients were frozen when the counselor wrote the message, but
    // who may receive it is re-decided now, failing closed: the student must
    // still be this counselor's, a message to the student goes only to their
    // address or phone on file, the parents must still be switched on, each
    // guardian still on file with alerts on and the same address, and an
    // alert still clear of the throttle. Anything unreadable holds the send.
    let recipients: Recipient[];
    try {
      const blocked = await sendBlockedReason(svc, row, settings);
      if (typeof blocked === "string") {
        await svc
          .from("student_messages")
          .update({ status: "cancelled", hold_reason: blocked })
          .eq("id", row.id)
          .eq("status", "scheduled");
        tally.held += 1;
        continue;
      }
      recipients = blocked.recipients;
    } catch {
      tally.held += 1;
      continue;
    }

    // What a counselor can have sent for them in a day is capped here too,
    // whoever wrote the row: the route charges its own limits when a message
    // is written, but a row written straight to the table (on a database
    // without the insert guard) never passed them. Over the cap, the row
    // waits an hour and is tried again; nothing is dropped.
    if (!(await consumeRateLimit(dispatchCapKey(row.counselor_id), DISPATCH_DAILY_CAP, 86_400))) {
      await svc
        .from("student_messages")
        .update({ scheduled_for: new Date(now.getTime() + 3_600_000).toISOString(), hold_reason: DISPATCH_CAP_HOLD })
        .eq("id", row.id)
        .eq("status", "scheduled");
      tally.held += 1;
      continue;
    }

    const claim = await svc
      .from("student_messages")
      .update({ status: "queued" })
      .eq("id", row.id)
      .eq("status", "scheduled")
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) continue;

    if (!names.has(row.counselor_id)) {
      const { data: c } = await svc.from("profiles").select("full_name").eq("id", row.counselor_id).maybeSingle();
      names.set(row.counselor_id, s((c as Row | null)?.full_name));
    }
    const outcome = await deliverMessage({ ...row, recipients }, names.get(row.counselor_id) ?? null, logger);
    await recordOutcome(svc, row.id, outcome, logger);
    tally[outcome.status] += 1;
  }
  return tally;
}

/**
 * Re-check a scheduled message just before it leaves. Returns the reason it
 * must not go (the row is cancelled with it), or the recipients still allowed.
 * Throws on any read error, which the caller treats as "hold".
 */
async function sendBlockedReason(
  svc: SupabaseClient,
  row: MessageRow,
  settings: AccountabilitySettings
): Promise<string | { recipients: Recipient[] }> {
  // Decided when it leaves, not when it was written: a counselor revoked since
  // scheduling sends nothing. A read error throws, and the caller holds the row.
  if (!(await isCounselorApproved(svc, row.counselor_id))) {
    return "The sender's account is not approved to send messages";
  }
  const { data: student, error } = await svc
    .from("profiles")
    .select("counselor_id, archived_at, email")
    .eq("id", row.student_id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!student || student.counselor_id !== row.counselor_id || student.archived_at) {
    return "The student is no longer on this counselor's roster";
  }
  if (row.kind === "alert") {
    const throttled = await alertThrottleReason(svc, row.student_id, settings);
    if (throttled) return throttled;
  }
  if (row.audience !== "parent") {
    // The student's own address or phone as it is on file now, never what
    // the row says: a row written straight to the table could name anyone.
    const student = await loadStudentContact(svc, row.student_id);
    const recipients = allowedRecipients(row, { student, family: [] });
    if (recipients.length === 0) return "No address on file for the student any more";
    // An email frozen with another address (written when the contact email
    // was followed, or before a sign-in email change) is cancelled rather
    // than re-addressed: the counselor saw that address in the To line.
    if (studentRecipientsStillAllowed(row.recipients, row.channel, student?.email).length === 0) {
      return "The student's address on file has changed since this was scheduled";
    }
    return { recipients };
  }

  const prefs = await loadAlertPrefs({ db: svc }, row.student_id);
  if (!prefs.copy_parents) return "Messages to the parents were switched off before this went out";
  const family = await loadFamily(svc, row.student_id);
  const recipients = allowedRecipients(row, { student: null, family });
  if (recipients.length === 0) return "No parent on file still receives messages";
  return { recipients };
}

/**
 * Which of a stored message's frozen recipients may still receive it, decided
 * against what is on file at send time. Every recipient must be one the
 * composer would have resolved for this student itself. For a message to the
 * student: the row must name the student (by id), and it goes to the address
 * or phone on file now, whatever the row froze, so a student who changes
 * their address still gets it (and can't cancel it by changing it). For one
 * to the parents: a guardian of this student who still receives messages, at
 * the same email. Anything else on the row is dropped, and what is returned
 * carries the addresses on file, not the row's. Pure, so it is unit-tested.
 */
export function allowedRecipients(
  row: Pick<MessageRow, "student_id" | "audience" | "channel" | "recipients">,
  onFile: { student: StudentContact | null; family: FamilyContact[] }
): Recipient[] {
  const frozen = Array.isArray(row.recipients) ? row.recipients : [];
  if (row.audience === "student") {
    const st = onFile.student;
    if (!st || st.id !== row.student_id) return [];
    const named = frozen.some((r) => r && r.kind === "student" && r.id === row.student_id);
    if (!named) return [];
    if (row.channel === "email" && !normEmail(st.email)) return [];
    if (row.channel === "sms" && !normPhone(st.phone)) return [];
    if (row.channel !== "email" && row.channel !== "sms") return [];
    return [{ kind: "student", id: st.id, name: st.name, email: st.email, phone: st.phone }];
  }
  if (row.audience !== "parent" || row.channel !== "email") return [];
  const byId = new Map(onFile.family.filter((g) => g.receivesMessages && normEmail(g.email)).map((g) => [g.id, g]));
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const r of frozen) {
    if (!r || r.kind !== "guardian" || seen.has(r.id)) continue;
    const g = byId.get(r.id);
    if (!g || normEmail(g.email) !== normEmail(r.email)) continue;
    seen.add(g.id);
    out.push({ kind: "guardian", id: g.id, name: g.name, email: g.email, phone: g.phone });
  }
  return out;
}
