/**
 * The parents directory: every parent or guardian a counselor works with, in
 * one list, and the same list as a CSV (`routes/guardians.ts`).
 *
 * **It is a view, never a list.** Nothing here is stored. Each row is a
 * `guardians` row joined to the student it belongs to, read as the caller (RLS
 * is the backstop) and limited to students whose profile the caller can read.
 * It is not a mailing list and not a second source of truth: blasts and the
 * composer derive their audiences from the roster on purpose
 * (`lib/blasts.ts`), and a copy of "who gets email" kept here would go stale
 * and email people who opted out. The directory therefore carries who a
 * parent is and how to reach them (name, relationship, email, phone, which
 * student), plus whether alerts and reports are switched on so a counselor can
 * see why a parent is not hearing from them, and no way to send anything.
 *
 * Only these fields leave: a student's id, name and class year, never an
 * email, phone, GPA, notes or any other column of theirs. The pure parts live
 * here so they are unit-tested without a database
 * (`test/unit/guardian-roster.test.ts`).
 */

import { z } from "zod";
import { toCsv } from "./csv.js";
import { badRequest } from "./errors.js";

export const ROSTER_DEFAULT_LIMIT = 100;
export const ROSTER_MAX_LIMIT = 500;
/** The most rows one CSV holds; past it the download answers 413 `roster_too_large`. */
export const ROSTER_CSV_MAX_ROWS = 5000;
/** The most guardian rows one request reads before it filters (memory bound, far above any caseload). */
export const ROSTER_READ_CAP = 20_000;

// ---- the query -------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .optional();

const rosterQuerySchema = z
  .object({
    q: optionalText(100),
    classYear: optionalText(10),
    includeArchived: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(ROSTER_MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((v) => !(v.cursor !== undefined && v.offset !== undefined), { message: "Use a cursor or an offset, not both", path: ["cursor"] });

export type RosterQuery = {
  q: string | null;
  classYear: string | null;
  includeArchived: boolean;
  limit: number;
  cursor: string | null;
  offset: number;
};

/** The query string both routes share; a bad value throws a ZodError (the error handler answers 400). */
export function parseRosterQuery(raw: unknown): RosterQuery {
  const v = rosterQuerySchema.parse(raw ?? {});
  return {
    q: v.q ?? null,
    classYear: v.classYear ?? null,
    includeArchived: v.includeArchived === "true",
    limit: v.limit ?? ROSTER_DEFAULT_LIMIT,
    cursor: v.cursor ?? null,
    offset: v.offset ?? 0,
  };
}

// ---- the rows --------------------------------------------------------------------

type Row = Record<string, unknown>;

/** A student as the directory knows one: nothing but what it may show. */
export type RosterStudent = { id: string; fullName: string | null; classYear: string | null; archived: boolean };

/** A guardians row, as read. */
export type RosterGuardian = {
  id: string;
  studentId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  alertsEnabled: boolean;
  receivesReports: boolean;
};

/** What `GET /guardians/roster` returns for each parent. The app reads exactly these keys. */
export type RosterEntry = {
  id: string;
  name: string;
  relationship: string | null;
  email: string | null;
  phone: string | null;
  studentId: string;
  studentName: string | null;
  classYear: string | null;
  receivesAlerts: boolean;
  receivesReports: boolean;
};

export type RosterRow = { key: string; entry: RosterEntry };

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};

export function toRosterGuardian(r: Row): RosterGuardian {
  return {
    id: String(r.id),
    studentId: String(r.student_id),
    fullName: text(r.full_name) ?? "",
    email: text(r.email),
    phone: text(r.phone),
    relationship: text(r.relationship),
    // A missing flag is the column's default (on), the same reading the composer and blasts use.
    alertsEnabled: r.alerts_enabled !== false,
    receivesReports: r.receives_reports !== false,
  };
}

export function toRosterStudent(r: Row): RosterStudent {
  return { id: String(r.id), fullName: text(r.full_name), classYear: text(r.grad_year), archived: r.archived_at !== null && r.archived_at !== undefined };
}

/** Archived students leave the list unless asked for; a class year narrows it. */
export function filterStudents(students: readonly RosterStudent[], f: { classYear: string | null; includeArchived: boolean }): RosterStudent[] {
  return students.filter((s) => (f.includeArchived || !s.archived) && (f.classYear === null || s.classYear === f.classYear));
}

// ---- order and search ------------------------------------------------------------

/** Lower case, accents and extra white space gone: how names are compared and searched. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const SUFFIX = /\s+(?:jr|sr|ii|iii|iv)\.?$/i;

/** "Maya Lee" and "Lee, Maya" both have the surname Lee; a trailing Jr./III is not a surname. */
export function studentSurname(fullName: string | null): { last: string; rest: string } {
  const name = (fullName ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { last: "", rest: "" };
  const comma = name.indexOf(",");
  if (comma > 0) return { last: name.slice(0, comma).trim(), rest: name.slice(comma + 1).trim() };
  const words = name.replace(SUFFIX, "").split(" ");
  const last = words[words.length - 1] ?? "";
  return { last, rest: words.slice(0, -1).join(" ") };
}

// Separator below every letter and digit, so "lee" sorts before "leeds".
const SEP = "\u0001";

function sortKey(student: RosterStudent, g: RosterGuardian): string {
  const { last, rest } = studentSurname(student.fullName);
  return [fold(last), fold(rest), student.id, fold(g.fullName), g.id].join(SEP);
}

const byKey = (a: RosterRow, b: RosterRow) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Guardians of the given students, searched and in order: the student's
 * surname, then first names, then the guardian's name, ties by id so the order
 * never changes between requests. A guardian whose student isn't in
 * `students` is not shown. `q` is matched (case and accents ignored) against
 * the guardian's name and email and the student's name, and never against an
 * id, a phone number or anything else.
 */
export function buildRoster(students: readonly RosterStudent[], guardians: readonly RosterGuardian[], q: string | null): RosterRow[] {
  const byId = new Map(students.map((s) => [s.id, s]));
  const needle = q === null ? "" : fold(q);
  const rows: RosterRow[] = [];
  for (const g of guardians) {
    const s = byId.get(g.studentId);
    if (!s) continue;
    if (needle) {
      const haystack = [g.fullName, g.email ?? "", s.fullName ?? ""].map(fold);
      if (!haystack.some((h) => h.includes(needle))) continue;
    }
    rows.push({
      key: sortKey(s, g),
      entry: {
        id: g.id,
        name: g.fullName,
        relationship: g.relationship,
        email: g.email,
        phone: g.phone,
        studentId: s.id,
        studentName: s.fullName,
        classYear: s.classYear,
        receivesAlerts: g.alertsEnabled,
        receivesReports: g.receivesReports,
      },
    });
  }
  return rows.sort(byKey);
}

// ---- paging ----------------------------------------------------------------------

const badCursor = () => badRequest("That page marker isn't valid. Start from the first page.");

function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ k: key }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  const k = (parsed as { k?: unknown } | null)?.k;
  if (typeof k !== "string" || k.length === 0 || k.length > 1000) throw badCursor();
  return k;
}

/**
 * One page of the sorted rows. A cursor names the last row of the previous page
 * by its sort key and the next page starts after that key, so rows added or
 * removed between two requests move nothing that was already read (an offset
 * does not promise that). `total` is every row the filters match.
 */
export function pageRoster(
  rows: readonly RosterRow[],
  p: { limit: number; cursor: string | null; offset: number }
): { guardians: RosterEntry[]; total: number; nextCursor: string | null } {
  let from = p.offset;
  if (p.cursor !== null) {
    const after = decodeCursor(p.cursor);
    const at = rows.findIndex((r) => r.key > after);
    from = at === -1 ? rows.length : at;
  }
  const page = rows.slice(from, from + p.limit);
  const more = from + page.length < rows.length;
  return {
    guardians: page.map((r) => r.entry),
    total: rows.length,
    nextCursor: more && page.length ? encodeCursor(rows[from + page.length - 1]!.key) : null,
  };
}

// ---- the CSV ---------------------------------------------------------------------

export const ROSTER_CSV_COLUMNS = ["Parent or guardian", "Relationship", "Email", "Phone", "Student", "Class year", "Gets alerts", "Gets reports"] as const;

const yesNo = (v: boolean) => (v ? "Yes" : "No");

/**
 * The directory as a spreadsheet: a header row, then one line per parent in the
 * order given. Built with the shared `csvCell`, which prefixes an apostrophe to
 * any text a spreadsheet would run as a formula (a parent's name, email or
 * relationship, the student's name: all typed by someone). That includes a phone
 * number that starts with "+": it shows with a leading apostrophe in a spreadsheet.
 */
export function rosterCsv(entries: readonly RosterEntry[]): string {
  const [name, relationship, email, phone, student, classYear, alerts, reports] = ROSTER_CSV_COLUMNS;
  return toCsv(
    entries.map((e) => ({
      [name]: e.name,
      [relationship]: e.relationship,
      [email]: e.email,
      [phone]: e.phone,
      [student]: e.studentName,
      [classYear]: e.classYear,
      [alerts]: yesNo(e.receivesAlerts),
      [reports]: yesNo(e.receivesReports),
    })),
    ROSTER_CSV_COLUMNS
  );
}

/** `meridies-parents-YYYY-MM-DD.csv`, the UTC date. */
export function rosterFilename(now: Date): string {
  return `meridies-parents-${now.toISOString().slice(0, 10)}.csv`;
}
