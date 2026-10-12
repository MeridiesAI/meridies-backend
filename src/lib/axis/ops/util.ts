/**
 * Small pieces every catalog file uses: input shapes, query strings, and the
 * replies the model reads. Anything a person typed (a title, a name, a note)
 * reaches the model only inside `untrusted(...)`.
 */
import { z } from "zod";
import { wrapUntrusted } from "../../context/pack.js";

export const uuid = z.string().uuid();
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
/** HH:MM, 24-hour. */
export const clock = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM");
export const isoDateTime = z.string().datetime({ offset: true });

/** "?a=1&b=2" from the defined values, or "". */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
}

/** A path segment from an id the input already validated. */
export const seg = (id: string) => encodeURIComponent(id);

/** Free text from the database or a person, marked as data for the model. */
export function untrusted(text: unknown, source = "record"): string {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  return wrapUntrusted(source, s.length > 300 ? `${s.slice(0, 297)}...` : s);
}

/** The value as plain text for a card (never sent to the model). */
export function plainText(v: unknown, max = 160): string {
  if (v == null) return "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const asArray = (body: unknown): Record<string, unknown>[] =>
  Array.isArray(body) ? (body.filter((r) => r && typeof r === "object") as Record<string, unknown>[]) : [];

export const asRecord = (body: unknown): Record<string, unknown> =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** The id a create returned, if any. */
export const idOf = (body: unknown): string | null => str(asRecord(body).id);

/**
 * A list for the model: one line per row, capped, with a note when rows were left out.
 * `line` must wrap anything a person typed with `untrusted`.
 */
export function listReply(rows: Record<string, unknown>[], line: (r: Record<string, unknown>) => string, empty: string, max = 60): string {
  if (!rows.length) return empty;
  const shown = rows.slice(0, max).map(line);
  return rows.length > max ? `${shown.join("\n")}\n(${rows.length - max} more not shown; narrow the lookup.)` : shown.join("\n");
}

/** "Due Nov 1" style label for cards. */
export function dayLabel(d: unknown): string {
  const s = str(d);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return "";
  const [y, m, dd] = s.slice(0, 10).split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[(m ?? 1) - 1]} ${dd}, ${y}`;
}

/** Card lines for the fields an update sets: "Title: …", "Due: …". Only the keys present. */
export function changeLines(input: Record<string, unknown>, labels: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, label] of Object.entries(labels)) {
    if (!(k in input)) continue;
    const v = input[k];
    out.push(`${label}: ${v === null ? "cleared" : typeof v === "boolean" ? (v ? "yes" : "no") : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? dayLabel(v) : plainText(Array.isArray(v) ? v.join(", ") : v)}`);
  }
  return out;
}

/** Drops undefined keys, so a PATCH body carries only what the model set. */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
