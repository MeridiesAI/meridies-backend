/**
 * Learning from Build College Lists (migration 20261119000001): what the list builder showed, and what people then
 * did with a school, kept so ranking weights can be learned later. Nothing here changes a ranking.
 *
 *   logImpressions  one list_builder_impressions row per school a POST /colleges/list-builder answer showed
 *   logChoice(s)    one list_builder_choices row per school added to or removed from a student's list, or
 *                   recommended to them, linked to the newest impression of that school for that student in the last
 *                   30 days (its run and position), when there is one
 *
 * Both write with the service client (the tables have no client grants), and store ids, numbers and fixed labels
 * only: no name and no free text about the student (the criteria's majors become the fields the ranking matched on,
 * its origin only whether one was set). A student whose counselor, or whose counselor's firm, has
 * `exclude_from_learning` (our team, demo and test accounts) is skipped entirely, and so is anything a flagged
 * counselor does on a student shared with them; so is any student whose flags can't be read (fail closed).
 *
 * They never throw and never hold the request up: call sites don't await them (`void logChoice(...)`); the returned
 * promise always resolves, with how many rows were written (tests read it). Every failure is a warning in the log.
 * While the migration isn't applied the first write fails, one warning says so, and nothing is tried for 5 minutes.
 *
 * Where they are called: POST /colleges/list-builder (impressions); every write of a school onto or off a list:
 * `addToList` (routes/application.ts: the board's Add, accepting a Recommended card, research's accept, and AxIS,
 * which calls those routes), POST /colleges/list-builder/add (a batch, source list_builder), DELETE
 * /application/college-list/:id, the older /student-colleges collection routes, and an AxIS Restore of a removed
 * school (routes/axis.ts); and POST /application/college-list/recommendations (action recommended).
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { isSchemaMissing } from "./axis/failsafe.js";
import { fieldFor, type Constraint, type ListCriteria, type ListPick } from "./collegesV10.js";
import { serviceClient } from "./supabase.js";

export type Band = "reach" | "target" | "likely";
export type ChoiceAction = "added" | "removed" | "recommended";
/** Where the change was made: Build College Lists' own screen, AxIS, or by hand anywhere else. */
export type ChoiceSource = "list_builder" | "manual" | "axis";

type Svc = Pick<SupabaseClient, "from">;
type Row = Record<string, unknown>;
type Log = { warn(obj: unknown, msg?: string): void };

/** The parts of a request the logger reads. */
export type LearnRequest = Pick<FastifyRequest, "auth" | "profile" | "log" | "headers">;

/** Tests inject the client and the clock; production takes `serviceClient()` and the wall clock. */
export type LearnDeps = { svc?: Svc | null; now?: () => Date };

/** What the logging needs in the database: the tables and the firm flag, then the counselor flag. */
export const LEARNING_MIGRATIONS = ["20261119000001_list_builder_learning", "20261120000001_list_learning_counselor_exclude"];
/** How far back a choice looks for the impression that showed the school. */
export const CHOICE_LOOKBACK_DAYS = 30;
/** The chat's dropped schools kept on an impression's criteria (the count is always kept). */
export const MAX_EXCLUDED_KEPT = 50;
const PAUSE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- The migration isn't in: one warning, then quiet for a while ----

let pausedUntil = 0;

function paused(now: Date): boolean {
  return now.getTime() < pausedUntil;
}

function pause(now: Date, log: Log): void {
  pausedUntil = now.getTime() + PAUSE_MS;
  log.warn({ migrations: LEARNING_MIGRATIONS }, "List-builder learning isn't logged: its database update isn't applied. Trying again in 5 minutes.");
}

/** Tests only. */
export function resetLearningForTest(): void {
  pausedUntil = 0;
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : String(err);

// ---- Who acted, and whose practice it is ----

function actorRole(request: LearnRequest): "counselor" | "student" | null {
  const role = request.profile?.role;
  return role === "counselor" || role === "student" ? role : null;
}

/**
 * AxIS runs its changes through this API in-process with this header (lib/axis/ops/dispatch.ts). It only labels the
 * row: a client that sends it itself mislabels nothing but its own choice, and is allowed nothing it wasn't already.
 */
export function isAxisRequest(request: Pick<FastifyRequest, "headers">): boolean {
  return request.headers?.["x-meridies-axis"] === "1";
}

type Practice = { firmId: string | null } | "excluded" | "missing";

/**
 * The student's practice, and whether learning may log it. The firm is the student's counselor's (null for a solo
 * counselor, or no counselor). "excluded" when the student's counselor, the acting counselor (a student shared with
 * them) or the counselor's firm is flagged `exclude_from_learning`, or the firm can't be found; "missing" when a
 * flag column isn't there (a migration isn't applied). A read error throws, and the caller logs nothing.
 */
async function practiceOf(svc: Svc, studentId: string, actor: { id: string; role: "counselor" | "student" }): Promise<Practice> {
  const student = await svc.from("profiles").select("counselor_id").eq("id", studentId).maybeSingle();
  if (student.error) throw student.error;
  const counselorId = ((student.data as Row | null)?.counselor_id as string | null) ?? null;
  const ids = [...new Set([counselorId, actor.role === "counselor" ? actor.id : null].filter((v): v is string => !!v))];
  let firmId: string | null = null;
  if (ids.length > 0) {
    const people = await svc.from("profiles").select("id, firm_id, exclude_from_learning").in("id", ids);
    if (people.error) {
      if (isSchemaMissing(people.error)) return "missing";
      throw people.error;
    }
    const rows = (people.data ?? []) as Row[];
    if (rows.some((r) => r.exclude_from_learning === true)) return "excluded";
    firmId = (rows.find((r) => r.id === counselorId)?.firm_id as string | null) ?? null;
  }
  if (!firmId) return { firmId: null };
  const firm = await svc.from("firms").select("exclude_from_learning").eq("id", firmId).maybeSingle();
  if (firm.error) {
    if (isSchemaMissing(firm.error)) return "missing";
    throw firm.error;
  }
  // A firm that can't be found can't be checked: nothing is logged.
  if (!firm.data) return "excluded";
  return (firm.data as Row).exclude_from_learning === true ? "excluded" : { firmId };
}

// ---- Impressions ----

/** One band of a list-builder answer: every school shown, in order, with its rank in the whole band. */
export type ShownBand = { fit: Band; total: number; shown: { pick: ListPick; bandRank: number }[] };

export type ImpressionRun = {
  studentId: string;
  criteria: ListCriteria;
  relaxed: Constraint[];
  view: { offset: number; perTier: number; excluded: string[] };
  /** Schools with a curated list profile, as opposed to the rest of the catalog. */
  curatedIds: ReadonlySet<string>;
  bands: ShownBand[];
};

/**
 * The criteria an impression keeps: the ListCriteria with its free text taken out (majors become the fields the
 * ranking matched them to; the origin's place and coordinates become `originSet`, the distance itself is each
 * row's `features.miles`), plus what else shaped the answer: the constraints loosened, the paging, and the schools
 * the list-builder chat dropped (ids).
 */
export function learningCriteria(c: ListCriteria, relaxed: Constraint[], view: ImpressionRun["view"]): Row {
  const fields = [...new Set(c.majors.map(fieldFor).filter((f): f is NonNullable<typeof f> => f !== null))].sort();
  return {
    majorFields: fields,
    majorsGiven: c.majors.length,
    sizes: c.sizes,
    settings: c.settings,
    testOptional: c.testOptional,
    miles: c.miles,
    originSet: c.origin !== null,
    aid: c.aid,
    diversity: c.diversity,
    relaxed,
    offset: view.offset,
    perTier: view.perTier,
    excluded: view.excluded.slice(0, MAX_EXCLUDED_KEPT),
    excludedCount: view.excluded.length,
  };
}

/** The ListSchool fields the ranking reads, where the school sat, and its match scores when list matching ran. */
export function learningFeatures(pick: ListPick, bandRank: number, bandTotal: number, curated: boolean): Row {
  const s = pick.school;
  return {
    admit: s.admit,
    satMid: s.satMid,
    gpaMid: s.gpaMid,
    needRating: s.needRating,
    largestGroupPct: s.largestGroupPct,
    undergrads: s.undergrads,
    setting: s.setting,
    testPolicy: s.testPolicy,
    fields: s.fields,
    miles: pick.miles,
    curated,
    bandRank,
    bandTotal,
    // List-match scores (LIST_MATCH_ENABLED), numbers only: the programs behind them are not kept.
    ...(pick.match
      ? { matchScore: pick.match.matchScore, coreScore: pick.match.coreScore, opportunityScore: pick.match.opportunityScore }
      : {}),
  };
}

const roundOdds = (odds: number | null) => (odds == null || !Number.isFinite(odds) ? null : Math.round(odds * 100) / 100);

/** The rows of one run (pure). Position is 1-based within the band's column, as shown. */
export function impressionRows(
  run: ImpressionRun,
  ids: { runId: string; firmId: string | null; actorId: string; actorRole: "counselor" | "student" }
): Row[] {
  const criteria = learningCriteria(run.criteria, run.relaxed, run.view);
  return run.bands.flatMap((band) =>
    band.shown.map(({ pick, bandRank }, i) => ({
      run_id: ids.runId,
      firm_id: ids.firmId,
      actor_id: ids.actorId,
      actor_role: ids.actorRole,
      student_id: run.studentId,
      college_id: pick.school.collegeId,
      position: i + 1,
      band: band.fit,
      odds: roundOdds(pick.odds),
      criteria,
      features: learningFeatures(pick, bandRank, band.total, run.curatedIds.has(pick.school.collegeId)),
    }))
  );
}

/** Logs one list-builder answer. Never throws; resolves with the rows written. */
export async function logImpressions(request: LearnRequest, run: ImpressionRun, deps: LearnDeps = {}): Promise<number> {
  const log = request.log;
  try {
    const now = deps.now?.() ?? new Date();
    if (paused(now)) return 0;
    const svc = deps.svc === undefined ? serviceClient() : deps.svc;
    const role = actorRole(request);
    if (!svc || !role) return 0;
    if (!run.bands.some((b) => b.shown.length > 0)) return 0;

    const practice = await practiceOf(svc, run.studentId, { id: request.auth.userId, role });
    if (practice === "missing") {
      pause(now, log);
      return 0;
    }
    if (practice === "excluded") return 0;

    const runId = randomUUID();
    const rows = impressionRows(run, { runId, firmId: practice.firmId, actorId: request.auth.userId, actorRole: role });
    const { error } = await svc.from("list_builder_impressions").insert(rows);
    if (error) {
      if (isSchemaMissing(error)) pause(now, log);
      else log.warn({ code: (error as { code?: string }).code }, "List-builder impressions not logged");
      return 0;
    }
    return rows.length;
  } catch (err) {
    log.warn({ err: errText(err) }, "List-builder impressions not logged");
    return 0;
  }
}

// ---- Choices ----

export type Choice = {
  studentId: string;
  /** The catalog school. A school typed in by hand has none and is not logged: nothing to learn against. */
  collegeId: string | null | undefined;
  action: ChoiceAction;
  source: ChoiceSource;
};

/** The newest impression of this school for this student since `since`, or null. */
async function lastImpression(svc: Svc, studentId: string, collegeId: string, since: Date): Promise<{ runId: string; position: number } | null> {
  const { data, error } = await svc
    .from("list_builder_impressions")
    .select("run_id, position")
    .eq("student_id", studentId)
    .eq("college_id", collegeId)
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  return row && typeof row.run_id === "string" && typeof row.position === "number" ? { runId: row.run_id, position: row.position } : null;
}

/**
 * Logs choices about schools on students' lists (a batch: one practice read per student). AxIS's requests are
 * labelled `axis` whatever the caller passed. Never throws; resolves with the rows written.
 */
export async function logChoices(request: LearnRequest, choices: Choice[], deps: LearnDeps = {}): Promise<number> {
  const log = request.log;
  try {
    const now = deps.now?.() ?? new Date();
    if (paused(now)) return 0;
    const svc = deps.svc === undefined ? serviceClient() : deps.svc;
    const role = actorRole(request);
    if (!svc || !role) return 0;
    const axis = isAxisRequest(request);
    const wanted = choices.filter(
      (c): c is Choice & { collegeId: string } => typeof c.collegeId === "string" && UUID.test(c.collegeId) && UUID.test(c.studentId)
    );
    if (wanted.length === 0) return 0;

    const since = new Date(now.getTime() - CHOICE_LOOKBACK_DAYS * 86_400_000);
    const rows: Row[] = [];
    for (const studentId of [...new Set(wanted.map((c) => c.studentId))]) {
      const practice = await practiceOf(svc, studentId, { id: request.auth.userId, role });
      if (practice === "missing") {
        pause(now, log);
        return 0;
      }
      if (practice === "excluded") continue;
      const mine = wanted.filter((c) => c.studentId === studentId);
      const shown = await Promise.all(mine.map((c) => lastImpression(svc, studentId, c.collegeId, since)));
      mine.forEach((c, i) => {
        rows.push({
          firm_id: practice.firmId,
          actor_id: request.auth.userId,
          actor_role: role,
          student_id: studentId,
          college_id: c.collegeId,
          action: c.action,
          source: axis ? "axis" : c.source,
          run_id: shown[i]?.runId ?? null,
          position: shown[i]?.position ?? null,
        });
      });
    }
    if (rows.length === 0) return 0;
    const { error } = await svc.from("list_builder_choices").insert(rows);
    if (error) {
      if (isSchemaMissing(error)) pause(now, log);
      else log.warn({ code: (error as { code?: string }).code }, "List-builder choices not logged");
      return 0;
    }
    return rows.length;
  } catch (err) {
    if (isSchemaMissing(err)) {
      pause(deps.now?.() ?? new Date(), log);
      return 0;
    }
    log.warn({ err: errText(err) }, "List-builder choices not logged");
    return 0;
  }
}

/** One choice. Never throws; resolves with the rows written (0 or 1). */
export function logChoice(request: LearnRequest, choice: Choice, deps: LearnDeps = {}): Promise<number> {
  return logChoices(request, [choice], deps);
}

/**
 * An AxIS Restore put a removed school back on the list (the database re-inserts the row, so no route sees it):
 * logged as added by AxIS. `payload` is the restored action's stored payload; anything but `college_list.remove`
 * logs nothing. The row is read on the counselor's own client. Never throws.
 */
export async function logRestoredChoice(
  request: LearnRequest & Pick<FastifyRequest, "db">,
  payload: unknown,
  deps: LearnDeps = {}
): Promise<number> {
  try {
    const p = (payload ?? {}) as { op?: unknown; input?: { student_college_id?: unknown } };
    const id = p.input?.student_college_id;
    if (p.op !== "college_list.remove" || typeof id !== "string" || !UUID.test(id)) return 0;
    const { data, error } = await request.db.from("student_colleges").select("student_id, college_id").eq("id", id).maybeSingle();
    if (error || !data) return 0;
    const row = data as Row;
    return await logChoices(
      request,
      [{ studentId: String(row.student_id), collegeId: (row.college_id as string | null) ?? null, action: "added", source: "axis" }],
      deps
    );
  } catch (err) {
    request.log.warn({ err: errText(err) }, "List-builder choices not logged");
    return 0;
  }
}
