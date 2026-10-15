/**
 * Whose calendar a meeting's event is on, and whether this caller may act on it.
 *
 * A meeting booked with a Meet / Teams link remembers the event it created
 * (`calendar_provider`, `calendar_event_id`) on its owner's Google or Outlook
 * calendar (`counselor_id`). The routes act on that event with stored OAuth
 * tokens, so the one rule is: a provider is only ever called with the
 * caller's own token, and only for a meeting the caller owns. A write
 * collaborator editing someone else's meeting changes it in Meridies only,
 * and the owner's event is left as it is (logged, never called with the
 * owner's token). The database says the same since
 * `20261024000011_meeting_calendar_owner_guard.sql`: only the owner sets or
 * changes the pointer, and nobody changes the owner from a user session. The
 * code doesn't depend on it: a row forged before that migration, or on a
 * database without it, still can't make the API call another counselor's
 * calendar.
 */

import type { SuiteProvider } from "./oauth.js";

type Row = Record<string, unknown>;

export type CalendarAccess =
  /** No event behind this meeting. */
  | { kind: "none" }
  /** The caller owns the meeting: act on the event with the caller's token. */
  | { kind: "owner"; ownerId: string; provider: SuiteProvider; eventId: string }
  /** Someone else's event: never call it. */
  | { kind: "not-owner"; provider: SuiteProvider };

const PROVIDERS: ReadonlySet<string> = new Set(["google", "microsoft"]);

function pointer(meeting: Row): { provider: SuiteProvider; eventId: string } | null {
  const provider = meeting.calendar_provider;
  const eventId = meeting.calendar_event_id;
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) return null;
  if (typeof eventId !== "string" || eventId.length === 0) return null;
  return { provider: provider as SuiteProvider, eventId };
}

/** Whether the caller owns the meeting (`counselor_id`), compared as stored. */
export function ownsMeeting(meeting: Row, callerId: string): boolean {
  return typeof meeting.counselor_id === "string" && callerId.length > 0 && meeting.counselor_id === callerId;
}

/**
 * What the caller may do with the event behind `meeting`. The token owner on
 * an `owner` answer is the caller's own id, never the stored `counselor_id`
 * read on its own.
 */
export function calendarAccess(meeting: Row, callerId: string): CalendarAccess {
  const p = pointer(meeting);
  if (!p) return { kind: "none" };
  if (!ownsMeeting(meeting, callerId)) return { kind: "not-owner", provider: p.provider };
  return { kind: "owner", ownerId: callerId, ...p };
}

/** The log line for a calendar sync skipped because the meeting is someone else's. */
export const NOT_OWNER_SKIP =
  "calendar sync skipped: the meeting's event is on its owner's calendar, not the caller's; changed in Meridies only";

/** Refusal for `createConference` on a meeting the caller doesn't own. */
export const NOT_OWNER_CONFERENCE =
  "Only the counselor who owns this meeting can put it on their calendar";
