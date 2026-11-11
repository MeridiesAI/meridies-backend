/**
 * The link to a calendar event Meridies made on a counselor's connected calendar, for the app's
 * "Open in Google Calendar". Nothing new is stored (no migration): the link is computed from what is.
 *
 * Google: an event's `htmlLink` is `https://www.google.com/calendar/event?eid=<eid>`, where `eid` is the
 * unpadded base64 of `<eventId> <calendarId>`. Every event the API makes is on `calendars/primary`
 * (lib/suiteApi.ts), and a primary calendar's id is its account's email address, which the grant row keeps
 * (`integration_tokens.account_email`, from the id_token's `email` claim; connecting another account is refused
 * until Google is disconnected). "primary" itself is an alias that means nothing inside an eid, so with no stored
 * email there is no link and the app keeps linking to the day.
 *
 * Outlook: an event's `webLink` isn't stored and can't be computed from its id, so there is no link.
 *
 * The eid carries the calendar's email address (base64 is not secrecy), so a link is only ever given to the
 * calendar's owner: `meetingHtmlLink` takes the caller and answers null on anyone else's meeting (a student's
 * copy is their own emailed invite, not this event).
 */

type Row = Record<string, unknown>;

const GOOGLE_EVENT_BASE = "https://www.google.com/calendar/event?eid=";

/** Google's event page for an event on a calendar, or null when either id can't make one. */
export function googleEventHtmlLink(eventId: string | null | undefined, calendarId: string | null | undefined): string | null {
  const event = typeof eventId === "string" ? eventId.trim() : "";
  const calendar = typeof calendarId === "string" ? calendarId.trim() : "";
  if (!event || !calendar || event.length > 1024 || calendar.length > 320) return null;
  if (/\s/.test(event) || /\s/.test(calendar)) return null;
  // An alias ("primary") or anything else that isn't a calendar's address can't be resolved by Google.
  if (!/^[^@]+@[^@]+$/.test(calendar)) return null;
  const eid = Buffer.from(`${event} ${calendar}`, "utf8").toString("base64url");
  return `${GOOGLE_EVENT_BASE}${eid}`;
}

/**
 * The event link for a stored meeting (or public booking) row, for `viewerId`. Only the row's owner
 * (`counselor_id`) gets one, only for a Google event, with that owner's connected Google address.
 */
export function meetingHtmlLink(row: Row, viewerId: string, googleAccountEmail: string | null): string | null {
  if (row.calendar_provider !== "google") return null;
  if (typeof row.counselor_id !== "string" || row.counselor_id !== viewerId) return null;
  return googleEventHtmlLink(row.calendar_event_id as string | null, googleAccountEmail);
}

/** Whether any of the rows would need the owner's Google address (saves the read when none does). */
export function needsGoogleAddress(rows: Row[], viewerId: string): boolean {
  return rows.some((r) => r.calendar_provider === "google" && r.counselor_id === viewerId && Boolean(r.calendar_event_id));
}
