/**
 * The answer compiler: lookups answered straight from the data, with no model.
 *
 * A large share of what counselors ask is a lookup with one right answer:
 * her GPA, the next deadline, who is behind, Cornell's admit rate. A model
 * adds latency and a chance of a wrong digit to those and nothing else. When
 * the understanding of a question fits one of the frames below exactly (one
 * clause, no judgement word, every entity resolved without ambiguity), the
 * answer is built from the rows themselves in a few milliseconds after the
 * reads. Anything less certain returns null and goes to the model.
 *
 * Frames: roster count, caseload risk, what is due (one student or the
 * roster), a student's facts, catalog figures for up to four schools.
 */
import type { FastifyRequest } from "fastify";
import { resolveStudentId } from "../guards.js";
import {
  collegeFacts,
  collegeFactText,
  format,
  isoDay,
  plain,
  studentFacts,
  upcomingItems,
  type CollegeFact,
  type StudentFacts,
  type UpcomingItem,
} from "./data.js";
import { plainGradYear } from "../context/identity.js";
import type { DateWindow } from "./dates.js";
import type { RosterIndex } from "./entities.js";
import type { SourceLedger } from "./ledger.js";
import { COLLEGE_ATTRIBUTES, STUDENT_ATTRIBUTES, type Attribute } from "./lexicon.js";
import type { Understanding } from "./nlu.js";
import { loadRosterRisk } from "./risk.js";

export type DirectAnswer = {
  frame: "roster-count" | "caseload-risk" | "upcoming" | "student-facts" | "college-facts";
  text: string;
  trace: string[];
  sources: string[];
  /**
   * The answer quotes text someone other than the counselor wrote (a deadline's or a student-added
   * task's title, the student's high school or majors). It is saved to the chat and read back next
   * turn, so the engine carries this forward like a turn that read outside content.
   */
  outside: boolean;
};

export type CompileContext = {
  request: FastifyRequest;
  chatStudentId: string | null;
  roster: RosterIndex;
  ledger: SourceLedger;
  /** The chat student's facts, fetched alongside everything else at the start of the turn. */
  chatFacts?: Promise<StudentFacts | null>;
  now?: Date;
};

const PERSON = /\b(she|her|hers|he|him|his|they|them|their|theirs)\b/;
const RISK = /\b(behind|falling behind|at risk|need attention|needs attention|overdue|stalled|struggling|slipping|focus on|worry about|check on|follow up with)\b/;
const RISK_WHO = /\b(who|which students?|which of my students|anyone|anybody|whos)\b/;
const UPCOMING = /\b(due|deadlines?|coming up|upcoming|next deadline|next meeting|whats next|on the calendar|this week|next week)\b/;
const SINGULAR_NEXT = /\bnext (deadline|meeting|task|thing)\b/;
/** Time words the date parser didn't turn into a window: answering with a default window would answer a different question. */
const UNPARSED_TIME =
  /\b(before|after|until|till|through|since|thanksgiving|christmas|winter|spring|summer|fall|break|holidays?|semester|quarter|end of|month|year|january|february|march|april|june|july|august|september|october|november|december)\b/;
const SHORT_DEFAULT_WINDOW: DateWindow = { from: null, to: "", label: "in the next 14 days" };

function firstName(name: string): string {
  return plain(name.split(/\s+/)[0] ?? name, 40);
}

function shortDate(iso: string, now: Date): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return d.getUTCFullYear() === now.getUTCFullYear() ? md : `${md}, ${d.getUTCFullYear()}`;
}

/** One resolved student the question is about: the chat's, or exactly one named without ambiguity. */
function targetStudent(u: Understanding, ctx: CompileContext): { id: string; viaChat: boolean } | "ambiguous" | null {
  if (u.ambiguousStudents.length) return "ambiguous";
  const named = u.students.filter((s) => s.score >= 0.8 || s.via === "pronoun");
  if (named.length > 1) return "ambiguous";
  if (named.length === 1) return { id: named[0]!.id, viaChat: false };
  return ctx.chatStudentId ? { id: ctx.chatStudentId, viaChat: true } : null;
}

const isLookup = (u: Understanding) =>
  u.form === "lookup" || u.form === "imperative" || (u.form === "statement" && u.norm.split(" ").length <= 6);

export async function compileDirect(u: Understanding, ctx: CompileContext): Promise<DirectAnswer | null> {
  if (u.clauses.length !== 1 || u.intent === "essay" || u.intent === "action" || u.intent === "chitchat") return null;
  const now = ctx.now ?? new Date();

  const timeUnclear = !u.window && UNPARSED_TIME.test(u.norm);
  // Caseload risk comes first: "who should I focus on" carries a judgement word but is a ranking the code owns.
  if (!ctx.chatStudentId && !u.students.length && RISK_WHO.test(u.norm) && RISK.test(u.norm) && !u.colleges.length && !timeUnclear) {
    return caseloadRisk(ctx, horizonFor(u.window, now));
  }
  if (u.judgement || !isLookup(u)) return null;

  if (!ctx.chatStudentId && !u.students.length && /\bhow many students\b/.test(u.norm)) {
    return { frame: "roster-count", text: `You have ${ctx.roster.size} active student${ctx.roster.size === 1 ? "" : "s"}.`, trace: ["Counted your roster"], sources: ["Roster"], outside: false };
  }

  const studentAttrs = u.attributes.filter((a) => STUDENT_ATTRIBUTES.has(a));
  const collegeAttrs = u.attributes.filter((a) => COLLEGE_ATTRIBUTES.has(a));

  if (u.colleges.length && !u.ambiguousColleges.length && !PERSON.test(u.norm) && !u.students.length) {
    const asks = new Set<Attribute>(collegeAttrs);
    if (u.attributes.includes("sat")) asks.add("sat_range");
    if (u.attributes.includes("act")) asks.add("act_range");
    const unrelated = u.attributes.filter((a) => !COLLEGE_ATTRIBUTES.has(a) && a !== "sat" && a !== "act");
    const sure = u.colleges.every((c) => c.score >= 0.8 || c.via === "pronoun");
    if (asks.size && !unrelated.length && sure && u.colleges.length <= 4) return collegeFigures(ctx, u.colleges.map((c) => c.id), [...asks]);
    return null;
  }
  if (u.colleges.length || u.ambiguousColleges.length) return null;

  if (UPCOMING.test(u.norm) && (u.attributes.includes("deadline") || u.window) && !studentAttrs.length && !timeUnclear) {
    const who = targetStudent(u, ctx);
    if (who === "ambiguous") return null;
    return upcoming(ctx, u, who?.id ?? null, now);
  }

  if (studentAttrs.length && studentAttrs.length === u.attributes.length) {
    const who = targetStudent(u, ctx);
    if (!who || who === "ambiguous") return null;
    return studentFactsAnswer(ctx, who.id, who.viaChat, studentAttrs);
  }
  return null;
}

/** The ranking's look-ahead: the window asked about ("this week"), else two weeks. */
function horizonFor(window: DateWindow | null, now: Date): number {
  if (!window) return 14;
  const days = Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${isoDay(now)}T00:00:00Z`)) / 86_400_000);
  return Math.max(1, Math.min(days, 60));
}

async function caseloadRisk(ctx: CompileContext, horizon: number): Promise<DirectAnswer> {
  const ranked = (await loadRosterRisk(ctx.request, horizon)).slice(0, 5);
  const span = horizon === 1 ? "by tomorrow" : `in the next ${horizon} days`;
  const text = ranked.length
    ? [
        `Ranked by overdue work, deadlines ${span} and days without activity:`,
        ...ranked.map((r, i) => `${i + 1}. ${plain(r.name, 60)}: ${r.reasons.join("; ")}.`),
      ].join("\n")
    : `Nobody on your roster has overdue work, a red flag or a deadline at risk ${span}.`;
  return { frame: "caseload-risk", text, trace: ["Ranked the caseload by urgency"], sources: ["Tasks", "Calendar"], outside: ranked.some((r) => r.outside) };
}

async function upcoming(ctx: CompileContext, u: Understanding, studentId: string | null, now: Date): Promise<DirectAnswer> {
  const id = studentId ? await resolveStudentId(ctx.request, studentId, "view") : null;
  const window: DateWindow = u.window ?? { ...SHORT_DEFAULT_WINDOW, to: isoDay(new Date(now.getTime() + 14 * 86_400_000)) };
  const meetings = /\b(meeting|meetings|call|calls|session|sessions|calendar|schedule|coming up)\b/.test(u.norm) || !u.attributes.includes("deadline");
  const items = await upcomingItems(ctx.request, { studentId: id, window, meetings, roster: ctx.roster, limit: 100 });
  const who = (it: UpcomingItem) => (id ? "" : `${plain(ctx.roster.get(it.studentId)?.name ?? "Student", 60)} · `);
  const line = (it: UpcomingItem) =>
    `${shortDate(it.date, now)}${it.overdue ? " (overdue)" : ""} · ${who(it)}${plain(it.title, 100)}${it.detail ? `, ${plain(it.detail, 60)}` : ""}${it.kind === "task" && it.status ? ` · ${it.status.replace("-", " ")}` : it.kind === "meeting" ? " · meeting" : ""}`;
  const name = id ? firstName(ctx.roster.get(id)?.name ?? (await studentFacts(ctx.request, id))?.name ?? "") : "";
  if (!items.length) {
    return {
      frame: "upcoming",
      text: `Nothing open is due ${window.label}${name ? ` for ${name}` : ""}.`,
      trace: ["Checked deadlines, tasks and meetings"],
      sources: ["Calendar", "Tasks"],
      outside: false,
    };
  }
  if (SINGULAR_NEXT.test(u.norm)) {
    const kind = /\bmeeting\b/.test(u.norm) ? "meeting" : /\btask\b/.test(u.norm) ? "task" : /\bdeadline\b/.test(u.norm) ? "deadline" : null;
    const next = items.find((i) => !i.overdue && (!kind || i.kind === kind));
    if (next) return { frame: "upcoming", text: `Next${kind ? ` ${kind}` : ""}: ${line(next)}.`, trace: ["Checked deadlines, tasks and meetings"], sources: ["Calendar", "Tasks"], outside: next.outside };
  }
  const shown = items.slice(0, 12);
  const more = items.length - shown.length;
  return {
    frame: "upcoming",
    text: [
      `${items.length} open item${items.length === 1 ? "" : "s"} ${window.label}${name ? ` for ${name}` : ""}:`,
      ...shown.map((i) => `- ${line(i)}`),
      ...(more > 0 ? [`- and ${more} more`] : []),
    ].join("\n"),
    trace: ["Checked deadlines, tasks and meetings"],
    sources: ["Calendar", "Tasks"],
    outside: shown.some((i) => i.outside),
  };
}

async function studentFactsAnswer(ctx: CompileContext, studentId: string, viaChat: boolean, attrs: Attribute[]): Promise<DirectAnswer | null> {
  const id = await resolveStudentId(ctx.request, studentId, "view");
  const f = viaChat && ctx.chatFacts ? await ctx.chatFacts : await studentFacts(ctx.request, id);
  if (!f) return null;
  const n = firstName(f.name) || "This student";
  const lines: string[] = [];
  // Which printed values are text the student (or an import, or the questionnaire) typed: rank, major,
  // school, testing status and a class year that isn't four digits. Numbers aren't.
  let outside = false;
  const typed = <T>(v: T): T => {
    outside = true;
    return v;
  };
  const satLine = () =>
    f.sat
      ? `${n}'s SAT is ${f.sat.total}${f.sat.superscore ? " (superscore)" : f.sat.ebrw !== null && f.sat.math !== null ? ` (${f.sat.ebrw} reading and writing, ${f.sat.math} math)` : ""}.`
      : `${n} has no SAT score on file${f.testStatus ? `; testing status: ${typed(plain(f.testStatus, 60))}` : ""}.`;
  const actLine = () => (f.act !== null ? `${n}'s ACT composite is ${f.act}.` : `${n} has no ACT score on file.`);
  for (const a of attrs) {
    if (a === "gpa") {
      lines.push(
        f.gpaUnweighted && f.gpaWeighted
          ? `${n}'s GPA is ${f.gpaUnweighted} unweighted and ${f.gpaWeighted} weighted.`
          : f.gpaUnweighted
            ? `${n}'s unweighted GPA is ${f.gpaUnweighted}.`
            : f.gpaWeighted
              ? `${n}'s weighted GPA is ${f.gpaWeighted}.`
              : `${n} has no GPA on file yet.`
      );
    } else if (a === "sat") lines.push(satLine());
    else if (a === "act") lines.push(actLine());
    else if (a === "tests") lines.push(satLine(), actLine());
    else if (a === "rank") lines.push(f.classRank ? `${n}'s class rank: ${typed(plain(f.classRank, 60))}.` : `${n} has no class rank on file.`);
    else if (a === "major") lines.push(f.majors.length ? `${n}'s intended major${f.majors.length === 1 ? " is" : "s are"} ${typed(f.majors.map((m) => plain(m, 60)).join(", "))}.` : `${n} has no intended major on file.`);
    else if (a === "class_year") lines.push(f.gradYear ? `${n} is in the class of ${plainGradYear(f.gradYear) ?? typed(plain(f.gradYear, 10))}.` : `${n} has no graduation year on file.`);
    else if (a === "school") lines.push(f.highSchool ? `${n} attends ${typed(plain(f.highSchool, 100))}.` : `${n} has no high school on file.`);
  }
  if (!lines.length) return null;
  return { frame: "student-facts", text: [...new Set(lines)].join("\n"), trace: [`Read ${n}'s record`], sources: ["Student profile", "Grades and scores"], outside };
}

async function collegeFigures(ctx: CompileContext, ids: string[], asks: Attribute[]): Promise<DirectAnswer | null> {
  const facts = await collegeFacts(ctx.request, ids);
  if (facts.length !== ids.length) return null;
  const year = (f: CollegeFact) => `College Scorecard${f.dataYear ? `, ${plain(f.dataYear, 12)}` : ""}`;
  const blocks: string[] = [];
  let stale = false;
  for (const f of facts) {
    const { ids: cite } = ctx.ledger.add([
      { chunkId: `college:${f.id}`, documentId: null, studentId: null, title: `${f.name} (${[f.city, f.state].filter(Boolean).join(", ")})`, text: collegeFactText(f), score: 1, source: "catalog", url: f.website },
    ]);
    const c = cite[0] ? ` [${cite[0]}]` : "";
    stale ||= f.stale;
    const name = plain(f.name, 100);
    const parts: string[] = [];
    for (const a of asks) {
      if (a === "admit_rate") parts.push(f.admitRate !== null ? `admitted ${format.pct(f.admitRate)} of applicants` : "doesn't report an admit rate");
      if (a === "sat_range") parts.push(f.sat25 !== null && f.sat75 !== null ? `has an SAT middle 50% of ${f.sat25}–${f.sat75}` : "doesn't report an SAT range");
      if (a === "act_range") parts.push(f.act25 !== null && f.act75 !== null ? `has an ACT middle 50% of ${f.act25}–${f.act75}` : "doesn't report an ACT range");
      if (a === "net_price") parts.push(f.netPrice !== null ? `has an average net price of ${format.money(f.netPrice)}` : "doesn't report an average net price");
      if (a === "enrollment") parts.push(f.enrollment !== null ? `enrolls ${f.enrollment.toLocaleString("en-US")} undergraduates` : "doesn't report its enrollment");
    }
    if (!parts.length) return null;
    const sentence = `${name} ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`} (${year(f)})${c}.`;
    blocks.push(facts.length > 1 ? `- ${sentence}` : sentence);
  }
  if (stale) blocks.push("These figures haven't been re-verified against the source in over a year.");
  return { frame: "college-facts", text: blocks.join("\n"), trace: [`Looked up ${facts.length === 1 ? plain(facts[0]!.name, 80) : `${facts.length} schools`} in the College Scorecard data`], sources: ["College catalog"], outside: false };
}
