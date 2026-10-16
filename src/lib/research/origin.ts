/**
 * Which tasks came from Research: an accepted activity suggestion becomes a
 * counselor task (source 'counselor', lib/research/accept.ts) whose title and
 * instructions are the research model's words, taken from a web page. AxIS
 * must not read such a task as the counselor's own text, so the places that
 * treat a counselor's task as trusted ask here first. The link is the
 * recommendation's `accepted_as` ({ type: "task", id }).
 *
 * Read on the caller's client: recommendations are readable by a counselor who
 * can view the student (RLS), never by the student. Null when the read fails
 * (callers then treat every task as possibly from Research). The ids go into
 * no prompt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function researchTaskIds(
  db: SupabaseClient,
  scope: { taskIds?: string[]; studentIds?: string[] }
): Promise<Set<string> | null> {
  if (scope.taskIds && !scope.taskIds.length) return new Set();
  if (scope.studentIds && !scope.studentIds.length) return new Set();
  let q = db.from("recommendations").select("accepted_as").eq("feature", "activities").not("accepted_as", "is", null);
  if (scope.taskIds) q = q.in("accepted_as->>id", scope.taskIds.slice(0, 1000));
  if (scope.studentIds) q = q.in("student_id", scope.studentIds.slice(0, 1000));
  const { data, error } = await q.limit(5000);
  if (error) return null;
  const out = new Set<string>();
  for (const r of (data ?? []) as { accepted_as: unknown }[]) {
    const a = r.accepted_as as { type?: unknown; id?: unknown } | null;
    if (a && a.type === "task" && typeof a.id === "string") out.add(a.id);
  }
  return out;
}
