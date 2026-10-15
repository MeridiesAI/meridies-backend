/**
 * The same suggestion across runs. Every run that isn't served from the cache stores fresh rows, so "Search again" or
 * a new focus can leave one program or college `suggested` twice, or suggest again something already accepted. This
 * module decides which rows are the same suggestion (`recommendationKey`) and labels the repeats (`markRepeats`), so a
 * list shows each suggestion once and the counselor can't turn one program into two tasks.
 *
 * The rule, per feature and key:
 *  - an accepted row whose college-list row or task still exists makes the newest `suggested` copy
 *    `repeatOf: { status: "accepted" }` (accept is refused with 409 `already_accepted`; dismiss still works);
 *  - every older `suggested` copy is `repeatOf: { status: "suggested" }`, pointing at the newest copy, which stands
 *    for them all: deciding it (accept or dismiss) dismisses the older copies too.
 * Accepted and dismissed rows are never marked.
 */
import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "../errors.js";

export type RepeatOf = { id: string; status: "suggested" | "accepted" };

/** The fields the rule reads. `createdAt` orders copies (newest wins); ties fall back to the id. */
export type RepeatCandidate = {
  id: string;
  feature: string;
  title: string;
  details: { collegeId?: string } | null;
  status: string;
  createdAt: string;
};

/**
 * A title folded for comparison: Unicode NFKC, lowercase, combining marks removed, `&` read as "and", every run of
 * anything that isn't a letter or a digit collapsed to one space. "Marine Science Program (A)" and
 * "marine science program a" are the same; "Program A" and "Program B" are not.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Which suggestion a row is. A college with a catalog id is that college (the id is set only when exactly one catalog
 * college has the title, so the same title always gives the same id); anything else is its folded title. The feature
 * is part of the key: an activity and a college never match.
 */
export function recommendationKey(r: Pick<RepeatCandidate, "feature" | "title" | "details">): string {
  const collegeId = r.feature === "college_list" ? r.details?.collegeId : undefined;
  return collegeId ? `${r.feature}|c:${collegeId}` : `${r.feature}|t:${normalizeTitle(r.title)}`;
}

const newerFirst = (a: RepeatCandidate, b: RepeatCandidate) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1;

/**
 * The repeat label for each of `targets`, decided against `pool` (the student's suggested and accepted rows; the
 * targets themselves may or may not be in it). `liveAccepted` holds the ids of accepted rows whose college-list row or
 * task still exists: an accepted row whose thing was deleted no longer blocks a new copy.
 */
export function markRepeats(
  targets: RepeatCandidate[],
  pool: RepeatCandidate[],
  liveAccepted: ReadonlySet<string>
): Map<string, RepeatOf | null> {
  const byId = new Map<string, RepeatCandidate>();
  for (const r of [...pool, ...targets]) byId.set(r.id, r);
  const newestSuggested = new Map<string, RepeatCandidate>();
  const accepted = new Map<string, RepeatCandidate>();
  for (const r of [...byId.values()].sort(newerFirst)) {
    const key = recommendationKey(r);
    if (r.status === "suggested" && !newestSuggested.has(key)) newestSuggested.set(key, r);
    if (r.status === "accepted" && liveAccepted.has(r.id) && !accepted.has(key)) accepted.set(key, r);
  }
  const out = new Map<string, RepeatOf | null>();
  for (const t of targets) {
    if (t.status !== "suggested") {
      out.set(t.id, null);
      continue;
    }
    const key = recommendationKey(t);
    const lead = newestSuggested.get(key);
    if (lead && lead.id !== t.id) out.set(t.id, { id: lead.id, status: "suggested" });
    else {
      const done = accepted.get(key);
      out.set(t.id, done ? { id: done.id, status: "accepted" } : null);
    }
  }
  return out;
}

type Row = Record<string, unknown>;

const ID_BATCH = 100;

const POOL_COLUMNS = "id, feature, title, details, status, accepted_as, created_at";

export const toCandidate = (r: Row): RepeatCandidate => ({
  id: r.id as string,
  feature: r.feature as string,
  title: r.title as string,
  details: (r.details as RepeatCandidate["details"]) ?? null,
  status: r.status as string,
  createdAt: r.created_at as string,
});

/** Accepted rows whose college-list row or task still exists, read on the caller's client (RLS applies). */
async function liveAcceptedIds(request: FastifyRequest, accepted: Row[]): Promise<Set<string>> {
  const live = new Set<string>();
  const refs = accepted
    .map((r) => ({ id: r.id as string, as: r.accepted_as as { type?: string; id?: string } | null }))
    .filter((r): r is { id: string; as: { type: string; id: string } } => typeof r.as?.id === "string" && typeof r.as?.type === "string");
  const lookups: [string, "student_colleges" | "deliverables"][] = [
    ["student_college", "student_colleges"],
    ["task", "deliverables"],
  ];
  await Promise.all(
    lookups.map(async ([type, table]) => {
      const ids = [...new Set(refs.filter((r) => r.as.type === type).map((r) => r.as.id))];
      const found = new Set<string>();
      // In batches, so a long history never builds a request URL PostgREST or the gateway would refuse.
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        const { data, error } = await request.db.from(table).select("id").in("id", ids.slice(i, i + ID_BATCH));
        if (error) throw fromPostgrest(error);
        for (const d of data ?? []) found.add(d.id as string);
      }
      for (const r of refs) if (r.as.type === type && found.has(r.as.id)) live.add(r.id);
    })
  );
  return live;
}

/** The student's rows in one status for these features, newest first, on the caller's client. */
export async function readCandidates(
  request: FastifyRequest,
  studentId: string,
  features: string[],
  status: "suggested" | "accepted",
  max = 500
): Promise<{ rows: RepeatCandidate[]; raw: Row[] }> {
  const { data, error } = await request.db
    .from("recommendations")
    .select(POOL_COLUMNS)
    .eq("student_id", studentId)
    .in("feature", features)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(max);
  if (error) throw fromPostgrest(error);
  const raw = (data ?? []) as Row[];
  return { rows: raw.map(toCandidate), raw };
}

/**
 * The student's suggested and accepted rows for these features, and which accepted ones still stand. Read on the
 * caller's client, so it never sees more than the counselor can. An accepted row with no `accepted_as` (its link
 * write failed) is treated as gone: nothing to point the counselor at.
 */
export async function loadRepeatPool(
  request: FastifyRequest,
  studentId: string,
  features: string[]
): Promise<{ pool: RepeatCandidate[]; live: Set<string> }> {
  const [sug, acc] = await Promise.all([
    readCandidates(request, studentId, features, "suggested"),
    readCandidates(request, studentId, features, "accepted"),
  ]);
  const live = await liveAcceptedIds(request, acc.raw);
  return { pool: [...sug.rows, ...acc.rows], live };
}

/** The other `suggested` copies of `rec` (same feature and key), by id. */
export function copiesOf(rec: RepeatCandidate, rows: RepeatCandidate[]): string[] {
  const key = recommendationKey(rec);
  return rows.filter((r) => r.id !== rec.id && r.status === "suggested" && recommendationKey(r) === key).map((r) => r.id);
}

/** An accepted row for the same suggestion whose college-list row or task still exists, if any. */
export function acceptedCopyOf(rec: RepeatCandidate, rows: RepeatCandidate[], live: ReadonlySet<string>): RepeatCandidate | null {
  const key = recommendationKey(rec);
  return rows.find((r) => r.id !== rec.id && r.status === "accepted" && live.has(r.id) && recommendationKey(r) === key) ?? null;
}

/** `repeatOf` for each target, against the student's rows for the targets' features. */
export async function repeatsFor(request: FastifyRequest, studentId: string, targets: RepeatCandidate[]): Promise<Map<string, RepeatOf | null>> {
  if (!targets.some((t) => t.status === "suggested")) return new Map(targets.map((t) => [t.id, null]));
  const features = [...new Set(targets.map((t) => t.feature))];
  const { pool, live } = await loadRepeatPool(request, studentId, features);
  return markRepeats(targets, pool, live);
}
