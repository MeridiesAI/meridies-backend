/**
 * Authorization. Auth says who you are; this says whether you may touch THIS
 * student. RLS enforces the same rules in the database, but a route that skips
 * the check would leak the *shape* of the answer (404 vs 403 vs empty list), so
 * both layers run — as AGENTS.md requires.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { forbidden, fromPostgrest, notFound } from "./errors.js";
import type { Role } from "./serialize.js";

export function requireRole(role: Role) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.profile.role !== role) {
      throw forbidden(`Only ${role}s can do that`);
    }
  };
}

/**
 * For a route both a counselor and a student may use (a student's AI tools): any other role, or none, is refused.
 * It decides nothing about WHICH student: resolveStudentId still pins a student to themselves.
 */
export function requireRoleIn(...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!roles.includes(request.profile.role as Role)) {
      throw forbidden(`Only ${roles.join(" and ")}s can do that`);
    }
  };
}

/**
 * Whether the caller may archive or restore `studentId`: a counselor writing
 * about someone other than themselves. Edit access (assertCanEditStudent) and
 * RLS decide which counselor; this only keeps a student, who passes the edit
 * check for their own record, from switching off what their counselor sends
 * about them.
 */
export function canArchive(role: Role | string | null | undefined, callerId: string, studentId: string): boolean {
  return role === "counselor" && callerId !== studentId;
}

/**
 * How the caller is related to this student, or a throw when they aren't: the student
 * themselves, their primary counselor, or a collaborator with read or write access. One
 * profiles read, plus one student_collaborators read for a caller who isn't the primary
 * counselor; the view and edit checks both decide from this, so an edit reads nothing twice.
 */
async function studentAccess(
  request: FastifyRequest,
  studentId: string
): Promise<"self" | "primary" | "read" | "write"> {
  if (request.auth.userId === studentId) return "self";

  const { data, error } = await request.db
    .from("profiles")
    .select("id, counselor_id")
    .eq("id", studentId)
    .maybeSingle();

  if (error) {
    request.log.error({ err: error }, "student visibility check failed");
    throw forbidden();
  }
  // RLS already hid rows the caller may not read, so "no row" means no access.
  if (!data) throw notFound("That student isn't on your roster");
  if (data.counselor_id === request.auth.userId) return "primary";

  const { data: shared } = await request.db
    .from("student_collaborators")
    .select("student_id, access")
    .eq("student_id", studentId)
    .eq("counselor_id", request.auth.userId)
    .maybeSingle();

  if (!shared) throw notFound("That student isn't on your roster");
  return shared.access === "write" ? "write" : "read";
}

/** Throws unless the caller is the student or a counselor who owns them. */
export async function assertCanViewStudent(
  request: FastifyRequest,
  studentId: string
): Promise<void> {
  await studentAccess(request, studentId);
}

/** View access plus write rights (primary counselor, or write collaborator). */
export async function assertCanEditStudent(
  request: FastifyRequest,
  studentId: string
): Promise<void> {
  const access = await studentAccess(request, studentId);
  if (access === "read") throw forbidden("You have read-only access to that student");
}

/**
 * Resolve the student a request is about. Counselors pass `studentId`;
 * a student is always themselves and may never pass someone else's id.
 */
export async function resolveStudentId(
  request: FastifyRequest,
  requested: string | undefined,
  mode: "view" | "edit" = "view"
): Promise<string> {
  if (request.profile.role === "student") {
    if (requested && requested !== request.auth.userId) {
      throw forbidden("You can only access your own record");
    }
    return request.auth.userId;
  }
  if (!requested) throw forbidden("studentId is required");
  if (mode === "edit") await assertCanEditStudent(request, requested);
  else await assertCanViewStudent(request, requested);
  return requested;
}

/** The most students a scoped list query names in its URL; past it the query runs on RLS alone, as before. */
export const CASELOAD_SCOPE_MAX = 250;

/**
 * Every student a counselor can see: their roster (archived included), the
 * students shared with them, and their own id, which is exactly what
 * `private.can_view_student` lets through. A list query over all of a
 * counselor's students (the calendar feed, the task list) filters on these ids
 * so Postgres reads this caseload's rows by index; without the filter it reads
 * every practice's rows and RLS checks each one, so the page slows down as
 * other practices grow. RLS still applies on top, so the filter can only
 * narrow what a query returns.
 *
 * Null when the caller isn't a counselor, or the caseload is over
 * CASELOAD_SCOPE_MAX ids (the URL would grow too long): run the query
 * unscoped then. A failed read throws rather than scoping to nothing.
 */
export async function caseloadStudentIds(request: FastifyRequest): Promise<string[] | null> {
  if (request.profile.role !== "counselor") return null;
  const me = request.auth.userId;
  const [own, shared] = await Promise.all([
    request.db.from("profiles").select("id").eq("counselor_id", me).limit(CASELOAD_SCOPE_MAX + 1),
    request.db.from("student_collaborators").select("student_id").eq("counselor_id", me).limit(CASELOAD_SCOPE_MAX + 1),
  ]);
  if (own.error) throw fromPostgrest(own.error);
  if (shared.error) throw fromPostgrest(shared.error);
  const ids = new Set<string>([me]);
  for (const r of (own.data ?? []) as Array<{ id: string }>) ids.add(r.id);
  for (const r of (shared.data ?? []) as Array<{ student_id: string }>) ids.add(r.student_id);
  return ids.size > CASELOAD_SCOPE_MAX + 1 ? null : [...ids];
}

const CASELOAD_PAGE = 1000;

/**
 * The same caseload as caseloadStudentIds (roster, archived included, the
 * students shared with them, and themselves: `private.can_view_student`), but
 * never null: read page by page, whatever its size. For a reader that must
 * never run unscoped (the calendar feed, which also runs under the service
 * role for the iCal subscription, where RLS holds nothing). Every read is
 * keyed by `counselorId` in the query itself, so it is correct on either
 * client; a failed read throws.
 */
export async function fullCaseloadStudentIds(db: SupabaseClient, counselorId: string): Promise<string[]> {
  const ids = new Set<string>([counselorId]);
  async function pages(table: "profiles" | "student_collaborators", col: "id" | "student_id") {
    for (let from = 0; ; from += CASELOAD_PAGE) {
      const { data, error } = await db
        .from(table)
        .select(col)
        .eq("counselor_id", counselorId)
        .order(col)
        .range(from, from + CASELOAD_PAGE - 1);
      if (error) throw fromPostgrest(error);
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const r of rows) ids.add(String(r[col]));
      if (rows.length < CASELOAD_PAGE) return;
    }
  }
  await Promise.all([pages("profiles", "id"), pages("student_collaborators", "student_id")]);
  return [...ids];
}
