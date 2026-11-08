/**
 * The subscribable calendar feed (routes/calendarIcal.ts): the token, and the
 * .ics a counselor's calendar app reads.
 *
 * The token is the whole credential: 32 random bytes (base64url, 43
 * characters), stored only as its sha256 in `calendar_feed_tokens`. The file
 * is built under the service role (no user is signed in), so everything here
 * is keyed by the token's counselor in the query itself: approval first
 * (approvedCounselorIds; unapproved or revoked reads as no feed), then their
 * whole caseload (fullCaseloadStudentIds: every student they may view, read
 * page by page, never unscoped) handed to buildCalendarFeed, which reads in
 * batches. What the file may say is decided by feedIcsEvents (lib/ics.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { approvedCounselorIds } from "./access.js";
import { buildCalendarFeed, dayIn, inChunks, isTimeZone } from "./calendarFeed.js";
import { fullCaseloadStudentIds } from "./guards.js";
import { buildFeedIcs, feedIcsEvents } from "./ics.js";

/** The token as it appears in the URL. */
export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The window a subscribed calendar is given: 30 days back, a year ahead. */
export const FEED_DAYS_BACK = 30;
export const FEED_DAYS_AHEAD = 365;

export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newFeedToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashFeedToken(token) };
}

/** The https URL and its webcal:// twin (what calendar apps open on a click). */
export function feedUrls(publicApiUrl: string, token: string): { url: string; webcalUrl: string } {
  const url = `${publicApiUrl.replace(/\/+$/, "")}/calendar/ical/${token}.ics`;
  return { url, webcalUrl: url.replace(/^https?:\/\//i, "webcal://") };
}

/** `[from, to]` in `tz` around `now`. */
export function feedWindow(now: Date, tz: string): { from: string; to: string } {
  const at = (days: number) => dayIn(new Date(now.getTime() + days * 86_400_000).toISOString(), tz);
  return { from: at(-FEED_DAYS_BACK), to: at(FEED_DAYS_AHEAD) };
}

/**
 * The counselor's calendar as an .ics, or null when there is none to give
 * (not an approved counselor). `svc` is the service client.
 */
export async function counselorFeedIcs(svc: SupabaseClient, counselorId: string, now: Date = new Date()): Promise<string | null> {
  const approved = await approvedCounselorIds(svc, [counselorId]);
  if (!approved.has(counselorId)) return null;

  const prof = await svc.from("profiles").select("timezone").eq("id", counselorId).maybeSingle();
  if (prof.error) throw new Error(`calendar feed: profile read failed (${prof.error.code ?? "unknown"})`);
  const saved = (prof.data as { timezone?: string | null } | null)?.timezone ?? null;
  const tz = saved && isTimeZone(saved) ? saved : "UTC";

  const caseload = await fullCaseloadStudentIds(svc, counselorId);
  const { items } = await buildCalendarFeed(
    { db: svc, ownerId: counselorId, role: "counselor", caseload },
    { ...feedWindow(now, tz), tz, includeDone: true, includeCancelled: false }
  );

  // Names only for students on this counselor's caseload.
  const allowed = new Set(caseload);
  const wanted = new Set<string>();
  for (const it of items) {
    if (it.studentId && allowed.has(it.studentId)) wanted.add(it.studentId);
    for (const a of it.attendeeIds) if (allowed.has(a)) wanted.add(a);
  }
  const names = new Map<string, string>();
  for (const ids of inChunks([...wanted], 200)) {
    const { data, error } = await svc.from("profiles").select("id, full_name").in("id", ids);
    if (error) throw new Error(`calendar feed: name read failed (${error.code ?? "unknown"})`);
    for (const r of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
      if (r.full_name) names.set(String(r.id), r.full_name);
    }
  }
  return buildFeedIcs(feedIcsEvents(items, names), { now });
}
