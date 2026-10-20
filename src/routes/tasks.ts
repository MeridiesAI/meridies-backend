/**
 * Task assignment and the per-task AI document tracker.
 *
 * A task is a `deliverables` row that has been *assigned*: it carries the
 * instruction both parties read, the documents the student works off, and one
 * or more dated stages. `POST /tasks` is the Create task button, and it is the
 * only route here that sends anything — the notification goes out over the
 * existing `message_deliveries` path, not a second outbound mechanism.
 *
 * The student's To-Do (SV Demo v2): a student sees their counselor's tasks
 * and may only record progress on them (status, words, percent, ticking a
 * step done). A student may add tasks for themselves (`source: "student"`);
 * those are theirs to rename, re-date and delete, and the counselor sees
 * them beside their own. RLS and two column-guard triggers
 * (20261010000003) enforce the same split, so a direct PostgREST write
 * can't get round it.
 *
 * The tracker answers a question `progress_events` and `draft_quality_checks`
 * cannot: does this work do what the assignment asked for? Stall detection is
 * imported from lib/accountability rather than re-derived, so "behind" means
 * the same thing here as on the roster alert list.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import {
  daysSince,
  DEFAULT_SETTINGS,
  isStalled,
  loadSettings,
  type AccountabilitySettings,
} from "../lib/accountability.js";
import { enforceNoProse, runStructured } from "../lib/anthropic.js";
import { registerCollection } from "../lib/collection.js";
import {
  sendSms,
  sendEmail,
  brandedEmail,
  brandedText,
  taskAssignmentEmail,
  taskAssignmentSms,
  type TaskNotification,
} from "../lib/email.js";
import { badRequest, conflict, forbidden, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { documentReadableForTask, toAiDoc, unconfirmedAttachedNote } from "../lib/context/documentAi.js";
import { essayBodyReadable } from "../lib/context/sections.js";
import { composeTrackerNote } from "../lib/trackerNote.js";
import { caseloadStudentIds, requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceRateLimit, limit } from "../lib/limits.js";
import { checkLiveDocuments, holdsNoActivity, isGrantProblem, liveStatusOf, type LiveFileCheck } from "../lib/liveDocuments.js";
import { loadPracticeSettings } from "../lib/practiceSettings.js";
import { HAND_INS_PER_STUDENT_DAY, HAND_INS_PER_TASK_HOUR, startSubmissionReview } from "../lib/submissionReview.js";
import { toTask, toTaskStage, toTrackerCheck } from "../lib/serialize.js";
import { researchTaskIds } from "../lib/research/origin.js";

type Row = Record<string, unknown>;

const TASK_KINDS = [
  "essay",
  "common-app-section",
  "activity-list",
  "document",
  "test-registration",
  "recommendation",
  "aid-form",
  "custom",
] as const;

/** A stage's deadline lands in the existing tracker, so it needs a type. */
const DEADLINE_TYPE_BY_KIND: Record<string, string> = {
  essay: "essay",
  "common-app-section": "application",
  "activity-list": "application",
  document: "document",
  "test-registration": "test",
  recommendation: "document",
  "aid-form": "financial",
  custom: "document",
};

const stageInput = z
  .object({
    name: z.string().trim().min(1).max(300),
    detail: z.string().trim().max(2000).optional(),
    dueDate: z.string().date().nullable().optional(),
  })
  .strict();

const createTaskBody = z
  .object({
    studentId: z.string().uuid(),
    kind: z.enum(TASK_KINDS).optional(),
    title: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(8000).optional(),
    dueDate: z.string().date().nullable().optional(),
    targetWords: z.number().int().min(0).max(100_000).nullable().optional(),
    essayId: z.string().uuid().nullable().optional(),
    studentCollegeId: z.string().uuid().nullable().optional(),
    /** Several deadlines when it's a multi-step process. Order is the array's. */
    stages: z.array(stageInput).max(20).optional(),
    documentIds: z.array(z.string().uuid()).max(20).optional(),
    notifyEmail: z.boolean().optional(),
    notifySms: z.boolean().optional(),
    /** Mirror each stage into the Deadline Command Center. On by default. */
    syncDeadlines: z.boolean().optional(),
    /** Counselor-only. False keeps the task off the student's side until it is shared. */
    visibleToStudent: z.boolean().optional(),
  })
  .strict();

/** What a student may add for themselves: a to-do, not an assignment. */
const studentTaskBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(2000).nullable().optional(),
    dueDate: z.string().date().nullable().optional(),
  })
  .strict();

const patchTaskBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    instructions: z.string().trim().max(8000).nullable().optional(),
    kind: z.enum(TASK_KINDS).optional(),
    status: z
      .enum(["not-started", "in-progress", "stalled", "review", "complete"])
      .optional(),
    dueDate: z.string().date().nullable().optional(),
    targetWords: z.number().int().min(0).max(100_000).nullable().optional(),
    currentWords: z.number().int().min(0).max(100_000).optional(),
    progressPct: z.number().int().min(0).max(100).optional(),
    /** Counselor-only: share a hidden task with the student, or take it back. */
    visibleToStudent: z.boolean().optional(),
  })
  .strict();

const stageBody = z
  .object({
    deliverable_id: z.string().uuid(),
    name: z.string().trim().min(1).max(300),
    detail: z.string().trim().max(2000).nullable().optional(),
    due_date: z.string().date().nullable().optional(),
    sequence: z.number().int().min(0).max(100).optional(),
    done: z.boolean().optional(),
  })
  .partial({ deliverable_id: true, name: true })
  .strict();

function taskUrl(taskId: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/dashboard/student?task=${encodeURIComponent(taskId)}`;
}

/** The counselor whose accountability settings govern this student. */
async function governingCounselorId(
  request: FastifyRequest,
  studentId: string
): Promise<string | null> {
  if (request.profile.role === "counselor") return request.auth.userId;
  if (request.auth.userId === studentId) return request.profile.counselor_id;
  const { data } = await request.db
    .from("profiles")
    .select("counselor_id")
    .eq("id", studentId)
    .maybeSingle();
  return (data?.counselor_id as string | null) ?? null;
}

async function settingsFor(
  request: FastifyRequest,
  studentId: string
): Promise<AccountabilitySettings> {
  const counselorId = await governingCounselorId(request, studentId);
  // An unassigned student has nobody's thresholds to use; the shipped defaults
  // are the honest fallback rather than treating everything as on track.
  if (!counselorId) return DEFAULT_SETTINGS;
  return loadSettings(request, counselorId, studentId);
}

/** Load a task's children in one round trip each, never per task. */
export async function hydrate(
  request: FastifyRequest,
  tasks: Row[]
): Promise<ReturnType<typeof toTask>[]> {
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id as string);

  // Which counselor tasks were accepted from Research (lib/research/origin.ts): AxIS reads their
  // titles as outside content. Counselors only (a student can't read recommendations).
  const counselorTasks = request.profile.role === "counselor" ? tasks.filter((t) => t.source !== "student").map((t) => t.id as string) : [];
  const [stages, docs, tracker, research] = await Promise.all([
    request.db
      .from("deliverable_stages")
      .select("*")
      .in("deliverable_id", ids)
      .order("sequence"),
    request.db
      .from("deliverable_documents")
      .select(
        "deliverable_id, document_id, role, note, created_at, " +
          "document:documents(id, filename, title, mime_type, size_bytes, kind, available_to_llm, ai_access, ferpa_waived, external_provider, bucket, storage_path)"
      )
      .in("deliverable_id", ids),
    request.db.from("deliverable_tracker_latest").select("*").in("deliverable_id", ids),
    counselorTasks.length ? researchTaskIds(request.db, { taskIds: counselorTasks }) : Promise.resolve(new Set<string>()),
  ]);

  const stageBy = new Map<string, Row[]>();
  for (const s of stages.data ?? []) {
    const key = s.deliverable_id as string;
    if (!stageBy.has(key)) stageBy.set(key, []);
    stageBy.get(key)!.push(s as Row);
  }
  const docBy = new Map<string, Row[]>();
  // The embedded `document:documents(...)` select confuses supabase-js's row
  // typing; the shape is checked by the serializer, so widen it here.
  for (const d of (docs.data ?? []) as unknown as Row[]) {
    const key = d.deliverable_id as string;
    if (!docBy.has(key)) docBy.set(key, []);
    docBy.get(key)!.push(d);
  }
  const trackerBy = new Map<string, Row>();
  for (const t of tracker.data ?? []) trackerBy.set(t.deliverable_id as string, t as Row);

  return tasks.map((t) =>
    toTask(t, {
      stages: stageBy.get(t.id as string) ?? [],
      documents: docBy.get(t.id as string) ?? [],
      tracker: trackerBy.get(t.id as string) ?? null,
      // Unreadable: every counselor task may be one (AxIS then treats them as outside content).
      ...(request.profile.role === "counselor" ? { fromResearch: t.source !== "student" && (research === null || research.has(t.id as string)) } : {}),
    })
  );
}

export default async function taskRoutes(app: FastifyInstance) {
  // ---- Stages ---------------------------------------------------------------
  //
  // The generator gives the student-scoped authorization for free; the two
  // things it can't know — that the parent task is this student's, and that a
  // student may only tick a stage off — go in beforeWrite.
  registerCollection(app, {
    path: "stages",
    table: "deliverable_stages",
    body: stageBody,
    toDto: (r) => toTaskStage(r),
    orderBy: { column: "sequence", ascending: true },
    filters: [{ param: "deliverableId", column: "deliverable_id" }],
    beforeWrite: async (request, studentId, values, action) => {
      if (request.profile.role === "student") {
        // A student marks work done. They do not move their own deadlines.
        const allowed = new Set(["done"]);
        const attempted = Object.keys(values).filter((k) => !allowed.has(k));
        if (action === "insert" || attempted.length > 0) {
          throw forbidden("Only your counselor can change a task's stages");
        }
      }
      const deliverableId = values.deliverable_id as string | undefined;
      if (!deliverableId) return;

      const { data } = await request.db
        .from("deliverables")
        .select("id, student_id")
        .eq("id", deliverableId)
        .maybeSingle();
      if (!data || data.student_id !== studentId) {
        throw badRequest("That stage doesn't belong to that task");
      }
    },
    beforeDelete: async (request) => {
      if (request.profile.role === "student") {
        throw forbidden("Only your counselor can change a task's stages");
      }
    },
    afterWrite: async (request, studentId, row, action) => {
      if (action === "update" && row.done) {
        await request.db
          .from("deliverable_stages")
          .update({ done_at: new Date().toISOString(), completed_by: request.auth.userId })
          .eq("id", row.id as string)
          .is("done_at", null);
        await request.db.from("progress_events").insert({
          student_id: studentId,
          deliverable_id: row.deliverable_id as string,
          entity_type: "deliverable",
          entity_id: row.deliverable_id as string,
          event: "status-changed",
          actor_id: request.auth.userId,
          metadata: { stage: row.name, done: true },
        });
      }
    },
  });

  // ---- Tasks ----------------------------------------------------------------

  app.get("/", { preHandler: [app.authenticate, limit("tasks:list", 300, 60)] }, async (request) => {
    const q = z
      .object({
        studentId: z.string().uuid().optional(),
        status: z.string().trim().max(20).optional(),
        includeComplete: z.enum(["true", "false"]).optional(),
        /** SV Demo v2: only the counselor's assignments, or only the student's own. */
        source: z.enum(["counselor", "student"]).optional(),
      })
      .parse(request.query);

    let builder = request.db.from("deliverables").select("*");
    if (q.source) builder = builder.eq("source", q.source);

    if (q.studentId || request.profile.role === "student") {
      const student = await resolveStudentId(request, q.studentId, "view");
      builder = builder.eq("student_id", student);
    } else {
      // The whole caseload. RLS already scopes a counselor to their own; naming
      // the students lets Postgres read only theirs (lib/guards.ts).
      const caseload = await caseloadStudentIds(request);
      if (caseload) builder = builder.in("student_id", caseload);
    }

    if (q.status) builder = builder.eq("status", q.status);
    else if (q.includeComplete !== "true") builder = builder.neq("status", "complete");

    const { data, error } = await builder
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(500);
    if (error) throw fromPostgrest(error);

    return hydrate(request, (data ?? []) as Row[]);
  });

  app.get("/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const { data, error } = await request.db
      .from("deliverables")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That task isn't on file");
    await resolveStudentId(request, data.student_id as string, "view");

    const [task] = await hydrate(request, [data as Row]);
    return task;
  });

  /**
   * The Create task button. Everything about the assignment lands in one
   * transaction-shaped sequence, and the notification is the last step so a
   * delivery failure leaves a real task behind rather than losing the work.
   */
  app.post(
    "/",
    {
      preHandler: [app.authenticate, limit("tasks:create", 60, 60)],
    },
    async (request, reply) => {
      // A student adds a to-do for themselves. Always their own record, never
      // an assignment: no stages, documents or notifications, and it is
      // marked as theirs so the counselor can tell it from what they assigned.
      if (request.profile.role === "student") {
        if (
          typeof request.body === "object" &&
          request.body !== null &&
          "visibleToStudent" in request.body
        ) {
          throw forbidden("Only your counselor can choose what you see");
        }
        const sb = studentTaskBody.parse(request.body);
        const studentId = request.auth.userId;
        const { data, error } = await request.db
          .from("deliverables")
          .insert({
            student_id: studentId,
            kind: "custom",
            title: sb.title,
            instructions: sb.instructions ?? null,
            due_date: sb.dueDate ?? null,
            status: "not-started",
            source: "student",
            created_by: studentId,
            notify_email: false,
            notify_sms: false,
          })
          .select("*")
          .single();
        if (error) throw fromPostgrest(error);

        await request.db.from("progress_events").insert({
          student_id: studentId,
          deliverable_id: data.id as string,
          entity_type: "deliverable",
          entity_id: data.id as string,
          event: "created",
          actor_id: studentId,
          metadata: { source: "student" },
        });

        const [dto] = await hydrate(request, [data as Row]);
        return reply.code(201).send(dto);
      }

      const b = createTaskBody.parse(request.body);
      await resolveStudentId(request, b.studentId, "edit");

      const visible = b.visibleToStudent !== false;
      const kind = b.kind ?? "custom";
      const stages = b.stages ?? [];
      // The task's own due date defaults to the last stage's, so a multi-step
      // task still sorts correctly next to single-deadline work.
      const stageDates = stages
        .map((s) => s.dueDate)
        .filter((d): d is string => Boolean(d))
        .sort();
      const dueDate = b.dueDate ?? stageDates.at(-1) ?? null;

      // Documents must be ones the caller can actually see. RLS filters the
      // read, so a short result means an id that isn't theirs to attach.
      let documents: Row[] = [];
      if (b.documentIds?.length) {
        const { data, error } = await request.db
          .from("documents")
          .select("id, filename, title, student_id")
          .in("id", b.documentIds);
        if (error) throw fromPostgrest(error);
        documents = (data ?? []) as Row[];
        if (documents.length !== b.documentIds.length) {
          throw badRequest("One of those documents isn't available to attach");
        }
      }

      const { data: task, error } = await request.db
        .from("deliverables")
        .insert({
          student_id: b.studentId,
          kind,
          title: b.title,
          instructions: b.instructions ?? null,
          essay_id: b.essayId ?? null,
          student_college_id: b.studentCollegeId ?? null,
          target_words: b.targetWords ?? null,
          due_date: dueDate,
          status: "not-started",
          source: "counselor",
          created_by: request.auth.userId,
          assigned_by: request.auth.userId,
          assigned_at: new Date().toISOString(),
          notify_email: b.notifyEmail ?? true,
          notify_sms: b.notifySms ?? false,
          visible_to_student: visible,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);

      const taskId = task.id as string;

      // Stages, in the order they were given.
      if (stages.length > 0) {
        const rows = stages.map((s, i) => ({
          deliverable_id: taskId,
          student_id: b.studentId,
          name: s.name,
          detail: s.detail ?? null,
          due_date: s.dueDate ?? null,
          sequence: i,
        }));
        const { error: stageError } = await request.db
          .from("deliverable_stages")
          .insert(rows);
        if (stageError) throw fromPostgrest(stageError);
      }

      // Mirror dated stages into the existing deadline tracker rather than
      // standing up a second one the counselor has to check separately. A
      // hidden task mirrors nothing: deadlines are the student's to read, so
      // they are made when the task is shared.
      if (b.syncDeadlines !== false && visible) {
        await mirrorStageDeadlines(request, {
          taskId,
          studentId: b.studentId,
          title: b.title,
          kind,
          instructions: b.instructions ?? null,
        });
      }

      if (documents.length > 0) {
        const { error: linkError } = await request.db.from("deliverable_documents").insert(
          documents.map((d) => ({
            deliverable_id: taskId,
            document_id: d.id as string,
            student_id: b.studentId,
            role: "reference",
            added_by: request.auth.userId,
          }))
        );
        if (linkError) throw fromPostgrest(linkError);
      }

      await request.db.from("progress_events").insert({
        student_id: b.studentId,
        deliverable_id: taskId,
        entity_type: "deliverable",
        entity_id: taskId,
        event: "created",
        actor_id: request.auth.userId,
        metadata: { stages: stages.length, documents: documents.length },
      });

      // Nobody is told about a task the student can't see.
      const notified = visible
        ? await notifyAssignment(request, {
            taskId,
            studentId: b.studentId,
            title: b.title,
            instructions: b.instructions ?? null,
            dueDate,
            stages: stages.map((s) => ({ name: s.name, dueDate: s.dueDate ?? null })),
            documentNames: documents.map((d) => String(d.title ?? d.filename ?? "document")),
            email: b.notifyEmail ?? true,
            sms: b.notifySms ?? false,
          })
        : { email: false, sms: "skipped" as SmsNotifyState, error: null };

      const { data: fresh } = await request.db
        .from("deliverables")
        .select("*")
        .eq("id", taskId)
        .maybeSingle();

      const [dto] = await hydrate(request, [(fresh ?? task) as Row]);
      return reply.code(201).send({ ...dto, notification: notified });
    }
  );

  app.patch(
    "/:id",
    { preHandler: [app.authenticate, limit("tasks:update", 240, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = patchTaskBody.parse(request.body);

      const { data: existing } = await request.db
        .from("deliverables")
        .select("student_id, source, status, visible_to_student, intake_request_id")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound("That task isn't on file");
      const studentId = existing.student_id as string;
      await resolveStudentId(request, studentId, "edit");

      // A request from New student moves only with the student's Submit: once
      // it is with the counselor (review) or received (complete) the student
      // can't take it back, and they never send it themselves by setting its
      // status. Otherwise a student loops "back to in progress, Submit again"
      // and every round re-reads the files and re-emails the counselor. The
      // database says the same (20261024000044).
      if (request.profile.role === "student" && existing.intake_request_id && b.status !== undefined) {
        const current = String(existing.status ?? "");
        if (current === "review" || current === "complete") {
          if (b.status !== current) throw conflict("This is with your counselor now.");
        } else if (b.status === "review" || b.status === "complete") {
          throw conflict("Use Submit to send this to your counselor.");
        }
      }

      if (b.visibleToStudent !== undefined) {
        if (request.profile.role !== "counselor") {
          throw forbidden("Only your counselor can choose what you see");
        }
        // A request from New student is answered by the student's Submit,
        // which needs every item in front of them.
        if (b.visibleToStudent === false && existing.intake_request_id) {
          throw badRequest("A request from New student is always shown to the student");
        }
        // Sharing is one-way: the student may already have the deadlines and
        // the notification, so a visible task can't be taken back.
        if (b.visibleToStudent === false && existing.visible_to_student !== false) {
          throw conflict(
            "A task the student can already see can't be hidden. Delete it or mark it done instead."
          );
        }
      }

      if (request.profile.role === "student") {
        // On their own to-do a student changes anything a to-do has; on an
        // assignment, only their progress.
        const allowed =
          existing.source === "student"
            ? new Set(["title", "instructions", "status", "dueDate", "progressPct"])
            : new Set(["status", "currentWords", "progressPct"]);
        const attempted = Object.keys(b).filter((k) => !allowed.has(k));
        if (attempted.length > 0) {
          throw forbidden(
            existing.source === "student"
              ? "That can't be changed on your own task"
              : "Only your counselor can change the assignment itself"
          );
        }
      }

      const update: Row = {};
      if (b.title !== undefined) update.title = b.title;
      if (b.instructions !== undefined) update.instructions = b.instructions;
      if (b.kind !== undefined) update.kind = b.kind;
      if (b.status !== undefined) update.status = b.status;
      if (b.dueDate !== undefined) update.due_date = b.dueDate;
      if (b.targetWords !== undefined) update.target_words = b.targetWords;
      if (b.currentWords !== undefined) update.current_words = b.currentWords;
      if (b.progressPct !== undefined) update.progress_pct = b.progressPct;
      if (b.visibleToStudent === true) update.visible_to_student = true;
      if (Object.keys(update).length > 0) update.last_activity_at = new Date().toISOString();

      // Nothing to change (e.g. hiding a task that is already hidden): answer with the task as it is.
      const { data, error } =
        Object.keys(update).length === 0
          ? await request.db.from("deliverables").select("*").eq("id", id).maybeSingle()
          : await request.db.from("deliverables").update(update).eq("id", id).select("*").maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();

      await request.db.from("progress_events").insert({
        student_id: studentId,
        deliverable_id: id,
        entity_type: "deliverable",
        entity_id: id,
        event: b.status ? "status-changed" : "edited",
        actor_id: request.auth.userId,
      });

      const [dto] = await hydrate(request, [data as Row]);

      // Sharing a hidden task is the moment it is assigned: do what creating
      // a visible one does (mirror its dated stages, tell the student).
      if (b.visibleToStudent === true && existing.visible_to_student === false) {
        await mirrorStageDeadlines(request, {
          taskId: id,
          studentId,
          title: String(data.title),
          kind: String(data.kind),
          instructions: (data.instructions as string | null) ?? null,
        });
        const notification = await notifyForTask(request, data as Row);
        // Re-read: the mirrored deadline ids and notifiedAt were written after the update.
        const { data: fresh } = await request.db.from("deliverables").select("*").eq("id", id).maybeSingle();
        const [shared] = await hydrate(request, [(fresh ?? data) as Row]);
        return { ...shared, notification };
      }
      return dto;
    }
  );

  app.delete(
    "/:id",
    {
      preHandler: [app.authenticate, limit("tasks:delete", 60, 60)],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { data: existing } = await request.db
        .from("deliverables")
        .select("student_id, source")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound("That task isn't on file");
      await resolveStudentId(request, existing.student_id as string, "edit");
      // A student deletes only what they added themselves.
      if (request.profile.role === "student" && existing.source !== "student") {
        throw forbidden("Only your counselor can remove a task they assigned");
      }

      const { error } = await request.db.from("deliverables").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  // ---- Attached documents ---------------------------------------------------

  app.post(
    "/:id/documents",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("tasks:attach", 120, 60)],
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z
        .object({
          documentIds: z.array(z.string().uuid()).min(1).max(20),
          role: z
            .enum(["reference", "starting-point", "rubric", "submission", "example"])
            .optional(),
          note: z.string().trim().max(500).optional(),
        })
        .strict()
        .parse(request.body);

      const { data: task } = await request.db
        .from("deliverables")
        .select("id, student_id")
        .eq("id", id)
        .maybeSingle();
      if (!task) throw notFound("That task isn't on file");
      const studentId = task.student_id as string;
      await resolveStudentId(request, studentId, "edit");

      const { data: docs, error: docError } = await request.db
        .from("documents")
        .select("id")
        .in("id", b.documentIds);
      if (docError) throw fromPostgrest(docError);
      if ((docs ?? []).length !== b.documentIds.length) {
        throw badRequest("One of those documents isn't available to attach");
      }

      const { error } = await request.db.from("deliverable_documents").upsert(
        b.documentIds.map((documentId) => ({
          deliverable_id: id,
          document_id: documentId,
          student_id: studentId,
          role: b.role ?? "reference",
          note: b.note ?? null,
          added_by: request.auth.userId,
        })),
        { onConflict: "deliverable_id,document_id" }
      );
      if (error) throw fromPostgrest(error);

      const { data: fresh } = await request.db
        .from("deliverables")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (!fresh) throw notFound("That task isn't on file");
      const [dto] = await hydrate(request, [fresh as Row]);
      return reply.code(201).send(dto);
    }
  );

  app.delete(
    "/:id/documents/:documentId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("tasks:detach", 120, 60)] },
    async (request) => {
      const p = z
        .object({ id: z.string().uuid(), documentId: z.string().uuid() })
        .parse(request.params);

      const { data: task } = await request.db
        .from("deliverables")
        .select("student_id")
        .eq("id", p.id)
        .maybeSingle();
      if (!task) throw notFound("That task isn't on file");
      await resolveStudentId(request, task.student_id as string, "edit");

      const { error } = await request.db
        .from("deliverable_documents")
        .delete()
        .eq("deliverable_id", p.id)
        .eq("document_id", p.documentId);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  // ---- Handing a file in ------------------------------------------------------
  //
  // The student (or the counselor, on their behalf) hands in a file already in
  // the student's documents against a task. The task moves to "review", AxIS
  // checks the file (lib/submissionReview.ts) and moves it on, and the counselor
  // hears about it. A student may only add or remove `submission` rows on their
  // own tasks; RLS (20261012000001) enforces the same.

  async function loadTaskForSubmission(request: FastifyRequest, id: string): Promise<Row> {
    const { data: task, error } = await request.db
      .from("deliverables")
      .select("id, student_id, status, intake_request_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!task) throw notFound("That task isn't on file");
    await resolveStudentId(request, task.student_id as string, "edit");
    return task as Row;
  }

  async function freshTask(request: FastifyRequest, id: string) {
    const { data } = await request.db.from("deliverables").select("*").eq("id", id).maybeSingle();
    if (!data) throw notFound("That task isn't on file");
    const [dto] = await hydrate(request, [data as Row]);
    return dto;
  }

  app.post(
    "/:id/submissions",
    { preHandler: [app.authenticate, limit("tasks:submit", 30, 60)] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { documentId } = z.object({ documentId: z.string().uuid() }).strict().parse(request.body);
      const task = await loadTaskForSubmission(request, id);
      const studentId = String(task.student_id);
      if (task.intake_request_id && request.profile.role === "student" && task.status === "review") {
        throw conflict("This is with your counselor now.");
      }

      const { data: doc, error: docError } = await request.db
        .from("documents")
        .select("id, student_id")
        .eq("id", documentId)
        .maybeSingle();
      if (docError) throw fromPostgrest(docError);
      if (!doc || doc.student_id !== studentId) throw badRequest("That file isn't in this student's documents");

      const { data: existing } = await request.db
        .from("deliverable_documents")
        .select("role")
        .eq("deliverable_id", id)
        .eq("document_id", documentId)
        .maybeSingle();
      if (existing && existing.role !== "submission") {
        throw conflict("That file is already on this task as reference material");
      }
      // The same file again while it waits on a check: nothing new for AxIS
      // to read or for the counselor to hear about.
      if (existing && task.status === "review") {
        return reply.code(200).send({
          task: await freshTask(request, id),
          review: { status: "skipped", reason: "This file is already handed in and waiting on a check." },
        });
      }
      // A hand-in runs an AxIS read (charged to the caller's AI quota) and
      // tells the counselor: per task and per student caps, DB-backed, so a
      // loop of hand-ins can't flood the counselor's inbox or spend AI.
      // A New student request is only attached here; its Submit is capped on
      // its own route.
      // Only a student's own hand-ins count: a counselor (or AxIS for them)
      // handing in for the student spends their own AI quota, tells nobody,
      // and must not be locked out by what the student did.
      if (request.profile.role === "student" && !task.intake_request_id) {
        await enforceRateLimit(`hand-in:task:${id}`, HAND_INS_PER_TASK_HOUR, 3600, "That's a lot of hand-ins for one task. Try again in an hour.");
        await enforceRateLimit(`hand-in:student:${studentId}`, HAND_INS_PER_STUDENT_DAY, 86_400, "That's a lot of hand-ins for one day. Try again tomorrow.");
      }
      if (!existing) {
        const { error } = await request.db.from("deliverable_documents").insert({
          deliverable_id: id,
          document_id: documentId,
          student_id: studentId,
          role: "submission",
          added_by: request.auth.userId,
        });
        if (error) throw fromPostgrest(error);
      }

      // A request from New student goes in with the student's Submit, all at
      // once (POST /me/intake/submit): until then the file is only attached.
      if (task.intake_request_id && request.profile.role === "student") {
        return reply.code(201).send({ task: await freshTask(request, id), review: null });
      }

      const now = new Date().toISOString();
      const { error: taskError } = await request.db
        .from("deliverables")
        .update({ status: "review", last_activity_at: now })
        .eq("id", id);
      if (taskError) throw fromPostgrest(taskError);
      await request.db.from("progress_events").insert({
        student_id: studentId,
        deliverable_id: id,
        entity_type: "deliverable",
        entity_id: id,
        event: "uploaded",
        actor_id: request.auth.userId,
        metadata: { documentId, handedIn: true },
      });

      const review = await startSubmissionReview(request, { taskId: id, documentId });
      return reply.code(201).send({ task: await freshTask(request, id), review });
    }
  );

  app.delete(
    "/:id/submissions/:documentId",
    { preHandler: [app.authenticate, limit("tasks:unsubmit", 60, 60)] },
    async (request) => {
      const p = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).parse(request.params);
      const task = await loadTaskForSubmission(request, p.id);
      // A finished task keeps the file it was finished with; the counselor reopens it first.
      if (request.profile.role === "student" && task.status === "complete") {
        throw conflict("This one is done. Ask your counselor to reopen it to change the file.");
      }
      if (request.profile.role === "student" && task.intake_request_id && task.status === "review") {
        throw conflict("This is with your counselor now.");
      }

      const { data: removed, error } = await request.db
        .from("deliverable_documents")
        .delete()
        .eq("deliverable_id", p.id)
        .eq("document_id", p.documentId)
        .eq("role", "submission")
        .select("document_id");
      if (error) throw fromPostgrest(error);
      if (!removed?.length) throw notFound("That file isn't handed in on this task");

      // Nothing left to check: a task waiting on a check goes back to the student.
      const { count } = await request.db
        .from("deliverable_documents")
        .select("document_id", { count: "exact", head: true })
        .eq("deliverable_id", p.id)
        .eq("role", "submission");
      if ((count ?? 0) === 0 && task.status === "review") {
        await request.db.from("deliverables").update({ status: "in-progress" }).eq("id", p.id);
      }
      return freshTask(request, p.id);
    }
  );

  /** The counselor asks AxIS to check the latest handed-in file again. */
  app.post(
    "/:id/review",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("ai:submission-review", 20, 60, "You're running checks very fast."),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ documentId: z.string().uuid().optional() }).strict().parse(request.body ?? {});
      await loadTaskForSubmission(request, id);

      let builder = request.db
        .from("deliverable_documents")
        .select("document_id, created_at")
        .eq("deliverable_id", id)
        .eq("role", "submission");
      if (b.documentId) builder = builder.eq("document_id", b.documentId);
      const { data: subs, error } = await builder.order("created_at", { ascending: false }).limit(1);
      if (error) throw fromPostgrest(error);
      const latest = subs?.[0];
      if (!latest) throw badRequest("Nothing has been handed in on this task yet");

      const review = await startSubmissionReview(request, { taskId: id, documentId: String(latest.document_id) });
      return { task: await freshTask(request, id), review };
    }
  );

  // ---- Re-send the assignment notification ----------------------------------

  app.post(
    "/:id/notify",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("tasks:notify", 20, 3600)],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z
        .object({ email: z.boolean().optional(), sms: z.boolean().optional() })
        .strict()
        .parse(request.body ?? {});

      const { data: task } = await request.db
        .from("deliverables")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (!task) throw notFound("That task isn't on file");
      const studentId = task.student_id as string;
      await resolveStudentId(request, studentId, "edit");
      if (task.visible_to_student === false) {
        throw conflict("Share this task with the student before sending it");
      }

      return notifyForTask(request, task as Row, b);
    }
  );

  // ---- The AI document tracker ---------------------------------------------

  app.get("/:id/tracker", { preHandler: app.authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const { data: task } = await request.db
      .from("deliverables")
      .select("student_id")
      .eq("id", id)
      .maybeSingle();
    if (!task) throw notFound("That task isn't on file");
    await resolveStudentId(request, task.student_id as string, "view");

    const { data, error } = await request.db
      .from("deliverable_tracker_checks")
      .select("*")
      .eq("deliverable_id", id)
      .order("checked_at", { ascending: false })
      .limit(50);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toTrackerCheck(r as Row));
  });

  /**
   * Run the tracker for one task.
   *
   * Order matters: the cheap, certain answer first. If nothing has happened
   * inside the counselor's stall window there is nothing to compare, so the
   * verdict is decided by the same stall rule the roster list uses and no model
   * is called. Only when there IS work does the assignment get compared to it.
   */
  app.post(
    "/:id/tracker",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("ai:document-tracker", 20, 60, "You're running the tracker very fast."),
      ],
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const { data: task } = await request.db
        .from("deliverables")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (!task) throw notFound("That task isn't on file");
      const studentId = task.student_id as string;
      await resolveStudentId(request, studentId, "edit");

      const settings = await settingsFor(request, studentId);
      const { settings: practice } = await loadPracticeSettings(request);

      const [{ data: events }, { data: attached }, { data: stages }] = await Promise.all([
        request.db
          .from("progress_events")
          .select("created_at, event, word_count")
          .eq("deliverable_id", id)
          .order("created_at", { ascending: false })
          .limit(20),
        request.db
          .from("deliverable_documents")
          .select(
            "role, document:documents(id, owner_id, filename, title, description, parsed_data, " +
              "parse_status, available_to_llm, kind, ai_access, ferpa_waived, kind_confirmed, updated_at, " +
              "external_provider, external_file_id, external_drive_id, external_modified_at)"
          )
          .eq("deliverable_id", id),
        request.db
          .from("deliverable_stages")
          .select("name, due_date, done")
          .eq("deliverable_id", id)
          .order("sequence"),
      ]);

      const attachedDocs = ((attached ?? []) as unknown as Row[]).map((row) => ({
        role: String(row.role),
        doc: row.document as Row | null,
      }));

      // A connected Google Doc / Word file reports its own edits: someone typing
      // in the live file is active even if nothing new was uploaded here.
      const live = await checkLiveDocuments(
        request,
        attachedDocs.map((r) => r.doc).filter((d): d is Row => d !== null)
      );

      const recordedActivity =
        (task.last_activity_at as string | null) ??
        ((events ?? [])[0]?.created_at as string | undefined) ??
        null;
      const lastActivity = laterOf(recordedActivity, live.latestEdit);
      const stale = isStalled(lastActivity, settings);
      const liveEditInWindow = live.latestEdit !== null && !isStalled(live.latestEdit, settings);
      const liveCaveat = liveProblems(live.checks);

      // The task rule (unconfirmed, keep-out, waived, practice switch, sensitive kinds): lib/context/documentAi.ts.
      const readable = attachedDocs.filter(
        (row) => row.doc && documentReadableForTask(toAiDoc(row.doc), practice.autoParseDocuments).allowed
      );
      const status = liveStatusOf(live.checks);
      // Unconfirmed attachments are why the tracker may have nothing to read: say so in the note.
      const unconfirmedNote = unconfirmedAttachedNote(attachedDocs.map((r) => r.doc), practice.autoParseDocuments);

      const submissions = readable.filter((r) => documentText(r.doc!).length > 0);

      const essayBody = await loadEssayBody(request, task);
      const hasWork = submissions.length > 0 || essayBody.length > 0;

      if (stale && !hasWork) {
        if (holdsNoActivity(live.checks)) {
          const held = live.checks.filter((c) => isGrantProblem(c.errorCode));
          const label = held[0]!.provider === "google" ? "Google" : "Microsoft";
          throw new HttpError(
            409,
            `${label} is disconnected, so Meridies can't see edits to ${quoteNames(held)}. Reconnect ${label} to check this task.`,
            `${held[0]!.provider}_disconnected`
          );
        }
        // A provider that asked us to slow down hasn't said "no edits": hold the verdict.
        const limited = live.checks.filter((c) => c.errorCode === "provider_rate_limited");
        if (limited.length > 0) {
          const label = limited[0]!.provider === "google" ? "Google" : "Microsoft";
          throw new HttpError(
            429,
            `${label} asked Meridies to slow down, so it couldn't check edits to ${quoteNames(limited)}. Try again in a minute.`,
            "provider_rate_limited"
          );
        }
        const days = daysSince(lastActivity);
        const watched = live.checks.filter((c) => !c.error);
        const base = lastActivity
          ? watched.length > 0
            ? `No activity for ${days} days — no edits to ${quoteNames(watched)} and nothing uploaded.`
            : `No activity for ${days} days — nothing uploaded against this assignment yet.`
          : watched.length > 0
            ? `No edits to ${quoteNames(watched)} since this task was assigned.`
            : "Nothing has happened on this task since it was assigned.";
        const note = composeTrackerNote(base, unconfirmedNote, liveCaveat);

        const saved = await saveCheck(request, {
          studentId,
          deliverableId: id,
          verdict: "no-activity",
          note,
          daysSinceActivity: days,
          stallAfterDays: settings.stall_after_days,
          documentsChecked: 0,
          source: "system",
          checkedBy: request.auth.userId,
        });
        return reply.code(201).send({ ...saved, liveStatus: status });
      }

      // Live edits but nothing readable to compare (a Word file, or a document
      // kept out of AI): active, and the note says only that — no alignment claim.
      if (!hasWork && liveEditInWindow) {
        const latest = live.checks
          .filter((c) => c.counts && c.modifiedAt)
          .sort((a, b) => new Date(b.modifiedAt!).getTime() - new Date(a.modifiedAt!).getTime())[0]!;
        const days = daysSince(latest.modifiedAt);
        const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
        const who = latest.editedBy ? ` by ${latest.editedBy}` : "";
        const base = `"${latest.name}" was edited ${when}${who} — active, but there is no readable text to check against the assignment.`;
        const saved = await saveCheck(request, {
          studentId,
          deliverableId: id,
          documentId: latest.documentId,
          verdict: "on-track",
          note: composeTrackerNote(base, unconfirmedNote, liveCaveat),
          daysSinceActivity: daysSince(lastActivity),
          stallAfterDays: settings.stall_after_days,
          documentsChecked: 0,
          source: "system",
          checkedBy: request.auth.userId,
        });
        return reply.code(201).send({ ...saved, liveStatus: status });
      }

      const instructions = String(task.instructions ?? "").trim();
      const evidence = [
        essayBody ? `Draft (${essayBody.length} chars):\n${essayBody.slice(0, 12_000)}` : "",
        ...submissions.slice(0, 5).map((r) => {
          const doc = r.doc!;
          return [
            `Document (${r.role}): ${String(doc.title ?? doc.filename)}`,
            documentText(doc).slice(0, 6_000),
          ].join("\n");
        }),
      ]
        .filter(Boolean)
        .join("\n\n---\n\n");

      const result = await runStructured<{
        verdict: "on-track" | "below-the-brief";
        note: string;
        alignmentScore: number;
        findings: string[];
      }>({
        request,
        module: "document-tracker",
        studentId,
        system: [
          "You check whether a student's work does what their counselor's assignment asked for.",
          "You judge alignment with the assignment, not writing quality and not effort — other checks cover those.",
          "Be concrete about what the assignment asked for and what the work does or doesn't do.",
          "Never rewrite, draft or continue the student's work. Never produce prose they could paste in.",
          "The note is ONE line a counselor can read at a glance, at most 200 characters.",
          "If the work substantially addresses the assignment, say on-track even when it could be better.",
        ].join("\n"),
        prompt: [
          `Assignment: ${task.title}`,
          instructions ? `Instructions given to the student:\n${instructions}` : "No written instructions were given; judge against the task title only.",
          stages?.length
            ? `Stages: ${(stages ?? [])
                .map((s) => `${s.name}${s.done ? " (done)" : ""}${s.due_date ? ` due ${s.due_date}` : ""}`)
                .join("; ")}`
            : "",
          "",
          "The student's work so far:",
          evidence || "(nothing submitted)",
        ]
          .filter(Boolean)
          .join("\n"),
        toolName: "tracker_verdict",
        maxTokens: 1200,
        schema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["on-track", "below-the-brief"] },
            note: { type: "string", maxLength: 200 },
            alignmentScore: { type: "number", minimum: 0, maximum: 1 },
            findings: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
          },
          required: ["verdict", "note", "alignmentScore", "findings"],
        },
        // Model output is untrusted: the note is forced onto one short line and
        // findings go through the same no-prose filter the essay routes use.
        validate: (value) => {
          const parsed = z
            .object({
              verdict: z.enum(["on-track", "below-the-brief"]),
              note: z.string(),
              alignmentScore: z.number().min(0).max(1),
              findings: z.array(z.string()),
            })
            .parse(value);
          return {
            ...parsed,
            note: oneLine(parsed.note, 300),
            findings: enforceNoProse(parsed.findings),
          };
        },
      });

      const saved = await saveCheck(request, {
        studentId,
        deliverableId: id,
        documentId: (submissions[0]?.doc?.id as string | undefined) ?? null,
        verdict: result.verdict,
        note: result.note || "Checked against the assignment.",
        alignmentScore: result.alignmentScore,
        daysSinceActivity: daysSince(lastActivity),
        stallAfterDays: settings.stall_after_days,
        documentsChecked: submissions.length + (essayBody ? 1 : 0),
        findings: result.findings,
        source: "ai",
        checkedBy: request.auth.userId,
      });

      return reply.code(201).send({ ...saved, liveStatus: status });
    }
  );
}

// ---- helpers ---------------------------------------------------------------

/** The later of two timestamps, as ISO, or whichever exists. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function quoteNames(checks: LiveFileCheck[]): string {
  const names = checks.slice(0, 2).map((c) => `"${c.name}"`);
  return checks.length > 2 ? `${names.join(", ")} and ${checks.length - 2} more` : names.join(" or ");
}

/** A one-line admission when a linked file couldn't be checked. */
function liveProblems(checks: LiveFileCheck[]): string {
  const failed = checks.filter((c) => c.error);
  if (failed.length === 0) return "";
  return `Couldn't check ${quoteNames(failed)} live (${failed[0]!.error}).`;
}

/** Whatever readable text the parser managed to pull out of a document. */
function documentText(doc: Row): string {
  const parsed = (doc.parsed_data ?? {}) as Record<string, unknown>;
  const candidates = [parsed.text, parsed.content, parsed.body, doc.description];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

/** The linked essay's draft, under the context layer's essay rule (its linked file confirmed and not kept out). */
async function loadEssayBody(request: FastifyRequest, task: Row): Promise<string> {
  if (!task.essay_id) return "";
  const { data } = await request.db
    .from("essays")
    .select("body, document_id, document:documents(available_to_llm, kind_confirmed)")
    .eq("id", task.essay_id as string)
    .maybeSingle();
  if (!data) return "";
  const row = data as unknown as Row;
  if (!essayBodyReadable(row.document_id, row.document)) return "";
  return String(row.body ?? "").trim();
}

/** Collapse to a single line and cap it: the note renders inline in a table. */
function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

async function saveCheck(
  request: FastifyRequest,
  input: {
    studentId: string;
    deliverableId: string;
    documentId?: string | null;
    verdict: "on-track" | "no-activity" | "below-the-brief";
    note: string;
    alignmentScore?: number | null;
    daysSinceActivity: number | null;
    stallAfterDays: number;
    documentsChecked: number;
    findings?: string[];
    source: "system" | "ai" | "counselor";
    checkedBy: string;
  }
) {
  const { data, error } = await request.db
    .from("deliverable_tracker_checks")
    .insert({
      student_id: input.studentId,
      deliverable_id: input.deliverableId,
      document_id: input.documentId ?? null,
      verdict: input.verdict,
      note: oneLine(input.note, 300) || "Checked against the assignment.",
      alignment_score: input.alignmentScore ?? null,
      days_since_activity: input.daysSinceActivity,
      stall_after_days: input.stallAfterDays,
      documents_checked: input.documentsChecked,
      findings: input.findings ?? [],
      source: input.source,
      checked_by: input.checkedBy,
    })
    .select("*")
    .single();

  if (error) throw fromPostgrest(error);
  return toTrackerCheck(data as Row);
}

/**
 * Send the assignment. Email goes out through Resend; SMS through Twilio. The
 * SMS state reported back is the true one — `sent` only after Twilio accepted
 * it, `queued` when no SMS provider is configured, `failed` otherwise — because
 * a task that claims to have texted a student when it didn't is worse than one
 * that says queued.
 *
 * A delivery failure is recorded on the task, never thrown: the assignment
 * exists, and the counselor needs to be told the message didn't go rather than
 * losing the task they just wrote.
 */
type SmsNotifyState = "sent" | "queued" | "failed" | "skipped" | "unavailable";

/** Send (or re-send) the assignment for a saved task, from its own stages and files. */
async function notifyForTask(
  request: FastifyRequest,
  task: Row,
  channels: { email?: boolean; sms?: boolean } = {}
) {
  const id = task.id as string;
  const [{ data: stages }, { data: docs }] = await Promise.all([
    request.db
      .from("deliverable_stages")
      .select("name, due_date")
      .eq("deliverable_id", id)
      .order("sequence"),
    request.db
      .from("deliverable_documents")
      .select("document:documents(filename, title)")
      .eq("deliverable_id", id),
  ]);

  return notifyAssignment(request, {
    taskId: id,
    studentId: task.student_id as string,
    title: String(task.title),
    instructions: (task.instructions as string | null) ?? null,
    dueDate: (task.due_date as string | null) ?? null,
    stages: (stages ?? []).map((s) => ({
      name: String(s.name),
      dueDate: (s.due_date as string | null) ?? null,
    })),
    documentNames: ((docs ?? []) as unknown as Row[]).map((d) => {
      const doc = d.document as Row | null;
      return String(doc?.title ?? doc?.filename ?? "document");
    }),
    email: channels.email ?? Boolean(task.notify_email),
    sms: channels.sms ?? Boolean(task.notify_sms),
  });
}

/** Give each dated stage that has none a Deadline Command Center entry. */
async function mirrorStageDeadlines(
  request: FastifyRequest,
  input: { taskId: string; studentId: string; title: string; kind: string; instructions: string | null }
): Promise<void> {
  const { data: saved } = await request.db
    .from("deliverable_stages")
    .select("id, name, due_date, deadline_id")
    .eq("deliverable_id", input.taskId)
    .order("sequence");

  for (const stage of saved ?? []) {
    if (!stage.due_date || stage.deadline_id) continue;
    const { data: deadline } = await request.db
      .from("deadlines")
      .insert({
        student_id: input.studentId,
        title: `${input.title} — ${stage.name}`,
        type: DEADLINE_TYPE_BY_KIND[input.kind] ?? "document",
        due_date: stage.due_date,
        owner: "student",
        description: input.instructions,
        created_by: request.auth.userId,
      })
      .select("id")
      .maybeSingle();
    if (deadline) {
      await request.db
        .from("deliverable_stages")
        .update({ deadline_id: deadline.id })
        .eq("id", stage.id as string);
    }
  }
}

async function notifyAssignment(
  request: FastifyRequest,
  input: {
    taskId: string;
    studentId: string;
    title: string;
    instructions: string | null;
    dueDate: string | null;
    stages: { name: string; dueDate: string | null }[];
    documentNames: string[];
    email: boolean;
    sms: boolean;
  }
): Promise<{ email: boolean; sms: SmsNotifyState; error: string | null }> {
  const { data: student } = await request.db
    .from("profiles")
    .select("full_name, email, phone")
    .eq("id", input.studentId)
    .maybeSingle();

  const payload: TaskNotification = {
    studentName: (student?.full_name as string | null) ?? null,
    counselorName: request.profile.full_name ?? null,
    title: input.title,
    instructions: input.instructions,
    stages: input.stages,
    documentNames: input.documentNames,
    dueDate: input.dueDate,
    url: taskUrl(input.taskId),
  };
  const template = taskAssignmentEmail(payload);

  let emailSent = false;
  let smsState: SmsNotifyState = "skipped";
  const errors: string[] = [];

  if (input.email) {
    const to = student?.email as string | undefined;
    if (!to) {
      errors.push("no email address on file");
    } else {
      const result = await sendEmail({
        to,
        subject: `New task: ${input.title}`,
        html: brandedEmail(template),
        text: brandedText(template),
        template: "task-assigned",
        student_id: input.studentId,
        deliverable_id: input.taskId,
        recipient_id: input.studentId,
        recipient_kind: "student",
        logger: request.log,
      });
      emailSent = result.sent;
      if (!result.sent && result.error) errors.push(result.error);
    }
  }

  if (input.sms) {
    const phone = student?.phone as string | undefined;
    if (!phone) {
      smsState = "unavailable";
      errors.push("no phone number on file");
    } else {
      const sms = await sendSms({
        to: phone,
        body: taskAssignmentSms(payload),
        template: "task-assigned",
        student_id: input.studentId,
        deliverable_id: input.taskId,
        recipient_id: input.studentId,
        recipient_kind: "student",
        logger: request.log,
      });
      smsState = sms.status;
      if (sms.status === "failed" && sms.error) errors.push(sms.error);
    }
  }

  // The in-app feed too — the email is the nudge, this is the record.
  await request.db.from("notifications").insert({
    recipient_id: input.studentId,
    student_id: input.studentId,
    kind: "deadline",
    urgency: "normal",
    title: `New task: ${input.title}`,
    body: input.instructions ?? null,
    href: `/dashboard/student?task=${input.taskId}`,
    action_items: input.stages
      .map((s) => (s.dueDate ? `${s.name} — due ${s.dueDate}` : s.name))
      .slice(0, 10),
    created_by: request.auth.userId,
  });

  const error = errors.length > 0 ? errors.join("; ").slice(0, 500) : null;
  // Only a message a provider accepted counts. A text sitting in the queue
  // because no SMS provider is configured has not reached the student.
  const delivered = emailSent || smsState === "sent";
  // A failed re-send must not erase the record of the first one that worked.
  const update: Record<string, unknown> = { notify_error: error };
  if (delivered) update.notified_at = new Date().toISOString();
  await request.db.from("deliverables").update(update).eq("id", input.taskId);

  return { email: emailSent, sms: smsState, error };
}
