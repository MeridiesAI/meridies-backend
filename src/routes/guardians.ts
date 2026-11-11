/**
 * The parents directory (`lib/guardianRoster.ts` has the rules and the CSV).
 *
 *   GET /guardians/roster      a page of every parent/guardian on the caller's caseload
 *   GET /guardians/roster.csv  the same list as a download
 *
 * Counselor only (a pending counselor is refused by `authenticate`, a student
 * by `requireRole`). Read-only and derived: it lists `guardians` rows beside
 * the student each belongs to and sends, stores and changes nothing. It is not
 * a mailing list; who a blast or message reaches is still decided from the
 * roster at send time (`lib/blasts.ts`).
 *
 * Scope: `caseloadStudentIds(request)` names the students (past 250 it reads
 * the counselor's roster from `profiles` instead), every read runs as the
 * caller so RLS applies on top, and only students whose profile the caller can
 * read are listed. That leaves out students shared with the caller by a
 * colleague: `guardians` RLS lets a collaborator read their parents, but
 * `profiles` RLS does not let them read the student's name (the same fact that
 * leaves them out of the roster Sheet, `routes/account.ts`), and a parent with
 * no student to show is no use. They are counted in `sharedNotShown` (and, on
 * the CSV, the `X-Shared-Not-Shown` header) so the list never silently looks
 * complete. That count ignores `q`, `classYear` and `includeArchived`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromPostgrest } from "../lib/errors.js";
import { caseloadStudentIds, requireRole } from "../lib/guards.js";
import {
  ROSTER_CSV_MAX_ROWS,
  ROSTER_READ_CAP,
  buildRoster,
  csvTooLarge,
  filterStudents,
  pageRoster,
  parseRosterQuery,
  readTooLarge,
  rosterCsv,
  rosterFilename,
  toRosterGuardian,
  toRosterStudent,
  type RosterGuardian,
  type RosterStudent,
} from "../lib/guardianRoster.js";
import { limit } from "../lib/limits.js";
import { readPaged, type PageFetch } from "../lib/pagedRead.js";

type Row = Record<string, unknown>;

/** URL length: the most ids one `in (...)` filter names. */
const IN_CHUNK = 200;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every page of a read (at most `cap` rows), or a 413 when it won't fit; a database error is thrown as ours. */
async function readAll(fetchPage: PageFetch, cap?: number): Promise<Row[]> {
  const r = await readPaged(fetchPage, { cap });
  if (r.error) throw fromPostgrest(r.error as { code?: string; message?: string });
  if (r.truncated) throw readTooLarge();
  return r.rows;
}

/** The students whose profile the caller can read, from the caseload (or, past 250, their own roster). */
async function readableStudents(request: FastifyRequest, caseload: string[] | null): Promise<RosterStudent[]> {
  const me = request.auth.userId;
  const cols = "id, full_name, grad_year, archived_at";
  if (caseload) {
    const ids = caseload.filter((id) => id !== me);
    if (ids.length === 0) return [];
    const { data, error } = await request.db.from("profiles").select(cols).in("id", ids).eq("role", "student");
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as Row[]).map(toRosterStudent);
  }
  const rows = await readAll((from, to) => request.db.from("profiles").select(cols).eq("counselor_id", me).eq("role", "student").order("id").range(from, to));
  return rows.map(toRosterStudent);
}

/** Students shared with the caller whose profile row RLS keeps from them (so they can't be named in the list). */
async function unreadableSharedIds(request: FastifyRequest, caseload: string[] | null, readable: readonly RosterStudent[]): Promise<string[]> {
  const me = request.auth.userId;
  const known = new Set(readable.map((s) => s.id));
  let candidates: string[];
  if (caseload) candidates = caseload.filter((id) => id !== me);
  else {
    const rows = await readAll((from, to) => request.db.from("student_collaborators").select("student_id").eq("counselor_id", me).order("student_id").range(from, to));
    candidates = rows.map((r) => String(r.student_id));
  }
  return candidates.filter((id) => !known.has(id));
}

async function countGuardiansOf(request: FastifyRequest, studentIds: readonly string[]): Promise<number> {
  let total = 0;
  for (const chunk of chunks(studentIds, IN_CHUNK)) {
    const { count, error } = await request.db.from("guardians").select("id", { count: "exact", head: true }).in("student_id", chunk);
    if (error) throw fromPostgrest(error);
    total += count ?? 0;
  }
  return total;
}

const GUARDIAN_COLUMNS = "id, student_id, full_name, email, phone, relationship, alerts_enabled, receives_reports";

async function readGuardians(request: FastifyRequest, studentIds: readonly string[]): Promise<RosterGuardian[]> {
  const out: RosterGuardian[] = [];
  for (const chunk of chunks(studentIds, IN_CHUNK)) {
    // One allowance for the whole request, not one per chunk: the cap is on what a request reads.
    const page = (columns: string) =>
      readPaged(
        (from, to) => request.db.from("guardians").select(columns).in("student_id", chunk).order("id").range(from, to),
        { cap: ROSTER_READ_CAP - out.length }
      );
    // `added_by` (20261122000001) labels a parent the student added; an older database lists the same rows without it.
    let r = await page(`${GUARDIAN_COLUMNS}, added_by`);
    if ((r.error as { code?: string } | null)?.code === "42703") r = await page(GUARDIAN_COLUMNS);
    if (r.error) throw fromPostgrest(r.error as { code?: string; message?: string });
    if (r.truncated) throw readTooLarge();
    const rows = r.rows;
    for (const r of rows) out.push(toRosterGuardian(r));
  }
  return out;
}

/** The caller's students (after the archived and class year filters), their parents, and how many shared students were left out. */
async function loadDirectory(request: FastifyRequest, f: { classYear: string | null; includeArchived: boolean }) {
  const caseload = await caseloadStudentIds(request);
  const readable = await readableStudents(request, caseload);
  const students = filterStudents(readable, f);
  const [guardians, shared] = await Promise.all([
    readGuardians(request, students.map((s) => s.id)),
    unreadableSharedIds(request, caseload, readable).then((ids) => countGuardiansOf(request, ids)),
  ]);
  return { students, guardians, sharedNotShown: shared };
}

export default async function guardianRoutes(app: FastifyInstance) {
  app.get(
    "/roster",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("guardians:roster", 60, 60)] },
    async (request, reply) => {
      const query = parseRosterQuery(request.query);
      const { students, guardians, sharedNotShown } = await loadDirectory(request, query);
      const page = pageRoster(buildRoster(students, guardians, query.q), query);
      reply.header("Cache-Control", "no-store");
      return { ...page, sharedNotShown };
    }
  );

  app.get(
    "/roster.csv",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("guardians:roster-csv", 10, 3600)] },
    async (request, reply) => {
      const query = parseRosterQuery(request.query);
      const { students, guardians, sharedNotShown } = await loadDirectory(request, query);
      const rows = buildRoster(students, guardians, query.q);
      if (rows.length > ROSTER_CSV_MAX_ROWS) throw csvTooLarge();
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${rosterFilename(new Date())}"`)
        .header("Cache-Control", "no-store")
        // The file can't carry a note, so the count the list returns as `sharedNotShown` rides in a header (the app fetches server-side).
        .header("X-Shared-Not-Shown", String(sharedNotShown))
        .send(rosterCsv(rows.map((r) => r.entry)));
    }
  );
}
