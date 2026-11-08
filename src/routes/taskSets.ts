/**
 * Saved task sets (migration 20261111000005, lib/taskSets.ts): a counselor's named list of up to 30
 * tasks, applied in one go to picked students or a class year. Every item has a stable `key` (assigned
 * here, kept when the client sends it back on PATCH); a task made from an item is marked with that key,
 * so editing the set never makes a re-apply skip or repeat an item.
 *
 *   GET    /task-sets             the caller's own sets, plus sets their firm colleagues shared
 *   POST   /task-sets             { name, items, shared? }
 *   PATCH  /task-sets/:id         { name?, items?, shared? }   owner only
 *   DELETE /task-sets/:id         owner only; tasks already made stay (their marker clears)
 *   POST   /task-sets/:id/apply   { studentIds | classYear, notifyEmail? }
 *
 * Apply makes one ordinary counselor task per item per student through the Create task button's own
 * code (`createTaskForStudent`), each marked with the set and item. Every student passes
 * `resolveStudentId(..., "edit")`, and a refusal is that student's line, never the batch's. A class year
 * is resolved here from the caller's ACTIVE roster (`profiles.grad_year`, archived students left out),
 * never from ids the client sends. Applying twice makes nothing new: what exists is read first and the
 * unique index catches a race (23505 on that index only), both reported as "already assigned". One apply
 * makes at most 300 NEW tasks: past it, 400 `apply_too_large` with `maxStudents` (and, for a class year,
 * the resolved `studentIds`) so the app can split it.
 *
 * Email: at most one assignment email per student per apply (the first task made for them; every task
 * still gets its in-app notice and stores `notify_email` as asked, so "send again" works), and at most TASK_SET_EMAIL_DAILY_CAP a day per counselor across
 * applies. Past the cap the task is made and the email skipped (`emailThrottled`). No texts.
 *
 * Without the migration every route answers 503 `task_sets_unavailable`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadWorkspace } from "../lib/crm.js";
import { badRequest, conflict, fromPostgrest, HttpError, notFound, publicMessage } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { consumeRateLimit, limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import {
  APPLY_MAX_STUDENTS,
  applyBody,
  applySize,
  dueDateFor,
  studentsInClass,
  TASK_SET_EMAIL_DAILY_CAP,
  taskSetBody,
  taskSetItem,
  taskSetPatch,
  todayIn,
  toTaskSet,
  withKeys,
  type TaskSetItem,
} from "../lib/taskSets.js";
import { createTaskForStudent, type CreateTaskInput } from "./tasks.js";

type Row = Record<string, unknown>;
type PgError = { code?: string; message?: string } | null;

const COLUMNS = "id, counselor_id, firm_id, name, items, created_at, updated_at";
const idParam = z.object({ id: z.string().uuid() }).strict();
/** Students worked on at once during an apply; each student's items run in order. */
const APPLY_CONCURRENCY = 4;

function unavailable(): HttpError {
  return new HttpError(503, "Saved task sets aren't switched on yet", "task_sets_unavailable");
}

function dbError(error: PgError): HttpError {
  return isResultsNotApplied(error) ? unavailable() : fromPostgrest(error);
}

/** The caller's firm, for `shared: true`; a solo counselor has none to share with. */
async function firmFor(request: FastifyRequest, shared: boolean | undefined): Promise<string | null | undefined> {
  if (shared === undefined) return undefined;
  if (!shared) return null;
  const ws = await loadWorkspace(request);
  if (!ws.firmId) throw badRequest("Join or start a firm to share a set");
  return ws.firmId;
}

type ItemResult = {
  item: number;
  key: string;
  title: string;
  status: "created" | "already-assigned" | "failed";
  taskId?: string;
  error?: string;
};

/** One student's line, in the app's `StudentResult` shape (lib/assignTaskBatch.ts) plus the items. */
type StudentResult = {
  taskId?: string;
  error?: string;
  notifyFailed?: boolean;
  notifyWhy?: string;
  alreadyAssigned?: boolean;
  emailThrottled?: boolean;
  notification?: { email: boolean; sms: string; error: string | null };
  items: ItemResult[];
};

/** The Create task body for one item, its relative dates made real for `today`. */
function taskInput(studentId: string, item: TaskSetItem, today: string, notifyEmail: boolean): CreateTaskInput {
  return {
    studentId,
    title: item.title,
    kind: item.kind ?? "custom",
    instructions: item.instructions,
    targetWords: item.targetWords ?? null,
    dueDate: dueDateFor(item, today),
    stages: item.stages?.map((s) => ({ name: s.name, detail: s.detail, dueDate: dueDateFor(s, today) })),
    notifyEmail,
    notifySms: false,
  };
}

async function mapLimit<T>(list: T[], n: number, fn: (v: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) await fn(list[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
}

export default async function taskSetRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [...counselor, limit("task-sets:list", 120, 60)] }, async (request) => {
    const me = request.auth.userId;
    const firmId = request.profile.firm_id ?? null;
    let q = request.db.from("task_sets").select(COLUMNS);
    // RLS decides what is readable; naming the rows keeps Postgres off other practices' sets.
    q = firmId ? q.or(`counselor_id.eq.${me},firm_id.eq.${firmId}`) : q.eq("counselor_id", me);
    const { data, error } = await q.order("created_at").limit(200);
    if (error) throw dbError(error);
    return ((data ?? []) as Row[]).map((r) => toTaskSet(r, me));
  });

  app.post("/", { preHandler: [...counselor, limit("task-sets:write", 60, 3600)] }, async (request, reply) => {
    const b = taskSetBody.parse(request.body);
    const firmId = await firmFor(request, b.shared);
    const { data, error } = await request.db
      .from("task_sets")
      .insert({ counselor_id: request.auth.userId, firm_id: firmId ?? null, name: b.name, items: withKeys(b.items) })
      .select(COLUMNS)
      .single();
    if (error) throw dbError(error);
    return reply.code(201).send(toTaskSet(data as Row, request.auth.userId));
  });

  app.patch("/:id", { preHandler: [...counselor, limit("task-sets:write", 60, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = taskSetPatch.parse(request.body);
    const firmId = await firmFor(request, b.shared);
    const update: Row = {};
    if (b.name !== undefined) update.name = b.name;
    // Keys the client sent back are kept, so tasks already made from an item stay tied to it.
    if (b.items !== undefined) update.items = withKeys(b.items);
    if (firmId !== undefined) update.firm_id = firmId;
    const { data, error } = await request.db
      .from("task_sets")
      .update(update)
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw notFound("That set isn't one of yours");
    return toTaskSet(data as Row, request.auth.userId);
  });

  app.delete("/:id", { preHandler: [...counselor, limit("task-sets:write", 60, 3600)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("task_sets")
      .delete()
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select("id");
    if (error) throw dbError(error);
    if (!data?.length) throw notFound("That set isn't one of yours");
    return reply.code(204).send();
  });

  app.post("/:id/apply", { preHandler: [...counselor, limit("task-sets:apply", 60, 3600)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = applyBody.parse(request.body);
    const me = request.auth.userId;

    const { data: set, error } = await request.db.from("task_sets").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw dbError(error);
    if (!set) throw notFound("That set isn't one you can use");
    const parsed = z.array(taskSetItem).safeParse(set.items);
    if (!parsed.success || parsed.data.some((i) => !i.key)) {
      throw conflict("This set needs to be saved again before it can be used");
    }
    const items = parsed.data as (TaskSetItem & { key: string })[];

    let studentIds: string[];
    if (b.classYear) {
      const { data: roster, error: rosterError } = await request.db
        .from("profiles")
        .select("id, grad_year, archived_at, role")
        .eq("counselor_id", me)
        .eq("role", "student")
        .is("archived_at", null)
        .limit(2000);
      if (rosterError) throw fromPostgrest(rosterError);
      studentIds = studentsInClass((roster ?? []) as Row[], b.classYear);
      if (studentIds.length === 0) throw badRequest(`No active students in the class of ${b.classYear}`);
      if (studentIds.length > APPLY_MAX_STUDENTS) {
        throw badRequest(`The class of ${b.classYear} has more than ${APPLY_MAX_STUDENTS} students; pick them in groups`);
      }
    } else {
      studentIds = [...new Set(b.studentIds ?? [])];
    }

    // What already exists for this set, read once: the fast path to "already assigned".
    const { data: existingRows, error: existingError } = await request.db
      .from("deliverables")
      .select("id, student_id, task_set_item_key")
      .eq("task_set_id", id)
      .in("student_id", studentIds);
    if (existingError) throw dbError(existingError);
    const existing = new Map<string, string>();
    for (const r of (existingRows ?? []) as Row[]) existing.set(`${r.student_id}:${r.task_set_item_key}`, String(r.id));

    // At most APPLY_MAX_NEW_TASKS NEW tasks an apply: a bigger one would outlive the request. Only what
    // doesn't exist yet counts, so a retry after a timeout always gets through.
    const present = studentIds.reduce((n, sid) => n + items.filter((it) => existing.has(`${sid}:${it.key}`)).length, 0);
    const size = applySize(studentIds.length, items.length, present);
    if (!size.ok) {
      return reply.code(400).send({
        error: `That would make ${size.toCreate} tasks at once; ${size.limit} is the most. Apply it to up to ${size.maxStudents} students at a time.`,
        code: "apply_too_large",
        limit: size.limit,
        perStudent: size.perStudent,
        maxStudents: size.maxStudents,
        ...(b.classYear ? { studentIds } : {}),
      });
    }

    const today = todayIn(request.profile.timezone);
    const notify = b.notifyEmail ?? true;
    const results: Record<string, StudentResult> = {};
    let created = 0;
    let already = 0;
    let failed = 0;
    let refused = 0;
    let emailThrottled = 0;

    await mapLimit(studentIds, APPLY_CONCURRENCY, async (studentId) => {
      const result: StudentResult = { items: [] };
      results[studentId] = result;
      try {
        await resolveStudentId(request, studentId, "edit");
      } catch (err) {
        refused++;
        result.error = publicMessage(err, "That student isn't on your roster");
        return;
      }

      // One email per student per apply: the first task actually made carries it.
      let email: "pending" | "sent" | "throttled" | "off" = notify ? "pending" : "off";
      let capChecked = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const line: ItemResult = { item: i, key: item.key, title: item.title, status: "created" };
        result.items.push(line);
        const prior = existing.get(`${studentId}:${item.key}`);
        if (prior) {
          line.status = "already-assigned";
          line.taskId = prior;
          already++;
          continue;
        }
        let withEmail = false;
        if (email === "pending") {
          if (!capChecked) {
            capChecked = true;
            if (!(await consumeRateLimit(`task-set-email:${me}`, TASK_SET_EMAIL_DAILY_CAP, 86_400, request.log))) {
              email = "throttled";
              result.emailThrottled = true;
              emailThrottled++;
            }
          }
          withEmail = email === "pending";
        }
        try {
          // The task stores the counselor's choice either way, so "send again" works later; only the
          // send itself is held back for every task after the first, and past the daily cap.
          const made = await createTaskForStudent(request, taskInput(studentId, item, today, notify), {
            marker: { taskSetId: id, itemKey: item.key },
            skipEmailSend: !withEmail,
          });
          if (made.alreadyAssigned) {
            line.status = "already-assigned";
            already++;
            continue;
          }
          line.taskId = made.taskId;
          created++;
          if (withEmail) {
            email = "sent";
            result.notification = made.notification;
            if (!made.notification.email) {
              result.notifyFailed = true;
              result.notifyWhy = made.notification.error ?? "The email didn't go";
            }
          }
        } catch (err) {
          request.log.warn({ err, taskSetId: id, item: i }, "task set item failed");
          line.status = "failed";
          line.error = publicMessage(err, "That task couldn't be made");
          failed++;
        }
      }

      result.taskId = result.items.find((l) => l.taskId)?.taskId;
      result.alreadyAssigned = result.items.every((l) => l.status === "already-assigned");
      const bad = result.items.filter((l) => l.status === "failed");
      if (bad.length) result.error = `${bad.length} of ${items.length} tasks couldn't be made: ${bad[0].error}`;
    });

    return { taskSetId: id, appliedOn: today, created, alreadyAssigned: already, failed, refused, emailThrottled, results };
  });
}
