/**
 * A restored meeting comes back quietly (Elvin, 11/26; was "sends its invitation again", 11/8).
 *
 * meetings.delete took the event off the counselor's connected calendar and emailed the invitees a cancellation. The
 * AxIS card's Restore (`POST /axis/actions/:id/undo`) puts the meeting back in Meridies and on the counselor's own
 * calendar, and emails nobody: no new invitation, no update. After `axis_trash_restore` succeeds, the route calls
 * `resyncRestoredMeetings`:
 *
 *   1. `axis_trash_restored_meetings` lists the meetings that restore brought back (from the trash rows, so a
 *      cascade would count too), each with the calendar it was on (it also raises the invite sequence above the
 *      delete's cancellation, so a later edit's update still outranks it).
 *   2. A meeting still ahead that was on its owner's Google or Microsoft calendar (or a Zoom meeting) goes back there the way a new
 *      meeting does (`createConferenceEvent`, owner only, with the caller's own token), with its new link. That call
 *      adds no attendees and sends no mail: Google with `sendUpdates=none`, Microsoft and Zoom with no attendees
 *      (nobody to notify). If it fails, the old link (which died with the deleted event) is cleared.
 *   3. Nothing is emailed. The counselor can send the invitation again from the meeting if they want families told.
 *
 * It is the counselor's own click on their card, never AxIS's (AxIS can't call the undo route). Never throws: the rows
 * are already back, so a failure here costs only the calendar event.
 */

import type { FastifyRequest } from "fastify";
import { isSchemaMissing } from "./axis/failsafe.js";
import type { ConnectProvider } from "./oauth.js";
import { createConferenceEvent, deleteCalendarEvent } from "./suiteApi.js";

type Row = Record<string, unknown>;

/** A meeting a restore brought back, and the calendar it was on before the delete (null: none). */
export type RestoredMeeting = { id: string; calendarProvider: ConnectProvider | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set<ConnectProvider>(["google", "microsoft", "zoom"]);

/** The function's answer, re-validated: a list of `{ id, calendarProvider }`, anything else dropped. */
export function restoredMeetingsFrom(raw: unknown): RestoredMeeting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = (item ?? {}) as Row;
    if (typeof r.id !== "string" || !UUID.test(r.id)) return [];
    const p = r.calendarProvider;
    return [{ id: r.id, calendarProvider: typeof p === "string" && PROVIDERS.has(p as ConnectProvider) ? (p as ConnectProvider) : null }];
  });
}

/**
 * Whether a restored meeting goes back on the calendar it was on: only the caller's own meeting (the event lives on
 * its owner's calendar, reached with the caller's own token, as everywhere else), still scheduled and ahead, with an
 * end time, and not already holding an event.
 */
export function calendarPlan(
  meeting: Row,
  wasOn: ConnectProvider | null,
  callerId: string,
  now: Date
): { put: true; provider: ConnectProvider } | { put: false; reason: string } {
  if (!wasOn) return { put: false, reason: "it wasn't on a connected calendar" };
  if (typeof meeting.counselor_id !== "string" || meeting.counselor_id !== callerId || !callerId) {
    return { put: false, reason: "the meeting's event is on its owner's calendar, not the caller's" };
  }
  if (meeting.status !== "scheduled") return { put: false, reason: "the meeting isn't scheduled" };
  if (typeof meeting.ends_at !== "string" || !meeting.ends_at) return { put: false, reason: "the meeting has no end time" };
  if (!(Date.parse(meeting.ends_at) > now.getTime())) return { put: false, reason: "the meeting is over" };
  if (meeting.calendar_event_id) return { put: false, reason: "the meeting already has a calendar event" };
  return { put: true, provider: wasOn };
}

type Deps = {
  createEvent: typeof createConferenceEvent;
  dropEvent: typeof deleteCalendarEvent;
  now: () => Date;
};
const DEFAULT_DEPS: Deps = {
  createEvent: createConferenceEvent,
  dropEvent: deleteCalendarEvent,
  now: () => new Date(),
};

/**
 * Puts the meetings an AxIS restore brought back on the counselor's calendar again, quietly: no invitation or update
 * is emailed. Resolves how many calendar events were made.
 */
export async function resyncRestoredMeetings(
  request: Pick<FastifyRequest, "db" | "log" | "auth">,
  actionId: string,
  deps: Deps = DEFAULT_DEPS
): Promise<{ calendars: number }> {
  const log = request.log;
  try {
    const { data, error } = await request.db.rpc("axis_trash_restored_meetings", { p_action: actionId });
    if (error) {
      // Before 20261113000001 the meeting comes back without its calendar event.
      if (!isSchemaMissing(error)) log.warn({ code: error.code }, "restored meetings not read; not put back on the calendar");
      return { calendars: 0 };
    }
    const meetings = restoredMeetingsFrom(data);
    if (meetings.length === 0) return { calendars: 0 };
    const callerId = request.auth.userId;
    let calendars = 0;

    for (const m of meetings) {
      const { data: found, error: readErr } = await request.db.from("meetings").select("*").eq("id", m.id).maybeSingle();
      if (readErr || !found) continue;
      let row = found as Row;

      const plan = calendarPlan(row, m.calendarProvider, callerId, deps.now());
      if (plan.put) {
        try {
          const created = await deps.createEvent(
            callerId,
            plan.provider,
            {
              title: String(row.title ?? ""),
              startsAt: String(row.starts_at),
              endsAt: String(row.ends_at),
              description: typeof row.agenda === "string" ? row.agenda : null,
            },
            log
          );
          const { data: saved, error: saveErr } = await request.db
            .from("meetings")
            .update({ calendar_provider: plan.provider, calendar_event_id: created.eventId, join_url: created.joinUrl })
            .eq("id", m.id)
            .select("*")
            .single();
          if (saveErr || !saved) {
            // Don't leave an event on their calendar that the meeting doesn't point at.
            await deps.dropEvent(callerId, plan.provider, created.eventId, log).catch(() => undefined);
            log.warn({ code: saveErr?.code }, "restored meeting's calendar event not saved; removed it again");
          } else {
            row = saved as Row;
            calendars++;
          }
        } catch (err) {
          log.warn(
            { provider: plan.provider, err: err instanceof Error ? err.message : "unknown" },
            "restored meeting not put back on the calendar"
          );
        }
        // Still no event: the delete took the owner's event off the calendar, and its Meet/Teams link with it. The
        // app shows no link rather than a dead one; the counselor can add a new one. (A
        // collaborator's delete never touched the owner's calendar, so their restore keeps the link: no plan.put.)
        if (!row.calendar_event_id && row.join_url) {
          const { data: cleared, error: clearErr } = await request.db
            .from("meetings")
            .update({ join_url: null })
            .eq("id", m.id)
            .select("*")
            .single();
          if (clearErr || !cleared) log.warn({ code: clearErr?.code }, "restored meeting's old link not cleared");
        }
      }

      // No invitation, update or notification is sent: a restore is quiet (Elvin, 11/26).
    }
    return { calendars };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : "unknown" }, "restored meetings not put back on the calendar");
    return { calendars: 0 };
  }
}
