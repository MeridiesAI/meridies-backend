/**
 * Emailed calendar invites for meetings, without Google or Microsoft.
 *
 * A meeting with `send_invites` on emails each invited student an iCalendar
 * file (lib/ics.ts) through Resend: REQUEST when they are invited or the
 * meeting changes, CANCEL when it is cancelled, deleted, they are taken off
 * it, or invites are switched off after going out. Guardians get the same when
 * the meeting invites them. The counselor who owns the meeting gets a PUBLISH
 * copy when the meeting isn't already on their connected calendar.
 *
 * Who receives anything is decided here, on the caller's own client (RLS
 * applies), and fails closed:
 *  - the meeting's own student must be on its owner's caseload, or nothing
 *    is sent at all;
 *  - a student must still be readable, not archived, and on the meeting
 *    owner's caseload (their counselor, or a collaborator of theirs);
 *  - a guardian only while the student's `copy_parents` is on
 *    (`loadAlertPrefs`, which throws on a read error) and their own
 *    `alerts_enabled` is on, so a guardian a student added (alerts off until
 *    the counselor turns them on) can't receive a meeting link;
 *  - any read that errors drops what it would have decided, never defaults it.
 *
 * Invites are transactional, like a task assignment: the counselor is acting
 * now, so quiet hours don't hold them. Each round that sends an invite or an
 * update costs one of 60 an hour per meeting owner, charged only after the
 * round is resolved to someone who will receive it, and never for a meeting
 * whose stored owner doesn't hold its student (a row forged to name another
 * counselor can't spend their allowance); a round of cancellations
 * is never held back, because a family keeping a meeting that is off is worse
 * than one more email. Sends run after the response, one at a time about a
 * quarter second apart (Resend's default limit is about two a second), each a
 * `message_deliveries` row linked to the meeting. A failed send never fails
 * the save. Nothing here calls the service client: the audit row is written
 * by lib/email.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { loadAlertPrefs, loadSettings } from "./accountability.js";
import { isTimeZone } from "./calendarFeed.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { toInviteDelivery, type InviteDelivery } from "./inviteDelivery.js";
import { buildMeetingIcs, mailto, meetingWhere, plainLine, type IcsMethod, type IcsMode } from "./ics.js";
import { consumeRateLimit } from "./limits.js";
import { serializeErr } from "./requestLog.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export type MeetingStatus = "scheduled" | "held" | "cancelled" | "no-show";
export type InviteTemplate = "meeting-invite" | "meeting-update" | "meeting-cancel";

/** What the invites need to know about a meeting row. */
export type MeetingState = {
  id: string;
  /** The meeting's owner: the ORGANIZER, the Reply-To, the throttle key and the time zone. */
  counselorId: string;
  primaryStudentId: string;
  status: MeetingStatus;
  sendInvites: boolean;
  guardiansInvited: boolean;
  startsAt: string;
  endsAt: string | null;
  title: string;
  location: string | null;
  joinUrl: string | null;
  mode: IcsMode;
  agenda: string | null;
  sequence: number;
  /** On the owner's connected Google / Outlook calendar already. */
  onProviderCalendar: boolean;
};

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const MODES = new Set<IcsMode>(["google-meet", "teams", "in-person", "phone"]);
const STATUSES = new Set<MeetingStatus>(["scheduled", "held", "cancelled", "no-show"]);

export function meetingState(r: Row): MeetingState {
  const mode = String(r.mode) as IcsMode;
  const status = String(r.status) as MeetingStatus;
  const seq = Number(r.ics_sequence);
  return {
    id: String(r.id),
    counselorId: String(r.counselor_id),
    primaryStudentId: String(r.student_id),
    status: STATUSES.has(status) ? status : "scheduled",
    sendInvites: r.send_invites === true,
    guardiansInvited: r.guardians_invited === true,
    startsAt: String(r.starts_at),
    endsAt: s(r.ends_at),
    title: String(r.title ?? ""),
    location: s(r.location),
    joinUrl: s(r.join_url),
    mode: MODES.has(mode) ? mode : "google-meet",
    agenda: s(r.agenda),
    sequence: Number.isInteger(seq) && seq >= 0 ? seq : 0,
    onProviderCalendar: Boolean(r.calendar_event_id),
  };
}

// ---------------------------------------------------------------------------
// Readiness: the migration (20261023090001) is applied
// ---------------------------------------------------------------------------

const MISSING_TTL_MS = 30_000;
let readiness: { ready: boolean; until: number } | null = null;
const SCHEMA_CODES = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);

type ProbeDb = {
  from(table: string): { select(cols: string): { limit(n: number): PromiseLike<{ error: { code?: string } | null }> } };
};

/**
 * Whether the invite columns exist, from a zero-row read on the caller's
 * client. Ready is kept for the life of the process; missing for 30 seconds,
 * so applying the migration takes effect without a deploy. Any other error
 * reads as not ready, uncached: no invite is sent on a guess.
 */
export async function invitesReady(db: ProbeDb, now: number = Date.now()): Promise<boolean> {
  if (readiness && (readiness.ready || now < readiness.until)) return readiness.ready;
  try {
    const { error } = await db.from("meetings").select("send_invites, ics_sequence").limit(0);
    if (!error) {
      readiness = { ready: true, until: Number.POSITIVE_INFINITY };
      return true;
    }
    if (error.code && SCHEMA_CODES.has(error.code)) readiness = { ready: false, until: now + MISSING_TTL_MS };
    return false;
  } catch {
    return false;
  }
}

/** For tests. */
export function resetInvitesReady(): void {
  readiness = null;
}

/** The invite column a write may name: none at all until the migration is in. */
export function inviteColumns(ready: boolean, sendInvites: boolean | undefined): { send_invites?: boolean } {
  return ready && sendInvites !== undefined ? { send_invites: sendInvites } : {};
}

/** A meeting that will email invites must have an end time (as the database's CHECK says). */
export function inviteEndError(ready: boolean, sendInvites: boolean, endsAt: string | null | undefined): string | null {
  return ready && sendInvites && !endsAt ? "A calendar invite needs an end time" : null;
}

// ---------------------------------------------------------------------------
// The plan: who is told what, from the meeting before and after a change
// ---------------------------------------------------------------------------

export type Audience = { audience: "student" | "guardians"; studentId: string };
export type PlannedMessage = {
  audience: "student" | "guardians" | "counselor";
  studentId: string;
  method: IcsMethod;
  template: InviteTemplate;
};

export type InvitePlan = {
  messages: PlannedMessage[];
  /** Everyone still invited afterwards: a cancellation never goes to an address that is still invited. */
  keep: Audience[];
  /** The meeting the files describe. */
  describe: MeetingState;
  sequence: number;
  /** False once the meeting is deleted: its delivery rows can't point at it. */
  linkMeeting: boolean;
};

export type PlanInput = {
  before: MeetingState | null;
  after: MeetingState | null;
  attendeesBefore: string[];
  attendeesAfter: string[];
  /** The counselor's "Email the change": off sends no update or cancellation for this change. */
  notify: boolean;
  now: Date;
};

function ended(m: MeetingState, now: Date): boolean {
  const end = Date.parse(m.endsAt ?? m.startsAt);
  return !(end > now.getTime());
}

/** Invites on, scheduled, not over: the state in which invitees hold the meeting on their calendars. */
function live(m: MeetingState, now: Date): boolean {
  return m.sendInvites && m.status === "scheduled" && !ended(m, now);
}

function material(a: MeetingState, b: MeetingState): boolean {
  const t = (v: string | null) => (v ? Date.parse(v) : null);
  return (
    a.title !== b.title ||
    t(a.startsAt) !== t(b.startsAt) ||
    t(a.endsAt) !== t(b.endsAt) ||
    (a.location ?? null) !== (b.location ?? null) ||
    (a.joinUrl ?? null) !== (b.joinUrl ?? null) ||
    a.mode !== b.mode ||
    (a.agenda ?? null) !== (b.agenda ?? null)
  );
}

const uniq = (ids: string[]) => [...new Set(ids)];

function to(students: string[], guardians: boolean, method: IcsMethod, template: InviteTemplate): PlannedMessage[] {
  return students.flatMap((studentId) => [
    { audience: "student" as const, studentId, method, template },
    ...(guardians ? [{ audience: "guardians" as const, studentId, method, template }] : []),
  ]);
}

function audiences(students: string[], guardians: boolean): Audience[] {
  return students.flatMap((studentId) => [
    { audience: "student" as const, studentId },
    ...(guardians ? [{ audience: "guardians" as const, studentId }] : []),
  ]);
}

/** The owner's own copy, unless the meeting is already on their connected calendar. */
function counselorCopy(m: MeetingState, method: IcsMethod, template: InviteTemplate): PlannedMessage[] {
  return m.onProviderCalendar ? [] : [{ audience: "counselor", studentId: m.primaryStudentId, method, template }];
}

export function planInviteRound(i: PlanInput): InvitePlan | null {
  const { before, after, now } = i;
  const was = uniq(i.attendeesBefore);
  const is = uniq(i.attendeesAfter);

  // Deleted: everyone who held it is told it's off.
  if (!after) {
    if (!before || !live(before, now)) return null;
    return {
      messages: [...to(was, before.guardiansInvited, "CANCEL", "meeting-cancel"), ...counselorCopy(before, "CANCEL", "meeting-cancel")],
      keep: [],
      describe: before,
      sequence: before.sequence + 1,
      linkMeeting: false,
    };
  }

  const isLive = live(after, now);
  const plan = (messages: PlannedMessage[], keep: Audience[] = isLive ? audiences(is, after.guardiansInvited) : []): InvitePlan | null =>
    messages.some((m) => m.audience !== "counselor")
      ? { messages, keep, describe: after, sequence: after.sequence, linkMeeting: true }
      : null;
  const inviteAll = () =>
    isLive ? plan([...to(is, after.guardiansInvited, "REQUEST", "meeting-invite"), ...counselorCopy(after, "PUBLISH", "meeting-invite")]) : null;

  if (!before) return inviteAll();

  const wasLive = live(before, now);
  // Switching invites on or off is itself the instruction to send, whatever `notify` says.
  if (before.sendInvites && !after.sendInvites) {
    if (!wasLive) return null;
    return plan([...to(was, before.guardiansInvited, "CANCEL", "meeting-cancel"), ...counselorCopy(before, "CANCEL", "meeting-cancel")], []);
  }
  if (!before.sendInvites && after.sendInvites) return inviteAll();
  if (!after.sendInvites || !i.notify) return null;

  if (wasLive && !isLive) {
    // Held or no-show: it happened, nothing to take back. Cancelled: take it off every calendar.
    if (after.status !== "cancelled") return null;
    return plan([...to(was, before.guardiansInvited, "CANCEL", "meeting-cancel"), ...counselorCopy(before, "CANCEL", "meeting-cancel")], []);
  }
  if (!wasLive) return inviteAll();

  const added = is.filter((id) => !was.includes(id));
  const removed = was.filter((id) => !is.includes(id));
  const kept = is.filter((id) => was.includes(id));
  const messages: PlannedMessage[] = [
    ...to(added, after.guardiansInvited, "REQUEST", "meeting-invite"),
    ...to(removed, before.guardiansInvited, "CANCEL", "meeting-cancel"),
  ];
  if (!before.guardiansInvited && after.guardiansInvited) {
    messages.push(...kept.map((studentId) => ({ audience: "guardians" as const, studentId, method: "REQUEST" as const, template: "meeting-invite" as const })));
  } else if (before.guardiansInvited && !after.guardiansInvited) {
    messages.push(...kept.map((studentId) => ({ audience: "guardians" as const, studentId, method: "CANCEL" as const, template: "meeting-cancel" as const })));
  }
  if (material(before, after)) {
    messages.push(...to(kept, before.guardiansInvited && after.guardiansInvited, "REQUEST", "meeting-update"));
    messages.push(...counselorCopy(after, "PUBLISH", "meeting-update"));
  }
  return plan(messages);
}

// ---------------------------------------------------------------------------
// Recipients, read on the caller's client
// ---------------------------------------------------------------------------

export type InviteRecipient = {
  email: string;
  name: string | null;
  kind: "student" | "guardian" | "counselor";
  recipientId: string;
  /** The invited student this message is about (the delivery row's student_id). */
  studentId: string;
  studentName: string | null;
  method: IcsMethod;
  template: InviteTemplate;
};

export type ResolvedRound = {
  meetingId: string;
  linkMeeting: boolean;
  meeting: MeetingState;
  sequence: number;
  organizer: { name: string | null; email: string };
  timeZone: string;
  recipients: InviteRecipient[];
  skipped: number;
  notes: string[];
};

const MAX_GUARDIANS_PER_STUDENT = 4;
const RANK: Record<IcsMethod, number> = { REQUEST: 3, PUBLISH: 2, CANCEL: 1 };

/** A valid address, lowercased, or null. */
function validEmail(v: unknown): string | null {
  const raw = s(v);
  if (!raw) return null;
  try {
    return mailto(raw).slice("mailto:".length);
  } catch {
    return null;
  }
}

/** Skip reason for a meeting whose stored owner doesn't hold its student. */
export const NOT_OWNERS_STUDENT = "The meeting's student isn't on its counselor's caseload, so no invites were emailed";

function ownerHolds(student: Row | undefined, owner: string, sharedWithOwner: boolean): boolean {
  return Boolean(student) && (student!.counselor_id === owner || sharedWithOwner);
}

export async function resolveRound(db: SupabaseClient, plan: InvitePlan): Promise<ResolvedRound | { skip: string }> {
  const meeting = plan.describe;
  const owner = meeting.counselorId;
  const notes: string[] = [];
  let skipped = 0;

  const { data: org, error: orgErr } = await db.from("profiles").select("id, full_name, email").eq("id", owner).maybeSingle();
  const organizerEmail = orgErr ? null : validEmail((org as Row | null)?.email);
  if (!organizerEmail) return { skip: "Couldn't read the email address of the meeting's counselor" };
  const organizer = { name: s((org as Row).full_name), email: organizerEmail };

  const studentIds = uniq([
    meeting.primaryStudentId,
    ...plan.messages.filter((m) => m.audience !== "counselor").map((m) => m.studentId),
    ...plan.keep.map((k) => k.studentId),
  ]);

  const [profiles, details] = await Promise.all([
    db.from("profiles").select("id, full_name, email, archived_at, counselor_id").in("id", studentIds),
    db.from("student_personal_details").select("student_id, contact_email").in("student_id", studentIds),
  ]);
  // Fails closed: without these we can't say who may receive what, or at which address.
  if (profiles.error || details.error) return { skip: "Couldn't read who to invite" };

  const contact = new Map(((details.data ?? []) as Row[]).map((d) => [String(d.student_id), validEmail(d.contact_email)]));
  const rows = new Map(((profiles.data ?? []) as Row[]).map((p) => [String(p.id), p]));

  // On the owner's caseload: their student, or one shared with them. An unreadable answer is "no".
  const shared = new Set<string>();
  const notOwn = studentIds.filter((id) => rows.get(id)?.counselor_id !== owner);
  if (notOwn.length > 0) {
    const { data, error } = await db.from("student_collaborators").select("student_id").eq("counselor_id", owner).in("student_id", notOwn);
    if (!error) for (const r of (data ?? []) as Row[]) shared.add(String(r.student_id));
  }
  // The owner must hold the meeting's own student (archived or not): a row
  // naming as its owner someone with no hold on the student (forged through
  // PostgREST before 20261024000011, or left by a collaborator since removed)
  // sends nothing, and spends nothing of that counselor's throttle.
  if (!ownerHolds(rows.get(meeting.primaryStudentId), owner, shared.has(meeting.primaryStudentId))) {
    return { skip: NOT_OWNERS_STUDENT };
  }
  const onRoster = new Set(
    studentIds.filter((id) => {
      const p = rows.get(id);
      return p && !p.archived_at && (p.counselor_id === owner || shared.has(id));
    })
  );

  // Guardians: parents switched on for the student, the guardian's own alerts on.
  const wantGuardians = uniq(
    [...plan.messages, ...plan.keep].filter((m) => m.audience === "guardians" && onRoster.has(m.studentId)).map((m) => m.studentId)
  );
  // Notes speak only of guardians this round meant to email, not of those it only checks against.
  const emailing = new Set(plan.messages.filter((m) => m.audience === "guardians").map((m) => m.studentId));
  const guardiansOf = new Map<string, Row[]>();
  if (wantGuardians.length > 0) {
    const allowed: string[] = [];
    let prefsUnreadable = false;
    let parentsOff = false;
    for (const id of wantGuardians) {
      try {
        const prefs = await loadAlertPrefs({ db }, id);
        if (prefs.copy_parents) allowed.push(id);
        else if (emailing.has(id)) parentsOff = true;
      } catch {
        if (emailing.has(id)) prefsUnreadable = true;
      }
    }
    if (prefsUnreadable) notes.push("Some guardians weren't emailed: their settings couldn't be read");
    if (parentsOff) notes.push("Messages to parents are switched off for a student, so their guardians weren't invited");
    if (allowed.length > 0) {
      const { data, error } = await db
        .from("guardians")
        .select("id, student_id, full_name, email, alerts_enabled, is_primary, created_at")
        .in("student_id", allowed)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) {
        if (allowed.some((id) => emailing.has(id))) notes.push("Guardians weren't emailed: they couldn't be read");
      } else {
        for (const g of (data ?? []) as Row[]) {
          if (g.alerts_enabled !== true) continue;
          const list = guardiansOf.get(String(g.student_id)) ?? [];
          if (list.length < MAX_GUARDIANS_PER_STUDENT) list.push(g);
          guardiansOf.set(String(g.student_id), list);
        }
      }
    }
  }

  const studentName = (id: string) => s(rows.get(id)?.full_name);
  const studentEmail = (id: string) => contact.get(id) ?? validEmail(rows.get(id)?.email);

  /** Who an audience reaches; counts the invited who can't be reached. */
  const reach = (a: { audience: PlannedMessage["audience"]; studentId: string }, count: boolean) => {
    const out: Omit<InviteRecipient, "method" | "template">[] = [];
    if (a.audience === "counselor") {
      out.push({ email: organizer.email, name: organizer.name, kind: "counselor", recipientId: owner, studentId: a.studentId, studentName: null });
      return out;
    }
    if (!onRoster.has(a.studentId)) {
      if (count && a.audience === "student") skipped += 1;
      return out;
    }
    if (a.audience === "student") {
      const email = studentEmail(a.studentId);
      if (email) {
        out.push({ email, name: studentName(a.studentId), kind: "student", recipientId: a.studentId, studentId: a.studentId, studentName: studentName(a.studentId) });
      } else if (count) skipped += 1;
      return out;
    }
    for (const g of guardiansOf.get(a.studentId) ?? []) {
      const email = validEmail(g.email);
      if (email) {
        out.push({ email, name: s(g.full_name), kind: "guardian", recipientId: String(g.id), studentId: a.studentId, studentName: studentName(a.studentId) });
      } else if (count) skipped += 1;
    }
    return out;
  };

  const stillInvited = new Set(plan.keep.flatMap((k) => reach(k, false).map((r) => r.email)));

  // One email per address: an invite outranks a copy outranks a cancellation,
  // and an address still invited (a guardian of two siblings) is never cancelled.
  const byEmail = new Map<string, InviteRecipient>();
  for (const m of plan.messages) {
    for (const r of reach(m, true)) {
      if (m.method === "CANCEL" && stillInvited.has(r.email)) continue;
      const prior = byEmail.get(r.email);
      if (!prior || RANK[m.method] > RANK[prior.method]) byEmail.set(r.email, { ...r, method: m.method, template: m.template });
    }
  }

  let timeZone = "UTC";
  try {
    const settings = await loadSettings({ db }, owner);
    if (isTimeZone(settings.timezone)) timeZone = settings.timezone;
  } catch {
    // Display only: the time is also in the attached file, in UTC.
  }

  return {
    meetingId: meeting.id,
    linkMeeting: plan.linkMeeting,
    meeting,
    sequence: plan.sequence,
    organizer,
    timeZone,
    recipients: [...byEmail.values()],
    skipped,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

export function whenShort(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function whenLong(startsAt: string, endsAt: string | null, timeZone: string): string {
  const start = new Date(startsAt).toLocaleString("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (!endsAt) return start;
  const end = new Date(endsAt).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${start}, until ${end}`;
}

const PREFIX: Record<InviteTemplate, string> = {
  "meeting-invite": "Invitation",
  "meeting-update": "Updated",
  "meeting-cancel": "Cancelled",
};

export function inviteEmail(
  r: Pick<InviteRecipient, "kind" | "template" | "studentName">,
  m: MeetingState,
  timeZone: string,
  counselorName: string | null
): { subject: string; html: string; text: string } {
  const title = plainLine(m.title, 150) || "Meeting";
  const who = plainLine(counselorName ?? "", 120) || "Your counselor";
  const cancel = r.template === "meeting-cancel";
  const lead =
    r.template === "meeting-invite"
      ? r.kind === "counselor"
        ? "A copy of this meeting for your own calendar."
        : `${who} invited you to a meeting.`
      : r.template === "meeting-update"
        ? "This meeting changed. The attached invite updates it on your calendar."
        : "This meeting is cancelled.";
  const about =
    r.kind === "guardian" && r.studentName ? `${who} booked this in Meridies for ${plainLine(r.studentName, 120)}.` : `${who} booked this in Meridies.`;

  const body = {
    heading: `${PREFIX[r.template]}: ${title}`,
    paragraphs: [
      lead,
      `When: ${whenLong(m.startsAt, m.endsAt, timeZone)}`,
      ...(cancel ? [] : [`Where: ${meetingWhere(m)}`]),
      ...(!cancel && m.agenda?.trim() ? [m.agenda.trim()] : []),
      ...(r.kind === "counselor" ? [] : [about]),
    ],
    ...(r.kind === "student" && !cancel ? { cta: { label: "Open your calendar", url: `${env.APP_URL.replace(/\/+$/, "")}/dashboard/student/calendar` } } : {}),
    footnote: cancel
      ? "Open the attached file to take it off your calendar."
      : "The calendar invite is attached. Open it to add this to your calendar.",
  };
  return {
    subject: plainLine(`${PREFIX[r.template]}: ${title} · ${whenShort(m.startsAt, timeZone)}`, 250),
    html: brandedEmail(body),
    text: brandedText(body),
  };
}

// ---------------------------------------------------------------------------
// Delivery, after the response
// ---------------------------------------------------------------------------

const SEND_SPACING_MS = 250;

/** The address the email comes from, for SENT-BY. */
function fromAddress(): string | null {
  const m = /<([^>]+)>\s*$/.exec(env.INVITE_FROM_EMAIL);
  return validEmail(m ? m[1] : env.INVITE_FROM_EMAIL);
}

type Deps = { send: typeof sendEmail; pause: (ms: number) => Promise<void>; now: () => Date };
const defaultDeps: Deps = { send: sendEmail, pause: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date() };

/** Send every message of a round, one at a time. Never throws. */
export async function deliverInviteRound(
  round: ResolvedRound,
  log: Log,
  deps: Deps = defaultDeps
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const sentBy = fromAddress();
  const m = round.meeting;
  for (const [i, r] of round.recipients.entries()) {
    if (i > 0) await deps.pause(SEND_SPACING_MS);
    try {
      if (!m.endsAt) throw new Error("no end time");
      const ics = buildMeetingIcs({
        meetingId: m.id,
        sequence: round.sequence,
        method: r.method,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        title: m.title,
        agenda: m.agenda,
        mode: m.mode,
        location: m.location,
        joinUrl: m.joinUrl,
        organizer: round.organizer,
        sentBy: sentBy && sentBy !== round.organizer.email ? sentBy : null,
        attendee: r.method === "PUBLISH" ? null : { name: r.name, email: r.email },
        now: deps.now(),
      });
      const email = inviteEmail(r, m, round.timeZone, round.organizer.name);
      const result = await deps.send({
        to: r.email,
        ...email,
        template: r.template,
        attachments: [
          {
            filename: r.method === "CANCEL" ? "cancel.ics" : "invite.ics",
            content: Buffer.from(ics, "utf8").toString("base64"),
            contentType: `text/calendar; charset=utf-8; method=${r.method}`,
          },
        ],
        replyTo: round.organizer.email,
        retryOn429: true,
        student_id: r.studentId,
        recipient_kind: r.kind,
        recipient_id: r.recipientId,
        meeting_id: round.linkMeeting ? round.meetingId : null,
        logger: log,
      });
      if (result.sent) sent += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      log.warn({ err: serializeErr(err), template: r.template }, "meeting invite not sent");
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// What the routes call
// ---------------------------------------------------------------------------

export type InviteRoundSummary =
  /** recipients: the students and guardians being emailed (the counselor's own copy isn't counted). */
  | { status: "sending"; recipients: number; skipped: number; note?: string }
  | { status: "none" }
  | { status: "skipped" | "unavailable"; reason: string };

export const INVITES_UNAVAILABLE: InviteRoundSummary = { status: "unavailable", reason: "Calendar invites aren't switched on yet" };
export const INVITE_ROUNDS_PER_HOUR = 60;
const NO_ADDRESS = "No one invited has an email address on file";
const THROTTLED = "Too many calendar invites this hour, so invites and updates weren't emailed";

type Prepared = { summary: InviteRoundSummary; round: ResolvedRound | null };

/**
 * Plan, throttle and resolve a round before the response, so the counselor
 * hears who is being emailed. Delivery is `startInviteDelivery`. Never throws.
 */
export async function prepareInviteRound(
  request: Pick<FastifyRequest, "db" | "log">,
  input: Omit<PlanInput, "now">,
  deps: { consume: typeof consumeRateLimit; now: Date } = { consume: consumeRateLimit, now: new Date() }
): Promise<Prepared> {
  try {
    const plan = planInviteRound({ ...input, now: deps.now });
    if (!plan) return { summary: { status: "none" }, round: null };

    // Resolve before charging the throttle: a round that sends nothing (its
    // organizer unreadable, its student not on the owner's caseload) must not
    // spend the owner's hourly allowance, or anyone able to edit a row naming
    // another counselor could use theirs up.
    let resolved = await resolveRound(request.db, plan);
    if ("skip" in resolved) return { summary: { status: "skipped", reason: resolved.skip }, round: null };
    if (!resolved.recipients.some((r) => r.kind !== "counselor")) {
      return { summary: { status: "skipped", reason: resolved.notes[0] ?? NO_ADDRESS }, round: null };
    }

    const notes: string[] = [];
    // Only a round that adds or updates an invite is counted: cancellations always go.
    if (plan.messages.some((m) => m.method !== "CANCEL")) {
      const allowed = await deps.consume(`meeting-invites:${plan.describe.counselorId}`, INVITE_ROUNDS_PER_HOUR, 3600, {
        warn: (msg) => request.log.warn(msg),
      });
      if (!allowed) {
        const cancels = plan.messages.filter((m) => m.method === "CANCEL");
        if (!cancels.some((m) => m.audience !== "counselor")) return { summary: { status: "skipped", reason: THROTTLED }, round: null };
        resolved = await resolveRound(request.db, { ...plan, messages: cancels });
        if ("skip" in resolved) return { summary: { status: "skipped", reason: resolved.skip }, round: null };
        notes.push(THROTTLED);
      }
    }

    notes.push(...resolved.notes);
    const invitees = resolved.recipients.filter((r) => r.kind !== "counselor").length;
    if (invitees === 0) {
      return {
        summary: { status: "skipped", reason: notes[0] ?? NO_ADDRESS },
        round: null,
      };
    }
    return {
      summary: {
        status: "sending",
        recipients: invitees,
        skipped: resolved.skipped,
        ...(notes.length ? { note: notes.join(". ") } : {}),
      },
      round: resolved,
    };
  } catch (err) {
    request.log.warn({ err: serializeErr(err) }, "meeting invites not prepared");
    return { summary: { status: "skipped", reason: "Calendar invites couldn't be prepared" }, round: null };
  }
}

/** Send a prepared round in the background; the response doesn't wait. */
export function startInviteDelivery(round: ResolvedRound | null, log: Log): void {
  if (!round) return;
  void deliverInviteRound(round, log).catch((err) => log.error({ err: serializeErr(err) }, "meeting invite round failed"));
}

/** The students invited to a meeting, the primary first. */
export async function loadAttendeeIds(db: SupabaseClient, meeting: Pick<MeetingState, "id" | "primaryStudentId">): Promise<string[]> {
  const { data, error } = await db.from("meeting_attendees").select("student_id").eq("meeting_id", meeting.id).limit(500);
  if (error) throw error;
  const others = ((data ?? []) as Row[]).map((r) => String(r.student_id)).filter((id) => id !== meeting.primaryStudentId);
  return [meeting.primaryStudentId, ...uniq(others)];
}

export type MeetingInviteDelivery = InviteDelivery & {
  email: string;
  recipientKind: "student" | "guardian" | "counselor";
  template: string;
};

/** The newest attempt per address, from delivery rows ordered newest first (GET /meetings/:id/invites). */
export function latestInvitePerAddress(rows: Row[]): MeetingInviteDelivery[] {
  const seen = new Set<string>();
  const out: MeetingInviteDelivery[] = [];
  for (const r of rows) {
    const email = s(r.to_email)?.toLowerCase();
    if (!email || seen.has(email)) continue;
    const d = toInviteDelivery(r);
    if (!d) continue;
    seen.add(email);
    const kind = r.recipient_kind === "guardian" || r.recipient_kind === "counselor" ? r.recipient_kind : "student";
    out.push({ email, recipientKind: kind, template: String(r.template ?? ""), ...d });
  }
  return out;
}
