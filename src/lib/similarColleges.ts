/**
 * Colleges like the ones a student lists, for the Similar colleges section of
 * their Events tab: a similar admit rate and SAT range, and the same type
 * (public or private), from the catalog's College Scorecard figures. Each
 * suggestion names the listed college it is closest to ("Similar to Cornell").
 *
 * The scoring is pure, so it is tested without a database; one query reads
 * the candidates.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

export type Profile = {
  id: string;
  /** 0-1. */
  admitRate: number | null;
  /** Midpoint of the SAT 25th-75th range. */
  satMid: number | null;
  control: string | null;
};

/** Lower is closer. Null when the two can't be compared (no admit rate on either). */
export function distance(a: Profile, b: Profile): number | null {
  if (a.admitRate == null || b.admitRate == null) return null;
  let d = Math.abs(a.admitRate - b.admitRate) * 100;
  if (a.satMid != null && b.satMid != null) d += Math.abs(a.satMid - b.satMid) / 20;
  else d += 5; // unknown SAT: a little further, never closer
  if ((a.control === "public") !== (b.control === "public")) d += 15;
  return d;
}

/**
 * Colleges like the listed ones, at most `max`, never one already listed.
 * Each candidate belongs to the listed college it is closest to; then the
 * listed colleges take turns, each contributing its closest remaining
 * candidate, so a list of Cornell and Rutgers gets schools like both rather
 * than six like Cornell.
 */
export function rankSimilar(
  listed: Profile[],
  candidates: Profile[],
  max = 6
): { id: string; similarTo: string; distance: number }[] {
  const listedIds = new Set(listed.map((l) => l.id));
  const byListed = new Map<string, { id: string; distance: number; i: number }[]>();
  candidates.forEach((c, i) => {
    if (listedIds.has(c.id)) return;
    let best: { to: string; d: number } | null = null;
    for (const l of listed) {
      const d = distance(l, c);
      if (d != null && (!best || d < best.d)) best = { to: l.id, d };
    }
    if (!best) return;
    const list = byListed.get(best.to) ?? [];
    list.push({ id: c.id, distance: best.d, i });
    byListed.set(best.to, list);
  });
  for (const list of byListed.values()) list.sort((a, b) => a.distance - b.distance || a.i - b.i);

  const out: { id: string; similarTo: string; distance: number }[] = [];
  const queues = listed.map((l) => ({ to: l.id, items: byListed.get(l.id) ?? [] }));
  for (let round = 0; out.length < max && queues.some((q) => q.items.length > round); round++) {
    for (const q of queues) {
      const next = q.items[round];
      if (next && out.length < max) out.push({ id: next.id, similarTo: q.to, distance: next.distance });
    }
  }
  return out;
}

const toProfile = (r: Row, control: string | null): Profile => {
  const lo = r.sat_total_25 == null ? null : Number(r.sat_total_25);
  const hi = r.sat_total_75 == null ? null : Number(r.sat_total_75);
  return {
    id: String(r.college_id),
    admitRate: r.admit_rate == null ? null : Number(r.admit_rate),
    satMid: lo != null && hi != null ? (lo + hi) / 2 : (lo ?? hi),
    control,
  };
};

/**
 * Up to `max` colleges like the listed ones: candidates within ten points of
 * the listed admit-rate range, with at least 1,500 undergraduates and a
 * website on file (so their events can be looked up).
 */
export async function similarColleges(
  db: SupabaseClient,
  listedIds: string[],
  max = 6
): Promise<{ id: string; similarTo: string }[]> {
  if (!listedIds.length) return [];
  const { data: listedStats, error } = await db
    .from("college_stats")
    .select("college_id, admit_rate, sat_total_25, sat_total_75, control")
    .in("college_id", listedIds);
  if (error) throw new Error(`college_stats: ${error.message}`);
  const listed = ((listedStats ?? []) as Row[]).map((r) => toProfile(r, (r.control as string | null) ?? null));
  const rates = listed.map((l) => l.admitRate).filter((v): v is number => v != null);
  if (!rates.length) return [];

  const lo = Math.max(0, Math.min(...rates) - 0.1);
  const hi = Math.min(1, Math.max(...rates) + 0.1);
  const { data: cands, error: e2 } = await db
    .from("college_stats")
    .select("college_id, admit_rate, sat_total_25, sat_total_75, control, undergrad_enrollment, college:colleges!inner(website)")
    .gte("admit_rate", lo)
    .lte("admit_rate", hi)
    .gte("undergrad_enrollment", 1500)
    .not("college.website", "is", null)
    .order("undergrad_enrollment", { ascending: false })
    .limit(300);
  if (e2) throw new Error(`college_stats candidates: ${e2.message}`);
  const candidates = ((cands ?? []) as unknown as Row[]).map((r) => toProfile(r, (r.control as string | null) ?? null));
  return rankSimilar(listed, candidates, max).map(({ id, similarTo }) => ({ id, similarTo }));
}
