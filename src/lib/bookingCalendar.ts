/**
 * The one place a provider is called with someone else's token: a student
 * booking, moving or cancelling time with their counselor puts that change on
 * the COUNSELOR's connected Google / Outlook calendar.
 *
 * lib/meetingCalendar.ts keeps the rule for everything else ("a provider is
 * only ever called with the caller's own token, and only for a meeting the
 * caller owns"); this file breaks it on purpose, as narrowly as it can:
 *
 *  - the token owner is `expected.counselorId`, which the route takes from the
 *    signed-in student's own `profiles.counselor_id` (lib/booking.ts
 *    studentBookingContext, approved and with booking on), never from the
 *    client;
 *  - the meeting row must name that counselor (`counselor_id`) and that
 *    student as its primary attendee (`student_id`), read with the service
 *    role from the database, never from the request; any mismatch throws
 *    before a provider is called;
 *  - creating is only for a meeting the student just reserved
 *    (`booked_by_student`, no event yet); moving and removing only the event
 *    the meeting already points at (`calendar_provider`, `calendar_event_id`);
 *  - it goes through the same suiteApi calls as the counselor's own routes
 *    (token refresh, scope checks, `sendUpdates=none`, no attendees), so the
 *    provider emails nobody: invites are Meridies' own (lib/meetingInvites.ts).
 *
 * The public booking link (20261121000001, routes/publicBooking.ts) is the same
 * exception for someone with no account: a booking through the counselor's link
 * lands on the counselor's calendar. Narrower still: the token owner is the
 * counselor the link's slug resolved to on the server (approved, booking and
 * the link on), the `public_bookings` row must name that counselor, still be
 * scheduled and have no event yet, and the only other call removes the event a
 * booking just made, when saving it failed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors.js";
import { GOOGLE_SCOPE, MICROSOFT_SCOPE, type SuiteProvider } from "./oauth.js";
import {
  createConferenceEvent,
  createPlainCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  type CalendarEventInput,
} from "./suiteApi.js";

type Row = Record<string, unknown>;
type Log = Parameters<typeof createConferenceEvent>[3];

export type BookingParties = { counselorId: string; studentId: string };

export type BookingProviderDeps = {
  create: (ownerId: string, provider: SuiteProvider, input: CalendarEventInput, log: Log) => Promise<{ eventId: string; joinUrl: string }>;
  /** A plain event, for a mode with no conference (in person, phone). */
  createPlain: (ownerId: string, provider: SuiteProvider, input: CalendarEventInput, log: Log) => Promise<{ eventId: string }>;
  update: (ownerId: string, provider: SuiteProvider, eventId: string, change: Partial<CalendarEventInput>, log: Log) => Promise<void>;
  remove: (ownerId: string, provider: SuiteProvider, eventId: string, log: Log) => Promise<void>;
};

const realDeps: BookingProviderDeps = {
  create: createConferenceEvent,
  createPlain: createPlainCalendarEvent,
  update: updateCalendarEvent,
  remove: deleteCalendarEvent,
};

/** Which connected suite hosts a booking mode's conference, or null when the mode needs none. */
export function bookingConferenceProvider(mode: string): SuiteProvider | null {
  if (mode === "google-meet") return "google";
  if (mode === "teams") return "microsoft";
  return null;
}

function assertParties(meeting: Row, expected: BookingParties): void {
  const ok =
    expected.counselorId.length > 0 &&
    expected.studentId.length > 0 &&
    meeting.counselor_id === expected.counselorId &&
    meeting.student_id === expected.studentId;
  if (!ok) throw new Error("booking calendar: the meeting isn't this counselor's meeting with this student");
}

function pointer(meeting: Row): { provider: SuiteProvider; eventId: string } {
  const provider = meeting.calendar_provider;
  const eventId = meeting.calendar_event_id;
  if ((provider !== "google" && provider !== "microsoft") || typeof eventId !== "string" || eventId.length === 0) {
    throw new Error("booking calendar: the meeting has no calendar event");
  }
  return { provider, eventId };
}

/**
 * Whether the counselor has `provider` connected with Calendar allowed: a grant
 * row whose scopes include the calendar scope. Read with the service role.
 * An unreadable answer is "not connected" (the booking goes ahead without a
 * link and says so), never a guess that a write would work.
 */
export async function counselorCalendarConnected(svc: SupabaseClient, counselorId: string, provider: SuiteProvider): Promise<boolean> {
  const { data, error } = await svc
    .from("integration_tokens")
    .select("scopes")
    .eq("owner_id", counselorId)
    .eq("provider", provider)
    .maybeSingle();
  if (error || !data) return false;
  const want = (provider === "google" ? GOOGLE_SCOPE.calendarEvents : MICROSOFT_SCOPE.calendar).toLowerCase();
  const scopes = Array.isArray((data as Row).scopes) ? ((data as Row).scopes as unknown[]) : [];
  return scopes.some((s) => typeof s === "string" && (s.toLowerCase() === want || s.toLowerCase().endsWith(`/${want}`)));
}

/** A conference event on the counselor's calendar for a meeting the student just reserved. */
export async function createBookingProviderEvent(
  meeting: Row,
  expected: BookingParties,
  provider: SuiteProvider,
  input: CalendarEventInput,
  log: Log,
  deps: BookingProviderDeps = realDeps
): Promise<{ provider: SuiteProvider; eventId: string; joinUrl: string }> {
  assertParties(meeting, expected);
  if (meeting.booked_by_student !== true) throw new Error("booking calendar: only a meeting the student reserved");
  if (meeting.calendar_event_id) throw new Error("booking calendar: the meeting already has an event");
  const created = await deps.create(expected.counselorId, provider, input, log);
  return { provider, ...created };
}

/**
 * A plain event (no conference) on the counselor's calendar for an in-person or phone
 * meeting the student just reserved: the same checks as createBookingProviderEvent.
 */
export async function createBookingPlainEvent(
  meeting: Row,
  expected: BookingParties,
  provider: SuiteProvider,
  input: CalendarEventInput,
  log: Log,
  deps: BookingProviderDeps = realDeps
): Promise<{ provider: SuiteProvider; eventId: string }> {
  assertParties(meeting, expected);
  if (meeting.booked_by_student !== true) throw new Error("booking calendar: only a meeting the student reserved");
  if (meeting.calendar_event_id) throw new Error("booking calendar: the meeting already has an event");
  const created = await deps.createPlain(expected.counselorId, provider, input, log);
  return { provider, eventId: created.eventId };
}

/** Move the meeting's existing event on the counselor's calendar. */
export async function moveBookingProviderEvent(
  meeting: Row,
  expected: BookingParties,
  change: Partial<CalendarEventInput>,
  log: Log,
  deps: BookingProviderDeps = realDeps
): Promise<void> {
  assertParties(meeting, expected);
  const p = pointer(meeting);
  await deps.update(expected.counselorId, p.provider, p.eventId, change, log);
}

/** Delete the meeting's existing event from the counselor's calendar. */
export async function removeBookingProviderEvent(
  meeting: Row,
  expected: BookingParties,
  log: Log,
  deps: BookingProviderDeps = realDeps
): Promise<void> {
  assertParties(meeting, expected);
  const p = pointer(meeting);
  try {
    await deps.remove(expected.counselorId, p.provider, p.eventId, log);
  } catch (err) {
    // The event is left on the counselor's calendar: ids only, so it can be found and removed by hand.
    log.warn({
      meetingId: String(meeting.id),
      provider: p.provider,
      eventId: p.eventId,
      status: err instanceof HttpError ? err.statusCode : null,
      code: err instanceof HttpError ? (err.code ?? null) : null,
    }, "booking: calendar event not deleted; cancelled in Meridies only");
    throw err;
  }
}

// ---- the public booking link ----------------------------------------------------------------------

/**
 * An event on the counselor's calendar for a booking just made through their public link: a conference event
 * (Meet / Teams) or a plain one (in person, phone). `counselorId` is the counselor the slug resolved to on the
 * server; the row must name them, be scheduled and have no event yet.
 */
export async function createPublicBookingEvent(
  booking: Row,
  counselorId: string,
  provider: SuiteProvider,
  input: CalendarEventInput,
  conference: boolean,
  log: Log,
  deps: BookingProviderDeps = realDeps
): Promise<{ provider: SuiteProvider; eventId: string; joinUrl: string | null }> {
  if (counselorId.length === 0 || booking.counselor_id !== counselorId) {
    throw new Error("booking calendar: the public booking isn't this counselor's");
  }
  if (booking.status !== "scheduled") throw new Error("booking calendar: the public booking isn't scheduled");
  if (booking.calendar_event_id) throw new Error("booking calendar: the public booking already has an event");
  if (conference) {
    const created = await deps.create(counselorId, provider, input, log);
    return { provider, eventId: created.eventId, joinUrl: created.joinUrl };
  }
  const created = await deps.createPlain(counselorId, provider, input, log);
  return { provider, eventId: created.eventId, joinUrl: null };
}

/** Remove the event a public booking just made, when saving the booking failed. Throws on failure. */
export async function removePublicBookingEvent(
  booking: Row,
  counselorId: string,
  event: { provider: SuiteProvider; eventId: string },
  log: Log,
  deps: BookingProviderDeps = realDeps
): Promise<void> {
  if (counselorId.length === 0 || booking.counselor_id !== counselorId) {
    throw new Error("booking calendar: the public booking isn't this counselor's");
  }
  await deps.remove(counselorId, event.provider, event.eventId, log);
}
