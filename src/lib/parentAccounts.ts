/**
 * Parent accounts (migration 20261123000002): the pure half. Tokens, the words of the invitation, and the Parent
 * view's shape. No I/O here; lib/parentInvites.ts and routes/parent.ts do the reads and sends.
 *
 * What a parent may see is decided in the database (`parent_student_view`, live link + the counselor's switches);
 * `toParentView` only renames what it returned and works out "overdue" in the student's time zone. It never adds a
 * section the database left out.
 */

import { createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";
import { deliveryReason, type InviteDelivery } from "./inviteDelivery.js";

type Row = Record<string, unknown>;

/** How long an invitation link works (the migration's default; said here for the email). */
export const INVITE_DAYS = 30;
export const PARENT_INVITE_TEMPLATE = "parent-invite";
export const PARENT_MESSAGE_MAX = 4000;
export const PASSWORD_MIN = 8;

/** 32 random bytes, URL-safe: the secret in the emailed link. Only its hash is stored. */
export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A token as it arrives from a client: the shape newInviteToken makes, nothing else. */
export function isInviteToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);
}

export function parentJoinUrl(token: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/join-parent/${token}`;
}

export function parentLoginUrl(): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/login?as=parent`;
}

const firstWord = (name: string | null | undefined): string => (name ?? "").trim().split(/\s+/)[0] ?? "";
/** A name as it goes into an email: one line, no more than 80 characters. */
export const oneLine = (s: string | null | undefined, max = 80): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** What the Parent view offers, in the parent's words. One place, so both emails say the same. */
export function whatParentsSee(studentFirst: string, counselor: string | null): string {
  return counselor
    ? `With a parent account you can see ${studentFirst}'s tasks, college list and deadlines, essay progress and upcoming meetings, as ${counselor} shares them, and send ${counselor} a message. It's read-only: nothing you do there changes ${studentFirst}'s work.`
    : `With a parent account you can follow ${studentFirst}'s tasks, college list and essay progress once ${studentFirst}'s counselor is on Meridies. It's read-only: nothing you do there changes ${studentFirst}'s work.`;
}

export type InviteEmailCopy = {
  studentName: string;
  parentName: string;
  counselorName: string | null;
  /** "join": a new account, with the tokenized link. "signin": the address already has a parent account. */
  kind: "join" | "signin";
  url: string;
};

/** The counselor's "Invite to Meridies" (and Resend). Pure. */
export function parentInviteEmail(c: InviteEmailCopy) {
  const student = oneLine(c.studentName) || "Your child";
  const first = firstWord(student) || student;
  const parentFirst = firstWord(oneLine(c.parentName));
  const counselor = oneLine(c.counselorName) || null;
  const who = counselor ?? `${first}'s counselor`;
  return {
    subject:
      c.kind === "join"
        ? `${who} invited you to follow ${first}'s college applications on Meridies`
        : `${first} is on your Meridies parent view`,
    heading: c.kind === "join" ? `Follow ${first}'s applications on Meridies` : `${first} is on your parent view`,
    paragraphs: [
      parentFirst ? `Dear ${parentFirst},` : "Hello,",
      c.kind === "join"
        ? `${who} invited you to create a parent account on Meridies, where ${first} and ${counselor ? "they" : "their counselor"} keep track of college applications.`
        : `${who} added ${first} to your Meridies parent account. Sign in to see where things stand.`,
      whatParentsSee(first, counselor),
      c.kind === "join" ? `The link works for ${INVITE_DAYS} days and only once.` : "",
    ],
    cta: { label: c.kind === "join" ? "Create your parent account" : "Open your parent view", url: c.url },
    footnote: counselor
      ? `Reply to this email to reach ${counselor}. If you weren't expecting it, reply and let them know.`
      : "If you weren't expecting this email, you can ignore it.",
  };
}

// ---- the counselor's chip ---------------------------------------------------------------------------------------

export type ParentAccountState = "none" | "invited" | "expired" | "joined" | "off";

export type ParentAccount = {
  /**
   * none: never invited (or every invitation was replaced); invited: a link is out and still good; expired: the last
   * link ran out; joined: the address has a parent account; off: this parent row doesn't give a view (the counselor
   * switched off a parent they added), so there is nothing to invite them to.
   */
  state: ParentAccountState;
  invitedAt: string | null;
  expiresAt: string | null;
  delivery: InviteDelivery | null;
};

const DELIVERY_STATES = new Set(["queued", "sent", "delivered", "bounced", "failed", "cancelled"]);

/** One row of `parent_invite_status` as the chip reads it. Pure. */
export function toParentAccount(r: Row, now = Date.now()): ParentAccount {
  const invitedAt = (r.invited_at as string | null) ?? null;
  const expiresAt = (r.expires_at as string | null) ?? null;
  const status = typeof r.delivery_status === "string" && DELIVERY_STATES.has(r.delivery_status) ? r.delivery_status : null;
  const delivery: InviteDelivery | null = status
    ? {
        status: status as InviteDelivery["status"],
        channel: r.delivery_channel === "sms" ? "sms" : "email",
        at: String(r.delivery_at ?? invitedAt ?? ""),
        deliveredAt: (r.delivered_at as string | null) ?? null,
        reason: deliveryReason(status as InviteDelivery["status"], r.delivery_error),
      }
    : null;
  let state: ParentAccountState;
  if (r.has_account === true) state = "joined";
  else if (r.grants_view !== true) state = "off";
  else if (!invitedAt || r.used_at) state = "none";
  else if (expiresAt && Date.parse(expiresAt) < now) state = "expired";
  else state = "invited";
  return { state, invitedAt, expiresAt, delivery: state === "joined" || state === "off" ? null : delivery };
}

// ---- the Parent view --------------------------------------------------------------------------------------------

export type ParentTask = { id: string; title: string; status: string; dueDate: string | null; overdue: boolean };
export type ParentCollege = {
  id: string;
  name: string;
  round: string | null;
  status: string;
  deadline: string | null;
  decisionDate: string | null;
  binding: boolean;
};
export type ParentEssay = {
  id: string;
  /** "Personal statement" or "Supplement": the kind, never the essay's title. */
  label: string;
  school: string | null;
  status: string;
  words: number | null;
  wordLimit: number | null;
  dueDate: string | null;
};
export type ParentMeeting = {
  id: string;
  startsAt: string;
  endsAt: string | null;
  mode: string | null;
  parentsInvited: boolean;
  title: string | null;
  location: string | null;
  joinUrl: string | null;
};

export type ParentView = {
  student: { id: string; name: string; firstName: string; classYear: string | null };
  counselor: { name: string } | null;
  /** False while the student has no approved counselor: then no section is shown at all. */
  counselorReady: boolean;
  canMessage: boolean;
  /** Each present only while the counselor's switch for it is on. */
  sections: {
    tasks?: { open: ParentTask[]; overdue: number; recentlyDone: { id: string; title: string; completedAt: string | null }[] };
    colleges?: ParentCollege[];
    essays?: ParentEssay[];
    meetings?: ParentMeeting[];
  };
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Today's date (YYYY-MM-DD) in a time zone; New York when the zone is missing or not one Intl knows. */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return fmt(timezone?.trim() || "America/New_York");
  } catch {
    return fmt("America/New_York");
  }
}

const essayLabel = (kind: unknown) => (kind === "personal-statement" ? "Personal statement" : kind === "supplement" ? "Supplement" : "Essay");

/** `parent_student_view`'s answer as the app reads it. Pure; a section the database left out stays out. */
export function toParentView(raw: unknown, now = new Date()): ParentView {
  const r = (raw ?? {}) as Row;
  const s = (r.student ?? {}) as Row;
  const c = (r.counselor ?? null) as Row | null;
  const sec = (r.sections ?? {}) as Row;
  const name = oneLine(str(s.fullName) ?? "", 120) || "Your student";
  const today = todayIn(str(s.timezone), now);
  const out: ParentView = {
    student: { id: String(s.id ?? ""), name, firstName: firstWord(name) || name, classYear: str(s.gradYear) },
    counselor: c && str(c.name) ? { name: oneLine(String(c.name), 120) } : null,
    counselorReady: r.counselorReady === true,
    canMessage: r.canMessage === true,
    sections: {},
  };
  if (Array.isArray(sec.tasks)) {
    const rows = sec.tasks as Row[];
    const open = rows
      .filter((t) => t.status !== "complete")
      .map((t) => {
        const due = str(t.dueDate);
        return { id: String(t.id), title: oneLine(String(t.title ?? ""), 300), status: String(t.status ?? "not-started"), dueDate: due, overdue: Boolean(due && due < today) };
      });
    out.sections.tasks = {
      open,
      overdue: open.filter((t) => t.overdue).length,
      recentlyDone: rows
        .filter((t) => t.status === "complete")
        .map((t) => ({ id: String(t.id), title: oneLine(String(t.title ?? ""), 300), completedAt: str(t.completedAt) })),
    };
  }
  if (Array.isArray(sec.colleges)) {
    out.sections.colleges = (sec.colleges as Row[]).map((x) => ({
      id: String(x.id),
      name: oneLine(String(x.name ?? ""), 200),
      round: str(x.round),
      status: String(x.status ?? "not-started"),
      deadline: str(x.deadline),
      decisionDate: str(x.decisionDate),
      binding: x.binding === true,
    }));
  }
  if (Array.isArray(sec.essays)) {
    out.sections.essays = (sec.essays as Row[]).map((e) => ({
      id: String(e.id),
      label: essayLabel(e.kind),
      school: str(e.school) ? oneLine(String(e.school), 200) : null,
      status: String(e.status ?? "not-started"),
      words: num(e.words),
      wordLimit: num(e.wordLimit),
      dueDate: str(e.dueDate),
    }));
  }
  if (Array.isArray(sec.meetings)) {
    out.sections.meetings = (sec.meetings as Row[]).map((m) => ({
      id: String(m.id),
      startsAt: String(m.startsAt),
      endsAt: str(m.endsAt),
      mode: str(m.mode),
      parentsInvited: m.parentsInvited === true,
      title: str(m.title) ? oneLine(String(m.title), 200) : null,
      location: str(m.location) ? oneLine(String(m.location), 300) : null,
      joinUrl: str(m.joinUrl) && /^https:\/\//i.test(String(m.joinUrl)) ? String(m.joinUrl) : null,
    }));
  }
  return out;
}

export type ParentChild = {
  id: string;
  name: string;
  firstName: string;
  classYear: string | null;
  counselorName: string | null;
  counselorReady: boolean;
  canMessage: boolean;
};

export function toParentChild(r: Row): ParentChild {
  const name = oneLine(str(r.full_name) ?? "", 120) || "Your student";
  return {
    id: String(r.student_id),
    name,
    firstName: firstWord(name) || name,
    classYear: str(r.grad_year),
    counselorName: str(r.counselor_name) ? oneLine(String(r.counselor_name), 120) : null,
    counselorReady: r.counselor_ready === true,
    canMessage: r.can_message === true,
  };
}

// ---- the database's refusals --------------------------------------------------------------------------------------

/** "Not switched on yet": the function, the table or the column isn't there (migration 20261123000002). */
export function parentSchemaMissing(e: { code?: string } | null | undefined): boolean {
  return ["PGRST202", "42883", "PGRST205", "42P01", "42703", "PGRST204"].includes(e?.code ?? "");
}

/** The machine reason a function raised (its HINT), when it gave one. */
export function hintOf(e: { hint?: string | null } | null | undefined): string | null {
  const h = (e?.hint ?? "").trim();
  return /^[a-z_]{2,40}$/.test(h) ? h : null;
}
