/**
 * Meetings (routes/meetings.ts) and the Calendar (routes/calendar.ts).
 *
 * A meeting is a session with a student; the student sees it on their
 * calendar, and no email or text goes out when one is booked, moved or
 * cancelled: the API sends no invitation, and the Google / Outlook event it
 * can create has no attendees and is written with `sendUpdates=none`
 * (lib/suiteApi.ts). Booking or moving one therefore runs at once.
 * `create_conference` puts an event with a real Meet / Teams link on the
 * counselor's connected Google or Outlook calendar, so that asks, and so do
 * cancelling and changing the mode (either removes that event), deleting, and
 * inviting other students (each one then sees the meeting, its title and
 * agenda).
 *
 * The Calendar's event types and practice events ("Planning milestone") are
 * the counselor's own. A practice event shared with a student shows on that
 * student's calendar, so sharing one, or moving a shared one to another
 * student, asks.
 *
 * The meetings routes take UTC times only; an op accepts any ISO time with an
 * offset and sends it as UTC. Cards show a time as the model wrote it, with
 * its offset (and the UTC time beside it), so it is never a bare clock time.
 */
import { z } from "zod";
import { BUILTIN_TYPES, isTimeZone } from "../../../calendarFeed.js";
import { op, type OpGroup, type UndoStep } from "../types.js";
import { asArray, asRecord, changeLines, dayLabel, defined, idOf, isoDateTime, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = { get<T>(url: string): Promise<T | null> };
type Row = Record<string, unknown>;

// ---- shared ---------------------------------------------------------------------

/** Any ISO time, as the UTC form the meetings routes accept (they refuse an offset). */
const utc = (iso: string): string => new Date(iso).toISOString();

const ISO_PARTS = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** The offset in minutes east of UTC an ISO string was written in, or null for Z / none. */
function offsetMinutes(iso: string): number | null {
  const m = ISO_PARTS.exec(iso);
  if (!m?.[3] || m[3].toUpperCase() === "Z") return null;
  const [, sign, hh, mm] = /^([+-])(\d{2}):?(\d{2})$/.exec(m[3])!;
  const n = Number(hh) * 60 + Number(mm);
  return n === 0 ? null : sign === "-" ? -n : n;
}

/** "Nov 3, 2026 at 16:00 UTC-05:00", read off the ISO string as written. */
function whenLabel(iso: unknown): string {
  const s = str(iso);
  if (!s) return "";
  const m = ISO_PARTS.exec(s);
  if (!m) return plainText(s, 40);
  const off = offsetMinutes(s);
  const zone = off === null ? "UTC" : `UTC${m[3]!.length === 5 ? `${m[3]!.slice(0, 3)}:${m[3]!.slice(3)}` : m[3]}`;
  return `${dayLabel(m[1])} at ${m[2]} ${zone}`;
}

/** The same instant written in the offset `like` was written in (so an old and a new time read alike). */
function sameOffset(iso: unknown, like: string): string {
  const s = str(iso);
  if (!s || Number.isNaN(Date.parse(s))) return "";
  const off = offsetMinutes(like);
  if (off === null) return whenLabel(new Date(s).toISOString());
  const local = new Date(Date.parse(s) + off * 60_000).toISOString().slice(0, 16);
  const abs = Math.abs(off);
  return whenLabel(`${local}${off < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`);
}

/** The card's full form: as written, plus the UTC time when it was written with an offset. */
function whenDetail(iso: string): string {
  return offsetMinutes(iso) === null ? whenLabel(iso) : `${whenLabel(iso)} (${whenLabel(utc(iso))})`;
}

/** The update that puts back exactly the keys `i` changed, or null when the old values don't pass the op's own input. */
function restore(
  name: string,
  schema: z.ZodTypeAny,
  i: Row,
  keep: Row,
  from: Record<string, (b: Row) => unknown>,
  b: Row
): UndoStep | null {
  const prev: Row = { ...keep };
  for (const [k, get] of Object.entries(from)) {
    if (!(k in i) || i[k] === undefined) continue;
    const v = get(b);
    if (v === undefined) return null;
    prev[k] = v;
  }
  if (Object.keys(prev).length === Object.keys(keep).length) return null;
  return schema.safeParse(prev).success ? { op: name, input: prev } : null;
}

const utcOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

// ---- meetings ---------------------------------------------------------------------

const MODES = ["google-meet", "teams", "in-person", "phone"] as const;
const STATUSES = ["scheduled", "held", "cancelled", "no-show"] as const;

const meetingFields = {
  title: z.string().trim().min(1).max(300),
  mode: z.enum(MODES),
  location: z.string().trim().max(300).nullable(),
  // The table refuses anything but http(s) (meetings.join_url check).
  join_url: z.string().url().max(2000).regex(/^https?:\/\//, "Use an http(s) link").nullable(),
  starts_at: isoDateTime,
  ends_at: isoDateTime.nullable(),
  agenda: z.string().trim().max(4000).nullable(),
  guardians_invited: z.boolean(),
  deadline_id: uuid.nullable(),
  create_conference: z.boolean(),
  attendee_ids: z.array(uuid).max(30),
};

const MEETING_LABELS = {
  title: "Title",
  mode: "Mode",
  location: "Location",
  join_url: "Link",
  agenda: "Agenda",
  guardians_invited: "Parents invited",
  deadline_id: "Linked deadline",
  status: "Status",
  meeting_note_id: "Linked meeting note",
  create_conference: "Create the Meet / Teams event",
};

type MeetingInput = Partial<Record<keyof typeof meetingFields | "status" | "meeting_note_id", unknown>>;

const meetingBody = (i: MeetingInput) =>
  defined({
    title: i.title,
    mode: i.mode,
    location: i.location,
    joinUrl: i.join_url,
    startsAt: typeof i.starts_at === "string" ? utc(i.starts_at) : undefined,
    endsAt: typeof i.ends_at === "string" ? utc(i.ends_at) : i.ends_at === null ? null : undefined,
    agenda: i.agenda,
    guardiansInvited: i.guardians_invited,
    deadlineId: i.deadline_id,
    createConference: i.create_conference,
    attendeeIds: i.attendee_ids,
    status: i.status,
    meetingNoteId: i.meeting_note_id,
  });

function meetingDetails(i: MeetingInput & { attendee_ids?: string[] }, h: { studentName(id: string): string }): string[] {
  const lines: string[] = [];
  if (typeof i.starts_at === "string") lines.push(`Starts: ${whenDetail(i.starts_at)}`);
  if (i.ends_at !== undefined) lines.push(`Ends: ${typeof i.ends_at === "string" ? whenDetail(i.ends_at) : "cleared"}`);
  const { attendee_ids, ...rest } = i;
  lines.push(...changeLines(rest, MEETING_LABELS));
  if (attendee_ids) lines.push(`Students invited: ${attendee_ids.map((id) => h.studentName(id)).join(", ") || "only the student it's for"}`);
  return lines;
}

type Meeting = {
  id?: string;
  studentId?: string;
  title?: string;
  mode?: string;
  location?: string | null;
  joinUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  status?: string;
  agenda?: string | null;
  guardiansInvited?: boolean;
  meetingNoteId?: string | null;
  deadlineId?: string | null;
  calendarProvider?: string | null;
  attendeeIds?: string[];
};

async function findMeeting(h: Get, id: string): Promise<Meeting | null> {
  const m = asRecord(await h.get<unknown>(`/meetings/${seg(id)}`));
  return m.id ? (m as Meeting) : null;
}

const meetingLabel = (m: Meeting | null) =>
  m ? `"${plainText(m.title, 80)}"${m.startsAt ? ` (${whenLabel(m.startsAt)})` : ""}` : "a meeting";

const meetingUpdateInput = z
  .object({
    meeting_id: uuid,
    title: meetingFields.title.optional(),
    mode: meetingFields.mode.optional(),
    location: meetingFields.location.optional(),
    join_url: meetingFields.join_url.optional(),
    starts_at: meetingFields.starts_at.optional(),
    ends_at: meetingFields.ends_at.optional(),
    agenda: meetingFields.agenda.optional(),
    guardians_invited: meetingFields.guardians_invited.optional(),
    deadline_id: meetingFields.deadline_id.optional(),
    create_conference: meetingFields.create_conference.optional(),
    attendee_ids: meetingFields.attendee_ids.optional(),
    status: z.enum(STATUSES).optional(),
    meeting_note_id: uuid.nullable().optional(),
  })
  .strict();

export const meetings: OpGroup = {
  heading: "Meetings",
  ops: [
    op({
      name: "meetings.list",
      kind: "read",
      title: "Meetings with ids, oldest first: a student's (incl. invited) or all the counselor's; pass from for upcoming ones.",
      doc: "{ student_id?, status?: scheduled|held|cancelled|no-show, from? ISO datetime, to? ISO datetime, limit? 1–200 }",
      input: z
        .object({
          student_id: uuid.optional(),
          status: z.enum(STATUSES).optional(),
          from: isoDateTime.optional(),
          to: isoDateTime.optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
      request: (i) => ({
        method: "GET",
        url: `/meetings${qs({
          studentId: i.student_id,
          status: i.status,
          from: i.from ? utc(i.from) : undefined,
          to: i.to ? utc(i.to) : undefined,
          limit: i.limit,
        })}`,
      }),
      reply: (body) =>
        listReply(
          asArray(body),
          (m) => {
            const others = Array.isArray(m.attendeeIds) ? m.attendeeIds.length : 1;
            return `id ${str(m.id)}: ${utcOrNull(m.startsAt) ?? "no time"} [${str(m.status)}, ${str(m.mode)}${m.calendarProvider ? ", on the connected calendar" : ""}] ${untrusted(m.title)} · student ${str(m.studentId)}${others > 1 ? ` (+${others - 1} more invited)` : ""}`;
          },
          "No meetings."
        ),
    }),
    op({
      name: "meetings.create",
      kind: "write",
      // Asks when it writes to the connected calendar, or when other students (other families) will see it.
      risk: (i) => (i.create_conference || (i.attendee_ids ?? []).some((id) => id !== i.student_id) ? "confirm" : "auto"),
      title: "Book a meeting with a student (no invitation is sent; create_conference adds a Meet/Teams calendar event).",
      doc: "{ student_id, title ≤300, starts_at ISO datetime with offset, ends_at?, mode?: google-meet|teams|in-person|phone, location?, join_url?, agenda? ≤4000, guardians_invited?, deadline_id?, attendee_ids? (other students) ≤30, create_conference? (needs ends_at) }",
      input: z
        .object({
          student_id: uuid,
          title: meetingFields.title,
          starts_at: meetingFields.starts_at,
          ends_at: meetingFields.ends_at.optional(),
          mode: meetingFields.mode.optional(),
          location: meetingFields.location.optional(),
          join_url: meetingFields.join_url.optional(),
          agenda: meetingFields.agenda.optional(),
          guardians_invited: meetingFields.guardians_invited.optional(),
          deadline_id: meetingFields.deadline_id.optional(),
          create_conference: meetingFields.create_conference.optional(),
          attendee_ids: meetingFields.attendee_ids.optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/meetings", body: { studentId: i.student_id, ...meetingBody(i) } }),
      describe: (i, h) => {
        const others = (i.attendee_ids ?? []).filter((id) => id !== i.student_id).length;
        return `Book "${plainText(i.title, 80)}" with ${h.studentName(i.student_id)}${others ? ` and ${others} more` : ""} on ${whenDetail(i.starts_at)}`;
      },
      details: (i, h) => {
        const { title: _title, starts_at: _starts, student_id: _student, ...rest } = i;
        return meetingDetails(rest, h);
      },
      warning: "Every student invited sees the meeting, its title and agenda on their calendar; with a Meet or Teams link, the event also goes on your connected Google or Outlook calendar.",
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "meetings.delete", input: { meeting_id: id } } : null;
      },
    }),
    op({
      name: "meetings.update",
      kind: "write",
      // Cancelling or a mode change can remove the connected-calendar event; attendee changes show the meeting to other families.
      risk: (i) => (i.status === "cancelled" || i.create_conference || i.mode !== undefined || i.attendee_ids !== undefined ? "confirm" : "auto"),
      title: "Change a meeting: move it, retitle, agenda, mode, who's invited, mark it held/no-show, or cancel it.",
      doc: "{ meeting_id, title?, starts_at?+ends_at? (move both; ISO with offset), mode?, location?|null, join_url?|null, agenda?|null, guardians_invited?, deadline_id?|null, attendee_ids? (all), status?: scheduled|held|cancelled|no-show, meeting_note_id?|null, create_conference? }",
      input: meetingUpdateInput,
      request: (i) => ({ method: "PATCH", url: `/meetings/${seg(i.meeting_id)}`, body: meetingBody(i) }),
      describe: async (i, h) => {
        const m = await findMeeting(h, i.meeting_id);
        const who = m?.studentId ? ` with ${h.studentName(m.studentId)}` : "";
        if (i.status === "cancelled") return `Cancel ${meetingLabel(m)}${who}`;
        if (i.starts_at) return `Move ${m ? `"${plainText(m.title, 80)}"${m.startsAt ? ` (${sameOffset(m.startsAt, i.starts_at)})` : ""}` : "a meeting"}${who} to ${whenDetail(i.starts_at)}`;
        if (i.status && Object.keys(i).length === 2) return `Mark ${meetingLabel(m)}${who} as ${i.status}`;
        if (i.attendee_ids && Object.keys(i).length === 2) return `Change who's invited to ${meetingLabel(m)}${who}`;
        return `Update ${meetingLabel(m)}${who}`;
      },
      details: (i, h) => meetingDetails(i, h),
      warning: "On a meeting booked on your Google or Outlook calendar, cancelling or changing the mode removes that event. Students added to the meeting see it, its title and agenda.",
      snapshot: (i, h) => findMeeting(h, i.meeting_id),
      undo: (i, _body, before) => {
        const b = asRecord(before) as Row & Meeting;
        if (!b.id || i.create_conference) return null;
        // The calendar event a cancel or a mode change removed can't be put back.
        if (b.calendarProvider && (i.status === "cancelled" || (i.mode !== undefined && i.mode !== b.mode))) return null;
        return restore(
          "meetings.update",
          meetingUpdateInput,
          i,
          { meeting_id: i.meeting_id },
          {
            title: (r) => r.title,
            mode: (r) => r.mode,
            location: (r) => r.location ?? null,
            join_url: (r) => r.joinUrl ?? null,
            starts_at: (r) => utcOrNull(r.startsAt),
            ends_at: (r) => utcOrNull(r.endsAt),
            agenda: (r) => r.agenda ?? null,
            guardians_invited: (r) => r.guardiansInvited === true,
            deadline_id: (r) => r.deadlineId ?? null,
            attendee_ids: (r) => (Array.isArray(r.attendeeIds) ? r.attendeeIds : undefined),
            status: (r) => r.status,
            meeting_note_id: (r) => r.meetingNoteId ?? null,
          },
          b
        );
      },
    }),
    op({
      name: "meetings.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a meeting outright (to keep a record that it was planned, cancel it with meetings.update instead).",
      doc: "{ meeting_id }",
      input: z.object({ meeting_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/meetings/${seg(i.meeting_id)}` }),
      describe: async (i, h) => {
        const m = await findMeeting(h, i.meeting_id);
        return `Delete ${meetingLabel(m)}${m?.studentId ? ` with ${h.studentName(m.studentId)}` : ""}`;
      },
      warning: "The meeting is deleted, not cancelled, along with any event on your connected calendar.",
    }),
  ],
};

// ---- calendar: the feed, event types, practice events -----------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").pipe(z.string().date());
const hex = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "Use a #RRGGBB colour");
const timeZone = z.string().trim().max(64).refine(isTimeZone, "That isn't a time zone");
const eventKind = z.enum(BUILTIN_TYPES);

const BUILTIN_LABELS: Record<string, string> = {
  deadline: "Deadline",
  meeting: "Meeting",
  task: "Task",
  milestone: "Milestone",
  event: "Professional event",
};

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type EventType = { id?: string; name?: string; description?: string | null; timeZone?: string; color?: string; sortOrder?: number };

async function findEventType(h: Get, id: string): Promise<EventType | null> {
  const hit = asArray(await h.get<unknown[]>("/calendar/event-types")).find((r) => r.id === id);
  return hit ? (hit as EventType) : null;
}

async function typeLabel(h: Get, type: string): Promise<string> {
  if (BUILTIN_LABELS[type]) return BUILTIN_LABELS[type]!;
  const t = await findEventType(h, type);
  return t ? `"${plainText(t.name, 60)}"` : "one of your event types";
}

type PracticeEvent = {
  id: string;
  title: string;
  detail: string | null;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  studentId: string | null;
  /** The event's own type: undefined when a reassignment hides it. */
  typeId: string | null | undefined;
};

/**
 * There is no single-event GET; the feed carries practice events (kind
 * `milestone`) in windows of at most 400 days, so look around today first.
 */
async function findPracticeEvent(h: Get, id: string): Promise<PracticeEvent | null> {
  for (const [a, b] of [
    [-120, 279],
    [280, 679],
    [-520, -121],
  ] as const) {
    const feed = await h.get<unknown>(`/calendar/feed${qs({ from: dayOffset(a), to: dayOffset(b), tz: "UTC" })}`);
    if (!feed) return null;
    const f = asRecord(feed);
    const hit = asArray(f.items).find((r) => r.kind === "milestone" && r.ref === id);
    if (!hit) continue;
    const moved = asArray(f.assignments).some((x) => x.eventKind === "milestone" && x.eventRef === id);
    const type = str(hit.type);
    return {
      id,
      title: str(hit.title) ?? "",
      detail: str(hit.detail),
      onDate: str(hit.date) ?? "",
      startsAt: utcOrNull(hit.startsAt),
      endsAt: utcOrNull(hit.endsAt),
      studentId: str(hit.studentId),
      typeId: moved ? undefined : type === "milestone" ? null : type,
    };
  }
  return null;
}

const eventLabel = (e: PracticeEvent | null) => (e ? `"${plainText(e.title, 80)}" (${dayLabel(e.onDate)})` : "a calendar event");

async function feedItemLabel(h: Get, kind: string, ref: string): Promise<string> {
  if (kind === "meeting") return `meeting ${meetingLabel(await findMeeting(h, ref))}`;
  if (kind === "milestone") return eventLabel(await findPracticeEvent(h, ref));
  if (kind === "deadline") {
    const d = asArray(await h.get<unknown[]>("/deadlines?includeDone=true")).find((r) => r.id === ref);
    if (d) return `deadline "${plainText(d.title, 80)}"`;
  }
  return `a ${BUILTIN_LABELS[kind]?.toLowerCase() ?? "calendar item"}`;
}

const eventTypeFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable(),
  time_zone: timeZone,
  color: hex,
  sort_order: z.number().int().min(0).max(999),
};

const eventTypeBody = (i: Partial<Record<keyof typeof eventTypeFields, unknown>>) =>
  defined({ name: i.name, description: i.description, timeZone: i.time_zone, color: i.color, sortOrder: i.sort_order });

const EVENT_TYPE_LABELS = { name: "Name", description: "Description", time_zone: "Time zone", color: "Colour", sort_order: "Order" };

const eventTypeUpdateInput = z
  .object({
    event_type_id: uuid,
    name: eventTypeFields.name.optional(),
    description: eventTypeFields.description.optional(),
    time_zone: eventTypeFields.time_zone.optional(),
    color: eventTypeFields.color.optional(),
    sort_order: eventTypeFields.sort_order.optional(),
  })
  .strict();

const practiceFields = {
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).nullable(),
  on_date: isoDate,
  starts_at: isoDateTime.nullable(),
  ends_at: isoDateTime.nullable(),
  student_id: uuid.nullable(),
  type_id: uuid.nullable(),
  shared_with_student: z.boolean(),
};

const practiceBody = (i: Partial<Record<keyof typeof practiceFields, unknown>>) =>
  defined({
    title: i.title,
    detail: i.detail,
    onDate: i.on_date,
    startsAt: i.starts_at,
    endsAt: i.ends_at,
    studentId: i.student_id,
    typeId: i.type_id,
    sharedWithStudent: i.shared_with_student,
  });

const PRACTICE_LABELS = {
  title: "Title",
  detail: "Notes",
  on_date: "Date",
  shared_with_student: "Shared with the student",
};

const practiceUpdateInput = z
  .object({
    event_id: uuid,
    title: practiceFields.title.optional(),
    detail: practiceFields.detail.optional(),
    on_date: practiceFields.on_date.optional(),
    starts_at: practiceFields.starts_at.optional(),
    ends_at: practiceFields.ends_at.optional(),
    student_id: practiceFields.student_id.optional(),
    type_id: practiceFields.type_id.optional(),
    shared_with_student: practiceFields.shared_with_student.optional(),
  })
  .strict();

async function practiceDetails(i: Row, h: Get & { studentName(id: string | null | undefined): string }): Promise<string[]> {
  const lines = changeLines(defined(i), PRACTICE_LABELS);
  if (i.starts_at !== undefined) lines.push(`Starts: ${typeof i.starts_at === "string" ? whenDetail(i.starts_at) : "cleared (all day)"}`);
  if (i.ends_at !== undefined) lines.push(`Ends: ${typeof i.ends_at === "string" ? whenDetail(i.ends_at) : "cleared"}`);
  if (i.student_id !== undefined) lines.push(`Student: ${i.student_id === null ? "none (practice-wide)" : h.studentName(str(i.student_id))}`);
  if (i.type_id !== undefined) lines.push(`Event type: ${i.type_id === null ? "none" : await typeLabel(h, String(i.type_id))}`);
  return lines;
}

export const calendar: OpGroup = {
  heading: "Calendar",
  ops: [
    op({
      name: "calendar.list",
      kind: "read",
      title: "Everything dated in a window (deadlines, meetings, tasks and their steps, practice events) with kind and ref ids.",
      doc: "{ from YYYY-MM-DD, to YYYY-MM-DD (≤400 days), tz? IANA zone, student_id?, include_done? bool, include_cancelled? bool }",
      input: z
        .object({
          from: isoDate,
          to: isoDate,
          tz: timeZone.optional(),
          student_id: uuid.optional(),
          include_done: z.boolean().optional(),
          include_cancelled: z.boolean().optional(),
        })
        .strict(),
      request: (i) => ({
        method: "GET",
        url: `/calendar/feed${qs({
          from: i.from,
          to: i.to,
          tz: i.tz,
          studentId: i.student_id,
          includeDone: i.include_done === false ? "false" : undefined,
          includeCancelled: i.include_cancelled ? "true" : undefined,
        })}`,
      }),
      reply: (body) =>
        listReply(
          asArray(asRecord(body).items),
          (e) => {
            const kind = str(e.kind) ?? "";
            const type = str(e.type) ?? kind;
            const flags = [
              kind,
              type !== kind ? `shown as ${BUILTIN_LABELS[type] ? type : `type ${type}`}` : null,
              e.meetingStatus ? str(e.meetingStatus) : e.done ? "done" : null,
              e.taskId && e.taskId !== e.ref ? `task ${str(e.taskId)}` : null,
            ].filter(Boolean);
            const at = e.allDay ? null : utcOrNull(e.startsAt);
            const time = at ? ` ${at}` : "";
            return `id ${str(e.ref)}: ${str(e.date)}${time} [${flags.join(", ")}] ${untrusted(e.title)}${e.school ? ` · ${untrusted(e.school)}` : ""}${e.studentId ? ` · student ${str(e.studentId)}` : " · practice-wide"}`;
          },
          "Nothing on the calendar in that window.",
          80
        ),
    }),
    op({
      name: "calendar.event_types",
      kind: "read",
      title: "The counselor's own calendar event types with ids (plus the built-in type keys).",
      doc: "{}",
      input: z.object({}).strict(),
      request: () => ({ method: "GET", url: "/calendar/event-types" }),
      reply: (body) => {
        const own = listReply(
          asArray(body),
          (t) => `id ${str(t.id)}: ${untrusted(t.name)} (${str(t.color)}, ${str(t.timeZone)})`,
          "No event types of their own."
        );
        return `${own}\nBuilt-in types: ${BUILTIN_TYPES.join(", ")}.`;
      },
    }),
    op({
      name: "calendar.create_event_type",
      kind: "write",
      risk: "auto",
      title: "Add a calendar event type (a named colour to sort events by).",
      doc: "{ name ≤80, color #RRGGBB, description? ≤500, time_zone? IANA zone, sort_order? 0–999 }",
      input: z
        .object({
          name: eventTypeFields.name,
          color: eventTypeFields.color,
          description: eventTypeFields.description.optional(),
          time_zone: eventTypeFields.time_zone.optional(),
          sort_order: eventTypeFields.sort_order.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/calendar/event-types", body: eventTypeBody(i) }),
      describe: (i) => `Add the event type "${plainText(i.name, 60)}" (${i.color}) to your calendar`,
      details: (i) => changeLines(defined({ description: i.description, time_zone: i.time_zone }), EVENT_TYPE_LABELS),
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "calendar.delete_event_type", input: { event_type_id: id } } : null;
      },
    }),
    op({
      name: "calendar.update_event_type",
      kind: "write",
      risk: "auto",
      title: "Rename or recolour one of the counselor's event types.",
      doc: "{ event_type_id, name? ≤80, color? #RRGGBB, description?|null, time_zone?, sort_order? }",
      input: eventTypeUpdateInput,
      request: (i) => ({ method: "PATCH", url: `/calendar/event-types/${seg(i.event_type_id)}`, body: eventTypeBody(i) }),
      describe: async (i, h) => {
        const t = await findEventType(h, i.event_type_id);
        return `Update the event type ${t ? `"${plainText(t.name, 60)}"` : "on your calendar"}`;
      },
      details: (i) => changeLines(i, EVENT_TYPE_LABELS),
      snapshot: (i, h) => findEventType(h, i.event_type_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        return restore(
          "calendar.update_event_type",
          eventTypeUpdateInput,
          i,
          { event_type_id: i.event_type_id },
          {
            name: (r) => r.name,
            description: (r) => r.description ?? null,
            time_zone: (r) => r.timeZone,
            color: (r) => r.color,
            sort_order: (r) => r.sortOrder,
          },
          b
        );
      },
    }),
    op({
      name: "calendar.delete_event_type",
      kind: "write",
      risk: "confirm",
      title: "Delete one of the counselor's event types (no event is deleted).",
      doc: "{ event_type_id }",
      input: z.object({ event_type_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/calendar/event-types/${seg(i.event_type_id)}` }),
      describe: async (i, h) => {
        const t = await findEventType(h, i.event_type_id);
        return `Delete the event type ${t ? `"${plainText(t.name, 60)}"` : "from your calendar"}`;
      },
      warning: "Events moved onto it go back to their own type, and practice events made with it lose their type.",
    }),
    op({
      name: "calendar.set_event_type",
      kind: "write",
      risk: "auto",
      title: "Show one calendar item as another type (a built-in key or an event type id); its own kind puts it back.",
      doc: "{ event_kind: deadline|meeting|task|milestone|event, event_ref (the item's id from calendar.list) ≤120, type: built-in key | event type id }",
      input: z
        .object({
          event_kind: eventKind,
          event_ref: z.string().trim().min(1).max(120),
          type: z.union([eventKind, uuid]),
        })
        .strict()
        .refine((i) => i.event_kind === "event" || uuid.safeParse(i.event_ref).success, {
          message: "That event reference isn't valid",
          path: ["event_ref"],
        }),
      request: (i) => ({ method: "PUT", url: "/calendar/assignments", body: { eventKind: i.event_kind, eventRef: i.event_ref, type: i.type } }),
      describe: async (i, h) => `Show ${await feedItemLabel(h, i.event_kind, i.event_ref)} as ${await typeLabel(h, i.type)}`,
      snapshot: async (i, h) => {
        const feed = await h.get<unknown>(`/calendar/feed${qs({ from: dayOffset(0), to: dayOffset(0), tz: "UTC" })}`);
        if (!feed) return null;
        const hit = asArray(asRecord(feed).assignments).find((a) => a.eventKind === i.event_kind && a.eventRef === i.event_ref);
        return { type: hit ? str(hit.type) : i.event_kind };
      },
      undo: (i, _body, before) => {
        const type = str(asRecord(before).type);
        return type ? { op: "calendar.set_event_type", input: { event_kind: i.event_kind, event_ref: i.event_ref, type } } : null;
      },
    }),
    op({
      name: "calendar.create_event",
      kind: "write",
      risk: (i) => (i.shared_with_student ? "confirm" : "auto"),
      title: "Add a practice event (a planning milestone) to the counselor's calendar, optionally about a student.",
      doc: "{ title ≤300, on_date YYYY-MM-DD, starts_at? ISO datetime (none = all day), ends_at?, detail? ≤2000, student_id?, type_id?, shared_with_student? bool (needs student_id) }",
      input: z
        .object({
          title: practiceFields.title,
          on_date: practiceFields.on_date,
          starts_at: practiceFields.starts_at.optional(),
          ends_at: practiceFields.ends_at.optional(),
          detail: practiceFields.detail.optional(),
          student_id: practiceFields.student_id.optional(),
          type_id: practiceFields.type_id.optional(),
          shared_with_student: practiceFields.shared_with_student.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/calendar/events", body: practiceBody(i) }),
      describe: (i, h) =>
        `Add "${plainText(i.title, 80)}" to your calendar on ${dayLabel(i.on_date)}${i.student_id ? ` (${h.studentName(i.student_id)})` : ""}${i.shared_with_student ? ", shared with the student" : ""}`,
      details: (i, h) => {
        const { title: _title, on_date: _date, student_id: _student, shared_with_student: _shared, ...rest } = i;
        return practiceDetails(rest, h);
      },
      warning: "The student sees it on their calendar.",
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "calendar.delete_event", input: { event_id: id } } : null;
      },
    }),
    op({
      name: "calendar.update_event",
      kind: "write",
      risk: (i) => (i.shared_with_student === true || typeof i.student_id === "string" ? "confirm" : "auto"),
      title: "Change a practice event: title, date, times, notes, student, type, or share it with the student.",
      doc: "{ event_id (a milestone id from calendar.list), title?, on_date? YYYY-MM-DD, starts_at?|null, ends_at?|null, detail?|null, student_id?|null, type_id?|null, shared_with_student? bool }",
      input: practiceUpdateInput,
      request: (i) => ({ method: "PATCH", url: `/calendar/events/${seg(i.event_id)}`, body: practiceBody(i) }),
      describe: async (i, h) => {
        const e = await findPracticeEvent(h, i.event_id);
        if (i.shared_with_student === true) return `Share ${eventLabel(e)} with ${h.studentName(i.student_id ?? e?.studentId)}`;
        return `Update ${eventLabel(e)}${e?.studentId ? ` (${h.studentName(e.studentId)})` : ""}`;
      },
      details: (i, h) => practiceDetails(i, h),
      warning: "A shared event shows on the student's calendar.",
      snapshot: (i, h) => findPracticeEvent(h, i.event_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        // Sharing isn't on the feed, and clearing the student un-shares: neither can be put back blind.
        if ("shared_with_student" in i || i.student_id === null) return null;
        if ("type_id" in i && b.typeId === undefined) return null;
        return restore(
          "calendar.update_event",
          practiceUpdateInput,
          i,
          { event_id: i.event_id },
          {
            title: (r) => r.title,
            detail: (r) => r.detail ?? null,
            on_date: (r) => r.onDate,
            starts_at: (r) => r.startsAt ?? null,
            ends_at: (r) => r.endsAt ?? null,
            student_id: (r) => r.studentId ?? null,
            type_id: (r) => r.typeId ?? null,
          },
          b
        );
      },
    }),
    op({
      name: "calendar.delete_event",
      kind: "write",
      risk: "confirm",
      title: "Delete a practice event from the counselor's calendar.",
      doc: "{ event_id }",
      input: z.object({ event_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/calendar/events/${seg(i.event_id)}` }),
      describe: async (i, h) => {
        const e = await findPracticeEvent(h, i.event_id);
        return `Delete ${eventLabel(e)} from your calendar${e?.studentId ? ` (${h.studentName(e.studentId)})` : ""}`;
      },
      warning: "The event is removed, and from the student's calendar too if it was shared.",
    }),
  ],
};
