/**
 * Events Hub listings from a CSV a curator compiles (scripts/ingest/events-csv.ts).
 * The rows land as Meridies-wide `hub_events` (no author, no firm), which every
 * approved counselor sees.
 *
 * CSV columns (header row, any order; blank = unknown):
 *
 *   name           required, 1-200 characters
 *   kind           conference | webinar | workshop | college-fair | info-session
 *                  | campus-tour | virtual-visit | open-house
 *   host           required, the organizer as it names itself
 *   start_date     required, YYYY-MM-DD
 *   end_date       YYYY-MM-DD, not before start_date
 *   start_time     HH:MM (24-hour), in time_zone
 *   end_time       HH:MM; needs start_time, and after it on a one-day event
 *   time_zone      IANA name, default America/New_York
 *   place          default "Online"
 *   url            required, http(s); the organizer's page for the event
 *   description    up to 1000 characters
 *   college_unitid IPEDS unitid of the college the event is about (must be in the catalog)
 *   photo_key      webinar | webinar-desk | conference | college-fair | workshop | lecture-hall
 *   topics         semicolon-separated: aid;essays;uc;lists;practice
 *   audience       counselor | student | everyone. Blank: everyone for an
 *                  info session, tour, virtual visit or open house (students
 *                  see those), counselor for the rest (a conference, a
 *                  counselor workshop).
 *
 * Loaded rows are source "csv". A row the discovery job found with the same
 * key becomes the curator's (the CSV wins); the job never overwrites it after.
 *
 * The natural key is (name, host, start_date), compared trimmed and ignoring
 * case: `hub_events` has no unique constraint to upsert on, and a URL is not
 * one (a recurring webinar shares one registration page across dates). The
 * loader matches only Meridies-wide rows, so a counselor's own listing is never
 * touched. Two rows of one file with the same key are an error.
 */

import { z } from "zod";
import { AUDIENCES, EVENT_KINDS, EVENT_TOPICS, PHOTO_KEYS, isTimeZone, type Audience } from "../eventsHub.js";

export type EventRow = {
  name: string;
  kind: (typeof EVENT_KINDS)[number];
  host: string;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  time_zone: string;
  place: string;
  url: string;
  description: string | null;
  photo_key: (typeof PHOTO_KEYS)[number] | null;
  topics: (typeof EVENT_TOPICS)[number][];
  audience: Audience;
  source: "csv";
};

/** Kinds students go to: a curator who leaves audience blank means them too. */
const STUDENT_FACING: ReadonlySet<string> = new Set(["info-session", "campus-tour", "virtual-visit", "open-house"]);

export type MappedEvent = { line: number; key: string; collegeUnitid: number | null; row: EventRow };
export type EventsMapResult = { ok: MappedEvent[]; errors: string[] };

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

/** A real calendar date, not just the shape (2026-02-30 is refused). */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "isn't a real date");
const clock = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24-hour)");

const csvRow = z
  .object({
    name: z.string().trim().min(1, "is required").max(200),
    kind: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(EVENT_KINDS)),
    host: z.string().trim().min(1, "is required").max(200),
    start_date: isoDate,
    end_date: opt(isoDate),
    start_time: opt(clock),
    end_time: opt(clock),
    time_zone: opt(z.string().trim().max(64).refine(isTimeZone, "isn't a recognised time zone")),
    place: opt(z.string().trim().min(1).max(200)),
    url: z
      .string()
      .trim()
      .max(2000)
      .url("isn't a URL")
      .refine((u) => /^https?:\/\//i.test(u), "must be http(s)"),
    description: opt(z.string().trim().max(1000)),
    college_unitid: opt(z.coerce.number().int().positive("isn't an IPEDS unitid")),
    photo_key: opt(z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(PHOTO_KEYS))),
    topics: opt(z.string()),
    audience: opt(z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(AUDIENCES))),
  })
  .passthrough();

const KNOWN = new Set(Object.keys(csvRow.shape));

/** The key two listings share when they are the same event. */
export const eventKey = (name: string, host: string, startDate: string): string =>
  [name, host, startDate].map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()).join("\u0000");

export function mapEventRow(raw: Record<string, string>, line: number): { out: MappedEvent | null; errors: string[] } {
  const errors: string[] = [];
  const unknown = Object.keys(raw).filter((k) => k !== "" && !KNOWN.has(k));
  if (unknown.length) errors.push(`unknown column(s): ${unknown.join(", ")}`);

  const parsed = csvRow.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join(".") || "row"}: ${issue.message}`);
    return { out: null, errors: errors.map((e) => `line ${line}: ${e}`) };
  }
  const r = parsed.data;

  const topics: EventRow["topics"] = [];
  for (const t of (r.topics ?? "").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(EVENT_TOPICS as readonly string[]).includes(t)) errors.push(`topics: "${t}" isn't one of ${EVENT_TOPICS.join("/")}`);
    else if (!topics.includes(t as EventRow["topics"][number])) topics.push(t as EventRow["topics"][number]);
  }
  if (r.end_date && r.end_date < r.start_date) errors.push("end_date: is before start_date");
  if (r.end_time && !r.start_time) errors.push("end_time: needs a start_time");
  if (r.start_time && r.end_time && !r.end_date && r.end_time <= r.start_time) {
    errors.push("end_time: has to be after start_time on a one-day event");
  }
  if (errors.length) return { out: null, errors: errors.map((e) => `line ${line}: ${e}`) };

  return {
    out: {
      line,
      key: eventKey(r.name, r.host, r.start_date),
      collegeUnitid: r.college_unitid ?? null,
      row: {
        name: r.name,
        kind: r.kind,
        host: r.host,
        start_date: r.start_date,
        end_date: r.end_date ?? null,
        start_time: r.start_time ?? null,
        end_time: r.end_time ?? null,
        time_zone: r.time_zone ?? "America/New_York",
        place: r.place ?? "Online",
        url: r.url,
        description: r.description ?? null,
        photo_key: r.photo_key ?? null,
        topics,
        audience: r.audience ?? (STUDENT_FACING.has(r.kind) ? "everyone" : "counselor"),
        source: "csv",
      },
    },
    errors: [],
  };
}

/**
 * Every row checked; any error anywhere and the caller loads nothing. Line
 * numbers count the header as line 1.
 */
export function mapEventsCsv(rows: Record<string, string>[]): EventsMapResult {
  const ok: MappedEvent[] = [];
  const errors: string[] = [];
  if (!rows.length) errors.push("the file has no rows");
  const seen = new Map<string, number>();
  rows.forEach((raw, i) => {
    const line = i + 2;
    const { out, errors: e } = mapEventRow(raw, line);
    errors.push(...e);
    if (!out) return;
    const first = seen.get(out.key);
    if (first !== undefined) {
      errors.push(`line ${line}: the same event (name, host, start_date) as line ${first}`);
      return;
    }
    seen.set(out.key, line);
    ok.push(out);
  });
  return { ok, errors };
}
