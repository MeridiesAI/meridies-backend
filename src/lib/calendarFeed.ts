/**
 * The Calendar's one feed (Demo v9: Apple-Calendar Day / Week / Month / Year
 * over a single grid).
 *
 * Everything with a date lands on the same board, so the board reads one
 * list instead of stitching five fetches together in the browser:
 *
 *   deadline   `deadlines` rows — except the ones a task stage or task owns,
 *              which are shown once, as the task.
 *   meeting    `meetings`, by start time. Cancelled sessions only on request.
 *   task       each dated stage of an assigned task; a task without stages
 *              by its own due date.
 *   milestone  the counselor's own practice events (`calendar_events`).
 *
 * Saved Events Hub events ("Professional events", kind `event`) are owned by
 * the Events Hub routes and merged by the client; the type reassignments that
 * apply to them are returned here so the client can apply them the same way.
 *
 * Every read runs on the caller's RLS-bound client. Nothing is invented: a
 * deadline with no date cannot be placed on a grid, so it is not in a feed
 * that is by definition a grid (the Tasks view still lists it).
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "./errors.js";

type Row = Record<string, unknown>;

export const BUILTIN_TYPES = ["deadline", "meeting", "task", "milestone", "event"] as const;
export type BuiltinType = (typeof BUILTIN_TYPES)[number];
export type FeedKind = Exclude<BuiltinType, "event">;

export type CalendarFeedItem = {
  /** `${kind}:${ref}` — stable across reads, used as the React key. */
  id: string;
  kind: FeedKind;
  /** The source row's id (a stage id for a staged task). */
  ref: string;
  /**
   * The type it shows as: its own kind, or where the counselor moved it — a
   * built-in key or the id of one of their event types.
   */
  type: string;
  title: string;
  /** Calendar day, `YYYY-MM-DD`, in the requested time zone. */
  date: string;
  /** ISO datetimes for a timed item; null for all-day. */
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  /** Null for a practice-wide item. */
  studentId: string | null;
  /** Every student on a meeting, primary first. Empty for other kinds. */
  attendeeIds: string[];
  detail: string | null;
  done: boolean;
  /** Meetings only: scheduled / held / cancelled / no-show. */
  meetingStatus: string | null;
  /** Tasks only: the task (deliverable) a stage belongs to. */
  taskId: string | null;
  /** Deadlines only: the school it is for. */
  school: string | null;
};

export type EventTypeDto = {
  id: string;
  name: string;
  description: string | null;
  timeZone: string;
  color: string;
  sortOrder: number;
  createdAt: string;
};

export type TypeAssignmentDto = {
  eventKind: BuiltinType;
  eventRef: string;
  /** A built-in key or an event type id. */
  type: string;
};

const s = (v: unknown): string => (v == null ? "" : String(v));
const ns = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export const toEventType = (r: Row): EventTypeDto => ({
  id: s(r.id),
  name: s(r.name),
  description: ns(r.description),
  timeZone: s(r.time_zone),
  color: s(r.color),
  sortOrder: Number(r.sort_order ?? 0),
  createdAt: s(r.created_at),
});

export const toAssignment = (r: Row): TypeAssignmentDto => ({
  eventKind: s(r.event_kind) as BuiltinType,
  eventRef: s(r.event_ref),
  type: r.type_id ? s(r.type_id) : s(r.builtin_type),
});

export const toPracticeEvent = (r: Row) => ({
  id: s(r.id),
  studentId: ns(r.student_id),
  title: s(r.title),
  detail: ns(r.detail),
  onDate: s(r.on_date),
  startsAt: ns(r.starts_at),
  endsAt: ns(r.ends_at),
  typeId: ns(r.type_id),
  sharedWithStudent: Boolean(r.shared_with_student),
  createdAt: s(r.created_at),
  updatedAt: s(r.updated_at),
});

/** True when `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day an instant falls on, in `tz`. */
export function dayIn(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type FeedQuery = {
  from: string;
  to: string;
  tz: string;
  /** A counselor narrowing to one student (already authorized by the route). */
  studentId?: string;
  includeDone: boolean;
  includeCancelled: boolean;
};

export async function loadAssignments(request: FastifyRequest): Promise<TypeAssignmentDto[]> {
  if (request.profile.role !== "counselor") return [];
  const { data, error } = await request.db
    .from("calendar_event_type_assignments")
    .select("event_kind, event_ref, builtin_type, type_id")
    .eq("owner_id", request.auth.userId)
    .limit(5000);
  if (error) throw fromPostgrest(error);
  return (data ?? []).map((r) => toAssignment(r as Row));
}

export async function loadEventTypes(request: FastifyRequest): Promise<EventTypeDto[]> {
  if (request.profile.role !== "counselor") return [];
  const { data, error } = await request.db
    .from("calendar_event_types")
    .select("*")
    .eq("owner_id", request.auth.userId)
    .order("sort_order")
    .order("created_at")
    .limit(200);
  if (error) throw fromPostgrest(error);
  return (data ?? []).map((r) => toEventType(r as Row));
}

/**
 * Build the feed. `q.studentId` is set only after the route proved the caller
 * may view that student; a student caller is always scoped to themselves.
 */
export async function buildCalendarFeed(
  request: FastifyRequest,
  q: FeedQuery
): Promise<{ items: CalendarFeedItem[]; eventTypes: EventTypeDto[]; assignments: TypeAssignmentDto[] }> {
  const isStudent = request.profile.role === "student";
  const me = request.auth.userId;
  const scopeStudent = isStudent ? me : q.studentId;

  // Meetings are timed; widen the instant window by a day either side so a
  // session late in the evening in `tz` is not lost to UTC, then filter by
  // its local day below.
  const fromInstant = `${addDays(q.from, -1)}T00:00:00Z`;
  const toInstant = `${addDays(q.to, 2)}T00:00:00Z`;

  // ---- deadlines ----
  let deadlines = request.db
    .from("deadlines")
    .select("id, student_id, title, school, type, due_date, done, description")
    .gte("due_date", q.from)
    .lte("due_date", q.to);
  if (scopeStudent) deadlines = deadlines.eq("student_id", scopeStudent);
  if (!q.includeDone) deadlines = deadlines.eq("done", false);

  // ---- meetings ----
  // A student's own and the ones they are invited to arrive through RLS; a
  // counselor reads the calendar they own.
  let attendeeMeetingIds: string[] | null = null;
  if (scopeStudent) {
    const { data, error } = await request.db
      .from("meeting_attendees")
      .select("meeting_id")
      .eq("student_id", scopeStudent)
      .limit(2000);
    if (error) throw fromPostgrest(error);
    attendeeMeetingIds = (data ?? []).map((r) => s((r as Row).meeting_id));
  }
  let meetings = request.db
    .from("meetings")
    .select("id, student_id, counselor_id, title, starts_at, ends_at, status, agenda, location, mode")
    .gte("starts_at", fromInstant)
    .lt("starts_at", toInstant);
  if (!isStudent) meetings = meetings.eq("counselor_id", me);
  if (scopeStudent) {
    const ids = attendeeMeetingIds ?? [];
    meetings = ids.length
      ? meetings.or(`student_id.eq.${scopeStudent},id.in.(${ids.join(",")})`)
      : meetings.eq("student_id", scopeStudent);
  }
  if (!q.includeCancelled) meetings = meetings.neq("status", "cancelled");

  // ---- tasks (with their stages) ----
  let tasks = request.db
    .from("deliverables")
    .select("id, student_id, title, status, due_date, instructions, deadline_id, deliverable_stages(id, name, detail, due_date, done, deadline_id, sequence)");
  if (scopeStudent) tasks = tasks.eq("student_id", scopeStudent);
  if (!q.includeDone) tasks = tasks.neq("status", "complete");

  // ---- practice events ----
  let practice = request.db
    .from("calendar_events")
    .select("*")
    .gte("on_date", q.from)
    .lte("on_date", q.to);
  if (isStudent) practice = practice.eq("student_id", me).eq("shared_with_student", true);
  else {
    practice = practice.eq("owner_id", me);
    if (scopeStudent) practice = practice.eq("student_id", scopeStudent);
  }

  const [dl, mt, tk, pe, eventTypes, assignments] = await Promise.all([
    deadlines.order("due_date").limit(3000),
    meetings.order("starts_at").limit(2000),
    tasks.limit(1000),
    practice.order("on_date").limit(2000),
    loadEventTypes(request),
    loadAssignments(request),
  ]);
  for (const r of [dl, mt, tk, pe]) if (r.error) throw fromPostgrest(r.error);

  const moved = new Map(assignments.map((a) => [`${a.eventKind}:${a.eventRef}`, a.type]));
  const typeOf = (kind: FeedKind, ref: string) => moved.get(`${kind}:${ref}`) ?? kind;

  const items: CalendarFeedItem[] = [];
  const base = {
    attendeeIds: [] as string[],
    meetingStatus: null,
    taskId: null,
    school: null,
  };

  // Tasks first, so the deadlines they own can be skipped.
  const ownedDeadlines = new Set<string>();
  for (const raw of (tk.data ?? []) as Row[]) {
    const stages = ((raw.deliverable_stages as Row[] | null) ?? []).slice();
    if (raw.deadline_id) ownedDeadlines.add(s(raw.deadline_id));
    for (const st of stages) if (st.deadline_id) ownedDeadlines.add(s(st.deadline_id));

    const done = s(raw.status) === "complete";
    if (stages.length > 0) {
      stages.sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
      for (const st of stages) {
        const date = ns(st.due_date);
        if (!date || date < q.from || date > q.to) continue;
        if (!q.includeDone && st.done) continue;
        const ref = s(st.id);
        items.push({
          ...base,
          id: `task:${ref}`,
          kind: "task",
          ref,
          type: typeOf("task", ref),
          title: stages.length > 1 ? `${s(raw.title)}: ${s(st.name)}` : s(raw.title),
          date,
          startsAt: null,
          endsAt: null,
          allDay: true,
          studentId: s(raw.student_id),
          detail: ns(st.detail) ?? ns(raw.instructions),
          done: done || Boolean(st.done),
          taskId: s(raw.id),
        });
      }
    } else {
      const date = ns(raw.due_date);
      if (!date || date < q.from || date > q.to) continue;
      const ref = s(raw.id);
      items.push({
        ...base,
        id: `task:${ref}`,
        kind: "task",
        ref,
        type: typeOf("task", ref),
        title: s(raw.title),
        date,
        startsAt: null,
        endsAt: null,
        allDay: true,
        studentId: s(raw.student_id),
        detail: ns(raw.instructions),
        done,
        taskId: ref,
      });
    }
  }

  for (const r of (dl.data ?? []) as Row[]) {
    const ref = s(r.id);
    if (ownedDeadlines.has(ref)) continue;
    items.push({
      ...base,
      id: `deadline:${ref}`,
      kind: "deadline",
      ref,
      type: typeOf("deadline", ref),
      title: s(r.title),
      date: s(r.due_date),
      startsAt: null,
      endsAt: null,
      allDay: true,
      studentId: s(r.student_id),
      detail: ns(r.description),
      done: Boolean(r.done),
      school: ns(r.school),
    });
  }

  const meetingRows = (mt.data ?? []) as Row[];
  const attendees = new Map<string, string[]>();
  if (meetingRows.length > 0) {
    const { data, error } = await request.db
      .from("meeting_attendees")
      .select("meeting_id, student_id")
      .in(
        "meeting_id",
        meetingRows.map((m) => s(m.id))
      )
      .limit(5000);
    if (error) throw fromPostgrest(error);
    for (const a of (data ?? []) as Row[]) {
      const list = attendees.get(s(a.meeting_id)) ?? [];
      list.push(s(a.student_id));
      attendees.set(s(a.meeting_id), list);
    }
  }
  for (const r of meetingRows) {
    const startsAt = s(r.starts_at);
    const date = dayIn(startsAt, q.tz);
    if (date < q.from || date > q.to) continue;
    const ref = s(r.id);
    const primary = s(r.student_id);
    const others = (attendees.get(ref) ?? []).filter((id) => id !== primary);
    items.push({
      ...base,
      id: `meeting:${ref}`,
      kind: "meeting",
      ref,
      type: typeOf("meeting", ref),
      title: s(r.title),
      date,
      startsAt,
      endsAt: ns(r.ends_at),
      allDay: false,
      studentId: primary,
      attendeeIds: [primary, ...others],
      detail: ns(r.agenda),
      done: s(r.status) === "held",
      meetingStatus: s(r.status),
    });
  }

  for (const r of (pe.data ?? []) as Row[]) {
    const ref = s(r.id);
    const own = r.type_id ? s(r.type_id) : null;
    const startsAt = ns(r.starts_at);
    items.push({
      ...base,
      id: `milestone:${ref}`,
      kind: "milestone",
      ref,
      // A practice event made on a custom type is that type; a reassignment
      // still wins, as everywhere else.
      type: moved.get(`milestone:${ref}`) ?? own ?? "milestone",
      title: s(r.title),
      date: s(r.on_date),
      startsAt,
      endsAt: ns(r.ends_at),
      allDay: startsAt === null,
      studentId: ns(r.student_id),
      detail: ns(r.detail),
      done: false,
    });
  }

  items.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(b.allDay) - Number(a.allDay) ||
      (a.startsAt ?? "").localeCompare(b.startsAt ?? "") ||
      a.title.localeCompare(b.title)
  );

  return { items, eventTypes, assignments };
}
