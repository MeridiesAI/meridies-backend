/**
 * Which colleges a roster's lists point at, most-listed first. One place for
 * the rule, so the Colleges tab, the Events Hub's recommendations and the
 * events discovery job agree.
 *
 * A list row a counselor typed by hand has no college_id; its name is matched
 * in Postgres (`match_college_names`: exact name or alias, then close
 * spelling). A school counts once per student, however many rows they have.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

export type ListRow = { student_id: unknown; college_id: unknown; name: unknown };

/** college id -> the students who list it. */
export async function collegesOnLists(db: SupabaseClient, rows: ListRow[]): Promise<Map<string, Set<string>>> {
  const typed = [...new Set(rows.filter((r) => !r.college_id && r.name).map((r) => String(r.name)))].slice(0, 500);
  const byName = new Map<string, string>();
  if (typed.length) {
    const { data, error } = await db.rpc("match_college_names", { p_names: typed });
    if (error) throw new Error(`match_college_names: ${error.message}`);
    for (const m of (data ?? []) as Row[]) if (m.college_id) byName.set(String(m.name).toLowerCase(), String(m.college_id));
  }

  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const cid = (r.college_id as string | null) ?? byName.get(String(r.name ?? "").toLowerCase()) ?? null;
    if (!cid) continue;
    const students = out.get(cid) ?? new Set<string>();
    students.add(String(r.student_id));
    out.set(cid, students);
  }
  return out;
}

/** The ids, most students first. Ties keep a stable order by id. */
export function rankColleges(byCollege: Map<string, Set<string>>, max = Infinity): string[] {
  return [...byCollege.entries()]
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([id]) => id);
}

/** List rows for these students, 200 ids a query. */
export async function listRowsFor(db: SupabaseClient, studentIds: string[]): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  for (let i = 0; i < studentIds.length; i += 200) {
    const { data, error } = await db
      .from("student_colleges")
      .select("student_id, college_id, name")
      .in("student_id", studentIds.slice(i, i + 200))
      .limit(5000);
    if (error) throw new Error(`student_colleges: ${error.message}`);
    rows.push(...((data ?? []) as ListRow[]));
  }
  return rows;
}
