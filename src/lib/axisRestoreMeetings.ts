/**
 * A restored meeting sends its invitation again (Elvin, 11/8; migration 20261113000001).
 *
 * meetings.delete took the event off the counselor's connected calendar and emailed the invitees a cancellation, so
 * a meeting the AxIS card's Restore (`POST /axis/actions/:id/undo`) puts back would otherwise be in Meridies while the
 * families think it's off. After `axis_trash_restore` succeeds, the route calls `reinviteRestoredMeetings`:
 *
 *   1. `axis_trash_restored_meetings` lists the meetings that restore brought back (from the trash rows, so a
 *      cascade would count too), each with the calendar it was on, and raises its invite sequence above the
 *      cancellation the delete sent (the meetings_ics_sequence trigger won't let a client do that).
 *   2. A meeting still ahead that was on its owner's Google or Microsoft calendar goes back there the way a new
 *      meeting does (`createConferenceEvent`, owner only, with the caller's own token), with its new link. If that
 *      fails, the old link (which died with the deleted event) is cleared, so the invitation carries none.
 *   3. It gets the round a new meeting gets (`prepareInviteRound` with no "before"): invites on, scheduled, not
 *      over, and the same fail-closed rules decide who is emailed. A past meeting sends nothing.
 *
 * It is the counselor's own click on their card, never AxIS's (AxIS can't call the undo route). Every other restore
 * still sends nothing. Never throws: the rows are already back, so a failure here costs only the invitation.
 */

import type { FastifyRequest } from "fastify";
import { isSchemaMissing } from "./axis/failsafe.js";
import { invitesReady, loadAttendeeIds, meetingState, prepareInviteRound, startInviteDelivery } from "./meetingInvites.js";
import type { SuiteProvider } from "./oauth.js";
import { createConferenceEvent, deleteCalendarEvent } from "./suiteApi.js";

type Row = Record<string, unknown>;

/** A meeting a restore brought back, and the calendar it was on before the delete (null: none). */
export type RestoredMeeting = { id: string; calendarProvider: SuiteProvider | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set<SuiteProvider>(["google", "microsoft"]);

/** The function's answer, re-validated: a list of `{ id, calendarProvider }`, anything else dropped. */
export function restoredMeetingsFrom(raw: unknown): RestoredMeeting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = (item ?? {}) as Row;
    if (typeof r.id !== "string" || !UUID.test(r.id)) return [];
    const p = r.calendarProvider;
    return [{ id: r.id, calendarProvider: typeof p === "string" && PROVIDERS.has(p as SuiteProvider) ? (p as SuiteProvider) : null }];
  });
}

/**
 * Whether a restored meeting goes back on the calendar it was on: only the caller's own meeting (the event lives on
 * its owner's calendar, reached with the caller's own token, as everywhere else), still scheduled and ahead, with an
 * end time, and not already holding an event.
 */
export function calendarPlan(
  meeting: Row,
  wasOn: SuiteProvider | null,
  callerId: string,
  now: Date
): { put: true; provider: SuiteProvider } | { put: false; reason: string } {
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
  prepare: typeof prepareInviteRound;
  start: typeof startInviteDelivery;
  now: () => Date;
};
const DEFAULT_DEPS: Deps = {
  createEvent: createConferenceEvent,
  dropEvent: deleteCalendarEvent,
  prepare: prepareInviteRound,
  start: startInviteDelivery,
  now: () => new Date(),
};

/**
 * Puts the meetings an AxIS restore brought back on the calendar again and sends their invitations. Resolves
 * `invited: true` when at least one invite round went out (the card then says "The invitation went out again").
 */
export async function reinviteRestoredMeetings(
  request: Pick<FastifyRequest, "db" | "log" | "auth">,
  actionId: string,
  deps: Deps = DEFAULT_DEPS
): Promise<{ invited: boolean }> {
  const log = request.log;
  try {
    const { data, error } = await request.db.rpc("axis_trash_restored_meetings", { p_action: actionId });
    if (error) {
      // Before 20261113000001 a restore sends nothing, as it always did.
      if (!isSchemaMissing(error)) log.warn({ code: error.code }, "restored meetings not read; no invitation sent");
      return { invited: false };
    }
    const meetings = restoredMeetingsFrom(data);
    if (meetings.length === 0) return { invited: false };
    const ready = await invitesReady(request.db);
    const callerId = request.auth.userId;
    let invited = false;

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
          }
        } catch (err) {
          log.warn(
            { provider: plan.provider, err: err instanceof Error ? err.message : "unknown" },
            "restored meeting not put back on the calendar; the invitation still goes"
          );
        }
        // Still no event: the delete took the owner's event off the calendar, and its Meet/Teams link with it. The
        // invitation (and the app) show no link rather than a dead one; the counselor can add a new one. (A
        // collaborator's delete never touched the owner's calendar, so their restore keeps the link: no plan.put.)
        if (!row.calendar_event_id && row.join_url) {
          const { data: cleared, error: clearErr } = await request.db
            .from("meetings")
            .update({ join_url: null })
            .eq("id", m.id)
            .select("*")
            .single();
          if (clearErr || !cleared) log.warn({ code: clearErr?.code }, "restored meeting's old link not cleared");
          else row = cleared as Row;
        }
      }

      if (!ready) continue;
      const state = meetingState(row);
      if (!state.sendInvites) continue;
      const attendees = await loadAttendeeIds(request.db, state).catch(() => null);
      if (!attendees) {
        log.warn("restored meeting's invitees not read; no invitation sent");
        continue;
      }
      const prepared = await deps.prepare(request, {
        before: null,
        after: state,
        attendeesBefore: [],
        attendeesAfter: attendees,
        notify: true,
      });
      if (prepared.round) {
        deps.start(prepared.round, log);
        invited = true;
      }
    }
    return { invited };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : "unknown" }, "restored meetings' invitations not sent");
    return { invited: false };
  }
}
