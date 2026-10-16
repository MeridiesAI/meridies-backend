/**
 * The reads AxIS's code paths share: the direct answers, the evidence planner
 * and the tools all ask the same questions of the same tables, so they ask
 * them here. Every read runs on the caller's RLS client.
 */
import type { FastifyRequest } from "fastify";
import { freshness } from "../collegesV10.js";
import { plainName } from "../context/identity.js";
import { buildStudentContext, type StudentContext } from "../context/index.js";
import { researchTaskIds } from "../research/origin.js";
import type { SectionName } from "../context/profiles.js";
import { fromPostgrest } from "../errors.js";
import { gpaLabel } from "../gpa.js";
import { TtlLru, sharedLoad } from "./cache.js";
import type { DateWindow } from "./dates.js";
import { RosterIndex, type RosterRow } from "./entities.js";

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const isoDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** Student-written text shown in a chat answer: one line, no markdown that could turn into a link or an image. */
export function plain(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").replace(/[[\]<>*_`#|]/g, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---- Roster -----------------------------------------------------------------------------

const rosterCache = new TtlLru<Promise<RosterIndex>>(500, 60_000);

/** The counselor's own active students. A minute's cache: rosters change by the day, questions by the second. */
export function loadRoster(request: FastifyRequest): Promise<RosterIndex> {
  if (request.profile.role !== "counselor") return Promise.resolve(new RosterIndex([]));
  return sharedLoad(rosterCache, request.auth.userId, async () => {
    const { data, error } = await request.db
      .from("profiles")
      .select("id, full_name")
      .eq("counselor_id", request.auth.userId)
      .eq("role", "student")
      .is("archived_at", null)
      .limit(1000);
    if (error) throw fromPostgrest(error);
    // Names as AxIS shows them everywhere (find_student, cards, rankings): name characters only,
    // clipped (lib/context/identity.ts). The student writes their own name, at any length.
    return new RosterIndex(((data ?? []) as Row[]).map((r): RosterRow => ({ id: String(r.id), name: plainName(str(r.full_name)) })));
  });
}

// ---- A student's assembled record ---------------------------------------------------------

const contextCache = new TtlLru<Promise<StudentContext>>(500, 60_000);

/**
 * The context layer's view of a student, kept a minute per caller. Consecutive
 * turns about the same student (the usual case) reuse it instead of running
 * its dozen reads again, and the bytes stay identical, so the prompt cache
 * keeps matching too. Access is checked by the caller on every turn before
 * this is reached, so a revoked student never comes back from here.
 */
/** `trustedOnly`: only what the counselor wrote (lib/context/profiles.ts TRUSTED_SECTIONS), for change turns. */
export function cachedStudentContext(request: FastifyRequest, studentId: string, only?: SectionName[], trustedOnly = false): Promise<StudentContext> {
  const key = `${request.auth.userId}:${studentId}:${only ? only.join(",") : "*"}:${trustedOnly ? "trusted" : "all"}`;
  return sharedLoad(contextCache, key, () => buildStudentContext(request, studentId, "chat", { ...(only ? { only } : {}), ...(trustedOnly ? { trustedOnly } : {}) }));
}

// ---- One student's facts ------------------------------------------------------------------

export type StudentFacts = {
  id: string;
  name: string;
  gradYear: string | null;
  highSchool: string | null;
  gpaUnweighted: string | null;
  gpaWeighted: string | null;
  classRank: string | null;
  sat: { total: number; ebrw: number | null; math: number | null; superscore: boolean } | null;
  act: number | null;
  testStatus: string | null;
  majors: string[];
};

export async function studentFacts(request: FastifyRequest, studentId: string): Promise<StudentFacts | null> {
  const [profile, academics, personal] = await Promise.all([
    request.db.from("profiles").select("full_name, grad_year, high_school").eq("id", studentId).maybeSingle(),
    request.db
      .from("student_academics")
      .select("gpa_unweighted, gpa_weighted, gpa_scale, class_rank, class_rank_value, sat_superscore, sat_ebrw, sat_math, act_composite, test_status")
      .eq("student_id", studentId)
      .maybeSingle(),
    request.db.from("student_personal_details").select("intended_majors").eq("student_id", studentId).maybeSingle(),
  ]);
  for (const r of [profile, academics, personal]) if (r.error) throw fromPostgrest(r.error);
  if (!profile.data) return null;
  const p = profile.data as Row;
  const a = (academics.data ?? {}) as Row;
  const scale = str(a.gpa_scale) || null;
  const ebrw = num(a.sat_ebrw);
  const math = num(a.sat_math);
  const superscore = num(a.sat_superscore);
  const sat =
    superscore !== null
      ? { total: superscore, ebrw, math, superscore: true }
      : ebrw !== null && math !== null
        ? { total: ebrw + math, ebrw, math, superscore: false }
        : null;
  const majors = (personal.data as Row | null)?.intended_majors;
  return {
    id: studentId,
    name: str(p.full_name),
    gradYear: str(p.grad_year) || null,
    highSchool: str(p.high_school) || null,
    gpaUnweighted: gpaLabel(num(a.gpa_unweighted), scale),
    gpaWeighted: gpaLabel(num(a.gpa_weighted), scale),
    classRank: str(a.class_rank) || str(a.class_rank_value) || null,
    sat,
    act: num(a.act_composite),
    testStatus: str(a.test_status) || null,
    majors: Array.isArray(majors) ? majors.filter((m): m is string => typeof m === "string" && !!m.trim()) : [],
  };
}

// ---- What is due ----------------------------------------------------------------------------

export type UpcomingItem = {
  kind: "deadline" | "task" | "meeting";
  /** Its title may be the student's words (any deadline, a task the student added): outside content for AxIS. */
  outside: boolean;
  studentId: string;
  title: string;
  detail: string | null;
  date: string;
  status: string | null;
  overdue: boolean;
};

/**
 * Open deadlines, open tasks and booked meetings in a window, oldest first.
 * Roster-wide when studentId is null: only the counselor's own students,
 * because RLS also returns a firm colleague's students they can see.
 */
export async function upcomingItems(
  request: FastifyRequest,
  opts: { studentId: string | null; window: DateWindow; meetings: boolean; roster?: RosterIndex; limit?: number }
): Promise<UpcomingItem[]> {
  const db = request.db;
  const today = isoDay();
  const { from, to } = opts.window;
  let dq = db.from("deadlines").select("student_id, title, school, type, due_date").eq("done", false).lte("due_date", to);
  let tq = db.from("deliverables").select("id, student_id, title, status, due_date, source").neq("status", "complete").lte("due_date", to);
  if (from) {
    dq = dq.gte("due_date", from);
    tq = tq.gte("due_date", from);
  }
  if (opts.studentId) {
    dq = dq.eq("student_id", opts.studentId);
    tq = tq.eq("student_id", opts.studentId);
  }
  const meetingsFrom = from && from > today ? `${from}T00:00:00Z` : new Date().toISOString();
  let mq = db
    .from("meetings")
    .select("student_id, title, starts_at")
    .eq("counselor_id", request.auth.userId)
    .eq("status", "scheduled")
    .gte("starts_at", meetingsFrom)
    .lte("starts_at", `${to}T23:59:59Z`);
  if (opts.studentId) mq = mq.eq("student_id", opts.studentId);
  const limit = Math.min(opts.limit ?? 200, 500);
  const [deadlines, tasks, meetings] = await Promise.all([
    dq.order("due_date").limit(limit),
    tq.order("due_date").limit(limit),
    opts.meetings && to >= today ? mq.order("starts_at").limit(limit) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [deadlines, tasks, meetings]) if (r.error) throw fromPostgrest(r.error);
  // A counselor task accepted from Research carries the research model's words (lib/research/origin.ts).
  const counselorTaskIds = ((tasks.data ?? []) as Row[]).filter((t) => t.source === "counselor").map((t) => String(t.id));
  const research = counselorTaskIds.length ? await researchTaskIds(db, { taskIds: counselorTaskIds }) : new Set<string>();
  const mine = (sid: string) => !!opts.studentId || !opts.roster || !!opts.roster.get(sid);
  const items: UpcomingItem[] = [
    ...((deadlines.data ?? []) as Row[]).map((d): UpcomingItem => ({
      kind: "deadline",
      outside: true,
      studentId: String(d.student_id),
      title: str(d.title),
      detail: [str(d.school), str(d.type)].filter(Boolean).join(", ") || null,
      date: str(d.due_date),
      status: null,
      overdue: str(d.due_date) < today,
    })),
    ...((tasks.data ?? []) as Row[]).map((t): UpcomingItem => ({
      kind: "task",
      outside: t.source !== "counselor" || research === null || research.has(String(t.id)),
      studentId: String(t.student_id),
      title: str(t.title),
      detail: null,
      date: str(t.due_date),
      status: str(t.status) || null,
      overdue: str(t.due_date) < today,
    })),
    ...((meetings.data ?? []) as Row[]).map((m): UpcomingItem => ({
      kind: "meeting",
      outside: false,
      studentId: String(m.student_id ?? ""),
      title: str(m.title) || "Meeting",
      detail: null,
      date: str(m.starts_at).slice(0, 10),
      status: null,
      overdue: false,
    })),
  ];
  return items.filter((i) => i.date && mine(i.studentId)).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

// ---- Catalog facts ----------------------------------------------------------------------------

export type CollegeFact = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  admitRate: number | null;
  sat25: number | null;
  sat75: number | null;
  act25: number | null;
  act75: number | null;
  netPrice: number | null;
  enrollment: number | null;
  dataYear: string | null;
  stale: boolean;
};

export async function collegeFacts(request: FastifyRequest, ids: string[]): Promise<CollegeFact[]> {
  if (!ids.length) return [];
  const [colleges, stats] = await Promise.all([
    request.db.from("colleges").select("id, name, city, state, website").in("id", ids),
    request.db
      .from("college_stats")
      .select("college_id, admit_rate, sat_total_25, sat_total_75, act_25, act_75, avg_net_price, undergrad_enrollment, data_year, source_verified_at")
      .in("college_id", ids),
  ]);
  if (colleges.error) throw fromPostgrest(colleges.error);
  if (stats.error) throw fromPostgrest(stats.error);
  const statBy = new Map(((stats.data ?? []) as Row[]).map((s) => [String(s.college_id), s]));
  const order = new Map(ids.map((id, i) => [id, i]));
  return ((colleges.data ?? []) as Row[])
    .map((c): CollegeFact => {
      const s = statBy.get(String(c.id)) ?? {};
      const f = freshness(s.source_verified_at, s.data_year);
      return {
        id: String(c.id),
        name: str(c.name),
        city: str(c.city) || null,
        state: str(c.state) || null,
        website: str(c.website) || null,
        admitRate: num(s.admit_rate),
        sat25: num(s.sat_total_25),
        sat75: num(s.sat_total_75),
        act25: num(s.act_25),
        act75: num(s.act_75),
        netPrice: num(s.avg_net_price),
        enrollment: num(s.undergrad_enrollment),
        dataYear: f.dataYear,
        stale: f.stale,
      };
    })
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** A catalog row as a citable passage: our labels, the official figures, the year they belong to. */
export function collegeFactText(f: CollegeFact): string {
  return [
    `Source: U.S. Department of Education College Scorecard, data year ${f.dataYear ?? "unknown"}${f.stale ? " (not re-verified in the last 13 months)" : ""}`,
    `Admit rate: ${f.admitRate !== null ? pct(f.admitRate) : "not reported"}`,
    `SAT middle 50%: ${f.sat25 !== null && f.sat75 !== null ? `${f.sat25}–${f.sat75}` : "not reported"}`,
    `ACT middle 50%: ${f.act25 !== null && f.act75 !== null ? `${f.act25}–${f.act75}` : "not reported"}`,
    `Average net price: ${f.netPrice !== null ? money(f.netPrice) : "not reported"}`,
    `Undergraduates: ${f.enrollment !== null ? f.enrollment.toLocaleString("en-US") : "not reported"}`,
  ].join("\n");
}

export const format = { pct, money };
