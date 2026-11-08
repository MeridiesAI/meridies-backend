/**
 * Student booking, part 2: a student books, moves or cancels time with their
 * own counselor (routes/studentBooking.ts). The rules and the order of the
 * writes live here; every database, provider, email and limiter call is
 * behind `BookingIo`, so the order and its rollbacks are unit tested with
 * stand-ins.
 *
 * Book: the start must be one of the slots GET /me/booking/slots offers for
 * that type right now (the same slotsFor, server-side, with the calendar's
 * busy time), else 409 `slot_unavailable`; duration and mode come from the
 * type, never the client. Reserve with public.book_meeting_slot (409
 * `slot_taken` when it races), then the conference event on the counselor's
 * calendar when the type is Meet/Teams and that calendar is connected
 * (lib/bookingCalendar.ts); a provider failure deletes the reservation and is
 * 503 `calendar_write_failed`. No calendar connected: booked without a link,
 * `joinUrl: null`, `conference: "not-connected"`. Then Meridies' own emailed
 * invite to the student (and the counselor's copy) and a notice to the
 * counselor. At most MAX_FUTURE_BOOKINGS future scheduled bookings each.
 *
 * Reschedule / cancel: any scheduled meeting where the caller is the primary
 * student, with their own counselor, whoever booked it, when it involves no
 * one else (no other attendee, guardians not invited: those rounds would
 * reach people the student can't see, 409 `ask_your_counselor`), starts in
 * the future, outside `cancel_cutoff_hours` (409 `inside_cutoff`) and while
 * `students_can_reschedule` is on (403 `student_changes_off`). A move is
 * checked against the grid ignoring the meeting itself, moved with
 * public.reschedule_meeting_slot, then on the calendar (a failure puts the old
 * time back, 503). A cancel is claimed with a conditional update (a second one
 * is 409 `already_cancelled` and emails nobody), then the event is deleted
 * best effort (`calendarRemoved`).
 */

import type { FastifyRequest } from "fastify";
import { slotsFor, type BookingSettingsDto, type IgnoreMeeting, type MeetingTypeDto, type StudentBookingContext } from "./booking.js";
import { bookingConferenceProvider } from "./bookingCalendar.js";
import { HttpError } from "./errors.js";
import { whenShort, type InviteRoundSummary } from "./meetingInvites.js";
import type { SuiteProvider } from "./oauth.js";
import type { CalendarEventInput } from "./suiteApi.js";

type Row = Record<string, unknown>;

/** Future scheduled meetings a student may have booked themselves at once. */
export const MAX_FUTURE_BOOKINGS = 10;
/** Book, move and cancel calls per student per hour. */
export const BOOKING_ACTIONS_PER_HOUR = 20;
/** Counselor notices (bell + email) per student per day. */
export const BOOKING_NOTICES_PER_DAY = 20;

const MINUTE = 60_000;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

// ---- errors -------------------------------------------------------------------------------------

export const slotUnavailable = () => new HttpError(409, "That time isn't available any more. Pick another.", "slot_unavailable");
export const slotTaken = () => new HttpError(409, "Someone just booked that time. Pick another.", "slot_taken");
export const calendarWriteFailed = () =>
  new HttpError(503, "Your counselor's calendar couldn't be updated, so nothing was changed. Try again shortly.", "calendar_write_failed");
const notFoundMeeting = () => new HttpError(404, "That meeting doesn't exist", "meeting_not_found");

/** book_meeting_slot / reschedule_meeting_slot errors, by message, as the routes answer them. */
export function rpcError(error: { code?: string; message?: string }): HttpError | null {
  const m = error.message ?? "";
  if (m.includes("slot_taken")) return slotTaken();
  if (m.includes("booking_disabled") || m.includes("not_your_counselor")) {
    return new HttpError(404, "Your counselor isn't taking bookings right now", "booking_not_available");
  }
  if (m.includes("meeting_not_found")) return notFoundMeeting();
  if (m.includes("invalid_slot")) return slotUnavailable();
  return null;
}

// ---- pure rules ---------------------------------------------------------------------------------

/** The first word of a name, at most 40 characters; "Your student" when there is none. */
export function firstName(full: string | null | undefined): string {
  const first = str(full).trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 40) : "Your student";
}

/** Whether a meeting starting at `startsAt` is less than `cutoffHours` real hours away. */
export function insideCutoff(startsAt: string, cutoffHours: number, now: Date): boolean {
  return Date.parse(startsAt) - now.getTime() < Math.max(0, cutoffHours) * 3_600_000;
}

export type NoticeAction = "booked" | "rescheduled" | "cancelled";
export type NoticeInput = {
  action: NoticeAction;
  first: string;
  typeName: string | null;
  startsAt: string;
  previous: string | null;
  timeZone: string;
  /** The student booked the meeting (true), or the counselor did and the student changed it. */
  byStudent: boolean;
  /** A cancel whose calendar delete failed: the event is still on this calendar. */
  calendarLeft?: SuiteProvider | null;
};

const when = (iso: string, tz: string) => whenShort(iso, tz).replace(/[  ]/g, " ");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** The counselor's bell title and body: the student's first name, the type and the time in the counselor's zone, nothing else. */
export function noticeText(n: NoticeInput): { title: string; body: string } {
  const at = when(n.startsAt, n.timeZone);
  const title =
    n.action === "booked"
      ? `${n.first} booked ${clip((n.typeName ?? "a meeting").trim(), 80)} on ${at}`
      : n.action === "rescheduled"
        ? `${n.first} moved a meeting to ${at}`
        : `${n.first} cancelled the meeting on ${at}`;
  const who = n.byStudent ? `${n.first} booked this in Meridies.` : `You set this meeting up; ${n.first} changed it in Meridies.`;
  const moved = n.action === "rescheduled" && n.previous ? `Moved from ${when(n.previous, n.timeZone)}. ${who}` : who;
  const left = n.calendarLeft ? ` It is still on your ${n.calendarLeft === "google" ? "Google" : "Outlook"} calendar; delete it there.` : "";
  return { title: clip(title, 200), body: moved + left };
}

/**
 * Why the student may not move or cancel this meeting, or null. Checked in
 * this order so the answer says the most useful thing: not theirs (404, the
 * same as a meeting that doesn't exist), already cancelled, no longer
 * scheduled or already started, someone else involved, switched off, too late.
 */
export function studentChangeRefusal(i: {
  meeting: Row;
  attendees: string[];
  studentId: string;
  counselorId: string;
  settings: BookingSettingsDto;
  now: Date;
}): HttpError | null {
  const m = i.meeting;
  if (m.student_id !== i.studentId) return notFoundMeeting();
  if (m.status === "cancelled") return new HttpError(409, "That meeting is already cancelled", "already_cancelled");
  if (m.status !== "scheduled" || !(Date.parse(str(m.starts_at)) > i.now.getTime())) {
    return new HttpError(409, "Only an upcoming meeting can be changed", "not_scheduled");
  }
  const others = i.attendees.some((id) => id !== i.studentId);
  if (m.counselor_id !== i.counselorId || others || m.guardians_invited === true) {
    return new HttpError(409, "Ask your counselor to change this meeting", "ask_your_counselor");
  }
  if (!i.settings.studentsCanReschedule) {
    return new HttpError(403, "Your counselor changes meetings themselves. Message them to move or cancel it.", "student_changes_off");
  }
  if (insideCutoff(str(m.starts_at), i.settings.cancelCutoffHours, i.now)) {
    return new HttpError(
      409,
      `It's too close to the meeting to change it here (${i.settings.cancelCutoffHours} hours). Message your counselor.`,
      "inside_cutoff"
    );
  }
  return null;
}

/**
 * Whether `startsAt` is exactly one of the starts GET /me/booking/slots offers
 * for this type now: the same slotsFor (weekly hours, meetings, calendar busy
 * time, buffer, notice, days ahead), asked about a one-minute window.
 */
export async function slotOpen(
  request: FastifyRequest,
  ctx: Extract<StudentBookingContext, { ok: true }>,
  type: Pick<MeetingTypeDto, "id" | "durationMinutes">,
  startsAt: string,
  now: Date,
  ignore: IgnoreMeeting | null = null
): Promise<boolean> {
  const at = Date.parse(startsAt);
  if (!Number.isFinite(at)) return false;
  const answer = await slotsFor(request, ctx, type, { from: new Date(at).toISOString(), to: new Date(at + MINUTE).toISOString() }, now, ignore);
  return answer.slots.some((s) => Date.parse(s.startsAt) === at);
}

// ---- the writes ---------------------------------------------------------------------------------

export type Notice = { action: NoticeAction; title: string; body: string };

export type BookingIo = {
  now(): Date;
  slotOpen(type: Pick<MeetingTypeDto, "id" | "durationMinutes">, startsAt: string, ignore: IgnoreMeeting | null): Promise<boolean>;
  countFutureBookings(): Promise<number>;
  /** book_meeting_slot; throws its errors as HttpErrors (rpcError). */
  reserve(a: { startsAt: string; endsAt: string; mode: string; title: string }): Promise<Row>;
  /** reschedule_meeting_slot; throws its errors as HttpErrors. */
  move(a: { meetingId: string; startsAt: string; endsAt: string }): Promise<Row>;
  /** Delete a reservation that couldn't be completed. */
  release(meetingId: string): Promise<void>;
  /** Put a moved meeting back. */
  restoreTimes(meetingId: string, startsAt: string, endsAt: string | null): Promise<void>;
  update(meetingId: string, values: Row): Promise<Row>;
  /** scheduled -> cancelled, clearing the calendar pointer; null when it was no longer scheduled. */
  claimCancel(meetingId: string): Promise<Row | null>;
  calendar: {
    connected(provider: SuiteProvider): Promise<boolean>;
    create(meeting: Row, provider: SuiteProvider, input: CalendarEventInput): Promise<{ provider: SuiteProvider; eventId: string; joinUrl: string }>;
    move(meeting: Row, change: Partial<CalendarEventInput>): Promise<void>;
    remove(meeting: Row): Promise<void>;
  };
  /** The emailed invite round (never throws). */
  invites(kind: NoticeAction, before: Row | null, after: Row): Promise<InviteRoundSummary>;
  /** The counselor's bell + email, rate-limited (never throws). */
  notify(n: Notice): Promise<void>;
  invitesReady(): Promise<boolean>;
};

type Who = { studentId: string; studentName: string | null; counselorId: string; settings: BookingSettingsDto };

const pointerOf = (m: Row) => Boolean(m.calendar_provider) && Boolean(m.calendar_event_id);

export type BookResult = {
  meeting: Row;
  invites: InviteRoundSummary;
  joinUrl: string | null;
  /** created: a Meet/Teams link on the counselor's calendar; not-connected: a conference type but no calendar; not-needed: in person or phone. */
  conference: "created" | "not-connected" | "not-needed";
};

export async function bookSlot(io: BookingIo, i: Who & { type: MeetingTypeDto; startsAt: string }): Promise<BookResult> {
  if ((await io.countFutureBookings()) >= MAX_FUTURE_BOOKINGS) {
    throw new HttpError(409, `You can have at most ${MAX_FUTURE_BOOKINGS} upcoming bookings`, "too_many_bookings");
  }
  if (!(await io.slotOpen(i.type, i.startsAt, null))) throw slotUnavailable();

  const first = firstName(i.studentName);
  const startsAt = new Date(i.startsAt).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + i.type.durationMinutes * MINUTE).toISOString();
  const title = `${i.type.name} - ${first}`;
  const reserved = await io.reserve({ startsAt, endsAt, mode: i.type.mode, title });
  const id = str(reserved.id);

  const provider = bookingConferenceProvider(i.type.mode);
  let conference: BookResult["conference"] = "not-needed";
  let event: { provider: SuiteProvider; eventId: string; joinUrl: string } | null = null;
  if (provider) {
    conference = (await io.calendar.connected(provider)) ? "created" : "not-connected";
    if (conference === "created") {
      try {
        event = await io.calendar.create(reserved, provider, { title, startsAt, endsAt, description: null });
      } catch {
        await io.release(id);
        throw calendarWriteFailed();
      }
    }
  }

  const values: Row = {};
  if (await io.invitesReady()) values.send_invites = true;
  if (event) Object.assign(values, { calendar_provider: event.provider, calendar_event_id: event.eventId, join_url: event.joinUrl });
  let saved = reserved;
  if (Object.keys(values).length > 0) {
    try {
      saved = await io.update(id, values);
    } catch (err) {
      if (event) await io.calendar.remove({ ...reserved, calendar_provider: event.provider, calendar_event_id: event.eventId }).catch(() => undefined);
      await io.release(id);
      throw err;
    }
  }

  const invites = await io.invites("booked", null, saved);
  await io.notify({
    action: "booked",
    ...noticeText({ action: "booked", first, typeName: i.type.name, startsAt, previous: null, timeZone: i.settings.timeZone, byStudent: true }),
  });
  return { meeting: saved, invites, joinUrl: (saved.join_url as string | null) ?? null, conference };
}

type Change = Who & { meeting: Row; attendees: string[] };

function refuse(io: BookingIo, i: Change): void {
  const refusal = studentChangeRefusal({ ...i, now: io.now() });
  if (refusal) throw refusal;
}

export async function rescheduleBooking(
  io: BookingIo,
  i: Change & { startsAt: string }
): Promise<{ meeting: Row; invites: InviteRoundSummary; calendarUpdated: boolean }> {
  refuse(io, i);
  const m = i.meeting;
  const oldStart = str(m.starts_at);
  const oldEnd = m.ends_at ? str(m.ends_at) : null;
  const minutes = oldEnd ? Math.round((Date.parse(oldEnd) - Date.parse(oldStart)) / MINUTE) : 60;
  if (!(minutes >= 15 && minutes <= 180)) throw new HttpError(409, "Ask your counselor to change this meeting", "ask_your_counselor");

  const ignore: IgnoreMeeting = { id: str(m.id), startsAt: oldStart, endsAt: oldEnd, onCalendar: pointerOf(m) };
  if (!(await io.slotOpen({ id: "reschedule", durationMinutes: minutes }, i.startsAt, ignore))) throw slotUnavailable();

  const startsAt = new Date(i.startsAt).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + minutes * MINUTE).toISOString();
  const moved = await io.move({ meetingId: str(m.id), startsAt, endsAt });

  let calendarUpdated = false;
  if (pointerOf(m)) {
    try {
      await io.calendar.move(m, { startsAt, endsAt });
      calendarUpdated = true;
    } catch {
      await io.restoreTimes(str(m.id), oldStart, oldEnd);
      throw calendarWriteFailed();
    }
  }

  const invites = await io.invites("rescheduled", m, moved);
  const first = firstName(i.studentName);
  await io.notify({
    action: "rescheduled",
    ...noticeText({ action: "rescheduled", first, typeName: null, startsAt, previous: oldStart, timeZone: i.settings.timeZone, byStudent: m.booked_by_student === true }),
  });
  return { meeting: moved, invites, calendarUpdated };
}

export async function cancelBooking(io: BookingIo, i: Change): Promise<{ meeting: Row; invites: InviteRoundSummary; calendarRemoved: boolean }> {
  refuse(io, i);
  const m = i.meeting;
  const claimed = await io.claimCancel(str(m.id));
  if (!claimed) throw new HttpError(409, "That meeting is already cancelled", "already_cancelled");

  // Nothing left on the counselor's calendar is "removed"; a failed delete is reported, never blocking.
  let calendarRemoved = true;
  let calendarLeft: SuiteProvider | null = null;
  if (pointerOf(m)) {
    try {
      await io.calendar.remove(m);
    } catch {
      calendarRemoved = false;
      calendarLeft = m.calendar_provider === "microsoft" ? "microsoft" : "google";
    }
  }

  const invites = await io.invites("cancelled", m, claimed);
  await io.notify({
    action: "cancelled",
    ...noticeText({
      action: "cancelled",
      first: firstName(i.studentName),
      typeName: null,
      startsAt: str(m.starts_at),
      previous: null,
      timeZone: i.settings.timeZone,
      byStudent: m.booked_by_student === true,
      calendarLeft,
    }),
  });
  return { meeting: claimed, invites, calendarRemoved };
}
