/**
 * iCalendar (RFC 5545) files for the meeting invites Meridies emails
 * (lib/meetingInvites.ts). Pure: no I/O, no clock unless none is passed.
 *
 * One file per recipient, and the only ATTENDEE in it is that recipient, so
 * one family's address never travels in another family's invite. The UID is
 * the meeting's and never changes, so every calendar that added the meeting
 * treats a later REQUEST as an update of it and a CANCEL as its removal; the
 * SEQUENCE comes from the database (`meetings.ics_sequence`, raised by a
 * trigger on every material change), so it only ever grows.
 *
 * Every value a person typed (title, agenda, location, names) is escaped as
 * TEXT or quoted as a parameter here, with line breaks turned into the `\n`
 * escape and other control characters dropped, so nothing typed can start a
 * property line of its own. Times are written in UTC. Lines are folded at 75
 * octets of UTF-8 without splitting a character.
 */

import { z } from "zod";

export type IcsMethod = "REQUEST" | "CANCEL" | "PUBLISH";
export type IcsPerson = { name: string | null; email: string };
export type IcsMode = "google-meet" | "teams" | "in-person" | "phone";

export type IcsEventInput = {
  meetingId: string;
  sequence: number;
  method: IcsMethod;
  /** ISO times; written in UTC. */
  startsAt: string;
  endsAt: string;
  title: string;
  agenda: string | null;
  mode: IcsMode;
  location: string | null;
  joinUrl: string | null;
  organizer: IcsPerson;
  /** The address the email actually comes from, when it isn't the organizer's. */
  sentBy: string | null;
  /** The one recipient this file is for; null for a PUBLISH copy. */
  attendee: IcsPerson | null;
  now?: Date;
};

const CRLF = "\r\n";
const UID_DOMAIN = "meridiesai.com";
const emailSchema = z.string().trim().email().max(320);

/** The same for the life of the meeting, whatever changes. */
export function meetingUid(meetingId: string): string {
  return `meeting-${meetingId}@${UID_DOMAIN}`;
}

/** 20261020T190000Z. Throws on a time that doesn't parse. */
export function icsDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error("Not a valid time");
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Control characters other than the line breaks TEXT turns into `\n`. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;

/** A TEXT value (RFC 5545 3.3.11): backslash, semicolon and comma escaped, line breaks as `\n`. */
export function escapeText(v: string): string {
  return v
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(CONTROLS, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** A parameter value, always quoted: a quoted-string may hold anything but DQUOTE and controls. */
export function paramValue(v: string): string {
  const clean = v.replace(/[\r\n]+/g, " ").replace(CONTROLS, "").replace(/"/g, "").trim();
  return `"${clean}"`;
}

/** One header-safe line: control characters out, whitespace runs collapsed. For an email subject. */
export function plainLine(v: string, max = 200): string {
  const s = v.replace(/[\r\n\t]+/g, " ").replace(CONTROLS, "").replace(/\s{2,}/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A valid email, lowercased, or a throw: the caller skips that recipient. */
export function mailto(email: string): string {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) throw new Error("Not a valid email address");
  return `mailto:${parsed.data.toLowerCase()}`;
}

/** An http(s) link fit for a URI value, or null. */
export function safeUrl(v: string | null): string | null {
  if (!v) return null;
  const s = v.replace(CONTROLS, "").replace(/[\r\n\s]/g, "");
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Fold a content line at 75 octets (RFC 5545 3.1): CRLF and one space, each
 * continuation's space counting toward its 75. Splits only between code
 * points, so a multi-byte character is never cut in two.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let budget = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > budget) {
      out.push(current);
      current = "";
      bytes = 0;
      budget = 74; // the leading space takes one octet
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

const MODE_LABEL: Record<IcsMode, string> = {
  "google-meet": "Google Meet",
  teams: "Microsoft Teams",
  "in-person": "In person",
  phone: "Phone call",
};

/**
 * Where the meeting is, as the invite's LOCATION: for a Meet or Teams
 * meeting its link, else what the counselor typed, else the mode's name, so
 * an invite never says nothing about where to be.
 */
export function meetingWhere(e: Pick<IcsEventInput, "mode" | "location" | "joinUrl">): string {
  const link = safeUrl(e.joinUrl);
  const typed = e.location?.trim() || null;
  if (e.mode === "google-meet" || e.mode === "teams") return link ?? typed ?? MODE_LABEL[e.mode];
  return typed ?? MODE_LABEL[e.mode];
}

export function modeLabel(mode: IcsMode): string {
  return MODE_LABEL[mode];
}

/** The whole file: CRLF line ends, folded, ending in CRLF. */
export function buildMeetingIcs(e: IcsEventInput): string {
  if (!Number.isInteger(e.sequence) || e.sequence < 0) throw new Error("SEQUENCE must be a whole number");
  const start = icsDate(e.startsAt);
  const end = icsDate(e.endsAt);
  if (Date.parse(e.endsAt) <= Date.parse(e.startsAt)) throw new Error("A meeting must end after it starts");
  if (e.method !== "PUBLISH" && !e.attendee) throw new Error("An invite or a cancellation names its attendee");

  const link = safeUrl(e.joinUrl);
  const description = [e.agenda?.trim() || null, link ? `Join: ${link}` : null].filter(Boolean).join("\n\n");

  const organizerParams = [
    e.organizer.name?.trim() ? `CN=${paramValue(e.organizer.name)}` : null,
    e.sentBy ? `SENT-BY=${paramValue(mailto(e.sentBy))}` : null,
  ].filter(Boolean);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Meridies//Meetings//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${meetingUid(e.meetingId)}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${icsDate((e.now ?? new Date()).toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeText(plainLine(e.title, 300))}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    `LOCATION:${escapeText(meetingWhere(e))}`,
    ...(link ? [`URL:${link}`] : []),
    `ORGANIZER${organizerParams.length ? `;${organizerParams.join(";")}` : ""}:${mailto(e.organizer.email)}`,
  ];
  if (e.attendee && e.method !== "PUBLISH") {
    const cn = e.attendee.name?.trim() ? `;CN=${paramValue(e.attendee.name)}` : "";
    lines.push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE${cn}:${mailto(e.attendee.email)}`
    );
  }
  lines.push(
    `STATUS:${e.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR"
  );
  return lines.map(foldLine).join(CRLF) + CRLF;
}
