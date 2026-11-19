/**
 * One invite round for a whole repeating series (lib/meetingInvites.ts carries one meeting).
 *
 * A series creates, changes or deletes many meetings in one request. A round per meeting would spend the 60 an
 * hour allowance N times and email each family N times, so a series round is one email per recipient listing
 * every affected date, charged once (`meeting-invites:<owner>`) for a create or an update and never for a
 * cancellation, only after recipients resolve to someone who will be emailed. Who receives it is resolveRound's
 * rules, unchanged (students attending, guardians when the meeting invites them, the owner's copy for rows not
 * already on their connected calendar); `notify: false` emails nobody.
 *
 * The safe variant, until a real-inbox test of multi-event invites: `create` attaches ONE .ics, METHOD:PUBLISH,
 * a VEVENT per occurrence with that meeting's own UID and SEQUENCE and no ATTENDEE or RSVP; `update` and
 * `cancel` send the text list of changed or cancelled dates and attach nothing. Limit: calendar apps keep the
 * events a create added at their old times (or at all, after a cancel) until the person changes or deletes
 * them; upgrade to REQUEST/CANCEL files after the invite spike.
 */

import type { FastifyRequest } from "fastify";
import { meetingCalendar, meetingVevent, type IcsEventInput } from "./ics.js";
import {
  audiencePlan,
  defaultDeps,
  INVITE_ROUNDS_PER_HOUR,
  live,
  NO_ADDRESS,
  resolveRound,
  sendRound,
  seriesEmail,
  THROTTLED,
  type Deps,
  type MeetingState,
  type Prepared,
  type ResolvedRound,
} from "./meetingInvites.js";
import { consumeRateLimit } from "./limits.js";
import { serializeErr } from "./requestLog.js";

type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export type SeriesRoundKind = "create" | "update" | "cancel";
/** A resolved round plus the occurrences it tells about, first to last. */
export type SeriesRound = ResolvedRound & { kind: SeriesRoundKind; rows: MeetingState[] };

/** One calendar holding every event, each with its own UID and SEQUENCE, under one METHOD. */
export function buildSeriesIcs(events: IcsEventInput[], method: "PUBLISH" | "CANCEL"): string {
  return meetingCalendar(method, events.flatMap((e) => meetingVevent({ ...e, method })));
}

const TEMPLATE = { create: "meeting-invite", update: "meeting-update", cancel: "meeting-cancel" } as const;

/** Resolve and throttle a series round before the response. Delivery is `startSeriesDelivery`. Never throws. */
export async function prepareSeriesInviteRound(
  request: Pick<FastifyRequest, "db" | "log">,
  input: { kind: SeriesRoundKind; before: MeetingState[]; after: MeetingState[]; attendeeIds: string[]; notify: boolean },
  deps: { consume: typeof consumeRateLimit; now: Date } = { consume: consumeRateLimit, now: new Date() }
): Promise<Prepared> {
  try {
    const { kind } = input;
    if (!input.notify) return { summary: { status: "none" }, round: null };
    // The occurrences invitees hold (or held, for a cancel): invites on, scheduled, not over.
    const rows = (kind === "cancel" ? input.before : input.after)
      .filter((r) => live(r, deps.now))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    if (rows.length === 0) return { summary: { status: "none" }, round: null };

    const first = rows[0]!;
    const plan = audiencePlan(
      first,
      input.attendeeIds,
      rows.some((r) => !r.onProviderCalendar),
      kind === "cancel" ? "CANCEL" : "PUBLISH",
      TEMPLATE[kind],
      kind !== "cancel"
    );
    // Resolved before the charge, as a single round is: a round that reaches nobody spends nothing.
    const resolved = await resolveRound(request.db, plan);
    if ("skip" in resolved) return { summary: { status: "skipped", reason: resolved.skip }, round: null };
    const invitees = resolved.recipients.filter((r) => r.kind !== "counselor").length;
    if (invitees === 0) return { summary: { status: "skipped", reason: resolved.notes[0] ?? NO_ADDRESS }, round: null };

    if (kind !== "cancel") {
      const allowed = await deps.consume(`meeting-invites:${first.counselorId}`, INVITE_ROUNDS_PER_HOUR, 3600, {
        warn: (msg) => request.log.warn(msg),
      });
      if (!allowed) return { summary: { status: "skipped", reason: THROTTLED }, round: null };
    }

    const round: SeriesRound = { ...resolved, kind, rows };
    return {
      summary: {
        status: "sending",
        recipients: invitees,
        skipped: resolved.skipped,
        ...(resolved.notes.length ? { note: resolved.notes.join(". ") } : {}),
      },
      round,
    };
  } catch (err) {
    request.log.warn({ err: serializeErr(err) }, "series invites not prepared");
    return { summary: { status: "skipped", reason: "Calendar invites couldn't be prepared" }, round: null };
  }
}

/** Send a series round: one email per recipient, the file only on a create. Never throws. */
export async function deliverSeriesRound(round: SeriesRound, log: Log, deps: Deps = defaultDeps): Promise<{ sent: number; failed: number }> {
  return sendRound(round, log, deps, (r, sentBy) => {
    // The owner's copy leaves out what is already on their connected calendar.
    const rows = r.kind === "counselor" ? round.rows.filter((x) => !x.onProviderCalendar) : round.rows;
    const email = seriesEmail(r, rows, round.timeZone, round.organizer.name);
    if (round.kind !== "create") return email;
    const now = deps.now();
    const ics = buildSeriesIcs(
      rows.map((x) => {
        if (!x.endsAt) throw new Error("no end time");
        return {
          meetingId: x.id,
          sequence: x.sequence,
          method: "PUBLISH" as const,
          startsAt: x.startsAt,
          endsAt: x.endsAt,
          title: x.title,
          agenda: x.agenda,
          mode: x.mode,
          location: x.location,
          joinUrl: x.joinUrl,
          organizer: round.organizer,
          sentBy: sentBy && sentBy !== round.organizer.email ? sentBy : null,
          attendee: null,
          now,
        };
      }),
      "PUBLISH"
    );
    return {
      ...email,
      attachments: [
        { filename: "invite.ics", content: Buffer.from(ics, "utf8").toString("base64"), contentType: "text/calendar; charset=utf-8; method=PUBLISH" },
      ],
    };
  });
}

/** Send a prepared series round in the background; the response doesn't wait. Anything but a series round is ignored. */
export function startSeriesDelivery(round: unknown, log: Log): void {
  if (!round || typeof round !== "object" || !("rows" in round) || !("kind" in round)) return;
  void deliverSeriesRound(round as SeriesRound, log).catch((err) => log.error({ err: serializeErr(err) }, "series invite round failed"));
}
