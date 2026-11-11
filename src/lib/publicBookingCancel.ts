/**
 * A counselor cancels a booking made through their public booking link (`public_bookings`, 20261121000001): the
 * rules and the write order, with the I/O injected (routes/booking.ts wires the real one; tests a fake).
 *
 *   1. The row is read on the caller's own client (owner-only RLS) and must name the caller: anything else is
 *      404 `booking_not_found`, so another counselor's id says nothing.
 *   2. A conditional `scheduled -> cancelled` (the column grant and `private.public_bookings_guard`, which stamps
 *      `cancelled_at`): a second cancel, or one racing it, is 409 `already_cancelled` and emails nobody. The slot
 *      is free from here on (slots, `book_public_slot` and `book_meeting_slot` count scheduled bookings only).
 *   3. The event on the counselor's own Google / Outlook calendar is deleted with the caller's own token (the
 *      caller is the owner; no one else's calendar is touched). Best effort, like a student's cancel:
 *      `calendarRemoved: false` when it failed (logged with ids only), true when nothing is left.
 *   4. After the answer (never fails the cancel): the booker is emailed a cancellation with an .ics CANCEL for the
 *      original invite (same UID `meeting-public-<id>@meridiesai.com`, SEQUENCE 1: the invite went out at 0), and a
 *      booking with a pipeline contact gets a `meeting` timeline entry "Cancelled <type> on <date>".
 *
 * The pointer (`calendar_provider` / `calendar_event_id`) is kept: a user session may write only `status`, and a
 * cancelled booking is never moved or re-created.
 */

import { brandedEmail, brandedText } from "./email.js";
import { HttpError } from "./errors.js";
import { buildMeetingIcs, meetingWhere, plainLine, type IcsMode } from "./ics.js";
import { whenLong, whenShort } from "./meetingInvites.js";
import type { SuiteProvider } from "./oauth.js";

type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const when = (iso: string, tz: string) => whenShort(iso, tz).replace(/[  ]/g, " ");

/** The original invite went out at SEQUENCE 0 (lib/publicBooking.ts publicBookingIcs); the cancel supersedes it. */
export const PUBLIC_CANCEL_SEQUENCE = 1;

export const bookingNotFound = () => new HttpError(404, "That booking doesn't exist", "booking_not_found");
export const alreadyCancelled = () => new HttpError(409, "That booking is already cancelled", "already_cancelled");

/** What the counselor's app reads about one of their public bookings. */
export type PublicBookingDto = {
  id: string;
  typeName: string;
  mode: string;
  name: string;
  email: string;
  phone: string | null;
  note: string | null;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "cancelled";
  joinUrl: string | null;
  calendarProvider: SuiteProvider | null;
  contactId: string | null;
  cancelledAt: string | null;
  createdAt: string;
};

export function toPublicBooking(r: Row): PublicBookingDto {
  const ns = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    id: str(r.id),
    typeName: str(r.type_name),
    mode: str(r.mode),
    name: str(r.name),
    email: str(r.email),
    phone: ns(r.phone),
    note: ns(r.note),
    startsAt: str(r.starts_at),
    endsAt: str(r.ends_at),
    status: r.status === "cancelled" ? "cancelled" : "scheduled",
    joinUrl: ns(r.join_url),
    calendarProvider: r.calendar_provider === "google" || r.calendar_provider === "microsoft" ? r.calendar_provider : null,
    contactId: ns(r.contact_id),
    cancelledAt: ns(r.cancelled_at),
    createdAt: str(r.created_at),
  };
}

/** The pipeline timeline entry: "Cancelled Check-in on Wed, Nov 11, 9:00 AM EST". */
export function cancelActivityText(typeName: string, startsAt: string, timeZone: string): string {
  return plainLine(`Cancelled ${typeName} on ${when(startsAt, timeZone)}`, 300);
}

/** The .ics CANCEL for the booker's invite: the original UID, SEQUENCE 1, the same organizer and attendee. */
export function publicBookingCancelIcs(
  b: Row,
  organizer: { name: string | null; email: string },
  attendee: { name: string | null; email: string },
  sentBy: string | null,
  now = new Date()
): string {
  return buildMeetingIcs({
    meetingId: `public-${str(b.id)}`,
    sequence: PUBLIC_CANCEL_SEQUENCE,
    method: "CANCEL",
    startsAt: str(b.starts_at),
    endsAt: str(b.ends_at),
    title: `${str(b.type_name)} with ${organizer.name ?? "your counselor"}`,
    agenda: null,
    mode: str(b.mode) as IcsMode,
    location: null,
    joinUrl: typeof b.join_url === "string" ? b.join_url : null,
    organizer,
    sentBy: sentBy && sentBy !== organizer.email ? sentBy : null,
    attendee,
    now,
  });
}

/** The booker's cancellation email: what was cancelled, when it was (the counselor's zone, named), how to rebook. */
export function bookerCancelEmail(b: Row, counselorName: string, timeZone: string): { subject: string; html: string; text: string } {
  const type = plainLine(str(b.type_name), 80) || "Meeting";
  const who = plainLine(counselorName, 120) || "your counselor";
  const body = {
    heading: `Cancelled: ${type} with ${who}`,
    paragraphs: [
      `Hi ${plainLine(str(b.name), 120).split(/\s+/)[0] || "there"}, ${who} cancelled your meeting.`,
      `It was: ${whenLong(str(b.starts_at), str(b.ends_at), timeZone)}`,
      `Where: ${meetingWhere({ mode: str(b.mode) as IcsMode, location: null, joinUrl: null })}`,
      `To find another time, reply to this email and ${who} will help.`,
    ],
    footnote: "The attached update removes it from your calendar.",
  };
  return {
    subject: plainLine(`Cancelled: ${type} with ${who} · ${whenShort(str(b.starts_at), timeZone)}`, 250),
    html: brandedEmail(body),
    text: brandedText(body),
  };
}

export type PublicCancelIo = {
  /** The row on the caller's own client, or null (not theirs, or no such row). */
  load(id: string): Promise<Row | null>;
  /** The conditional scheduled -> cancelled; the updated row, or null when it was no longer scheduled. */
  cancel(id: string): Promise<Row | null>;
  /** Delete the event on the caller's own calendar. Throws on failure. */
  removeEvent(provider: SuiteProvider, eventId: string): Promise<void>;
  /** Log a failed delete (ids only). */
  eventLeft(provider: SuiteProvider, eventId: string): void;
  /** The email and the timeline entry, after the answer; never throws. */
  afterCancel(booking: Row): void;
};

export type PublicCancelAnswer = { booking: PublicBookingDto; calendarRemoved: boolean };

export async function cancelPublicBooking(io: PublicCancelIo, i: { id: string; counselorId: string }): Promise<PublicCancelAnswer> {
  const row = await io.load(i.id);
  if (!row || row.counselor_id !== i.counselorId) throw bookingNotFound();
  if (row.status !== "scheduled") throw alreadyCancelled();
  const saved = await io.cancel(i.id);
  if (!saved) throw alreadyCancelled();

  let calendarRemoved = true;
  const provider = saved.calendar_provider;
  const eventId = typeof saved.calendar_event_id === "string" ? saved.calendar_event_id : "";
  if ((provider === "google" || provider === "microsoft") && eventId) {
    try {
      await io.removeEvent(provider, eventId);
    } catch {
      calendarRemoved = false;
      io.eventLeft(provider, eventId);
    }
  }
  io.afterCancel(saved);
  return { booking: toPublicBooking(saved), calendarRemoved };
}
