/**
 * Colleges, Events Hub and Resources (routes/collegesV10.ts, routes/events.ts,
 * routes/resources.ts). Nothing here sends a message or reaches a family: a
 * webinar note or an Events Hub listing is seen by the counselor (and their
 * firm when shared), a practice resource by the practice only, and a pin or a
 * resource's closing date lands on a student's page the way a deadline does.
 * So adding, editing, saving and pinning run at once with Undo; deleting a
 * listing, a resource or a note asks, and so does a pin to a student that
 * carries a note (the student reads the note on their page). The catalog
 * itself is Meridies' (staff and service role only) and has no write here.
 * `colleges.find` is the one catalog finder: every op that takes a
 * college_id points at it.
 */
import { z } from "zod";
import { CALENDAR_TARGETS, EVENT_KINDS, EVENT_TOPICS, PHOTO_KEYS, REMINDERS, isTimeZone } from "../../../eventsHub.js";
import { op, type OpGroup, type UndoStep } from "../types.js";
import { asArray, asRecord, changeLines, day, dayLabel, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Get = { get<T>(url: string): Promise<T | null> };

/** An http(s) address, as the routes take it. */
const httpUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address");
/** HH:MM, 24-hour, as routes/events.ts checks it. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const share = z.enum(["firm", "me"]);

/** A catalog school's name, for a card. GET /colleges/:id is the single-row read. */
async function collegeName(h: Get, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const b = asRecord(await h.get(`/colleges/${seg(id)}`));
  return str(asRecord(b.college).name);
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return plainText(u, 60);
  }
};

// ---- Colleges -------------------------------------------------------------------------

type Tip = { id?: string; collegeId?: string; source?: string; sessionDate?: string | null; tip?: string; sourceUrl?: string | null; scope?: string; mine?: boolean };

async function findTip(h: Get, collegeId: string, tipId: string): Promise<Tip | null> {
  const rows = await h.get<unknown[]>(`/colleges/${seg(collegeId)}/webinar-tips`);
  const hit = asArray(rows).find((r) => r.id === tipId);
  return hit ? (asRecord(hit) as Tip) : null;
}

const tipLabel = (t: Tip | null) =>
  t ? `webinar note "${plainText(t.source, 80)}"${t.sessionDate ? ` (${dayLabel(t.sessionDate)})` : ""}` : "a webinar note (not found on that college; check the ids)";

const tipFields = {
  source: z.string().trim().min(1).max(200),
  session_date: day.nullable(),
  tip: z.string().trim().min(1).max(600),
  source_url: httpUrl.nullable(),
  share,
};

const TIP_LABELS = { source: "Source", session_date: "Session date", tip: "Advice", source_url: "Link", share: "Shared with" };

const toTipBody = (i: Record<string, unknown>) =>
  defined({ source: i.source, sessionDate: i.session_date, tip: i.tip, sourceUrl: i.source_url, share: i.share });

export const colleges: OpGroup = {
  heading: "Colleges",
  ops: [
    op({
      name: "colleges.find",
      kind: "read",
      title: "Find a school in the Meridies college catalog by name or alias (e.g. \"UCLA\"): the college_id every action takes.",
      doc: "{ query ≤120 (the school's name), states? [two-letter codes], limit? 1-100 }",
      input: z
        .object({
          query: z.string().trim().min(1).max(120),
          states: z.array(z.string().regex(/^[A-Za-z]{2}$/)).min(1).max(60).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      request: (i) => ({ method: "GET", url: `/colleges/search${qs({ q: i.query, states: i.states?.join(","), limit: i.limit ?? 10 })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (c) => {
            const aka = Array.isArray(c.aka) ? c.aka.map(String).filter(Boolean).slice(0, 2) : [];
            const where = [str(c.city), str(c.state)].filter(Boolean).join(", ");
            return `id ${str(c.id)}: ${untrusted(`${str(c.name) ?? ""}${aka.length ? ` (also ${aka.join(", ")})` : ""}${where ? ` · ${where}` : ""}`, "catalog")}`;
          },
          "No school in the catalog matches. Try the official name; a school not in the catalog can still go on a college list by name."
        ),
    }),
    op({
      name: "colleges.webinar_tips",
      kind: "read",
      title: "Supplemental advice from webinars on one college, with ids (yours, your firm's and Meridies').",
      doc: "{ college_id }",
      input: z.object({ college_id: uuid }).strict(),
      request: (i) => ({ method: "GET", url: `/colleges/${seg(i.college_id)}/webinar-tips` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (t) =>
            `id ${str(t.id)}: ${str(t.sessionDate) ?? "no date"} [${t.mine ? (t.scope === "firm" ? "yours, shared with your firm" : "yours") : t.scope === "firm" ? "your firm's" : "Meridies"}] ${untrusted(t.source)}: ${untrusted(t.tip)}`,
          "No webinar advice on this college."
        ),
    }),
    op({
      name: "colleges.add_webinar_tip",
      kind: "write",
      risk: "auto",
      title: "Add a note of advice from a college's webinar or info session to its profile.",
      doc: "{ college_id, source ≤200 (the session), tip ≤600, session_date? YYYY-MM-DD, source_url? http(s), share?: firm|me }",
      input: z
        .object({
          college_id: uuid,
          source: tipFields.source,
          tip: tipFields.tip,
          session_date: tipFields.session_date.optional(),
          source_url: tipFields.source_url.optional(),
          share: share.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: `/colleges/${seg(i.college_id)}/webinar-tips`, body: toTipBody(i) }),
      describe: async (i, h) => `Add webinar advice to ${(await collegeName(h, i.college_id)) ?? "a college"}: "${plainText(i.source, 80)}"`,
      details: (i) => changeLines(i, { tip: TIP_LABELS.tip, session_date: TIP_LABELS.session_date, source_url: TIP_LABELS.source_url, share: TIP_LABELS.share }),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "colleges.delete_webinar_tip", input: { tip_id: id, college_id: i.college_id } } : null;
      },
    }),
    op({
      name: "colleges.update_webinar_tip",
      kind: "write",
      risk: "auto",
      title: "Change one of the counselor's own webinar notes on a college.",
      doc: "{ tip_id, college_id (the note's college), source?, tip? ≤600, session_date? YYYY-MM-DD|null, source_url?|null, share?: firm|me }",
      input: z
        .object({
          tip_id: uuid,
          college_id: uuid,
          source: tipFields.source.optional(),
          tip: tipFields.tip.optional(),
          session_date: tipFields.session_date.optional(),
          source_url: tipFields.source_url.optional(),
          share: share.optional(),
        })
        .strict()
        .refine((x) => Object.keys(toTipBody(x)).length > 0, "Give at least one field to change"),
      request: (i) => ({ method: "PATCH", url: `/colleges/webinar-tips/${seg(i.tip_id)}`, body: toTipBody(i) }),
      describe: async (i, h) => {
        const [t, name] = await Promise.all([findTip(h, i.college_id, i.tip_id), collegeName(h, i.college_id)]);
        return `Update ${tipLabel(t)}${t && name ? ` on ${name}` : ""}`;
      },
      details: (i) => changeLines(i, TIP_LABELS),
      snapshot: (i, h) => findTip(h, i.college_id, i.tip_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id || b.mine !== true) return null;
        const old: Record<string, unknown> = {
          source: b.source,
          tip: b.tip,
          session_date: b.sessionDate ?? null,
          source_url: b.sourceUrl ?? null,
          share: b.scope === "firm" ? "firm" : "me",
        };
        const prev: Record<string, unknown> = { tip_id: i.tip_id, college_id: i.college_id };
        for (const k of Object.keys(old)) if (k in i) prev[k] = old[k];
        return { op: "colleges.update_webinar_tip", input: prev };
      },
    }),
    op({
      name: "colleges.delete_webinar_tip",
      kind: "write",
      risk: "confirm",
      title: "Delete one of the counselor's own webinar notes on a college.",
      doc: "{ tip_id, college_id (the note's college) }",
      input: z.object({ tip_id: uuid, college_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/colleges/webinar-tips/${seg(i.tip_id)}` }),
      describe: async (i, h) => {
        const [t, name] = await Promise.all([findTip(h, i.college_id, i.tip_id), collegeName(h, i.college_id)]);
        return `Delete ${tipLabel(t)}${t && name ? ` from ${name}` : ""}`;
      },
      warning: "The note is deleted for you and anyone in your firm it was shared with.",
    }),
    op({
      name: "colleges.research_folder",
      kind: "write",
      risk: "auto",
      title: "Find (or make) the Files › Policy & research folder for a link's or file's school; then files.add_link with its folder_id.",
      doc: "{ url? (the link), filename? ≤300 } (one of them)",
      input: z
        .object({
          url: z.string().trim().min(4).max(2000).optional(),
          filename: z.string().trim().min(1).max(300).optional(),
        })
        .strict()
        .refine((x) => x.url || x.filename, "Give a link or a file name"),
      request: (i) => ({ method: "POST", url: "/colleges/research/folder", body: defined({ url: i.url, filename: i.filename }) }),
      describe: (i) => `Find the Policy & research folder for ${i.url ? hostOf(i.url) : `"${plainText(i.filename, 80)}"`}`,
      reply: (body) => {
        const b = asRecord(body);
        const folder = str(b.folderId);
        if (!folder) return "";
        return `Folder id ${folder}: Policy & research › ${untrusted(b.folderName, "files")}${b.created ? " (new)" : ""}${b.collegeId ? `; college id ${str(b.collegeId)}` : ""}.`;
      },
    }),
  ],
};

// ---- Events Hub -----------------------------------------------------------------------

type HubEvent = {
  id?: string;
  name?: string;
  kind?: string;
  host?: string;
  startDate?: string;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  timeZone?: string;
  place?: string;
  url?: string;
  description?: string | null;
  college?: { id?: string; shortName?: string } | null;
  photoKey?: string | null;
  topics?: string[];
  scope?: string;
  mine?: boolean;
  saved?: { targets?: string[]; reminder?: string } | null;
};

const findEvent = (h: Get, id: string) => h.get<HubEvent>(`/events/${seg(id)}`);

const eventLabel = (e: HubEvent | null) => (e ? `"${plainText(e.name, 80)}"${e.startDate ? ` (${dayLabel(e.startDate)})` : ""}` : "an Events Hub listing");

function eventLine(e: Record<string, unknown>): string {
  const when = `${str(e.startDate) ?? "no date"}${e.startTime ? ` ${str(e.startTime)}` : ""}${e.endDate ? ` to ${str(e.endDate)}` : ""}`;
  const owner = e.mine ? (e.scope === "firm" ? "yours, shared with your firm" : "yours") : e.scope === "firm" ? "your firm's" : "Meridies";
  const saved = asRecord(e.saved);
  const targets = Array.isArray(saved.targets) ? saved.targets.map(String) : [];
  const college = asRecord(e.college);
  return (
    `id ${str(e.id)}: ${when} [${str(e.kind)}; ${owner}${targets.length ? `; saved to ${targets.join("/")}` : ""}] ` +
    `${untrusted(e.name)} · host ${untrusted(e.host)}${college.shortName ? ` · ${untrusted(college.shortName, "catalog")}` : ""}`
  );
}

const eventFields = {
  name: z.string().trim().min(1).max(200),
  kind: z.enum(EVENT_KINDS),
  host: z.string().trim().min(1).max(200),
  start_date: day,
  end_date: day.nullable(),
  start_time: hhmm.nullable(),
  end_time: hhmm.nullable(),
  time_zone: z.string().trim().min(1).max(64).refine(isTimeZone, "Use an IANA time zone, e.g. America/New_York"),
  place: z.string().trim().min(1).max(200),
  url: httpUrl,
  description: z.string().trim().max(1000).nullable(),
  college_id: uuid.nullable(),
  photo_key: z.enum(PHOTO_KEYS).nullable(),
  topics: z.array(z.enum(EVENT_TOPICS)).max(5),
  share,
};

const EVENT_LABELS = {
  name: "Name",
  kind: "Kind",
  host: "Host",
  start_date: "Starts",
  end_date: "Ends",
  start_time: "Start time",
  end_time: "End time",
  time_zone: "Time zone",
  place: "Place",
  url: "Link",
  description: "Description",
  photo_key: "Photo",
  topics: "Topics",
  share: "Shared with",
};

const toEventBody = (i: Record<string, unknown>) =>
  defined({
    name: i.name,
    kind: i.kind,
    host: i.host,
    startDate: i.start_date,
    endDate: i.end_date,
    startTime: i.start_time,
    endTime: i.end_time,
    timeZone: i.time_zone,
    place: i.place,
    url: i.url,
    description: i.description,
    collegeId: i.college_id,
    photoKey: i.photo_key,
    topics: i.topics,
    share: i.share,
  });

/**
 * The route's date and time rules (routes/events.ts checkTimes), so a listing it would
 * refuse is refused here with the field named. On an update only what the input
 * itself can show: the route checks the rest against the stored listing.
 */
function checkEventTimes(
  i: { start_date?: string; end_date?: string | null; start_time?: string | null; end_time?: string | null },
  ctx: z.RefinementCtx,
  creating: boolean
) {
  if (i.end_date && i.start_date && i.end_date < i.start_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end_date"], message: "An event can't end before it starts" });
  }
  if (!creating) return;
  if (i.end_time && !i.start_time) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["start_time"], message: "Give a start time with the end time" });
  if (i.start_time && i.end_time && !i.end_date && i.end_time <= i.start_time) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end_time"], message: "The end time has to be after the start time" });
  }
}

/** Card lines for a listing's fields, the college by name rather than id. */
async function eventLines(i: Record<string, unknown>, h: Get): Promise<string[]> {
  const lines = changeLines(Array.isArray(i.topics) && !i.topics.length ? { ...i, topics: "none" } : i, EVENT_LABELS);
  if ("college_id" in i && i.college_id !== undefined) {
    lines.push(`College: ${i.college_id === null ? "cleared" : ((await collegeName(h, String(i.college_id))) ?? "a catalog college")}`);
  }
  return lines;
}

/** Puts a listing's save back the way the snapshot found it. */
function restoreSave(eventId: string, before: unknown): UndoStep | null {
  const b = asRecord(before);
  if (!b.id) return null;
  const saved = asRecord(b.saved);
  const targets = Array.isArray(saved.targets) ? saved.targets.map(String) : [];
  if (!targets.length) return { op: "events.unsave", input: { event_id: eventId } };
  const reminder = (REMINDERS as readonly string[]).includes(String(saved.reminder)) ? String(saved.reminder) : undefined;
  return { op: "events.save", input: defined({ event_id: eventId, targets, reminder }) };
}

export const events: OpGroup = {
  heading: "Events Hub",
  ops: [
    op({
      name: "events.list",
      kind: "read",
      title: "Upcoming Events Hub listings with ids (search, kind, one college), or saved_only for the counselor's saves.",
      doc: "{ query? ≤120, kind?: conference|webinar|workshop|college-fair|info-session, college_id?, saved_only? bool }",
      input: z
        .object({
          query: z.string().trim().max(120).optional(),
          kind: z.enum(EVENT_KINDS).optional(),
          college_id: uuid.optional(),
          saved_only: z.boolean().optional(),
        })
        .strict(),
      request: (i) =>
        i.saved_only
          ? { method: "GET", url: "/events/saved" }
          : { method: "GET", url: `/events${qs({ q: i.query, kind: i.kind, colleges: i.college_id })}` },
      reply: (body, i) => {
        // The feed carries updates too; only listings have ids an action takes.
        const rows = Array.isArray(body)
          ? asArray(body)
          : asArray(asRecord(body).items)
              .filter((x) => x.type === "event")
              .map((x) => asRecord(x.item));
        const needle = (i.query ?? "").toLowerCase();
        // GET /events/saved takes no filters; apply them here.
        const shown = i.saved_only
          ? rows.filter(
              (e) =>
                (!i.kind || e.kind === i.kind) &&
                (!i.college_id || asRecord(e.college).id === i.college_id) &&
                (!needle || `${str(e.name) ?? ""} ${str(e.host) ?? ""} ${str(e.place) ?? ""}`.toLowerCase().includes(needle))
            )
          : rows;
        return listReply(shown, eventLine, i.saved_only ? "No saved events match." : "No upcoming events match.");
      },
    }),
    op({
      name: "events.create",
      kind: "write",
      risk: "auto",
      title: "Add a listing to the Events Hub (shared with the counselor's firm by default; share: me keeps it to them).",
      doc: "{ name, kind: conference|webinar|workshop|college-fair|info-session, host, start_date YYYY-MM-DD, url, end_date?, start_time? HH:MM, end_time?, time_zone? IANA, place?, description?, college_id?, topics? [aid|essays|uc|lists|practice], share?: firm|me }",
      input: z
        .object({
          name: eventFields.name,
          kind: eventFields.kind,
          host: eventFields.host,
          start_date: eventFields.start_date,
          url: eventFields.url,
          end_date: eventFields.end_date.optional(),
          start_time: eventFields.start_time.optional(),
          end_time: eventFields.end_time.optional(),
          time_zone: eventFields.time_zone.optional(),
          place: eventFields.place.optional(),
          description: eventFields.description.optional(),
          college_id: eventFields.college_id.optional(),
          photo_key: eventFields.photo_key.optional(),
          topics: eventFields.topics.optional(),
          share: share.optional(),
        })
        .strict()
        .superRefine((i, ctx) => checkEventTimes(i, ctx, true)),
      request: (i) => ({ method: "POST", url: "/events", body: toEventBody(i) }),
      describe: (i) => `Add "${plainText(i.name, 80)}" (${dayLabel(i.start_date)}) to the Events Hub${i.share === "me" ? ", just for you" : i.share === "firm" ? ", for your firm" : ""}`,
      details: (i, h) => eventLines(defined({ host: i.host, place: i.place, url: i.url, start_time: i.start_time, college_id: i.college_id, share: i.share }), h),
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "events.delete", input: { event_id: id } } : null;
      },
    }),
    op({
      name: "events.update",
      kind: "write",
      risk: "auto",
      title: "Change one of the counselor's own Events Hub listings.",
      doc: "{ event_id, name?, kind?, host?, start_date?, end_date?|null, start_time?|null, end_time?|null, time_zone?, place?, url?, description?|null, college_id?|null, photo_key?|null, topics?, share?: firm|me }",
      input: z
        .object({
          event_id: uuid,
          name: eventFields.name.optional(),
          kind: eventFields.kind.optional(),
          host: eventFields.host.optional(),
          start_date: eventFields.start_date.optional(),
          end_date: eventFields.end_date.optional(),
          start_time: eventFields.start_time.optional(),
          end_time: eventFields.end_time.optional(),
          time_zone: eventFields.time_zone.optional(),
          place: eventFields.place.optional(),
          url: eventFields.url.optional(),
          description: eventFields.description.optional(),
          college_id: eventFields.college_id.optional(),
          photo_key: eventFields.photo_key.optional(),
          topics: eventFields.topics.optional(),
          share: share.optional(),
        })
        .strict()
        .superRefine((i, ctx) => checkEventTimes(i, ctx, false))
        .refine((x) => Object.keys(toEventBody(x)).length > 0, "Give at least one field to change"),
      request: (i) => ({ method: "PATCH", url: `/events/${seg(i.event_id)}`, body: toEventBody(i) }),
      describe: async (i, h) => `Update ${eventLabel(await findEvent(h, i.event_id))} in the Events Hub`,
      details: (i, h) => eventLines(i, h),
      snapshot: (i, h) => findEvent(h, i.event_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id || b.mine !== true) return null;
        const old: Record<string, unknown> = {
          name: b.name,
          kind: b.kind,
          host: b.host,
          start_date: b.startDate,
          end_date: b.endDate ?? null,
          start_time: b.startTime ?? null,
          end_time: b.endTime ?? null,
          time_zone: b.timeZone,
          place: b.place,
          url: b.url,
          description: b.description ?? null,
          college_id: str(asRecord(b.college).id),
          photo_key: b.photoKey ?? null,
          topics: Array.isArray(b.topics) ? b.topics : [],
          share: b.scope === "firm" ? "firm" : "me",
        };
        const prev: Record<string, unknown> = { event_id: i.event_id };
        for (const k of Object.keys(old)) if (k in i) prev[k] = old[k];
        return { op: "events.update", input: prev };
      },
    }),
    op({
      name: "events.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete one of the counselor's own Events Hub listings.",
      doc: "{ event_id }",
      input: z.object({ event_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/events/${seg(i.event_id)}` }),
      describe: async (i, h) => `Delete ${eventLabel(await findEvent(h, i.event_id))} from the Events Hub`,
      warning: "The listing is deleted for you and anyone in your firm it was shared with, with their saves.",
    }),
    op({
      name: "events.save",
      kind: "write",
      risk: "auto",
      title: "Add to Calendar: save a listing (meridies puts it on the Meridies calendar), or change where it's saved.",
      doc: "{ event_id, targets: [meridies|google|outlook|apple] 1-4 (google/outlook/apple only record the choice), reminder?: none|15m|1h|1d|1w }",
      input: z
        .object({
          event_id: uuid,
          targets: z.array(z.enum(CALENDAR_TARGETS)).min(1).max(4),
          reminder: z.enum(REMINDERS).optional(),
        })
        .strict(),
      request: (i) => ({ method: "PUT", url: `/events/${seg(i.event_id)}/save`, body: defined({ targets: i.targets, reminder: i.reminder }) }),
      describe: async (i, h) => `Add ${eventLabel(await findEvent(h, i.event_id))} to your calendar`,
      details: (i) => [`Calendars: ${[...new Set(i.targets)].join(", ")}`, ...(i.reminder ? [`Reminder: ${i.reminder}`] : [])],
      snapshot: (i, h) => findEvent(h, i.event_id),
      undo: (i, _body, before) => restoreSave(i.event_id, before),
    }),
    op({
      name: "events.unsave",
      kind: "write",
      risk: "auto",
      title: "Take a saved listing off the counselor's calendar (the listing stays in the hub).",
      doc: "{ event_id }",
      input: z.object({ event_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/events/${seg(i.event_id)}/save` }),
      describe: async (i, h) => `Remove ${eventLabel(await findEvent(h, i.event_id))} from your calendar`,
      snapshot: (i, h) => findEvent(h, i.event_id),
      undo: (i, _body, before) => {
        const step = restoreSave(i.event_id, before);
        return step && step.op === "events.save" ? step : null;
      },
    }),
  ],
};

// ---- Resources --------------------------------------------------------------------------

const CATEGORIES = ["testing", "research", "applications", "aid"] as const;
const AUDIENCES = ["counselor", "student", "both"] as const;

type Resource = {
  id?: string;
  title?: string;
  category?: string;
  url?: string;
  description?: string;
  opensOn?: string | null;
  closesOn?: string | null;
  cycle?: string | null;
  audience?: string;
  stateScope?: string | null;
  owner?: string;
};

/** No single-resource GET; the list is the library plus the practice's rows (RLS-scoped). */
async function findResource(h: Get, id: string): Promise<Resource | null> {
  const rows = await h.get<unknown[]>("/resources");
  const hit = asArray(rows).find((r) => r.id === id);
  return hit ? (asRecord(hit) as Resource) : null;
}

const resourceLabel = (r: Resource | null) => (r ? `"${plainText(r.title, 80)}"` : "a resource");

type Pin = { pinId?: string; note?: string | null; resource?: Resource };

async function findPin(h: Get, pinId: string, target: { student_id?: string; college_id?: string }): Promise<Pin | null> {
  const url = target.student_id ? `/resources/pins${qs({ studentId: target.student_id })}` : target.college_id ? `/resources/pins${qs({ collegeId: target.college_id })}` : null;
  if (!url) return null;
  const rows = await h.get<unknown[]>(url);
  const hit = asArray(rows).find((r) => r.pinId === pinId);
  return hit ? (asRecord(hit) as Pin) : null;
}

const resourceFields = {
  category: z.enum(CATEGORIES),
  title: z.string().trim().min(1).max(200),
  // The route resolves and checks the address (lib/links.ts); only http(s) passes.
  url: httpUrl,
  description: z.string().trim().max(1200),
  opens_on: day.nullable(),
  closes_on: day.nullable(),
  cycle: z.string().regex(/^\d{4}-\d{2}$/, "YYYY-YY, e.g. 2026-27").nullable(),
  audience: z.enum(AUDIENCES),
  state_scope: z.string().regex(/^[A-Za-z]{2}$/, "A two-letter state code").nullable(),
};

const RESOURCE_LABELS = {
  title: "Title",
  category: "Category",
  url: "Link",
  description: "Description",
  opens_on: "Opens",
  closes_on: "Closes",
  cycle: "Cycle",
  audience: "For",
  state_scope: "State",
};

const toResourceBody = (i: Record<string, unknown>) =>
  defined({
    category: i.category,
    title: i.title,
    url: i.url,
    description: i.description,
    opensOn: i.opens_on,
    closesOn: i.closes_on,
    cycle: i.cycle,
    audience: i.audience,
    stateScope: i.state_scope,
  });

function pinLine(p: Record<string, unknown>): string {
  const r = asRecord(p.resource);
  // A pin's note is not sent to the model: say only that there is one.
  return `pin ${str(p.pinId)}: resource ${str(r.id)} [${str(r.category)}; ${r.owner === "practice" ? "your practice's" : "Meridies library"}] ${untrusted(r.title)}${p.note ? " (has a note)" : ""}`;
}

const pinTarget = z.object({ resource_id: uuid, note: z.string().trim().max(500).optional() });

export const resources: OpGroup = {
  heading: "Resources",
  ops: [
    op({
      name: "resources.list",
      kind: "read",
      title: "The resource library with ids: the Meridies library (read-only) and the practice's own resources.",
      doc: "{ category?: testing|research|applications|aid, state? two-letter, audience?: counselor|student|both, query? ≤120 }",
      input: z
        .object({
          category: z.enum(CATEGORIES).optional(),
          state: z.string().regex(/^[A-Za-z]{2}$/).optional(),
          audience: z.enum(AUDIENCES).optional(),
          query: z.string().trim().max(120).optional(),
        })
        .strict(),
      request: (i) => ({ method: "GET", url: `/resources${qs({ category: i.category, state: i.state, audience: i.audience, q: i.query })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (r) =>
            `id ${str(r.id)}: [${str(r.category)}; ${r.owner === "practice" ? "your practice's" : "Meridies library, read-only"}${r.closesOn ? `; closes ${str(r.closesOn)}` : ""}${r.linkStatus === "broken" ? "; broken link" : ""}] ${untrusted(r.title)}`,
          "No resources match."
        ),
    }),
    op({
      name: "resources.student_pins",
      kind: "read",
      title: "Resources pinned to a student, with pin ids.",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/resources/pins${qs({ studentId: i.student_id })}` }),
      reply: (body) => listReply(asArray(body), pinLine, "Nothing is pinned to this student."),
    }),
    op({
      name: "resources.college_pins",
      kind: "read",
      title: "Resources the practice pinned to a college, with pin ids.",
      doc: "{ college_id }",
      input: z.object({ college_id: uuid }).strict(),
      request: (i) => ({ method: "GET", url: `/resources/pins${qs({ collegeId: i.college_id })}` }),
      reply: (body) => listReply(asArray(body), pinLine, "Nothing is pinned to this college."),
    }),
    op({
      name: "resources.create",
      kind: "write",
      risk: "auto",
      title: "Add a resource (a link) to the practice's own library.",
      doc: "{ category: testing|research|applications|aid, title ≤200, url, description? ≤1200, opens_on? YYYY-MM-DD, closes_on?, cycle? YYYY-YY, audience?: counselor|student|both, state_scope? two-letter }",
      input: z
        .object({
          category: resourceFields.category,
          title: resourceFields.title,
          url: resourceFields.url,
          description: resourceFields.description.optional(),
          opens_on: resourceFields.opens_on.optional(),
          closes_on: resourceFields.closes_on.optional(),
          cycle: resourceFields.cycle.optional(),
          audience: resourceFields.audience.optional(),
          state_scope: resourceFields.state_scope.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/resources", body: toResourceBody(i) }),
      describe: (i) => `Add "${plainText(i.title, 80)}" to your practice's resources`,
      details: (i) => [`Link: ${hostOf(i.url)}`, ...changeLines(i, { category: "Category", opens_on: "Opens", closes_on: "Closes", audience: "For", state_scope: "State" })],
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "resources.delete", input: { resource_id: id } } : null;
      },
    }),
    op({
      name: "resources.update",
      kind: "write",
      risk: "auto",
      title: "Change one of the practice's own resources (Meridies library rows can't be edited).",
      doc: "{ resource_id, category?, title?, url?, description?, opens_on? YYYY-MM-DD|null, closes_on?|null, cycle?|null, audience?, state_scope?|null }",
      input: z
        .object({
          resource_id: uuid,
          category: resourceFields.category.optional(),
          title: resourceFields.title.optional(),
          url: resourceFields.url.optional(),
          description: resourceFields.description.optional(),
          opens_on: resourceFields.opens_on.optional(),
          closes_on: resourceFields.closes_on.optional(),
          cycle: resourceFields.cycle.optional(),
          audience: resourceFields.audience.optional(),
          state_scope: resourceFields.state_scope.optional(),
        })
        .strict()
        .refine((x) => Object.keys(toResourceBody(x)).length > 0, "Give at least one field to change"),
      request: (i) => ({ method: "PATCH", url: `/resources/${seg(i.resource_id)}`, body: toResourceBody(i) }),
      describe: async (i, h) => `Update ${resourceLabel(await findResource(h, i.resource_id))} in your practice's resources`,
      details: (i) => changeLines(i, RESOURCE_LABELS),
      snapshot: (i, h) => findResource(h, i.resource_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id || b.owner !== "practice") return null;
        const from: Record<string, string> = {
          category: "category",
          title: "title",
          url: "url",
          description: "description",
          opens_on: "opensOn",
          closes_on: "closesOn",
          cycle: "cycle",
          audience: "audience",
          state_scope: "stateScope",
        };
        const prev: Record<string, unknown> = { resource_id: i.resource_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("description" in prev && prev.description === null) prev.description = "";
        if (("title" in prev && !prev.title) || ("url" in prev && !prev.url)) return null;
        return { op: "resources.update", input: prev };
      },
    }),
    op({
      name: "resources.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete one of the practice's own resources (Meridies library rows can't be deleted).",
      doc: "{ resource_id }",
      input: z.object({ resource_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/resources/${seg(i.resource_id)}` }),
      describe: async (i, h) => `Delete ${resourceLabel(await findResource(h, i.resource_id))} from your practice's resources`,
      warning: "The resource is deleted for the whole practice, with everywhere it was pinned.",
    }),
    op({
      name: "resources.pin_to_student",
      kind: "write",
      // The student reads the pin and its note on their page: a note is words shown to them, so it asks first.
      risk: (i) => (i.note ? "confirm" : "auto"),
      title: "Pin a resource to a student's page (the student sees it; with a note it waits for Confirm).",
      doc: "{ resource_id, student_id, note? ≤500 (shown to the student) }",
      input: pinTarget.extend({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/resources/${seg(i.resource_id)}/pins`, body: defined({ studentId: i.student_id, note: i.note }) }),
      describe: async (i, h) => `Pin ${resourceLabel(await findResource(h, i.resource_id))} to ${h.studentName(i.student_id)}'s page`,
      details: (i) => (i.note ? [`Note: ${plainText(i.note, 500)}`] : []),
      warning: "The student sees this resource and your note on their page.",
      reply: (body) => `Pinned (pin id ${str(asRecord(body).pinId) ?? "unknown"}).`,
      undo: (i, body) => {
        const pin = str(asRecord(body).pinId);
        return pin ? { op: "resources.unpin", input: { pin_id: pin, student_id: i.student_id } } : null;
      },
    }),
    op({
      name: "resources.pin_to_college",
      kind: "write",
      risk: "auto",
      title: "Pin a resource to a college for the practice (its Resources & data tab).",
      doc: "{ resource_id, college_id, note? ≤500 }",
      input: pinTarget.extend({ college_id: uuid }).strict(),
      request: (i) => ({ method: "POST", url: `/resources/${seg(i.resource_id)}/pins`, body: defined({ collegeId: i.college_id, note: i.note }) }),
      describe: async (i, h) => {
        const [r, name] = await Promise.all([findResource(h, i.resource_id), collegeName(h, i.college_id)]);
        return `Pin ${resourceLabel(r)} to ${name ?? "a college"}`;
      },
      details: (i) => (i.note ? [`Note: ${plainText(i.note, 500)}`] : []),
      reply: (body) => `Pinned (pin id ${str(asRecord(body).pinId) ?? "unknown"}).`,
      undo: (i, body) => {
        const pin = str(asRecord(body).pinId);
        return pin ? { op: "resources.unpin", input: { pin_id: pin, college_id: i.college_id } } : null;
      },
    }),
    op({
      name: "resources.unpin",
      kind: "write",
      risk: "auto",
      title: "Unpin a resource from a student or a college (the resource itself stays).",
      doc: "{ pin_id (from resources.student_pins or college_pins), student_id? | college_id? (exactly one: where the pin is) }",
      input: z
        .object({ pin_id: uuid, student_id: uuid.optional(), college_id: uuid.optional() })
        .strict()
        .refine((x) => !x.student_id !== !x.college_id, "Give student_id or college_id, not both"),
      request: (i) => ({ method: "DELETE", url: `/resources/pins/${seg(i.pin_id)}` }),
      describe: async (i, h) => {
        const p = await findPin(h, i.pin_id, i);
        if (!p) return `Unpin a resource (pin ${i.pin_id}, not found ${i.student_id ? "on that student's page" : "on that college"})`;
        const what = resourceLabel(p.resource ?? null);
        if (i.student_id) return `Unpin ${what} from ${h.studentName(i.student_id)}'s page`;
        return `Unpin ${what} from ${(await collegeName(h, i.college_id)) ?? "a college"}`;
      },
      snapshot: (i, h) => findPin(h, i.pin_id, i),
      undo: (i, _body, before) => {
        const p = asRecord(before);
        const resourceId = str(asRecord(p.resource).id);
        if (!resourceId) return null;
        const note = str(p.note) ?? undefined;
        if (i.student_id) return { op: "resources.pin_to_student", input: defined({ resource_id: resourceId, student_id: i.student_id, note }) };
        if (i.college_id) return { op: "resources.pin_to_college", input: defined({ resource_id: resourceId, college_id: i.college_id, note }) };
        return null;
      },
    }),
    op({
      name: "resources.add_deadline",
      kind: "write",
      risk: "auto",
      title: "Put a dated resource's closing date (e.g. Cal Grant) on a student's deadlines.",
      doc: "{ resource_id (one with a closing date), student_id }",
      input: z.object({ resource_id: uuid, student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: `/resources/${seg(i.resource_id)}/deadline`, body: { studentId: i.student_id } }),
      describe: async (i, h) => {
        const r = await findResource(h, i.resource_id);
        return `Add ${resourceLabel(r)}${r?.closesOn ? ` (closes ${dayLabel(r.closesOn)})` : ""} to ${h.studentName(i.student_id)}'s deadlines`;
      },
      reply: (body) => {
        const b = asRecord(body);
        return `Deadline added (id ${str(b.deadlineId) ?? "unknown"}, due ${str(b.dueDate) ?? "?"}).`;
      },
      undo: (_i, body) => {
        const id = str(asRecord(body).deadlineId);
        return id ? { op: "deadlines.delete", input: { deadline_id: id } } : null;
      },
    }),
  ],
};
