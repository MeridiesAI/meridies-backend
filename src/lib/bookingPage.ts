/**
 * A counselor's own Google Calendar booking page (an appointment schedule),
 * linked from Settings > Booking and shown to their students as "Book on
 * {counselor}'s calendar", beside Meridies' own booking or instead of it.
 *
 * Stored on `booking_settings` (`booking_page_url`, `booking_page_mode`), which
 * `20261118000001_booking_page_link.sql` adds; until it is applied (`bookingPageReady` false) no query
 * names those columns, a save naming them is 503 `booking_page_unavailable`,
 * and students see no link.
 *
 * Only Google's own booking-page hosts are accepted, over https, with no
 * credentials or port: `calendar.app.google/<id>` (the short link Google
 * gives) and `calendar.google.com/calendar/...` (the long form). The link is
 * handed to a student's browser, so any other host would let a counselor's
 * account point students at an arbitrary site. The database CHECK holds the
 * same rule for a direct write.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

export const BOOKING_PAGE_MODES = ["alongside", "instead"] as const;
export type BookingPageMode = (typeof BOOKING_PAGE_MODES)[number];

export const BOOKING_PAGE_MAX = 500;
export const BOOKING_PAGE_COLUMNS = "booking_page_url, booking_page_mode";

export const BOOKING_PAGE_HELP =
  "Paste your Google Calendar booking page link: https://calendar.app.google/… or https://calendar.google.com/calendar/…";

/** A Google Calendar booking page link, normalised, or why not. */
export function parseBookingPageUrl(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: BOOKING_PAGE_HELP };
  const s = raw.trim();
  if (s.length === 0 || s.length > BOOKING_PAGE_MAX || /[\s"<>\\]/.test(s)) return { ok: false, message: BOOKING_PAGE_HELP };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: BOOKING_PAGE_HELP };
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return { ok: false, message: BOOKING_PAGE_HELP };
  const host = u.hostname.toLowerCase();
  const fits =
    (host === "calendar.app.google" && u.pathname.length > 1) ||
    (host === "calendar.google.com" && u.pathname.startsWith("/calendar/") && u.pathname.length > "/calendar/".length);
  if (!fits) return { ok: false, message: BOOKING_PAGE_HELP };
  const value = u.toString();
  if (value.length > BOOKING_PAGE_MAX) return { ok: false, message: BOOKING_PAGE_HELP };
  return { ok: true, value };
}

/** A stored value read back: kept only when it still passes the rule, else null. */
export function storedBookingPage(url: unknown, mode: unknown): { url: string; mode: BookingPageMode } | null {
  const parsed = parseBookingPageUrl(url);
  if (!parsed.ok) return null;
  return { url: parsed.value, mode: mode === "instead" ? "instead" : "alongside" };
}

export function bookingPageUnavailable(): HttpError {
  return new HttpError(503, "Linking a Google booking page isn't switched on yet", "booking_page_unavailable");
}

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = Number.NEGATIVE_INFINITY;

/**
 * Whether the columns exist, from a zero-row read: ready is kept for the
 * process, missing for 30 s (so applying the migration takes effect without a
 * deploy). Any other error reads as not ready, uncached: the page link is an
 * extra, never a reason for booking itself to fail.
 */
export async function bookingPageReady(db: SupabaseClient, now: number = Date.now()): Promise<boolean> {
  if (ready) return true;
  if (now - missingAt < MISSING_RECHECK_MS) return false;
  try {
    const { error } = await db.from("booking_settings").select(BOOKING_PAGE_COLUMNS).limit(0);
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
export function resetBookingPageReady(): void {
  ready = false;
  missingAt = Number.NEGATIVE_INFINITY;
}
