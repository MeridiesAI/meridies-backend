/**
 * Student booking, part 1 (20261111000001): the counselor's booking settings
 * and meeting types, and the slots a student is offered.
 *
 * The counselor's own routes (routes/booking.ts) run on `request.db`; the
 * tables are owner-only. A student never reads them directly: their routes
 * (routes/studentBooking.ts) take the counselor from the student's own
 * `profiles.counselor_id` (the row `authenticate` loaded, never a client id),
 * require that counselor approved (`isCounselorApproved`, fail closed) and
 * booking enabled, and only then read the counselor's rows with the service
 * role. Busy time is the counselor's scheduled Meridies meetings plus their
 * connected calendar (`listBusy`), never shown to the student: only the free
 * slots leave the server.
 */

import { readFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCounselorApproved } from "./access.js";
import { busyWindow, clampWindow, computeSlots, type BusyInterval, type HoursRange } from "./bookingSlots.js";
import { env } from "../env.js";
import { HttpError, fromPostgrest } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import { busyReconnectNeeded, busyUnavailable, listBusy } from "./suiteApi.js";
import { serviceClient } from "./supabase.js";
import { SUITE_PROVIDERS, type SuiteProvider } from "./oauth.js";

type Row = Record<string, unknown>;

export const BOOKING_MODES = ["google-meet", "teams", "in-person", "phone"] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export const SETTINGS_COLUMNS =
  "counselor_id, enabled, time_zone, weekly_hours, min_notice_hours, max_days_ahead, buffer_minutes, cancel_cutoff_hours, students_can_reschedule, created_at, updated_at";
export const TYPE_COLUMNS = "id, counselor_id, name, duration_minutes, mode, active, sort_order, created_at, updated_at";

/** What a counselor who never saved settings has: the table's defaults. */
export const DEFAULT_SETTINGS = {
  enabled: false,
  time_zone: "America/New_York",
  weekly_hours: {},
  min_notice_hours: 24,
  max_days_ahead: 30,
  buffer_minutes: 0,
  cancel_cutoff_hours: 24,
  students_can_reschedule: true,
} as const;

/** A meeting with no end blocks an hour, the same as book_meeting_slot. */
export const OPEN_ENDED_MEETING_MS = 60 * 60_000;

export function bookingUnavailable(): HttpError {
  return new HttpError(503, "Booking isn't switched on yet", "booking_unavailable");
}

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

/** Whether the migration is in: a ready answer is kept for the process, a missing one for 30 s. */
export async function bookingReady(db: SupabaseClient): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < MISSING_RECHECK_MS) return false;
  const [a, b] = await Promise.all([
    db.from("booking_settings").select("counselor_id").limit(0),
    db.from("booking_meeting_types").select("id").limit(0),
  ]);
  const error = a.error ?? b.error;
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw fromPostgrest(error);
}

export async function requireBookingReady(db: SupabaseClient): Promise<void> {
  if (!(await bookingReady(db))) throw bookingUnavailable();
}

const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export type BookingSettingsDto = {
  saved: boolean;
  enabled: boolean;
  timeZone: string;
  weeklyHours: Record<string, HoursRange[]>;
  minNoticeHours: number;
  maxDaysAhead: number;
  bufferMinutes: number;
  cancelCutoffHours: number;
  studentsCanReschedule: boolean;
  updatedAt: string | null;
};

export function toSettings(r: Row | null): BookingSettingsDto {
  const row: Row = r ?? { ...DEFAULT_SETTINGS };
  const hours = row.weekly_hours && typeof row.weekly_hours === "object" && !Array.isArray(row.weekly_hours) ? row.weekly_hours : {};
  return {
    saved: Boolean(r),
    enabled: row.enabled === true,
    timeZone: str(row.time_zone) || DEFAULT_SETTINGS.time_zone,
    weeklyHours: hours as Record<string, HoursRange[]>,
    minNoticeHours: num(row.min_notice_hours, DEFAULT_SETTINGS.min_notice_hours),
    maxDaysAhead: num(row.max_days_ahead, DEFAULT_SETTINGS.max_days_ahead),
    bufferMinutes: num(row.buffer_minutes, DEFAULT_SETTINGS.buffer_minutes),
    cancelCutoffHours: num(row.cancel_cutoff_hours, DEFAULT_SETTINGS.cancel_cutoff_hours),
    studentsCanReschedule: row.students_can_reschedule !== false,
    updatedAt: r && r.updated_at ? str(r.updated_at) : null,
  };
}

export type MeetingTypeDto = {
  id: string;
  name: string;
  durationMinutes: number;
  mode: BookingMode;
  active: boolean;
  sortOrder: number;
};

export function toMeetingType(r: Row): MeetingTypeDto {
  return {
    id: str(r.id),
    name: str(r.name),
    durationMinutes: num(r.duration_minutes, 30),
    mode: str(r.mode) as BookingMode,
    active: r.active !== false,
    sortOrder: num(r.sort_order, 0),
  };
}

/** What a student is told about their counselor's booking: the types, or why there are none. */
export type StudentBookingContext =
  | { ok: true; svc: SupabaseClient; counselorId: string; settings: BookingSettingsDto }
  | { ok: false; reason: "no_counselor" | "not_available" };

/**
 * The caller's (a student's) counselor, when they can be booked: from the
 * caller's own profile row, approved, with booking enabled. An unapproved
 * counselor and booking switched off read the same (`not_available`), so the
 * answer says nothing about the counselor's account.
 */
export async function studentBookingContext(request: FastifyRequest): Promise<StudentBookingContext> {
  const svc = serviceClient();
  if (!svc) throw bookingUnavailable();
  await requireBookingReady(svc);

  const counselorId = request.profile.counselor_id;
  if (!counselorId) return { ok: false, reason: "no_counselor" };
  if (!(await isCounselorApproved(svc, counselorId))) return { ok: false, reason: "not_available" };

  const { data, error } = await svc.from("booking_settings").select(SETTINGS_COLUMNS).eq("counselor_id", counselorId).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data || (data as Row).enabled !== true) return { ok: false, reason: "not_available" };
  return { ok: true, svc, counselorId, settings: toSettings(data as Row) };
}

/** The counselor's active meeting types, in their order. */
export async function activeTypes(svc: SupabaseClient, counselorId: string): Promise<MeetingTypeDto[]> {
  const { data, error } = await svc
    .from("booking_meeting_types")
    .select(TYPE_COLUMNS)
    .eq("counselor_id", counselorId)
    .eq("active", true)
    .order("sort_order")
    .order("created_at")
    .limit(100);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).map(toMeetingType);
}

/** The longest meeting type (minutes): a slot starting just before `to` still runs this far past it. */
const MAX_TYPE_MINUTES = 180;

/**
 * A meeting a reschedule is moving: it never blocks its own new time, neither as a
 * Meridies meeting (by id) nor as its own event on the counselor's calendar (the busy
 * interval with exactly its start and end, when it has an event there).
 */
export type IgnoreMeeting = { id: string; startsAt: string; endsAt: string | null; onCalendar: boolean };

/**
 * The counselor's scheduled Meridies meetings that could touch a slot starting in
 * [from, to) once widened by the buffer (a slot starting just before `to` runs up to
 * MAX_TYPE_MINUTES past it).
 */
export async function meetingBusy(
  svc: SupabaseClient,
  counselorId: string,
  from: string,
  to: string,
  bufferMinutes: number,
  ignoreId: string | null = null
): Promise<BusyInterval[]> {
  const pad = bufferMinutes * 60_000;
  // A meeting is at most a day long in practice; reach back a day so one that started earlier still counts.
  const lo = new Date(Date.parse(from) - pad - 24 * 3_600_000).toISOString();
  const hi = new Date(Date.parse(to) + pad + MAX_TYPE_MINUTES * 60_000).toISOString();
  const { data, error } = await svc
    .from("meetings")
    .select("id, starts_at, ends_at")
    .eq("counselor_id", counselorId)
    .eq("status", "scheduled")
    .gte("starts_at", lo)
    .lt("starts_at", hi)
    .limit(2000);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).filter((m) => !ignoreId || str(m.id) !== ignoreId).map((m) => {
    const start = Date.parse(str(m.starts_at));
    const end = m.ends_at ? Date.parse(str(m.ends_at)) : start + OPEN_ENDED_MEETING_MS;
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  });
}

export type BusyFixtureEnv = { BOOKING_BUSY_FIXTURE?: string | undefined; NODE_ENV?: string | undefined };
const FIXTURE_ALLOWED_ENVS: readonly string[] = ["development", "test"];

/**
 * A message for index.ts to refuse to start with, or null. The busy-time stand-in
 * would offer students slots over the counselor's real calendar, so it runs only
 * when the RAW NODE_ENV is development or test (env.NODE_ENV defaults to
 * development when unset): production is refused, and so is anything else.
 */
export function bookingBusyFixtureRefusal(e: BusyFixtureEnv): string | null {
  if (!e.BOOKING_BUSY_FIXTURE) return null;
  if (e.NODE_ENV === "production") {
    return "refusing to start: BOOKING_BUSY_FIXTURE is for tests only and must not be set when NODE_ENV=production";
  }
  if (e.NODE_ENV === undefined || !FIXTURE_ALLOWED_ENVS.includes(e.NODE_ENV)) {
    return "refusing to start: BOOKING_BUSY_FIXTURE is for tests only and needs NODE_ENV=development or NODE_ENV=test";
  }
  return null;
}

/** The stand-in's path when it is set and allowed, else null. */
function busyFixturePath(): string | null {
  const e = { BOOKING_BUSY_FIXTURE: env.BOOKING_BUSY_FIXTURE, NODE_ENV: process.env.NODE_ENV };
  return e.BOOKING_BUSY_FIXTURE && bookingBusyFixtureRefusal(e) === null ? e.BOOKING_BUSY_FIXTURE : null;
}

function fixtureBusy(path: string, counselorId: string): BusyInterval[] {
  const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, BusyInterval[]>;
  return Array.isArray(all[counselorId]) ? all[counselorId] : [];
}

/**
 * The counselor's busy time on the calendars they connected. A counselor with
 * no calendar connected (no grant, or a grant without Calendar) has none: their
 * Meridies meetings still count. A connected calendar we couldn't read stops
 * the answer, so slots are never offered over busy time nobody checked: a grant
 * that no longer works is 409 `calendar_reconnect_needed`, an outage 503
 * `calendar_busy_unavailable`. Our own per-counselor limit passes through as 429.
 */
export async function calendarBusy(
  svc: SupabaseClient,
  counselorId: string,
  from: string,
  to: string,
  timeZone: string,
  log: FastifyRequest["log"]
): Promise<BusyInterval[]> {
  const fixture = busyFixturePath();
  if (fixture) return fixtureBusy(fixture, counselorId);

  const { data, error } = await svc.from("integration_tokens").select("provider").eq("owner_id", counselorId).limit(10);
  if (error) throw busyUnavailable();
  const providers = new Set(((data ?? []) as Row[]).map((r) => str(r.provider)));
  const out: BusyInterval[] = [];
  for (const provider of SUITE_PROVIDERS as readonly SuiteProvider[]) {
    if (!providers.has(provider)) continue;
    try {
      out.push(...(await listBusy(counselorId, provider, from, to, timeZone, log)));
    } catch (e) {
      // A provider's own 429 is already a 503 here (listBusy); a 429 that reaches this is our limiter's.
      if (e instanceof HttpError && e.statusCode === 429) throw e;
      log.warn({ provider, status: e instanceof HttpError ? e.statusCode : null, code: e instanceof HttpError ? e.code : null }, "booking busy read failed");
      // 409 is a grant problem (the refresh refused, or the provider refused the token): it won't fix itself.
      if (e instanceof HttpError && e.statusCode === 409) throw busyReconnectNeeded();
      throw busyUnavailable();
    }
  }
  return out;
}

/** Calendar busy time without the moving meeting's own event (the interval with exactly its times). */
function withoutOwnEvent(busy: BusyInterval[], ignore: IgnoreMeeting): BusyInterval[] {
  const start = Date.parse(ignore.startsAt);
  const end = ignore.endsAt ? Date.parse(ignore.endsAt) : start + OPEN_ENDED_MEETING_MS;
  return busy.filter((b) => !(Date.parse(b.start) === start && Date.parse(b.end) === end));
}

export type SlotsAnswer = {
  timeZone: string;
  typeId: string;
  durationMinutes: number;
  from: string | null;
  to: string | null;
  slots: { startsAt: string; endsAt: string }[];
};

/** The free slots for one of the counselor's active types, in the asked window as clamped. */
export async function slotsFor(
  request: FastifyRequest,
  ctx: Extract<StudentBookingContext, { ok: true }>,
  type: Pick<MeetingTypeDto, "id" | "durationMinutes">,
  window: { from: string; to: string },
  now = new Date(),
  ignore: IgnoreMeeting | null = null
): Promise<SlotsAnswer> {
  const s = ctx.settings;
  const base = { timeZone: s.timeZone, typeId: type.id, durationMinutes: type.durationMinutes };
  const clamped = clampWindow({ from: window.from, to: window.to, now, maxDaysAhead: s.maxDaysAhead });
  if (!clamped) return { ...base, from: null, to: null, slots: [] };
  const calWindow = busyWindow(clamped.from, clamped.to, s.bufferMinutes, s.timeZone);

  const [meetings, rawCalendar] = await Promise.all([
    meetingBusy(ctx.svc, ctx.counselorId, clamped.from, clamped.to, s.bufferMinutes, ignore?.id ?? null),
    // Asked for whole local days (widened by the buffer first), so requests seconds apart share listBusy's
    // 60 s cache and its rate-limit charge; computeSlots still filters by the exact window and `now`.
    calendarBusy(ctx.svc, ctx.counselorId, calWindow.from, calWindow.to, s.timeZone, request.log),
  ]);
  const calendar = ignore?.onCalendar ? withoutOwnEvent(rawCalendar, ignore) : rawCalendar;
  const starts = computeSlots({
    timeZone: s.timeZone,
    weeklyHours: s.weeklyHours,
    durationMinutes: type.durationMinutes,
    bufferMinutes: s.bufferMinutes,
    minNoticeHours: s.minNoticeHours,
    maxDaysAhead: s.maxDaysAhead,
    from: clamped.from,
    to: clamped.to,
    busy: [...meetings, ...calendar],
    now,
  });
  return {
    ...base,
    ...clamped,
    slots: starts.map((startsAt) => ({
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + type.durationMinutes * 60_000).toISOString(),
    })),
  };
}
