/**
 * My Work Queue (demo v6-v9, `lib/workQueue.ts`).
 *
 * The counselor's own list: to-dos, private notes, deadlines to chase. Owner
 * only — never the student it mentions — plus the colleague who assigned an
 * item from Management (v9), who keeps sight of what they assigned.
 *
 * `GET` can append *derived*, read-only rows (`origin` other than
 * "work-item"): family reports waiting on approval and meetings in the next
 * seven days. They are computed, not copied, so they cannot drift from the
 * report or meeting they point at; the UI opens their source instead of
 * ticking them.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { assertCanViewStudent, requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { COUNSELOR_STEPS, confirmedStudents, openSteps, setupFacts, type SetupLink } from "../lib/studentSetup.js";

type Row = Record<string, unknown>;

const KINDS = ["task", "note", "deadline", "report", "meeting"] as const;
const REPEATS = ["none", "daily", "weekly", "monthly"] as const;

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  studentId: z.string().uuid().optional(),
  includeDone: z.enum(["true", "false"]).optional(),
  includeDerived: z.enum(["true", "false"]).optional(),
  /** mine: my queue. assigned: what I put on colleagues' queues. */
  scope: z.enum(["mine", "assigned"]).optional(),
});

const fields = {
  studentId: z.string().uuid().nullable(),
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).nullable(),
  owner: z.enum(["counselor", "student"]),
  dueDate: z.string().date().nullable(),
  dueTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 14:30")
    .nullable(),
  repeat: z.enum(REPEATS),
  source: z.string().trim().max(120).nullable(),
};

const createSchema = z
  .object({
    ...fields,
    /** Management (v9): another counselor in the same firm. Omit for yourself. */
    assigneeId: z.string().uuid().optional(),
  })
  .partial()
  .required({ title: true })
  .strict();

const patchSchema = z
  .object({ ...fields, done: z.boolean(), assigneeId: z.string().uuid() })
  .partial()
  .strict();

const SELECT =
  "*, student:profiles!counselor_work_items_student_id_fkey(full_name), " +
  "assignee:profiles!counselor_work_items_counselor_id_fkey(full_name), " +
  "assigner:profiles!counselor_work_items_assigned_by_fkey(full_name)";

const nameOf = (v: unknown): string | null => {
  const n = (v as { full_name?: unknown } | null)?.full_name;
  return typeof n === "string" && n ? n : null;
};

export function toWorkItem(r: Row, me: string) {
  return {
    id: String(r.id),
    origin: "work-item" as "work-item" | "family-report" | "meeting" | "setup",
    kind: String(r.kind) as (typeof KINDS)[number],
    title: String(r.title),
    detail: r.detail ? String(r.detail) : null,
    studentId: r.student_id ? String(r.student_id) : null,
    studentName: nameOf(r.student),
    owner: (r.owner === "student" ? "student" : "counselor") as "counselor" | "student",
    dueDate: r.due_date ? String(r.due_date) : null,
    dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
    repeat: (r.repeat ? String(r.repeat) : "none") as (typeof REPEATS)[number],
    done: r.done === true,
    doneAt: r.done_at ? String(r.done_at) : null,
    source: r.source ? String(r.source) : null,
    /** Null when it is the viewer's own item. */
    assignee:
      String(r.counselor_id) === me ? null : { id: String(r.counselor_id), name: nameOf(r.assignee) },
    assignedBy:
      !r.assigned_by || String(r.assigned_by) === String(r.counselor_id)
        ? null
        : { id: String(r.assigned_by), name: nameOf(r.assigner) },
    familyReportId: r.family_report_id ? String(r.family_report_id) : null,
    meetingId: r.meeting_id ? String(r.meeting_id) : null,
    /** A setup row: where the step is done ("college-list", "calendar"…). */
    setupLink: null as SetupLink | null,
    createdAt: String(r.created_at),
  };
}
export type WorkItemDto = ReturnType<typeof toWorkItem>;

function toUpdate(body: z.infer<typeof patchSchema>): Row {
  const u: Row = {};
  if (body.studentId !== undefined) u.student_id = body.studentId;
  if (body.kind !== undefined) u.kind = body.kind;
  if (body.title !== undefined) u.title = body.title;
  if (body.detail !== undefined) u.detail = body.detail;
  if (body.owner !== undefined) u.owner = body.owner;
  if (body.dueDate !== undefined) u.due_date = body.dueDate;
  if (body.dueTime !== undefined) u.due_time = body.dueTime;
  if (body.repeat !== undefined) u.repeat = body.repeat;
  if (body.source !== undefined) u.source = body.source;
  if (body.done !== undefined) u.done = body.done;
  if (body.assigneeId !== undefined) u.counselor_id = body.assigneeId;
  // Clearing the date clears what hangs off it.
  if (body.dueDate === null) {
    u.due_time = null;
    u.repeat = "none";
  }
  return u;
}

export default async function workItemRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [...counselor, limit("work-items:list", 240, 60)] }, async (request) => {
    const q = listQuery.parse(request.query);
    const me = request.auth.userId;
    if (q.studentId) await assertCanViewStudent(request, q.studentId);

    let query = request.db.from("counselor_work_items").select(SELECT);
    query =
      q.scope === "assigned"
        ? query.eq("assigned_by", me).neq("counselor_id", me)
        : query.eq("counselor_id", me);
    if (q.studentId) query = query.eq("student_id", q.studentId);
    if (q.includeDone !== "true") query = query.eq("done", false);
    const own = query
      .order("done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(500);

    if (q.includeDerived !== "true" || q.scope === "assigned") {
      const { data, error } = await own;
      if (error) throw fromPostgrest(error);
      return ((data ?? []) as unknown as Row[]).map((r) => toWorkItem(r, me));
    }

    // Derived rows: reports to approve, meetings to prepare. Skip any a real
    // item already points at. None of these reads depends on another, so they
    // go out together rather than one round trip after the next.
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 86_400_000);

    let reports = request.db
      .from("family_reports")
      .select("id, title, student_id, created_at, student:profiles!family_reports_student_id_fkey(full_name)")
      .eq("counselor_id", me)
      .eq("status", "draft");
    let meetings = request.db
      .from("meetings")
      .select("id, title, student_id, starts_at, created_at, student:profiles!meetings_student_id_fkey(full_name)")
      .eq("counselor_id", me)
      .eq("status", "scheduled")
      .gte("starts_at", now.toISOString())
      .lte("starts_at", week.toISOString());
    if (q.studentId) {
      reports = reports.eq("student_id", q.studentId);
      meetings = meetings.eq("student_id", q.studentId);
    }
    const [o, r, m, confirmed] = await Promise.all([
      own,
      reports.limit(100),
      meetings.order("starts_at").limit(100),
      confirmedStudents(request),
    ]);
    if (o.error) throw fromPostgrest(o.error);
    if (r.error) throw fromPostgrest(r.error);
    if (m.error) throw fromPostgrest(m.error);
    const items = ((o.data ?? []) as unknown as Row[]).map((row) => toWorkItem(row, me));
    const linkedReports = new Set(items.map((i) => i.familyReportId).filter(Boolean));
    const linkedMeetings = new Set(items.map((i) => i.meetingId).filter(Boolean));

    const derived: WorkItemDto[] = [];
    for (const row of (r.data ?? []) as Row[]) {
      if (linkedReports.has(String(row.id))) continue;
      derived.push({
        ...base(row, "family-report", "report"),
        title: `Approve the ${String(row.title)}`,
        source: "Family reports",
        familyReportId: String(row.id),
      });
    }
    for (const row of (m.data ?? []) as Row[]) {
      if (linkedMeetings.has(String(row.id))) continue;
      const starts = String(row.starts_at);
      derived.push({
        ...base(row, "meeting", "meeting"),
        title: `Prepare for ${String(row.title)}`,
        dueDate: starts.slice(0, 10),
        dueTime: null,
        source: "Calendar",
        meetingId: String(row.id),
      });
    }
    // Setup rows: what is left on a student confirmed from New student. Each
    // clears itself once the record has it (lib/studentSetup.ts).
    const setupIds = [...confirmed.keys()].filter((id) => !q.studentId || id === q.studentId);
    const facts = await setupFacts(request, setupIds);
    for (const id of setupIds) {
      const f = facts.get(id);
      if (!f) continue;
      for (const step of openSteps(COUNSELOR_STEPS, f)) {
        derived.push({
          ...base({ id: `${id}:${step.key}`, title: step.title, student_id: id, student: { full_name: confirmed.get(id) }, created_at: now.toISOString() }, "setup", "task"),
          source: "New student setup",
          setupLink: step.link,
        });
      }
    }
    return [...items, ...derived];
  });

  app.post("/", { preHandler: [...counselor, limit("work-items:write", 240, 60)] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const me = request.auth.userId;
    if (body.studentId) await assertCanViewStudent(request, body.studentId);

    const insert: Row = {
      ...toUpdate(body),
      counselor_id: body.assigneeId ?? me,
      assigned_by: me,
      source: body.source ?? (body.assigneeId && body.assigneeId !== me ? "Management" : "Added by you"),
    };
    const { data, error } = await request.db
      .from("counselor_work_items")
      .insert(insert)
      .select(SELECT)
      .single();
    // RLS refuses an assignee outside the caller's firm; say so plainly.
    if (error?.code === "42501") throw notFound("That counselor isn't in your practice");
    if (error) throw fromPostgrest(error);
    return reply.code(201).send(toWorkItem(data as unknown as Row, me));
  });

  app.patch("/:id", { preHandler: [...counselor, limit("work-items:write", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchSchema.parse(request.body);
    if (body.studentId) await assertCanViewStudent(request, body.studentId);
    const me = request.auth.userId;

    const { data, error } = await request.db
      .from("counselor_work_items")
      .update(toUpdate(body))
      .eq("id", id)
      .or(`counselor_id.eq.${me},assigned_by.eq.${me}`)
      .select(SELECT)
      .maybeSingle();
    if (error?.code === "42501") throw notFound("That counselor isn't in your practice");
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That item isn't on your queue");
    return toWorkItem(data as unknown as Row, me);
  });

  app.delete("/:id", { preHandler: [...counselor, limit("work-items:write", 240, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const me = request.auth.userId;
    const { data, error } = await request.db
      .from("counselor_work_items")
      .delete()
      .eq("id", id)
      .or(`counselor_id.eq.${me},assigned_by.eq.${me}`)
      .select("id")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That item isn't on your queue");
    return { deleted: true };
  });
}

function base(
  row: Row,
  origin: "family-report" | "meeting" | "setup",
  kind: "report" | "meeting" | "task"
): WorkItemDto {
  return {
    id: `${origin}:${String(row.id)}`,
    origin,
    kind,
    title: String(row.title),
    detail: null,
    studentId: row.student_id ? String(row.student_id) : null,
    studentName: nameOf(row.student),
    owner: "counselor",
    dueDate: null,
    dueTime: null,
    repeat: "none",
    done: false,
    doneAt: null,
    source: null,
    assignee: null,
    assignedBy: null,
    familyReportId: null,
    meetingId: null,
    setupLink: null,
    createdAt: String(row.created_at),
  };
}
