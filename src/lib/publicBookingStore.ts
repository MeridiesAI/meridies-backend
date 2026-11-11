/**
 * The public booking link's storage (20261121000001): whether the migration is in, and the busy time its bookings
 * add to a counselor's calendar. Kept apart from lib/publicBooking.ts so lib/booking.ts (student slots) and
 * lib/calendarFeed.ts can read it without importing the link's routes' logic.
 *
 * Until the migration is applied `publicBookingReady` is false and nothing names `public_bookings` or the two
 * booking_settings columns: slots count no public bookings (there are none), the calendar feed shows none, the
 * public routes answer 503 `public_booking_unavailable` and GET /booking/settings leaves the new fields out.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusyInterval } from "./bookingSlots.js";
import { fromPostgrest, HttpError } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;

export const PUBLIC_SETTINGS_COLUMNS = "public_slug, public_booking_enabled";
export const PUBLIC_BOOKING_COLUMNS =
  "id, counselor_id, booking_type_id, type_name, mode, name, email, phone, note, starts_at, ends_at, status, join_url, calendar_provider, calendar_event_id, contact_id, cancelled_at, created_at";

export function publicBookingUnavailable(): HttpError {
  return new HttpError(503, "Booking links aren't switched on yet", "public_booking_unavailable");
}

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = Number.NEGATIVE_INFINITY;

/**
 * Whether the migration is in, from two zero-row reads: ready is kept for the process, missing for 30 s (so
 * applying it takes effect without a deploy). Any other error reads as not ready, uncached: the link is an extra,
 * never a reason for student booking or the calendar to fail. (book_meeting_slot checks public bookings itself,
 * so a slot read that skipped them can still never double-book.)
 */
export async function publicBookingReady(db: SupabaseClient, now: number = Date.now()): Promise<boolean> {
  if (ready) return true;
  if (now - missingAt < MISSING_RECHECK_MS) return false;
  try {
    const [a, b] = await Promise.all([
      db.from("booking_settings").select(PUBLIC_SETTINGS_COLUMNS).limit(0),
      db.from("public_bookings").select("id").limit(0),
    ]);
    const error = a.error ?? b.error;
    if (!error) {
      ready = true;
      return true;
    }
    if (isResultsNotApplied(error)) missingAt = now;
    return false;
  } catch {
    return false;
  }
}

/** For tests. */
export function resetPublicBookingReady(): void {
  ready = false;
  missingAt = Number.NEGATIVE_INFINITY;
}

/** For tests: read as applied without a probe. */
export function markPublicBookingReady(): void {
  ready = true;
}

/**
 * A counselor's scheduled public bookings starting in [lo, hi), as busy time. Read with the service role by the
 * slot code (lib/booking.ts meetingBusy), keyed by the counselor the caller's own context resolved.
 */
export async function publicBookingBusy(svc: SupabaseClient, counselorId: string, lo: string, hi: string): Promise<BusyInterval[]> {
  const { data, error } = await svc
    .from("public_bookings")
    .select("starts_at, ends_at")
    .eq("counselor_id", counselorId)
    .eq("status", "scheduled")
    .gte("starts_at", lo)
    .lt("starts_at", hi)
    .limit(2000);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).map((r) => ({
    start: new Date(String(r.starts_at)).toISOString(),
    end: new Date(String(r.ends_at)).toISOString(),
  }));
}
