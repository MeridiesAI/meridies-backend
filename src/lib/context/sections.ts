/**
 * One loader per context section (spec §4). Each selects named columns from
 * the AI allowlist through columns(), never `select *`, and returns a Section
 * or nothing.
 *
 * Trust rule: `Section.body` holds only text this file writes (labels, counts)
 * plus fixed-enum values and numbers. Everything a student, an import or a
 * document supplied, names and titles included, goes into the section's
 * `untrusted` list and reaches the prompt as an escaped data block.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromPostgrest } from "../errors.js";
import { gpaLabel } from "../gpa.js";
import { columns } from "./ai-allowlist.js";
import { documentAiDecision, toAiDoc } from "./documentAi.js";
import type { Section } from "./pack.js";
import type { SectionName } from "./profiles.js";
import type { ContextUsage, StudentContext } from "./types.js";

type Row = Record<string, unknown>;
type Omitted = ContextUsage["omitted"][number];
export type LoaderOptions = { essayBodies: boolean; practiceReadsDocuments: boolean };
export type LoaderResult = { section: Section | null; omitted?: Omitted[]; facts?: Partial<StudentContext["facts"]> };
export type Loader = (db: SupabaseClient, studentId: string, opts: LoaderOptions) => Promise<LoaderResult>;

/** The longest document text read into a prompt; a longer document is dropped whole. */
const DOCUMENT_TEXT_CAP = 12_000;

type Res = { data: unknown; error: { code?: string; message?: string } | null };

async function many(q: PromiseLike<Res>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw fromPostgrest(error);
  return Array.isArray(data) ? (data as Row[]) : [];
}

async function one(q: PromiseLike<Res>): Promise<Row | null> {
  const { data, error } = await q;
  if (error) throw fromPostgrest(error);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
/** "label: value" when there is a value. */
const kv = (label: string, v: unknown): string | null => {
  const s = typeof v === "number" || typeof v === "boolean" ? String(v) : str(v);
  return s ? `${label}: ${s}` : null;
};
const compact = (parts: (string | null | undefined | false)[]): string[] => parts.filter((p): p is string => typeof p === "string" && p !== "");
/** A data-block source label built from a student-written name: one line, bounded. */
const tag = (prefix: string, name: string): string => `${prefix}:${name.replace(/\s+/g, " ").trim().slice(0, 80)}`;

const empty = (section: SectionName): LoaderResult => ({ section: null, omitted: [{ section, reason: "empty" }] });

/** A section whose only content is free text: one escaped block, no trusted body. */
const textSection = (name: SectionName, label: string, source: string, lines: string[], body = ""): LoaderResult =>
  lines.length === 0 && !body
    ? empty(name)
    : { section: { name, label, body, untrusted: lines.length ? [{ source, text: lines.join("\n") }] : [] } };

// A scale is shown as plain text only when it is a bare number ("4.0", "100").
const SAFE_SCALE = /^\d{1,3}(\.\d{1,2})?$/;

const profile: Loader = async (db, studentId) => {
  const r = await one(db.from("profiles")
    .select(columns("profiles", ["full_name", "grad_year", "high_school", "hometown", "headline"]))
    .eq("id", studentId).maybeSingle());
  if (!r) return { section: null };
  const lines = compact([kv("Name", r.full_name), kv("Graduation year", r.grad_year), kv("High school", r.high_school),
    kv("Hometown", r.hometown), kv("Headline", r.headline)]);
  return {
    ...textSection("profile", "Student", "profile", lines),
    facts: {
      gradYear: str(r.grad_year) || null,
      identity: { name: str(r.full_name) || null, email: null, school: str(r.high_school) || null, hometown: str(r.hometown) || null },
    },
  };
};

const academics: Loader = async (db, studentId) => {
  const r = await one(db.from("student_academics")
    .select(columns("student_academics", ["gpa_unweighted", "gpa_weighted", "gpa_scale", "class_rank", "class_rank_value",
      "rigor_count", "rigor_subjects", "test_status", "sat_ebrw", "sat_math", "sat_superscore", "act_composite",
      "strength_areas", "strength_subjects"]))
    .eq("student_id", studentId).maybeSingle());
  if (!r) return empty("academics");
  const scale = str(r.gpa_scale) || null;
  const unweighted = num(r.gpa_unweighted);
  const weighted = num(r.gpa_weighted);
  const gpaLines = compact([
    unweighted !== null && `GPA (unweighted): ${gpaLabel(unweighted, scale)}`,
    weighted !== null && `GPA (weighted): ${gpaLabel(weighted, scale)}`,
  ]);
  const scaleIsSafe = scale === null || SAFE_SCALE.test(scale);
  const sat = num(r.sat_superscore) ?? (num(r.sat_ebrw) !== null && num(r.sat_math) !== null ? (num(r.sat_ebrw) ?? 0) + (num(r.sat_math) ?? 0) : null);
  const act = num(r.act_composite);
  const rigor = num(r.rigor_count);
  const body = compact([
    ...(scaleIsSafe ? gpaLines : []),
    sat !== null && `SAT: ${sat}`,
    num(r.sat_ebrw) !== null && `SAT evidence-based reading and writing: ${num(r.sat_ebrw)}`,
    num(r.sat_math) !== null && `SAT math: ${num(r.sat_math)}`,
    act !== null && `ACT: ${act}`,
    rigor !== null && `Rigorous courses: ${rigor}`,
    str(r.test_status) && `Testing status: ${str(r.test_status)}`,
  ]).join("\n");
  const free = compact([
    ...(scaleIsSafe ? [] : gpaLines),
    kv("Class rank", r.class_rank), kv("Class rank value", r.class_rank_value),
    strings(r.rigor_subjects).length ? `Rigor subjects: ${strings(r.rigor_subjects).join(", ")}` : null,
    strings(r.strength_areas).length ? `Strength areas: ${strings(r.strength_areas).join(", ")}` : null,
    strings(r.strength_subjects).length ? `Strength subjects: ${strings(r.strength_subjects).join(", ")}` : null,
  ]);
  const res = textSection("academics", "Academics", "academics", free, body);
  return { ...res, facts: { gpa: { value: unweighted ?? weighted, scale }, sat, act } };
};

const personal: Loader = async (db, studentId) => {
  const r = await one(db.from("student_personal_details")
    .select(columns("student_personal_details", ["intended_majors", "first_gen", "citizenship"]))
    .eq("student_id", studentId).maybeSingle());
  if (!r) return empty("personal");
  const majors = strings(r.intended_majors);
  const body = compact([
    typeof r.first_gen === "boolean" && `First-generation college student: ${r.first_gen ? "yes" : "no"}`,
    str(r.citizenship) && `Citizenship: ${str(r.citizenship)}`,
  ]).join("\n");
  const res = textSection("personal", "Personal", "intended-majors", majors.length ? [`Intended majors: ${majors.join(", ")}`] : [], body);
  return { ...res, facts: { intendedMajors: majors } };
};

const activities: Loader = async (db, studentId) => {
  const rows = await many(db.from("activities")
    .select(columns("activities", ["name", "position", "organization", "category", "grade_levels", "hours_per_week",
      "weeks_per_year", "description", "source"]))
    .eq("student_id", studentId).order("sort_order").limit(30));
  if (rows.length === 0) return empty("activities");
  const untrusted: { source: string; text: string }[] = [];
  rows.forEach((a, i) => {
    const name = str(a.name) || "Untitled";
    const details = compact([
      `${i + 1}. ${name}`, kv("Position", a.position), kv("Organization", a.organization), kv("Category", a.category),
      strings(a.grade_levels).length ? `Grades: ${strings(a.grade_levels).join(", ")}` : null,
      kv("Hours per week", num(a.hours_per_week)), kv("Weeks per year", num(a.weeks_per_year)), kv("Entered via", a.source),
    ]).join("; ");
    untrusted.push({ source: "activity-details", text: details });
    if (str(a.description)) untrusted.push({ source: tag("activity", name), text: str(a.description) });
  });
  const categories = [...new Set(rows.map((a) => str(a.category)).filter(Boolean))];
  return {
    section: { name: "activities", label: "Activities", body: `${rows.length} activities, in the order the student ranked them.`, untrusted },
    facts: { activityCategories: categories },
  };
};

const awards: Loader = async (db, studentId) => {
  const rows = await many(db.from("awards").select(columns("awards", ["name", "level", "year"]))
    .eq("student_id", studentId).order("sort_order").limit(30));
  return textSection("awards", "Awards", "awards",
    rows.map((a) => compact([str(a.name) || "Untitled", kv("level", a.level), kv("year", a.year)]).join("; ")));
};

const courses: Loader = async (db, studentId) => {
  const rows = await many(db.from("courses")
    .select(columns("courses", ["name", "type", "grade", "status", "school_year", "source"]))
    .eq("student_id", studentId).order("sort_order").limit(40));
  return textSection("courses", "Courses", "courses",
    rows.map((c) => compact([str(c.name), kv("type", c.type), kv("grade", c.grade), kv("status", c.status),
      kv("school year", c.school_year), kv("entered via", c.source)]).join("; ")));
};

const testScores: Loader = async (db, studentId) => {
  const rows = await many(db.from("test_scores")
    .select(columns("test_scores", ["exam", "kind", "score", "taken_on", "source"]))
    .eq("student_id", studentId).order("sort_order").limit(40));
  return textSection("testScores", "Test scores", "test-scores",
    rows.map((t) => compact([str(t.exam), kv("score", t.score), kv("kind", t.kind), kv("taken", t.taken_on), kv("entered via", t.source)]).join("; ")));
};

const colleges: Loader = async (db, studentId) => {
  const rows = await many(db.from("student_colleges")
    .select(columns("student_colleges", ["name", "round", "fit", "status"]))
    .eq("student_id", studentId).order("sort_order").limit(40));
  return textSection("colleges", "College list", "college-list",
    rows.map((c) => compact([str(c.name), kv("round", c.round), kv("fit", c.fit), kv("status", c.status)]).join("; ")));
};

const intake: Loader = async (db, studentId) => {
  const r = await one(db.from("intake_responses").select(columns("intake_responses", ["answers"]))
    .eq("student_id", studentId).maybeSingle());
  const a = r?.answers;
  if (!a || (typeof a === "object" && Object.keys(a).length === 0)) return empty("intake");
  return { section: { name: "intake", label: "Intake answers", body: "", untrusted: [{ source: "intake", text: JSON.stringify(a) }] } };
};

const meetingNotes: Loader = async (db, studentId) => {
  const rows = await many(db.from("meeting_notes")
    .select(columns("meeting_notes", ["meeting_date", "title", "summary", "tags"]))
    .eq("student_id", studentId).order("meeting_date", { ascending: false }).limit(8));
  if (rows.length === 0) return empty("meetingNotes");
  return {
    section: {
      name: "meetingNotes", label: "Meeting notes", body: `${rows.length} most recent notes, newest first.`,
      untrusted: rows.map((n) => ({
        source: `meeting:${str(n.meeting_date) || "undated"}`,
        text: compact([str(n.title), str(n.summary), strings(n.tags).length ? `Tags: ${strings(n.tags).join(", ")}` : null]).join("\n"),
      })),
    },
  };
};

const upcomingMeetings: Loader = async (db, studentId) => {
  const rows = await many(db.from("meetings")
    .select(columns("meetings", ["title", "starts_at", "status", "agenda"]))
    .eq("student_id", studentId).gte("starts_at", new Date().toISOString()).neq("status", "cancelled")
    .order("starts_at").limit(8));
  return textSection("upcomingMeetings", "Upcoming meetings", "upcoming-meetings",
    rows.map((m) => compact([str(m.starts_at), str(m.title), kv("status", m.status), kv("agenda", m.agenda)]).join("; ")));
};

const deadlines: Loader = async (db, studentId) => {
  const rows = await many(db.from("deadlines")
    .select(columns("deadlines", ["title", "school", "type", "due_date", "level", "done"]))
    .eq("student_id", studentId).order("due_date").limit(20));
  return textSection("deadlines", "Deadlines", "deadlines",
    rows.map((d) => compact([str(d.due_date), str(d.title), kv("school", d.school), kv("type", d.type), kv("level", d.level), kv("done", d.done)]).join("; ")));
};

const polygon: Loader = async (db, studentId) => {
  // Hidden axes are ones the counselor removed from the student's polygon; they stay out of the prompt too.
  const rows = await many(db.from("student_polygon_axes")
    .select(columns("student_polygon_axes", ["label", "score", "max_score", "note"]))
    .eq("student_id", studentId).eq("hidden", false).order("sort_order"));
  return textSection("polygon", "Strength profile", "strength-profile",
    rows.map((a) => compact([`${str(a.label)}: ${num(a.score) ?? "unscored"} of ${num(a.max_score) ?? "?"}`, kv("note", a.note)]).join("; ")));
};

const tasks: Loader = async (db, studentId) => {
  const rows = await many(db.from("deliverables")
    .select(columns("deliverables", ["title", "kind", "status", "due_date"]))
    .eq("student_id", studentId).neq("status", "complete").order("due_date").limit(20));
  return textSection("tasks", "Open tasks", "tasks",
    rows.map((t) => compact([str(t.title), kv("kind", t.kind), kv("status", t.status), kv("due", t.due_date)]).join("; ")));
};

/**
 * An essay body may be read when the essay has no linked file, or its linked file came back and is not
 * kept out of AI. A linked file that did not come back (hidden by RLS) fails closed.
 */
export function essayBodyReadable(documentId: unknown, document: unknown): boolean {
  if (documentId === null || documentId === undefined) return true;
  return typeof document === "object" && document !== null && (document as Row).available_to_llm !== false;
}

const essays: Loader = async (db, studentId, opts) => {
  // The embedded document carries the "keep out of AI" switch of the file an essay was read from.
  // Bodies are the heavy column: read them only for a feature that asks for them.
  const essayCols = opts.essayBodies
    ? (["title", "prompt", "school", "status", "word_count", "body", "document_id"] as const)
    : (["title", "prompt", "school", "status", "word_count", "document_id"] as const);
  const rows = await many(db.from("essays")
    .select(`${columns("essays", essayCols)}, document:documents(${columns("documents", ["available_to_llm"])})`)
    .eq("student_id", studentId).order("sort_order").limit(30));
  if (rows.length === 0) return empty("essays");
  const untrusted: { source: string; text: string }[] = [{
    source: "essay-details",
    text: rows.map((e, i) => compact([`${i + 1}. ${str(e.title)}`, kv("prompt", e.prompt), kv("school", e.school),
      kv("status", e.status), kv("words", num(e.word_count))]).join("; ")).join("\n"),
  }];
  if (opts.essayBodies) {
    for (const e of rows) {
      if (essayBodyReadable(e.document_id, e.document) && str(e.body)) untrusted.push({ source: tag("essay", str(e.title)), text: str(e.body) });
    }
  }
  return { section: { name: "essays", label: "Essays", body: `${rows.length} essays.`, untrusted } };
};

const documents: Loader = async (db, studentId, opts) => {
  if (!opts.practiceReadsDocuments) {
    return { section: null, omitted: [{ section: "documents", reason: "practice-setting" }] };
  }
  // Metadata first: parsed text can be large, and a file the rule keeps out never needs it read.
  const rows = await many(db.from("documents")
    .select(columns("documents", ["id", "filename", "title", "kind", "available_to_llm", "ai_access", "ferpa_waived", "kind_confirmed"]))
    .eq("student_id", studentId).order("created_at"));
  if (rows.length === 0) return empty("documents");
  const allowed = rows.filter((d) => documentAiDecision(toAiDoc(d), opts.practiceReadsDocuments).allowed);
  const parsedById = new Map<string, Row | null>();
  if (allowed.length > 0) {
    const texts = await many(db.from("documents")
      .select(columns("documents", ["id", "parsed_data"]))
      .in("id", allowed.map((d) => str(d.id))));
    for (const t of texts) parsedById.set(str(t.id), (t.parsed_data as Row | null) ?? null);
  }
  const untrusted: { source: string; text: string }[] = [];
  const items: string[] = [];
  const omitted: Omitted[] = [];
  let uncategorized = 0;
  let blocked = 0;
  let unparsed = 0;
  for (const d of rows) {
    const decision = documentAiDecision(toAiDoc(d), opts.practiceReadsDocuments);
    if (!decision.allowed) {
      if (decision.reason === "not-categorized") uncategorized++;
      else blocked++;
      continue;
    }
    const parsed = parsedById.get(str(d.id)) ?? null;
    const body = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    if (!body) {
      unparsed++;
      continue;
    }
    if (body.length > DOCUMENT_TEXT_CAP) {
      omitted.push({ section: "documents", reason: "budget" });
      continue;
    }
    const filename = str(d.filename);
    untrusted.push({ source: tag("document", filename), text: body });
    items.push(filename);
  }
  if (uncategorized > 0) omitted.push({ section: "documents", reason: "not-categorized", count: uncategorized });
  if (blocked > 0) omitted.push({ section: "documents", reason: "not-allowed", count: blocked });
  if (unparsed > 0) omitted.push({ section: "documents", reason: "empty", count: unparsed });
  if (untrusted.length === 0) {
    if (omitted.length === 0) omitted.push({ section: "documents", reason: "empty" });
    return { section: null, omitted };
  }
  return { section: { name: "documents", label: "Documents", items, body: `${items.length} documents.`, untrusted }, omitted };
};

export const LOADERS: Record<SectionName, Loader> = {
  profile, academics, personal, activities, awards, courses, testScores, colleges, intake,
  meetingNotes, upcomingMeetings, deadlines, polygon, tasks, essays, documents,
};
