/**
 * The public booking link (20261121000001): every counselor has a share link, /public/book/<slug>, that anyone
 * (a prospective family, no Meridies account) can use to book one of the counselor's active meeting types, in
 * the same free slots their students see. Routes: routes/publicBooking.ts (public) and the slug's two counselor
 * routes in routes/booking.ts.
 *
 * The slug is the counselor's name slugified plus a 5-character random suffix ("jane-doe-4f7km"). Only the API
 * writes it, with the service role (a database trigger refuses a user session's write): on the first
 * GET /booking/settings of a settings row without one, and on POST /booking/public-link/rotate. A link answers
 * only while the counselor is approved, has booking set up and on (and not replaced by a Google booking page),
 * and has the link on; anything else, an unknown slug included, is the same 404 `booking_link_not_found`, so a
 * link says nothing about the account behind it.
 *
 * A booking is accepted only at a start the slots answer offers now (the student code's slotOpen: weekly hours,
 * meetings, public bookings, the connected calendar's busy time, buffer, notice); duration and mode come from the
 * type. It is reserved with public.book_public_slot under the same advisory lock as student booking, so a family
 * and a student can't take one slot (409 `slot_unavailable` either way), then put on the counselor's connected
 * calendar like a student's booking (lib/bookingCalendar.ts; a provider failure releases it, 503
 * `calendar_write_failed`). After the answer: the booker is emailed an .ics invite, the counselor gets a bell
 * notice and an email with an .ics copy, and the booker goes on the Contact Pipeline
 * (public.public_booking_to_pipeline). A filled-in `website` field (a honeypot real people never see) gets a
 * 201 that looks like a booking and stores nothing.
 */

import { createHash, randomInt, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isCounselorApproved } from "./access.js";
import {
  bookingReady,
  meridiesBookingOn,
  settingsColumns,
  toSettings,
  type BookingSettingsDto,
  type MeetingTypeDto,
  type StudentBookingContext,
} from "./booking.js";
import { bookingConferenceProvider } from "./bookingCalendar.js";
import { bookingPageReady } from "./bookingPage.js";
import { brandedEmail, brandedText } from "./email.js";
import { fromPostgrest, HttpError } from "./errors.js";
import { buildMeetingIcs, meetingWhere, plainLine, type IcsMethod, type IcsMode } from "./ics.js";
import { readPractice } from "./invoiceDocument.js";
import { whenLong, whenShort } from "./meetingInvites.js";
import type { SuiteProvider } from "./oauth.js";
import { PUBLIC_SETTINGS_COLUMNS, publicBookingReady, publicBookingUnavailable } from "./publicBookingStore.js";
import type { CalendarEventInput } from "./suiteApi.js";

type Row = Record<string, unknown>;

const MINUTE = 60_000;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

// ---- the slug ---------------------------------------------------------------------------------------

/** 32 characters, no l, o, 0 or 1 (nothing to misread when the link is read aloud). */
export const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const SLUG_SUFFIX_LENGTH = 5;
const SLUG_BASE_MAX = 40;
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The name part: lower-case, accents folded, anything else a single dash, at most 40 characters; "counselor" when nothing is left. */
export function slugBase(name: string | null | undefined): string {
  const folded = (name ?? "")
    .slice(0, 300)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ø/g, "o");
  const dashed = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-/, "").replace(/-$/, "");
  const cut = dashed.slice(0, SLUG_BASE_MAX).replace(/-$/, "");
  return cut || "counselor";
}

/** The random part. `pick(n)` returns 0..n-1 (crypto.randomInt by default). */
export function slugSuffix(pick: (n: number) => number = randomInt): string {
  let out = "";
  for (let i = 0; i < SLUG_SUFFIX_LENGTH; i++) out += SLUG_ALPHABET[pick(SLUG_ALPHABET.length)];
  return out;
}

export function makeSlug(name: string | null | undefined, pick?: (n: number) => number): string {
  return `${slugBase(name)}-${slugSuffix(pick)}`;
}

/** The database CHECK's rule: 3-64 characters of lower-case letters and digits in dash-separated runs. */
export function isPublicSlug(v: unknown): v is string {
  return typeof v === "string" && v.length >= 3 && v.length <= 64 && SLUG_SHAPE.test(v);
}

/**
 * Write a new slug for the counselor's settings row, with the service role (a user session can't), and return
 * it. `onlyIfMissing`: only when the row has none yet (the lazy first GET), returning whatever is there when
 * another request set one first. Null when the counselor has no settings row. A taken slug (unique index) is
 * retried with a new suffix.
 */
export async function writeSlug(
  svc: SupabaseClient,
  counselorId: string,
  name: string | null | undefined,
  opts: { onlyIfMissing: boolean },
  pick?: (n: number) => number
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = makeSlug(name, pick);
    let q = svc.from("booking_settings").update({ public_slug: slug }).eq("counselor_id", counselorId);
    if (opts.onlyIfMissing) q = q.is("public_slug", null);
    const { data, error } = await q.select("public_slug").maybeSingle();
    if (error) {
      if (error.code === "23505") continue;
      throw fromPostgrest(error);
    }
    if (data) return slug;
    if (!opts.onlyIfMissing) return null;
    const { data: now, error: readError } = await svc.from("booking_settings").select("public_slug").eq("counselor_id", counselorId).maybeSingle();
    if (readError) throw fromPostgrest(readError);
    const current = (now as Row | null)?.public_slug;
    return isPublicSlug(current) ? current : null;
  }
  throw new HttpError(503, "Couldn't make a booking link. Try again.", "public_booking_unavailable");
}

// ---- the link -------------------------------------------------------------------------------------

export const bookingLinkNotFound = () => new HttpError(404, "This booking link isn't available", "booking_link_not_found");
export const typeNotFound = () => new HttpError(404, "That meeting type isn't available", "type_not_found");
export const slotUnavailable = () => new HttpError(409, "That time isn't available any more. Pick another.", "slot_unavailable");
export const calendarWriteFailed = () =>
  new HttpError(503, "The counselor's calendar couldn't be updated, so nothing was booked. Try again shortly.", "calendar_write_failed");

/** Whether a link takes visitors: approved, booking set up and on (not replaced by a Google page), the link on. */
export function publicLinkOpen(i: { approved: boolean; row: Row | null }): boolean {
  if (!i.approved || !i.row) return false;
  return i.row.public_booking_enabled !== false && isPublicSlug(i.row.public_slug) && meridiesBookingOn(i.row);
}

/** The student code's booking context, reached through a link instead of a student's own counselor. */
export type PublicLinkContext = Extract<StudentBookingContext, { ok: true }> & { row: Row };

/** The counselor a slug names, when their link is open; else 404 `booking_link_not_found` (503 before the migration). */
export async function resolvePublicLink(svc: SupabaseClient, slug: string): Promise<PublicLinkContext> {
  if (!(await bookingReady(svc)) || !(await publicBookingReady(svc))) throw publicBookingUnavailable();
  if (!isPublicSlug(slug)) throw bookingLinkNotFound();
  const pageReady = await bookingPageReady(svc);
  const { data, error } = await svc.from("booking_settings").select(settingsColumns(pageReady, true)).eq("public_slug", slug).maybeSingle();
  if (error) throw fromPostgrest(error);
  const row = (data as Row | null) ?? null;
  if (!row) throw bookingLinkNotFound();
  const counselorId = str(row.counselor_id);
  const approved = await isCounselorApproved(svc, counselorId);
  if (!publicLinkOpen({ approved, row })) throw bookingLinkNotFound();
  return { ok: true, svc, counselorId, settings: toSettings(row, pageReady, true), row };
}

export type PublicCounselor = {
  name: string;
  practiceName: string | null;
  logoUrl: string | null;
  /** Never sent to the visitor: the invite's organizer and the notice's address. */
  email: string | null;
};

/** Who the link books: the name, a firm's name and the practice logo (https only); the address stays server-side. */
export async function publicCounselor(svc: SupabaseClient, counselorId: string): Promise<PublicCounselor> {
  const { data, error } = await svc.from("profiles").select("full_name, firm_id, email").eq("id", counselorId).maybeSingle();
  if (error) throw fromPostgrest(error);
  const p = (data as Row | null) ?? {};
  const name = plainLine(str(p.full_name), 120) || "Your counselor";
  const firmId = typeof p.firm_id === "string" ? p.firm_id : null;
  const practice = await readPractice(svc, { firmId, counselorId }, name);
  const logo = practice.logoUrl && /^https:\/\/[^\s"<>]+$/.test(practice.logoUrl) && practice.logoUrl.length <= 2000 ? practice.logoUrl : null;
  const email = typeof p.email === "string" && /^[^\s@]+@[^\s@]+$/.test(p.email) ? p.email : null;
  return { name, practiceName: firmId ? plainLine(practice.name, 120) || null : null, logoUrl: logo, email };
}

export type PublicPageAnswer = {
  counselor: { name: string; practiceName: string | null; logoUrl: string | null; timezone: string };
  types: { id: string; name: string; durationMinutes: number; mode: MeetingTypeDto["mode"] }[];
};

export function publicPageAnswer(counselor: PublicCounselor, settings: BookingSettingsDto, types: MeetingTypeDto[]): PublicPageAnswer {
  return {
    counselor: { name: counselor.name, practiceName: counselor.practiceName, logoUrl: counselor.logoUrl, timezone: settings.timeZone },
    types: types.map((t) => ({ id: t.id, name: t.name, durationMinutes: t.durationMinutes, mode: t.mode })),
  };
}

// ---- booking ------------------------------------------------------------------------------------------

// C0/C1 controls and the Unicode line and paragraph separators (built from char codes so the source stays ASCII).
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROLS_RE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${SEPARATORS}]`);
const CONTROLS_BUT_LINES_RE = new RegExp(`[\\x00-\\x09\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f${SEPARATORS}]`);
const NO_CONTROLS = (v: string) => !CONTROLS_RE.test(v);
const NO_CONTROLS_BUT_LINES = (v: string) => !CONTROLS_BUT_LINES_RE.test(v);

export const publicBookBody = z
  .object({
    typeId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    name: z.string().trim().min(1).max(120).refine(NO_CONTROLS, "Use letters, not control characters"),
    email: z.string().trim().max(320).email(),
    phone: z.string().trim().max(40).refine(NO_CONTROLS, "That isn't a phone number").nullable().optional(),
    note: z.string().trim().max(1000).refine(NO_CONTROLS_BUT_LINES, "Remove the control characters").nullable().optional(),
    /** A honeypot: the page hides it, so only a bot fills it in. */
    website: z.string().max(500).nullable().optional(),
  })
  .strict();
export type PublicBookBody = z.infer<typeof publicBookBody>;

/** Upcoming scheduled bookings one address may hold with one counselor at once. */
export const MAX_UPCOMING_PER_EMAIL = 3;

export function isHoneypot(body: { website?: string | null }): boolean {
  return typeof body.website === "string" && body.website.trim().length > 0;
}

export type PublicBookingAnswer = {
  booking: { id: string; startsAt: string; endsAt: string; mode: MeetingTypeDto["mode"]; joinUrl: string | null; typeName: string };
};

/** What a bot that filled the honeypot is told: a booking that doesn't exist. */
export function decoyAnswer(type: MeetingTypeDto, startsAt: string): PublicBookingAnswer {
  const start = new Date(startsAt).toISOString();
  return {
    booking: {
      id: randomUUID(),
      startsAt: start,
      endsAt: new Date(Date.parse(start) + type.durationMinutes * MINUTE).toISOString(),
      mode: type.mode,
      joinUrl: null,
      typeName: type.name,
    },
  };
}

/** book_public_slot's errors, as the route answers them. A race and a stale slot read the same. */
export function publicRpcError(error: { code?: string; message?: string }): HttpError | null {
  const m = error.message ?? "";
  if (m.includes("slot_taken") || m.includes("invalid_slot")) return slotUnavailable();
  if (m.includes("booking_disabled")) return bookingLinkNotFound();
  if (m.includes("type_not_found")) return typeNotFound();
  return null;
}

/** The counselor's calendar event: "<type> with <name>", with the booker's details in its description. */
export function publicEventInput(type: MeetingTypeDto, b: { name: string; email: string; phone: string | null; note: string | null }, startsAt: string, endsAt: string): CalendarEventInput {
  const lines = [
    "Booked through your Meridies booking link.",
    `Email: ${b.email}`,
    ...(b.phone ? [`Phone: ${b.phone}`] : []),
    ...(b.note ? ["", `Note: ${b.note}`] : []),
  ];
  return { title: plainLine(`${type.name} with ${b.name}`, 300), startsAt, endsAt, description: lines.join("\n") };
}

export type PublicBookingIo = {
  now(): Date;
  /** Whether `startsAt` is one of the starts GET /public/book/:slug/slots offers for this type now. */
  slotOpen(type: MeetingTypeDto, startsAt: string): Promise<boolean>;
  countUpcomingForEmail(email: string): Promise<number>;
  /** book_public_slot; throws its errors as HttpErrors (publicRpcError). */
  reserve(a: { typeId: string; startsAt: string; endsAt: string; name: string; email: string; phone: string | null; note: string | null }): Promise<Row>;
  /** Delete a reservation that couldn't be completed. */
  release(id: string): Promise<void>;
  save(id: string, values: Row): Promise<Row>;
  calendar: {
    connected(provider: SuiteProvider): Promise<boolean>;
    create(booking: Row, provider: SuiteProvider, input: CalendarEventInput, conference: boolean): Promise<{ provider: SuiteProvider; eventId: string; joinUrl: string | null }>;
    remove(booking: Row, event: { provider: SuiteProvider; eventId: string }): Promise<void>;
  };
  /** The emails, the counselor's notice and the pipeline card, after the answer. Never throws. */
  afterBooking(booking: Row): void;
};

/**
 * Book a slot through the link. The honeypot first (nothing is read or written), then the per-address cap, the
 * slot, the reservation, the counselor's calendar (rolled back on a failure), and the follow-ups.
 */
export async function bookPublic(io: PublicBookingIo, i: { type: MeetingTypeDto; body: PublicBookBody }): Promise<PublicBookingAnswer> {
  if (isHoneypot(i.body)) return decoyAnswer(i.type, i.body.startsAt);

  const email = i.body.email.trim().toLowerCase();
  if ((await io.countUpcomingForEmail(email)) >= MAX_UPCOMING_PER_EMAIL) {
    throw new HttpError(409, `You already have ${MAX_UPCOMING_PER_EMAIL} upcoming bookings with this counselor`, "too_many_bookings");
  }
  if (!(await io.slotOpen(i.type, i.body.startsAt))) throw slotUnavailable();

  const startsAt = new Date(i.body.startsAt).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + i.type.durationMinutes * MINUTE).toISOString();
  const who = {
    name: i.body.name.trim(),
    email,
    phone: i.body.phone?.trim() || null,
    note: i.body.note?.trim() || null,
  };
  const reserved = await io.reserve({ typeId: i.type.id, startsAt, endsAt, ...who });
  const id = str(reserved.id);

  const input = publicEventInput(i.type, who, startsAt, endsAt);
  const conferenceOn = bookingConferenceProvider(i.type.mode);
  let event: { provider: SuiteProvider; eventId: string; joinUrl: string | null } | null = null;
  const provider = conferenceOn
    ? (await io.calendar.connected(conferenceOn)) ? conferenceOn : null
    : (await io.calendar.connected("google")) ? "google" : (await io.calendar.connected("microsoft")) ? "microsoft" : null;
  if (provider) {
    try {
      event = await io.calendar.create(reserved, provider, input, conferenceOn !== null);
    } catch {
      await io.release(id);
      throw calendarWriteFailed();
    }
  }

  let saved = reserved;
  if (event) {
    try {
      saved = await io.save(id, {
        calendar_provider: event.provider,
        calendar_event_id: event.eventId,
        ...(event.joinUrl ? { join_url: event.joinUrl } : {}),
      });
    } catch (err) {
      await io.calendar.remove(reserved, event).catch(() => undefined);
      await io.release(id);
      throw err;
    }
  }

  io.afterBooking(saved);
  return {
    booking: {
      id,
      startsAt,
      endsAt,
      mode: i.type.mode,
      joinUrl: typeof saved.join_url === "string" && saved.join_url ? saved.join_url : null,
      typeName: i.type.name,
    },
  };
}

// ---- what is sent afterwards ------------------------------------------------------------------------

const when = (iso: string, tz: string) => whenShort(iso, tz).replace(/[  ]/g, " ");

/** The pipeline timeline entry: "Booked Check-in for Wed, Nov 11, 9:00 AM EST". */
export function activityText(typeName: string, startsAt: string, timeZone: string): string {
  return plainLine(`Booked ${typeName} for ${when(startsAt, timeZone)}`, 300);
}

/** The counselor's bell and email: who, what and when, then how to reach them. */
export function counselorNotice(b: Row, timeZone: string): { title: string; body: string } {
  const name = plainLine(str(b.name), 120);
  const title = plainLine(`${name} booked ${plainLine(str(b.type_name), 80)} on ${when(str(b.starts_at), timeZone)}`, 200);
  const parts = [
    `${name} booked this through your public booking link.`,
    `Email: ${str(b.email)}`,
    ...(b.phone ? [`Phone: ${plainLine(str(b.phone), 40)}`] : []),
    ...(b.note ? [`Note: ${str(b.note).slice(0, 1000)}`] : []),
  ];
  const noLink =
    (b.mode === "google-meet" || b.mode === "teams") && !b.join_url
      ? ` It has no ${b.mode === "teams" ? "Teams" : "Google Meet"} link yet: send ${name} one, or connect your ${b.mode === "teams" ? "Outlook" : "Google"} Calendar so bookings get one.`
      : "";
  return { title, body: parts.join("\n") + noLink };
}

/** The .ics for a public booking: its own UID space (`meeting-public-<id>@meridiesai.com`), SEQUENCE 0. */
export function publicBookingIcs(
  b: Row,
  organizer: { name: string | null; email: string },
  attendee: { name: string | null; email: string } | null,
  method: IcsMethod,
  sentBy: string | null,
  now = new Date()
): string {
  return buildMeetingIcs({
    meetingId: `public-${str(b.id)}`,
    sequence: 0,
    method,
    startsAt: str(b.starts_at),
    endsAt: str(b.ends_at),
    title: `${str(b.type_name)} with ${method === "PUBLISH" ? str(b.name) : organizer.name ?? "your counselor"}`,
    agenda: method === "PUBLISH" ? (b.note ? str(b.note) : null) : null,
    mode: str(b.mode) as IcsMode,
    location: null,
    joinUrl: typeof b.join_url === "string" ? b.join_url : null,
    organizer,
    sentBy: sentBy && sentBy !== organizer.email ? sentBy : null,
    attendee,
    now,
  });
}

/** The booker's confirmation email: what, when (in the counselor's zone, named), where, and how to change it. */
export function bookerEmail(b: Row, counselorName: string, timeZone: string): { subject: string; html: string; text: string } {
  const type = plainLine(str(b.type_name), 80) || "Meeting";
  const who = plainLine(counselorName, 120) || "your counselor";
  const body = {
    heading: `Booked: ${type} with ${who}`,
    paragraphs: [
      `Hi ${plainLine(str(b.name), 120).split(/\s+/)[0] || "there"}, your meeting with ${who} is booked.`,
      `When: ${whenLong(str(b.starts_at), str(b.ends_at), timeZone)}`,
      `Where: ${meetingWhere({ mode: str(b.mode) as IcsMode, location: null, joinUrl: typeof b.join_url === "string" ? b.join_url : null })}`,
      `To change or cancel it, reply to this email and ${who} will help.`,
    ],
    footnote: "The calendar invite is attached. Open it to add this to your calendar.",
  };
  return {
    subject: plainLine(`Booked: ${type} with ${who} · ${whenShort(str(b.starts_at), timeZone)}`, 250),
    html: brandedEmail(body),
    text: brandedText(body),
  };
}

/** A rate-limit key for an address that never stores the address. */
export function emailKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export { PUBLIC_SETTINGS_COLUMNS };
