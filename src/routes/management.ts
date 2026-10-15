/**
 * Management (demo v7, v9): the practice's consultants, the tasks assigned to
 * each (subtasks indented under their task), their alert figures, and an
 * email blast to the consultants.
 *
 * Who may do what is decided in migration 20261005050003 and enforced there
 * by RLS and SECURITY DEFINER functions; routes check first so the answer is
 * a clear 403 rather than an empty write:
 *   - everyone in a firm sees the consultant list and caseload sizes;
 *   - alert figures: firm owners/admins see everyone's, a consultant their own;
 *   - owners/admins assign tasks to anyone in the firm, anyone to themselves;
 *   - the staff blast is an owner/admin action.
 * A solo counselor is a practice of one and administers it.
 *
 * `GET /management/tasks/mine` is what My Work Queue reads for the tasks a
 * consultant has been assigned here.
 *
 * Caseload transfer (spec 2026-10-15-caseload-transfer-design.md), firm
 * owners/admins only, decided in SQL (transfer_caseload, SECURITY DEFINER):
 *   GET  /management/consultants/:id/transfer-preview  what would move
 *   POST /management/consultants/:id/transfer          move the students, all or nothing
 *   GET  /management/transfers                         the firm's last 50 transfers
 * It is not in the AxIS catalog.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  listTransfers,
  loadPreview,
  notifyTransfer,
  plannedEmails,
  runTransfer,
  toTransferResponse,
  transferBody,
} from "../lib/caseloadTransfer.js";
import { crmError, fillTemplate, loadWorkspace, paragraphs } from "../lib/crm.js";
import { brandedEmail, brandedText, sendEmail } from "../lib/email.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid }).strict();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

const TASK_COLUMNS =
  "id, firm_id, assignee_id, assigned_by, parent_id, title, detail, student_id, student_name, due_on, done, done_at, position, created_at, updated_at";

export type ConsultantTask = {
  id: string;
  assigneeId: string;
  assignedBy: string | null;
  title: string;
  detail: string | null;
  studentId: string | null;
  studentName: string | null;
  dueOn: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
  subtasks: ConsultantTask[];
};

function toTask(r: Row): ConsultantTask {
  return {
    id: String(r.id),
    assigneeId: String(r.assignee_id),
    assignedBy: (r.assigned_by as string | null) ?? null,
    title: String(r.title),
    detail: (r.detail as string | null) ?? null,
    studentId: (r.student_id as string | null) ?? null,
    studentName: (r.student_name as string | null) ?? null,
    dueOn: (r.due_on as string | null) ?? null,
    done: r.done === true,
    doneAt: (r.done_at as string | null) ?? null,
    createdAt: String(r.created_at),
    subtasks: [],
  };
}

/** Nest subtasks under their task, both in position order. */
function nest(rows: Row[]): ConsultantTask[] {
  const sorted = [...rows].sort(
    (a, b) => Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at))
  );
  const top = new Map<string, ConsultantTask>();
  for (const r of sorted) if (!r.parent_id) top.set(String(r.id), toTask(r));
  for (const r of sorted) {
    if (!r.parent_id) continue;
    const parent = top.get(String(r.parent_id));
    if (parent) parent.subtasks.push(toTask(r));
  }
  return [...top.values()];
}

export type Consultant = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  seatRole: string;
  isYou: boolean;
  studentCount: number;
  /** Archived students still on their caseload (a removal counts them; a transfer moves them). */
  archivedCount: number;
  /** Null when the caller may not see this consultant's figures. */
  alerts: { overdue: number; noActivity: number; progressPct: number | null } | null;
};

async function loadConsultants(request: FastifyRequest): Promise<Consultant[]> {
  const { data, error } = await request.db.rpc("firm_consultants");
  if (error) throw crmError(error);
  return ((data ?? []) as Row[]).map((r) => ({
    id: String(r.profile_id),
    name: String(r.full_name ?? ""),
    email: String(r.email ?? ""),
    avatarUrl: (r.avatar_url as string | null) ?? null,
    seatRole: String(r.seat_role ?? "counselor"),
    isYou: r.profile_id === request.auth.userId,
    studentCount: Number(r.student_count ?? 0),
    archivedCount: Number(r.archived_count ?? 0),
    alerts: r.alerts_visible
      ? {
          overdue: Number(r.overdue_count ?? 0),
          noActivity: Number(r.no_activity_count ?? 0),
          progressPct: r.progress_pct === null || r.progress_pct === undefined ? null : Number(r.progress_pct),
        }
      : null,
  }));
}

async function nextTaskPosition(request: FastifyRequest, assigneeId: string, parentId: string | null): Promise<number> {
  let q = request.db.from("consultant_tasks").select("position").eq("assignee_id", assigneeId);
  q = parentId ? q.eq("parent_id", parentId) : q.is("parent_id", null);
  const { data, error } = await q.order("position", { ascending: false }).limit(1);
  if (error) throw crmError(error);
  const top = (data ?? [])[0] as Row | undefined;
  return top ? Number(top.position) + 1 : 0;
}

async function loadTask(request: FastifyRequest, id: string): Promise<ConsultantTask> {
  const { data, error } = await request.db
    .from("consultant_tasks")
    .select(TASK_COLUMNS)
    .or(`id.eq.${id},parent_id.eq.${id}`)
    .limit(200);
  if (error) throw crmError(error);
  const rows = (data ?? []) as unknown as Row[];
  const self = rows.find((r) => r.id === id);
  if (!self) throw notFound("That task isn't one you can see");
  if (self.parent_id) return toTask(self);
  return nest(rows)[0];
}

export default async function managementRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  /**
   * The page: every consultant with their tasks (subtasks nested). Tasks are
   * what RLS lets the caller see: an admin sees all, a consultant the ones
   * assigned to or by them.
   */
  app.get("/", { preHandler: [...counselor, limit("management:read", 120, 60)] }, async (request) => {
    const [ws, consultants] = await Promise.all([loadWorkspace(request), loadConsultants(request)]);
    const ids = consultants.map((c) => c.id);

    let tasks: Row[] = [];
    if (ids.length > 0) {
      let q = request.db.from("consultant_tasks").select(TASK_COLUMNS).in("assignee_id", ids);
      q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null);
      const { data, error } = await q.limit(5000);
      if (error) throw crmError(error);
      tasks = (data ?? []) as unknown as Row[];
    }
    const byAssignee = new Map<string, Row[]>();
    for (const t of tasks) {
      const k = String(t.assignee_id);
      byAssignee.set(k, [...(byAssignee.get(k) ?? []), t]);
    }

    return {
      workspace: { firmId: ws.firmId, isAdmin: ws.isAdmin },
      consultants: consultants.map((c) => {
        const list = nest(byAssignee.get(c.id) ?? []);
        return { ...c, tasks: list, openTaskCount: list.filter((t) => !t.done).length };
      }),
    };
  });

  /** The tasks assigned to the caller, for My Work Queue. */
  app.get("/tasks/mine", { preHandler: [...counselor, limit("management:read", 120, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("consultant_tasks")
      .select(TASK_COLUMNS)
      .eq("assignee_id", request.auth.userId)
      .limit(2000);
    if (error) throw crmError(error);
    return nest((data ?? []) as unknown as Row[]);
  });

  /** "Which student is this about": the chosen consultant's caseload, names only. */
  app.get(
    "/consultants/:id/students",
    { preHandler: [...counselor, limit("management:read", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db.rpc("firm_consultant_students", { p_consultant: id });
      if (error) throw crmError(error);
      return ((data ?? []) as Row[]).map((r) => ({
        id: String(r.student_id),
        name: String(r.full_name ?? ""),
        gradYear: (r.grad_year as string | null) ?? null,
      }));
    }
  );

  /** Caseload transfer: what would move, for the transfer popup (firm owner/admin). */
  app.get(
    "/consultants/:id/transfer-preview",
    { preHandler: [...counselor, limit("management:transfer-preview", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return loadPreview(request, id);
    }
  );

  /**
   * Caseload transfer: move the consultant's students, and their records, in
   * one transaction. The emails go after the commit and never fail the call.
   */
  app.post(
    "/consultants/:id/transfer",
    { preHandler: [...counselor, limit("management:transfer", 30, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = transferBody.parse(request.body);
      const result = await runTransfer(request, id, body);
      const planned = plannedEmails(result, body.notifyStudents);
      void notifyTransfer(request.log, request.db, result, {
        notifyStudents: body.notifyStudents,
        adminId: request.auth.userId,
      });
      return toTransferResponse(result, { planned });
    }
  );

  /** The firm's recent transfers: everything for an owner/admin, what involves them for anyone else (RLS). */
  app.get("/transfers", { preHandler: [...counselor, limit("management:read", 120, 60)] }, async (request) => {
    const ws = await loadWorkspace(request);
    if (!ws.firmId) return [];
    return listTransfers(request.db, ws.firmId);
  });

  /**
   * Assign task (v9), or the row's "Add" (a title, optionally under a task).
   * More than one stage makes a multi-step task: each stage becomes a subtask
   * with its own due date, and the task is due with the last one.
   */
  app.post(
    "/tasks",
    { preHandler: [...counselor, limit("management:tasks", 120, 60)] },
    async (request, reply) => {
      const b = z
        .object({
          assigneeId: uuid,
          title: z.string().trim().min(1).max(300),
          detail: z.string().trim().max(4000).optional(),
          studentId: uuid.optional(),
          parentId: uuid.optional(),
          stages: z
            .array(z.object({ name: z.string().trim().min(1).max(300), dueOn: isoDate }).strict())
            .max(12)
            .optional(),
          notify: z.boolean().default(false),
        })
        .strict()
        .parse(request.body);
      if (b.parentId && (b.stages?.length || b.studentId)) {
        throw badRequest("A subtask is just a title");
      }

      const ws = await loadWorkspace(request);
      const consultants = await loadConsultants(request);
      const assignee = consultants.find((c) => c.id === b.assigneeId);
      if (!assignee) throw notFound("That consultant isn't in your practice");
      if (!assignee.isYou && !ws.isAdmin) {
        throw forbidden("Only a firm owner or admin can assign tasks to another consultant");
      }

      const stages = b.stages ?? [];
      const multi = stages.length > 1;
      const { data, error } = await request.db
        .from("consultant_tasks")
        .insert({
          firm_id: ws.firmId,
          assignee_id: b.assigneeId,
          assigned_by: request.auth.userId,
          parent_id: b.parentId ?? null,
          title: b.title,
          detail: b.detail || null,
          student_id: b.studentId ?? null,
          due_on: stages.length ? stages[stages.length - 1].dueOn : null,
          position: await nextTaskPosition(request, b.assigneeId, b.parentId ?? null),
        })
        .select(TASK_COLUMNS)
        .single();
      if (error) {
        if (error.code === "42501" && b.studentId) {
          throw badRequest("That student isn't on this consultant's caseload");
        }
        throw crmError(error);
      }
      const task = data as unknown as Row;

      if (multi) {
        const { error: subError } = await request.db.from("consultant_tasks").insert(
          stages.map((s, i) => ({
            firm_id: ws.firmId,
            assignee_id: b.assigneeId,
            assigned_by: request.auth.userId,
            parent_id: task.id,
            title: s.name,
            due_on: s.dueOn,
            position: i,
          }))
        );
        if (subError) {
          await request.db.from("consultant_tasks").delete().eq("id", String(task.id));
          throw crmError(subError);
        }
      }

      let notified = false;
      if (b.notify && !assignee.isYou && assignee.email) {
        const template = {
          heading: "A new task in Management",
          paragraphs: [
            `${request.profile.full_name || "Your practice"} assigned you: ${b.title}.`,
            ...(b.detail ? [b.detail] : []),
            ...(task.student_name ? [`It's about ${String(task.student_name)}.`] : []),
            ...(stages.length
              ? [stages.map((s) => `${s.name}: due ${s.dueOn}`).join("\n")]
              : []),
          ],
          footnote: "Sent through Meridies.",
        };
        const sent = await sendEmail({
          to: assignee.email,
          subject: `New task: ${b.title}`,
          html: brandedEmail(template),
          text: brandedText(template),
          template: "consultant-task",
          recipient_kind: "counselor",
          recipient_id: assignee.id,
          logger: request.log,
        });
        notified = sent.sent;
      }

      return reply.code(201).send({ task: await loadTask(request, String(task.id)), notified });
    }
  );

  /** Tick off, rename in place, re-date. */
  app.patch(
    "/tasks/:id",
    { preHandler: [...counselor, limit("management:tasks", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          title: z.string().trim().min(1).max(300).optional(),
          detail: z.string().trim().max(4000).nullable().optional(),
          dueOn: isoDate.nullable().optional(),
          done: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);
      const update: Row = {};
      if (b.title !== undefined) update.title = b.title;
      if (b.detail !== undefined) update.detail = b.detail || null;
      if (b.dueOn !== undefined) update.due_on = b.dueOn;
      if (b.done !== undefined) update.done = b.done;
      if (Object.keys(update).length === 0) throw badRequest("Nothing to change");

      const { data, error } = await request.db
        .from("consultant_tasks")
        .update(update)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) throw crmError(error);
      if (!data) throw notFound("That task isn't one you can change");
      return loadTask(request, id);
    }
  );

  app.delete(
    "/tasks/:id",
    { preHandler: [...counselor, limit("management:tasks", 120, 60)] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db.from("consultant_tasks").delete().eq("id", id).select("id");
      if (error) throw crmError(error);
      if (!data || data.length === 0) {
        throw notFound("Only whoever assigned a task, or a firm admin, can remove it");
      }
      return reply.code(204).send();
    }
  );

  /**
   * Email blast to consultants (v9). Recipients are firm members chosen by id;
   * {first} and {me} are filled per recipient. Owner/admin only.
   */
  app.post(
    "/blast",
    {
      preHandler: [
        ...counselor,
        limit("management:blast", 10, 3600, "You've sent several blasts this hour. Give it a moment."),
      ],
    },
    async (request, reply) => {
      const b = z
        .object({
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20_000),
          consultantIds: z.array(uuid).min(1).max(200),
        })
        .strict()
        .parse(request.body);
      const ws = await loadWorkspace(request);
      if (!ws.firmId) throw conflict("Email blasts to consultants need a firm with more than one consultant");
      if (!ws.isAdmin) throw forbidden("Only a firm owner or admin can email the consultants");

      const consultants = await loadConsultants(request);
      const byId = new Map(consultants.map((c) => [c.id, c]));
      const missing = b.consultantIds.filter((id) => !byId.has(id));
      if (missing.length > 0) throw badRequest("One of those consultants isn't in your practice");
      const recipients = [...new Set(b.consultantIds)].map((id) => byId.get(id)!);

      const { data: blast, error } = await request.db
        .from("staff_blasts")
        .insert({
          firm_id: ws.firmId,
          sender_id: request.auth.userId,
          subject: b.subject,
          body: b.body,
          recipient_count: recipients.length,
        })
        .select("id")
        .single();
      if (error) throw crmError(error);
      const blastId = String((blast as Row).id);

      const { data: rows, error: rowError } = await request.db
        .from("staff_blast_recipients")
        .insert(
          recipients.map((r) => ({
            blast_id: blastId,
            profile_id: r.id,
            full_name: r.name,
            to_email: r.email || null,
            status: r.email ? "queued" : "skipped",
          }))
        )
        .select("id, profile_id, to_email, status");
      if (rowError) throw crmError(rowError);

      let delivered = 0;
      let failed = 0;
      for (const row of (rows ?? []) as Row[]) {
        if (row.status === "skipped" || !row.to_email) continue;
        const r = byId.get(String(row.profile_id));
        const vars = { first: r?.name.split(/\s+/)[0] ?? null, me: request.profile.full_name };
        const subject = fillTemplate(b.subject, vars);
        const template = {
          heading: subject,
          paragraphs: paragraphs(fillTemplate(b.body, vars)),
          footnote: request.profile.full_name
            ? `Sent by ${request.profile.full_name} through Meridies.`
            : "Sent through Meridies.",
        };
        const sent = await sendEmail({
          to: String(row.to_email),
          subject,
          html: brandedEmail(template),
          text: brandedText(template),
          template: "staff-blast",
          recipient_kind: "counselor",
          recipient_id: (row.profile_id as string | null) ?? null,
          logger: request.log,
        });
        if (sent.sent) delivered += 1;
        else failed += 1;
        await request.db
          .from("staff_blast_recipients")
          .update({
            status: sent.sent ? "sent" : "failed",
            message_delivery_id: sent.deliveryId,
            error: sent.error ? "Not delivered" : null,
            sent_at: sent.sent ? new Date().toISOString() : null,
          })
          .eq("id", String(row.id));
      }

      const status = failed === 0 && delivered > 0 ? "sent" : delivered === 0 ? "failed" : "partial";
      await request.db
        .from("staff_blasts")
        .update({ status, delivered_count: delivered, failed_count: failed, sent_at: new Date().toISOString() })
        .eq("id", blastId);

      return reply.code(201).send({
        id: blastId,
        status,
        recipientCount: recipients.length,
        deliveredCount: delivered,
        failedCount: failed,
        skippedCount: recipients.length - delivered - failed,
      });
    }
  );
}
