/**
 * Tasks (routes/tasks.ts) and accountability (routes/accountability.ts).
 *
 * A task is an assignment on the student's To-Do. Creating one the student
 * can see sends the assignment (email, a text if chosen, and the in-app
 * notice) and puts its dated steps on their calendar, so it asks first; a
 * task created hidden (`visible_to_student: false`) tells nobody and runs at
 * once. Sharing a hidden task later, re-sending the assignment and deleting
 * one ask. Editing a task, its steps or its attached files runs at once.
 *
 * Accountability: a red flag reaches the student at once and can escalate to
 * the parents, and a parent alert goes to the family, so both ask. So do the
 * alert settings and recipients that decide who hears, and the guardians the
 * alerts go to. Red-flag and parent-alert text never comes back in a lookup.
 */
import { z } from "zod";
import { op, type OpGroup, type OpHelpers } from "../types.js";
import { asArray, asRecord, changeLines, day, dayLabel, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

type Row = Record<string, unknown>;
type Getter = Pick<OpHelpers, "get">;

// ---- Tasks -------------------------------------------------------------------

const KINDS = ["essay", "common-app-section", "activity-list", "document", "test-registration", "recommendation", "aid-form", "custom"] as const;
const STATUSES = ["not-started", "in-progress", "stalled", "review", "complete"] as const;
const DOC_ROLES = ["reference", "starting-point", "rubric", "submission", "example"] as const;

const TASK_LABELS = {
  title: "Title",
  instructions: "Instructions",
  kind: "Kind",
  status: "Status",
  due_date: "Due",
  target_words: "Target words",
  current_words: "Words so far",
  progress_pct: "Progress %",
};
const TASK_FROM: Record<string, string> = {
  title: "title",
  instructions: "instructions",
  kind: "kind",
  status: "status",
  due_date: "dueDate",
  target_words: "targetWords",
  current_words: "currentWords",
  progress_pct: "progressPct",
};

const STAGE_LABELS = { name: "Step", detail: "Detail", due_date: "Due", sequence: "Position", done: "Done" };

const stageIn = z
  .object({
    name: z.string().trim().min(1).max(300),
    detail: z.string().trim().max(2000).optional(),
    due_date: day.nullable().optional(),
  })
  .strict();

async function findTask(h: Getter, id: string | null | undefined): Promise<Row | null> {
  if (!id) return null;
  const t = await h.get<unknown>(`/tasks/${seg(id)}`);
  const r = asRecord(t);
  return r.id ? r : null;
}

const taskLabel = (t: Row | null) => (t ? `"${plainText(t.title, 80)}"${t.dueDate ? ` (due ${dayLabel(t.dueDate)})` : ""}` : "a task");

/** One student's steps, from the stages list (the routes have no single-stage GET). */
async function findStage(h: Getter, studentId: string, stageId: string): Promise<Row | null> {
  const rows = await h.get<unknown[]>(`/tasks/stages${qs({ studentId })}`);
  return asArray(rows).find((r) => r.id === stageId) ?? null;
}

const taskFlags = (t: Row) =>
  [
    str(t.kind),
    str(t.status),
    t.visibleToStudent === false ? "hidden from student" : null,
    t.source === "student" ? "added by student" : null,
    t.intakeRequestId ? "New student request" : null,
  ]
    .filter(Boolean)
    .join(", ");

const notifyChannels = (email: boolean, sms: boolean) => ["in-app notice", email ? "email" : null, sms ? "text" : null].filter(Boolean).join(", ");

export const tasks: OpGroup = {
  heading: "Tasks",
  ops: [
    op({
      name: "tasks.list",
      kind: "read",
      title: "A student's open tasks with ids (include_complete adds finished ones).",
      doc: "{ student_id, include_complete? bool, source?: counselor|student }",
      input: z.object({ student_id: uuid, include_complete: z.boolean().optional(), source: z.enum(["counselor", "student"]).optional() }).strict(),
      takesStudent: true,
      request: (i) => ({
        method: "GET",
        url: `/tasks${qs({ studentId: i.student_id, includeComplete: i.include_complete ? "true" : undefined, source: i.source })}`,
      }),
      reply: (body) =>
        listReply(
          asArray(body),
          (t) => {
            const steps = asArray(t.stages).length;
            return `id ${str(t.id)}: [${taskFlags(t)}] ${t.dueDate ? `due ${str(t.dueDate)} ` : ""}${untrusted(t.title)}${steps ? ` · ${steps} step${steps === 1 ? "" : "s"}` : ""}`;
          },
          "No open tasks."
        ),
    }),
    op({
      name: "tasks.get",
      kind: "read",
      title: "One task with its steps and attached files, with their ids.",
      doc: "{ task_id }",
      input: z.object({ task_id: uuid }).strict(),
      request: (i) => ({ method: "GET", url: `/tasks/${seg(i.task_id)}` }),
      reply: (body) => {
        const t = asRecord(body);
        if (!t.id) return "That task isn't on file.";
        const lines = [
          `id ${str(t.id)}: [${taskFlags(t)}] ${t.dueDate ? `due ${str(t.dueDate)} ` : ""}${untrusted(t.title)} · student ${str(t.studentId)}${t.notifiedAt ? ` · last sent to the student ${str(t.notifiedAt)?.slice(0, 10)}` : ""}`,
        ];
        for (const s of asArray(t.stages)) {
          lines.push(`step ${str(s.id)}: #${str(s.sequence) ?? "0"} ${untrusted(s.name)}${s.dueDate ? ` due ${str(s.dueDate)}` : ""}${s.done ? " [done]" : ""}`);
        }
        for (const d of asArray(t.documents)) {
          lines.push(`file ${str(d.documentId)}: [${str(d.role)}] ${untrusted(d.title ?? d.filename, "document")}${d.kind ? ` (${str(d.kind)})` : ""}`);
        }
        return lines.join("\n");
      },
    }),
    op({
      name: "tasks.create",
      kind: "write",
      risk: (i) => (i.visible_to_student === false ? "auto" : "confirm"),
      title: "Assign a task to a student (sends it; visible_to_student: false keeps it hidden and runs at once).",
      doc: "{ student_id, title ≤300, kind?: essay|common-app-section|activity-list|document|test-registration|recommendation|aid-form|custom, instructions? ≤8000, due_date?, stages? [{name, detail?, due_date?}]≤20, document_ids?, notify_email?, notify_sms?, sync_deadlines?, visible_to_student? }",
      input: z
        .object({
          student_id: uuid,
          title: z.string().trim().min(1).max(300),
          kind: z.enum(KINDS).optional(),
          instructions: z.string().trim().max(8000).optional(),
          due_date: day.nullable().optional(),
          stages: z.array(stageIn).max(20).optional(),
          document_ids: z.array(uuid).max(20).optional(),
          notify_email: z.boolean().optional(),
          notify_sms: z.boolean().optional(),
          sync_deadlines: z.boolean().optional(),
          visible_to_student: z.boolean().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/tasks",
        body: defined({
          studentId: i.student_id,
          title: i.title,
          kind: i.kind,
          instructions: i.instructions,
          dueDate: i.due_date,
          stages: i.stages?.map((s) => defined({ name: s.name, detail: s.detail, dueDate: s.due_date })),
          documentIds: i.document_ids,
          notifyEmail: i.notify_email,
          notifySms: i.notify_sms,
          syncDeadlines: i.sync_deadlines,
          visibleToStudent: i.visible_to_student,
        }),
      }),
      describe: (i, h) =>
        `${i.visible_to_student === false ? "Add hidden task" : "Assign task"} "${plainText(i.title, 80)}"${i.due_date ? ` due ${dayLabel(i.due_date)}` : ""} ${i.visible_to_student === false ? "for" : "to"} ${h.studentName(i.student_id)}`,
      details: (i) => {
        const out: string[] = [];
        out.push(
          i.visible_to_student === false
            ? "Hidden from the student until shared; nothing is sent."
            : `Sent to the student by: ${notifyChannels(i.notify_email !== false, i.notify_sms === true)}`
        );
        if (i.kind) out.push(`Kind: ${i.kind}`);
        if (i.stages?.length) out.push(`Steps: ${i.stages.map((s) => `${plainText(s.name, 60)}${s.due_date ? ` (${dayLabel(s.due_date)})` : ""}`).join("; ")}`);
        if (i.visible_to_student !== false && i.sync_deadlines !== false && i.stages?.some((s) => s.due_date)) out.push("Dated steps go on the student's calendar.");
        if (i.document_ids?.length) out.push(`Files attached: ${i.document_ids.length}`);
        if (i.instructions) out.push(`Instructions: ${plainText(i.instructions, 800)}`);
        return out;
      },
      warning: "The student is sent the assignment now (in-app, and by email or text as shown).",
      reply: (body) => {
        const b = asRecord(body);
        const n = asRecord(b.notification);
        const sent = b.visibleToStudent === false ? "hidden from the student; nothing was sent" : `email ${n.email ? "sent" : "not sent"}, text ${str(n.sms) ?? "skipped"}`;
        return `Task created (id ${idOf(body) ?? "unknown"}); ${sent}.`;
      },
      // A hidden task has told nobody and mirrored nothing, so deleting it puts things back.
      // A shared one has been sent and has put deadlines on the calendar: no clean undo.
      undo: (i, body) => {
        const id = idOf(body);
        return id && i.visible_to_student === false ? { op: "tasks.delete", input: { task_id: id } } : null;
      },
    }),
    op({
      name: "tasks.update",
      kind: "write",
      risk: "auto",
      title: "Change a task: title, instructions, kind, status, due date, word target or progress.",
      doc: "{ task_id, title?, instructions? ≤8000|null, kind?, status?: not-started|in-progress|stalled|review|complete, due_date? YYYY-MM-DD|null, target_words?|null, current_words?, progress_pct? 0-100 }",
      input: z
        .object({
          task_id: uuid,
          title: z.string().trim().min(1).max(300).optional(),
          instructions: z.string().trim().max(8000).nullable().optional(),
          kind: z.enum(KINDS).optional(),
          status: z.enum(STATUSES).optional(),
          due_date: day.nullable().optional(),
          target_words: z.number().int().min(0).max(100_000).nullable().optional(),
          current_words: z.number().int().min(0).max(100_000).optional(),
          progress_pct: z.number().int().min(0).max(100).optional(),
        })
        .strict(),
      request: (i) => ({
        method: "PATCH",
        url: `/tasks/${seg(i.task_id)}`,
        body: defined({
          title: i.title,
          instructions: i.instructions,
          kind: i.kind,
          status: i.status,
          dueDate: i.due_date,
          targetWords: i.target_words,
          currentWords: i.current_words,
          progressPct: i.progress_pct,
        }),
      }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        const what = taskLabel(t);
        const lead = i.status === "complete" && Object.keys(i).length === 2 ? `Mark ${what} complete` : `Update ${what}`;
        return `${lead}${t?.studentId ? ` for ${h.studentName(str(t.studentId))}` : ""}`;
      },
      details: (i) => changeLines(i, TASK_LABELS),
      snapshot: (i, h) => findTask(h, i.task_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { task_id: i.task_id };
        for (const [k, dto] of Object.entries(TASK_FROM)) if (k in i) prev[k] = b[dto] ?? null;
        if ("title" in prev && !prev.title) return null;
        if ("current_words" in prev) prev.current_words = Number(prev.current_words ?? 0);
        if ("progress_pct" in prev) prev.progress_pct = Number(prev.progress_pct ?? 0);
        return { op: "tasks.update", input: prev };
      },
    }),
    op({
      name: "tasks.share",
      kind: "write",
      risk: "confirm",
      title: "Show a hidden task to the student (sends the assignment, puts its dated steps on their calendar).",
      doc: "{ task_id }",
      input: z.object({ task_id: uuid }).strict(),
      request: (i) => ({ method: "PATCH", url: `/tasks/${seg(i.task_id)}`, body: { visibleToStudent: true } }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        return `Share ${taskLabel(t)}${t?.studentId ? ` with ${h.studentName(str(t.studentId))}` : " with the student"}`;
      },
      details: async (i, h) => {
        const t = await findTask(h, i.task_id);
        if (!t) return [];
        if (t.visibleToStudent !== false) return ["The student can already see this task."];
        const dated = asArray(t.stages).filter((s) => s.dueDate).length;
        return [
          `Sent to the student by: ${notifyChannels(t.notifyEmail === true, t.notifySms === true)}`,
          ...(dated ? [`${dated} dated step${dated === 1 ? "" : "s"} go on the student's calendar.`] : []),
          ...(t.instructions ? [`Instructions: ${plainText(t.instructions, 800)}`] : []),
        ];
      },
      warning: "The student is sent the assignment and sees it on their To-Do. A shared task can't be hidden again.",
      reply: (body) => {
        const n = asRecord(asRecord(body).notification);
        return `Shared; email ${n.email ? "sent" : "not sent"}, text ${str(n.sms) ?? "skipped"}.`;
      },
    }),
    op({
      name: "tasks.notify",
      kind: "write",
      risk: "confirm",
      title: "Send the task's assignment to the student again (email and/or text).",
      doc: "{ task_id, email? bool, sms? bool } (omitted channels use the task's own settings)",
      input: z.object({ task_id: uuid, email: z.boolean().optional(), sms: z.boolean().optional() }).strict(),
      request: (i) => ({ method: "POST", url: `/tasks/${seg(i.task_id)}/notify`, body: defined({ email: i.email, sms: i.sms }) }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        return `Re-send ${taskLabel(t)}${t?.studentId ? ` to ${h.studentName(str(t.studentId))}` : " to the student"}`;
      },
      details: async (i, h) => {
        const t = await findTask(h, i.task_id);
        if (!t) return [];
        const email = i.email ?? t.notifyEmail === true;
        const sms = i.sms ?? t.notifySms === true;
        const steps = asArray(t.stages).map((s) => `${plainText(s.name, 60)}${s.dueDate ? ` (${dayLabel(s.dueDate)})` : ""}`);
        return [
          `To: the student, by ${notifyChannels(email, sms)}`,
          `Subject: New task: ${plainText(t.title, 200)}`,
          ...(steps.length ? [`Steps: ${steps.join("; ")}`] : []),
          ...(t.instructions ? [`Message: ${plainText(t.instructions, 1200)}`] : []),
        ];
      },
      warning: "The student gets the assignment again by the channels shown.",
      reply: (body) => {
        const n = asRecord(body);
        return `Sent; email ${n.email ? "sent" : "not sent"}, text ${str(n.sms) ?? "skipped"}.`;
      },
    }),
    op({
      name: "tasks.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a task (it leaves the student's To-Do).",
      doc: "{ task_id }",
      input: z.object({ task_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/tasks/${seg(i.task_id)}` }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        return `Delete task ${taskLabel(t)}${t?.studentId ? ` for ${h.studentName(str(t.studentId))}` : ""}`;
      },
      warning: "The task, its steps, attached-file links and activity history are deleted. Deadlines it already put on the calendar stay.",
    }),
    op({
      name: "tasks.add_step",
      kind: "write",
      risk: "auto",
      title: "Add a step (a dated stage) to a task.",
      doc: "{ student_id, task_id, name ≤300, detail? ≤2000|null, due_date? YYYY-MM-DD|null, sequence? 0-100 (next unused position, see tasks.get), done? bool }",
      input: z
        .object({
          student_id: uuid,
          task_id: uuid,
          name: z.string().trim().min(1).max(300),
          detail: z.string().trim().max(2000).nullable().optional(),
          due_date: day.nullable().optional(),
          sequence: z.number().int().min(0).max(100).optional(),
          done: z.boolean().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/tasks/stages",
        body: defined({ studentId: i.student_id, deliverable_id: i.task_id, name: i.name, detail: i.detail, due_date: i.due_date, sequence: i.sequence, done: i.done }),
      }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        return `Add step "${plainText(i.name, 80)}"${i.due_date ? ` due ${dayLabel(i.due_date)}` : ""} to ${taskLabel(t)} for ${h.studentName(i.student_id)}`;
      },
      details: (i) => changeLines(i, STAGE_LABELS),
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "tasks.delete_step", input: { student_id: i.student_id, step_id: id } } : null;
      },
    }),
    op({
      name: "tasks.update_step",
      kind: "write",
      risk: "auto",
      title: "Change a task's step: name, detail, date, position, or tick it done.",
      doc: "{ student_id, step_id, name? ≤300, detail? ≤2000|null, due_date? YYYY-MM-DD|null, sequence? 0-100, done? bool }",
      input: z
        .object({
          student_id: uuid,
          step_id: uuid,
          name: z.string().trim().min(1).max(300).optional(),
          detail: z.string().trim().max(2000).nullable().optional(),
          due_date: day.nullable().optional(),
          sequence: z.number().int().min(0).max(100).optional(),
          done: z.boolean().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/tasks/stages/${seg(i.step_id)}`,
        body: defined({ name: i.name, detail: i.detail, due_date: i.due_date, sequence: i.sequence, done: i.done }),
      }),
      describe: async (i, h) => {
        const s = await findStage(h, i.student_id, i.step_id);
        const what = s ? `step "${plainText(s.name, 80)}"` : "a task step";
        return `${i.done === true && Object.keys(i).length === 3 ? "Tick off" : "Update"} ${what} for ${h.studentName(i.student_id)}`;
      },
      details: (i) => changeLines(i, STAGE_LABELS),
      snapshot: (i, h) => findStage(h, i.student_id, i.step_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const from: Record<string, string> = { name: "name", detail: "detail", due_date: "dueDate", sequence: "sequence", done: "done" };
        const prev: Record<string, unknown> = { student_id: i.student_id, step_id: i.step_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("name" in prev && !prev.name) return null;
        if ("sequence" in prev) prev.sequence = Number(prev.sequence ?? 0);
        if ("done" in prev) prev.done = prev.done === true;
        return { op: "tasks.update_step", input: prev };
      },
    }),
    op({
      name: "tasks.delete_step",
      kind: "write",
      risk: "confirm",
      title: "Remove a step from a task.",
      doc: "{ student_id, step_id }",
      input: z.object({ student_id: uuid, step_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/tasks/stages/${seg(i.step_id)}` }),
      describe: async (i, h) => {
        const s = await findStage(h, i.student_id, i.step_id);
        const t = s ? await findTask(h, str(s.deliverableId)) : null;
        return `Remove ${s ? `step "${plainText(s.name, 80)}"` : "a task step"}${t ? ` from ${taskLabel(t)}` : ""} for ${h.studentName(i.student_id)}`;
      },
      warning: "The step is removed from the task. A calendar deadline it created stays.",
    }),
    op({
      name: "tasks.attach_files",
      kind: "write",
      risk: "auto",
      title: "Attach files from the student's documents or the practice's Files to a task.",
      doc: "{ task_id, document_ids [1-20], role?: reference|starting-point|rubric|submission|example, note? ≤500 }",
      input: z
        .object({
          task_id: uuid,
          document_ids: z.array(uuid).min(1).max(20),
          role: z.enum(DOC_ROLES).optional(),
          note: z.string().trim().max(500).optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: `/tasks/${seg(i.task_id)}/documents`, body: defined({ documentIds: i.document_ids, role: i.role, note: i.note }) }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        const n = i.document_ids.length;
        return `Attach ${n} file${n === 1 ? "" : "s"} to ${taskLabel(t)}${t?.studentId ? ` for ${h.studentName(str(t.studentId))}` : ""}`;
      },
      details: (i) => [`As: ${i.role ?? "reference"}`, ...(i.note ? [`Note: ${plainText(i.note, 400)}`] : [])],
      snapshot: (i, h) => findTask(h, i.task_id),
      // One new file comes off again cleanly; a re-attach (it changes the role) or several files don't.
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id || i.document_ids.length !== 1) return null;
        const docId = i.document_ids[0]!;
        if (asArray(b.documents).some((d) => d.documentId === docId)) return null;
        return { op: "tasks.detach_file", input: { task_id: i.task_id, document_id: docId } };
      },
    }),
    op({
      name: "tasks.detach_file",
      kind: "write",
      risk: "confirm",
      title: "Take an attached file off a task (the file itself stays).",
      doc: "{ task_id, document_id }",
      input: z.object({ task_id: uuid, document_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/tasks/${seg(i.task_id)}/documents/${seg(i.document_id)}` }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        const d = t ? asArray(t.documents).find((x) => x.documentId === i.document_id) : undefined;
        return `Take ${d ? `"${plainText(d.title ?? d.filename, 80)}"` : "a file"} off ${taskLabel(t)}${t?.studentId ? ` for ${h.studentName(str(t.studentId))}` : ""}`;
      },
      warning: "The file is no longer attached to the task; it stays in Files.",
      snapshot: (i, h) => findTask(h, i.task_id),
      undo: (i, _body, before) => {
        const d = asArray(asRecord(before).documents).find((x) => x.documentId === i.document_id);
        if (!d) return null;
        const role = str(d.role);
        if (!role || !(DOC_ROLES as readonly string[]).includes(role)) return null;
        return { op: "tasks.attach_files", input: defined({ task_id: i.task_id, document_ids: [i.document_id], role, note: str(d.note) ?? undefined }) };
      },
    }),
    op({
      name: "tasks.remove_handed_in_file",
      kind: "write",
      risk: "confirm",
      title: "Take a handed-in file off a task; a task waiting on its check goes back to in progress.",
      doc: "{ task_id, document_id }",
      input: z.object({ task_id: uuid, document_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/tasks/${seg(i.task_id)}/submissions/${seg(i.document_id)}` }),
      describe: async (i, h) => {
        const t = await findTask(h, i.task_id);
        const d = t ? asArray(t.documents).find((x) => x.documentId === i.document_id && x.role === "submission") : undefined;
        return `Remove handed-in ${d ? `"${plainText(d.title ?? d.filename, 80)}"` : "file"} from ${taskLabel(t)}${t?.studentId ? ` for ${h.studentName(str(t.studentId))}` : ""}`;
      },
      warning: "The hand-in is withdrawn (the file stays in the student's documents); the student hands it in again to have it checked.",
    }),
  ],
};

// ---- Accountability ------------------------------------------------------------

const SEVERITIES = ["critical", "high", "medium"] as const;
const CHANNELS = ["email", "sms", "both"] as const;

const SETTINGS_LABELS = {
  enabled: "Alerts on",
  stall_after_days: "Stalled after (days)",
  escalate_after_hours: "Red flags escalate after (hours)",
  min_days_between_alerts: "Days between parent alerts",
  auto_send_parent_alerts: "Send escalations to parents automatically",
  alert_on_low_quality: "Alert on low-quality drafts",
  quiet_hours_start: "Quiet hours start (hour)",
  quiet_hours_end: "Quiet hours end (hour)",
  timezone: "Time zone",
};
const SETTINGS_KEYS = Object.keys(SETTINGS_LABELS);

const GUARDIAN_LABELS = {
  full_name: "Name",
  relationship: "Relationship",
  email: "Email",
  phone: "Phone",
  preferred_channel: "Prefers",
  alerts_enabled: "Gets alerts",
  receives_reports: "Gets family reports",
  is_primary: "Primary",
};
const GUARDIAN_KEYS = Object.keys(GUARDIAN_LABELS);

/** Open, acknowledged and escalated flags across the roster (RLS-scoped). */
async function findFlag(h: Getter, id: string): Promise<Row | null> {
  const rows = await h.get<unknown[]>("/accountability/red-flags");
  return asArray(rows).find((r) => r.id === id) ?? null;
}

async function findGuardian(h: Getter, studentId: string, id: string): Promise<Row | null> {
  const rows = await h.get<unknown[]>(`/accountability/guardians${qs({ studentId })}`);
  return asArray(rows).find((r) => r.id === id) ?? null;
}

const relationshipOf = (g: Row | null) => plainText(g?.relationship, 40) || "guardian";

/** Who a parent alert would reach, decided the way the route decides it. Card only. */
async function alertRecipientLines(h: Getter, studentId: string, guardianId: string | undefined, studentName: string): Promise<string[]> {
  const [prefs, guardians] = await Promise.all([
    h.get<unknown>(`/accountability/alert-prefs${qs({ studentId })}`),
    h.get<unknown[]>(`/accountability/guardians${qs({ studentId })}`),
  ]);
  const p = asRecord(prefs);
  const copyParents = p.copyParents !== false;
  const copyStudent = p.copyStudent === true;
  const out: string[] = [];
  if (copyParents) {
    const enabled = asArray(guardians).filter((g) => g.alerts_enabled === true);
    const g = guardianId ? enabled.find((x) => x.id === guardianId) : [...enabled].sort((a, b) => Number(b.is_primary === true) - Number(a.is_primary === true))[0];
    out.push(g ? `To: ${plainText(g.full_name, 80)} (${relationshipOf(g)})` : "To: no guardian with alerts on");
  } else {
    out.push("To: parents are switched off for this student");
  }
  if (copyStudent) out.push(`Copy: ${studentName}`);
  return out;
}

export const accountability: OpGroup = {
  heading: "Red flags, parent alerts and guardians",
  ops: [
    op({
      name: "accountability.list_red_flags",
      kind: "read",
      title: "Open, acknowledged and escalated red flags with ids (one student's, or the whole roster's).",
      doc: "{ student_id? }",
      input: z.object({ student_id: uuid.optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/accountability/red-flags${qs({ studentId: i.student_id })}` }),
      // Never the flag's title or message: red-flag text is not on the AI allowlist.
      reply: (body, i) =>
        listReply(
          asArray(body),
          (f) => {
            const about = f.deliverable_id ? `task ${str(f.deliverable_id)}` : f.deadline_id ? `deadline ${str(f.deadline_id)}` : "no task";
            const raised = str(f.created_at)?.slice(0, 10);
            const escalates = f.status === "open" ? str(f.escalate_at)?.slice(0, 10) : null;
            return `id ${str(f.id)}: [${str(f.severity)}, ${str(f.status)}${f.trigger ? `, ${str(f.trigger)}` : ""}] about ${about}${raised ? ` · raised ${raised}` : ""}${escalates ? ` · escalates ${escalates}` : ""}${i.student_id ? "" : ` · student ${str(f.student_id)}`}`;
          },
          "No open red flags."
        ),
    }),
    op({
      name: "accountability.list_guardians",
      kind: "read",
      title: "A student's guardians with ids, relationship and whether they get alerts (no contact details).",
      doc: "{ student_id }",
      input: z.object({ student_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/accountability/guardians${qs({ studentId: i.student_id })}` }),
      // Names, emails and phone numbers stay out: guardians are not on the AI allowlist.
      reply: (body) =>
        listReply(
          asArray(body),
          (g) =>
            `id ${str(g.id)}: ${untrusted(g.relationship || "guardian", "guardian")}${g.is_primary ? ", primary" : ""} · alerts ${g.alerts_enabled ? "on" : "off"} · reports ${g.receives_reports ? "on" : "off"} · prefers ${str(g.preferred_channel) ?? "email"} · ${g.email ? "email on file" : "no email"}, ${g.phone ? "phone on file" : "no phone"}`,
          "No guardians on file."
        ),
    }),
    op({
      name: "accountability.raise_red_flag",
      kind: "write",
      risk: "confirm",
      title: "Raise a red flag the student sees at once; if nothing moves, it escalates to the parents.",
      doc: "{ student_id, title ≤300, message ≤4000, severity?: critical|high|medium, task_id?, deadline_id?, action_items? [≤300] ≤10 }",
      input: z
        .object({
          student_id: uuid,
          title: z.string().trim().min(1).max(300),
          message: z.string().trim().min(1).max(4000),
          severity: z.enum(SEVERITIES).optional(),
          task_id: uuid.nullable().optional(),
          deadline_id: uuid.nullable().optional(),
          action_items: z.array(z.string().trim().max(300)).max(10).optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/accountability/red-flags",
        body: defined({
          studentId: i.student_id,
          title: i.title,
          message: i.message,
          severity: i.severity,
          deliverableId: i.task_id,
          deadlineId: i.deadline_id,
          actionItems: i.action_items,
        }),
      }),
      describe: (i, h) => `Raise a ${i.severity ?? "critical"} red flag for ${h.studentName(i.student_id)}: "${plainText(i.title, 80)}"`,
      details: async (i, h) => {
        const t = i.task_id ? await findTask(h, i.task_id) : null;
        return [
          ...(t ? [`About task: ${taskLabel(t)}`] : []),
          `Message: ${plainText(i.message, 1200)}`,
          ...(i.action_items?.length ? [`To do: ${i.action_items.map((a) => plainText(a, 120)).join("; ")}`] : []),
        ];
      },
      warning: "The student is notified at once; if the work doesn't move before the escalation timer runs out, it becomes an alert to the parents.",
      // Cancelling stops the escalation; the notice the student already got stays.
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "accountability.update_red_flag", input: { flag_id: id, status: "cancelled" } } : null;
      },
    }),
    op({
      name: "accountability.update_red_flag",
      kind: "write",
      risk: "confirm",
      title: "Resolve, cancel or acknowledge a red flag (it stops escalating to the parents).",
      doc: "{ flag_id, status: resolved|cancelled|acknowledged }",
      input: z.object({ flag_id: uuid, status: z.enum(["acknowledged", "resolved", "cancelled"]) }).strict(),
      request: (i) => ({ method: "PATCH", url: `/accountability/red-flags/${seg(i.flag_id)}`, body: { status: i.status } }),
      // Labelled by its task and date, never its own text.
      describe: async (i, h) => {
        const f = await findFlag(h, i.flag_id);
        const t = f?.deliverable_id ? await findTask(h, str(f.deliverable_id)) : null;
        const verb = i.status === "resolved" ? "Resolve" : i.status === "cancelled" ? "Cancel" : "Acknowledge";
        const raised = f ? dayLabel(f.created_at) : "";
        return `${verb} ${f ? `the ${plainText(f.severity, 20)} red flag` : "a red flag"}${t ? ` on ${taskLabel(t)}` : ""}${f ? ` for ${h.studentName(str(f.student_id))}` : ""}${raised ? ` (raised ${raised})` : ""}`;
      },
      warning: "Only an open flag escalates to the parents, and a flag can't be reopened once changed.",
    }),
    op({
      name: "accountability.send_parent_alert",
      kind: "write",
      risk: "confirm",
      title: "Send an alert about a student to their parents (and the student, if copied), by email and/or text.",
      doc: "{ student_id, subject ≤300, body ≤8000, guardian_id?, red_flag_id?, urgency?: critical|high|normal, action_items? [≤300]≤10, channel?: email|sms|both, override_quiet_hours? bool }",
      input: z
        .object({
          student_id: uuid,
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(8000),
          guardian_id: uuid.optional(),
          red_flag_id: uuid.optional(),
          urgency: z.enum(["critical", "high", "normal"]).optional(),
          action_items: z.array(z.string().trim().max(300)).max(10).optional(),
          channel: z.enum(CHANNELS).optional(),
          override_quiet_hours: z.boolean().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/accountability/parent-alerts",
        body: defined({
          studentId: i.student_id,
          subject: i.subject,
          body: i.body,
          guardianId: i.guardian_id,
          redFlagId: i.red_flag_id,
          urgency: i.urgency,
          actionItems: i.action_items,
          channel: i.channel,
          overrideQuietHours: i.override_quiet_hours,
        }),
      }),
      describe: (i, h) => `Send a parent alert about ${h.studentName(i.student_id)}: "${plainText(i.subject, 80)}"`,
      details: async (i, h) => [
        ...(await alertRecipientLines(h, i.student_id, i.guardian_id, h.studentName(i.student_id))),
        `By: ${i.channel ?? "email"}${i.override_quiet_hours ? " (even in quiet hours)" : ""}`,
        `Subject: ${plainText(i.subject, 300)}`,
        `Message: ${plainText(i.body, 1200)}`,
        ...(i.action_items?.length ? [`To do: ${i.action_items.map((a) => plainText(a, 120)).join("; ")}`] : []),
      ],
      warning: "This goes to the family now, or at the next send window if it's quiet hours; the alert throttle may hold it back.",
      reply: (body) => {
        const b = asRecord(body);
        const why = str(b.blockedReason);
        return `Parent alert ${str(b.status) ?? "recorded"} (id ${idOf(body) ?? "unknown"})${why ? `: ${why}` : ""}.`;
      },
    }),
    op({
      name: "accountability.set_alert_recipients",
      kind: "write",
      risk: (i) => (i.copy_parents === true || i.copy_student === true ? "confirm" : "auto"),
      title: "Choose who gets a student's alerts: parents, the student, or both (switching on asks first).",
      doc: "{ student_id, copy_parents? bool, copy_student? bool, note? ≤1000|null }",
      input: z
        .object({
          student_id: uuid,
          copy_parents: z.boolean().optional(),
          copy_student: z.boolean().optional(),
          note: z.string().trim().max(1000).nullable().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PUT",
        url: "/accountability/alert-prefs",
        body: defined({ studentId: i.student_id, copyParents: i.copy_parents, copyStudent: i.copy_student, note: i.note }),
      }),
      describe: (i, h) => `Change who gets alerts about ${h.studentName(i.student_id)}`,
      details: (i) => changeLines(i, { copy_parents: "Parents get alerts", copy_student: "Student is copied", note: "Note" }),
      warning: "Alerts about this student will go to whoever is switched on here.",
      snapshot: (i, h) => h.get(`/accountability/alert-prefs${qs({ studentId: i.student_id })}`),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.studentId) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id };
        if ("copy_parents" in i) prev.copy_parents = b.copyParents !== false;
        if ("copy_student" in i) prev.copy_student = b.copyStudent === true;
        if ("note" in i) prev.note = str(b.note);
        return { op: "accountability.set_alert_recipients", input: prev };
      },
    }),
    op({
      name: "accountability.update_settings",
      kind: "write",
      risk: "confirm",
      title: "Change when work counts as stalled and how parent alerts behave (all students, or one).",
      doc: "{ student_id? (omit: all), enabled?, stall_after_days? 1-90, escalate_after_hours? 1-720, min_days_between_alerts? 1-90, auto_send_parent_alerts?, alert_on_low_quality?, quiet_hours_start?|null 0-23, quiet_hours_end?|null, timezone? }",
      input: z
        .object({
          student_id: uuid.optional(),
          enabled: z.boolean().optional(),
          stall_after_days: z.number().int().min(1).max(90).optional(),
          escalate_after_hours: z.number().int().min(1).max(720).optional(),
          min_days_between_alerts: z.number().int().min(1).max(90).optional(),
          auto_send_parent_alerts: z.boolean().optional(),
          alert_on_low_quality: z.boolean().optional(),
          quiet_hours_start: z.number().int().min(0).max(23).nullable().optional(),
          quiet_hours_end: z.number().int().min(0).max(23).nullable().optional(),
          timezone: z.string().trim().max(60).optional(),
        })
        .strict(),
      request: (i) => ({
        method: "PUT",
        url: "/accountability/settings",
        body: defined({
          studentId: i.student_id,
          enabled: i.enabled,
          stallAfterDays: i.stall_after_days,
          escalateAfterHours: i.escalate_after_hours,
          minDaysBetweenAlerts: i.min_days_between_alerts,
          autoSendParentAlerts: i.auto_send_parent_alerts,
          alertOnLowQuality: i.alert_on_low_quality,
          quietHoursStart: i.quiet_hours_start,
          quietHoursEnd: i.quiet_hours_end,
          timezone: i.timezone,
        }),
      }),
      describe: (i, h) => (i.student_id ? `Change accountability settings for ${h.studentName(i.student_id)}` : "Change your accountability settings for all students"),
      details: (i) => changeLines(i, SETTINGS_LABELS),
      warning: "These rules decide when students count as behind and when their parents are alerted.",
      // Only the all-students row puts back cleanly: a student's first override starts from the
      // database defaults, not the values it inherited, so reverting the changed keys isn't enough.
      snapshot: (i, h) => (i.student_id ? Promise.resolve(null) : h.get("/accountability/settings")),
      undo: (i, _body, before) => {
        if (i.student_id) return null;
        const b = asRecord(before);
        if (!("stall_after_days" in b)) return null;
        const prev: Record<string, unknown> = {};
        for (const k of SETTINGS_KEYS) if (k in i) prev[k] = b[k] ?? null;
        return { op: "accountability.update_settings", input: prev };
      },
    }),
    op({
      name: "accountability.add_guardian",
      kind: "write",
      risk: "confirm",
      title: "Add a parent or guardian to a student (they receive alerts and family reports unless switched off).",
      doc: "{ student_id, full_name ≤200, email? (email or phone required), phone? ≤40, relationship? ≤60, preferred_channel?: email|sms|both, alerts_enabled?, receives_reports?, is_primary? }",
      input: z
        .object({
          student_id: uuid,
          full_name: z.string().trim().min(1).max(200),
          email: z.string().trim().email().max(254).nullable().optional(),
          phone: z.string().trim().max(40).nullable().optional(),
          relationship: z.string().trim().max(60).optional(),
          preferred_channel: z.enum(CHANNELS).optional(),
          alerts_enabled: z.boolean().optional(),
          receives_reports: z.boolean().optional(),
          is_primary: z.boolean().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "POST",
        url: "/accountability/guardians",
        body: defined({
          studentId: i.student_id,
          full_name: i.full_name,
          email: i.email,
          phone: i.phone,
          relationship: i.relationship,
          preferred_channel: i.preferred_channel,
          alerts_enabled: i.alerts_enabled,
          receives_reports: i.receives_reports,
          is_primary: i.is_primary,
        }),
      }),
      describe: (i, h) => `Add a guardian (${plainText(i.relationship, 40) || "parent or guardian"}) for ${h.studentName(i.student_id)}`,
      details: (i) => changeLines(i, GUARDIAN_LABELS),
      warning: "They start receiving this student's alerts and family reports unless those are switched off.",
      undo: (i, body) => {
        const id = idOf(body);
        return id ? { op: "accountability.remove_guardian", input: { student_id: i.student_id, guardian_id: id } } : null;
      },
    }),
    op({
      name: "accountability.update_guardian",
      kind: "write",
      risk: (i) =>
        ["email", "phone", "preferred_channel", "is_primary"].some((k) => k in i) || i.alerts_enabled === true || i.receives_reports === true ? "confirm" : "auto",
      title: "Change a guardian's details or what they get (new contact details or switching on asks first).",
      doc: "{ student_id, guardian_id, full_name?, email?|null, phone?|null, relationship?, preferred_channel?: email|sms|both, alerts_enabled?, receives_reports?, is_primary? }",
      input: z
        .object({
          student_id: uuid,
          guardian_id: uuid,
          full_name: z.string().trim().min(1).max(200).optional(),
          email: z.string().trim().email().max(254).nullable().optional(),
          phone: z.string().trim().max(40).nullable().optional(),
          relationship: z.string().trim().max(60).optional(),
          preferred_channel: z.enum(CHANNELS).optional(),
          alerts_enabled: z.boolean().optional(),
          receives_reports: z.boolean().optional(),
          is_primary: z.boolean().optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({
        method: "PATCH",
        url: `/accountability/guardians/${seg(i.guardian_id)}`,
        body: defined({
          full_name: i.full_name,
          email: i.email,
          phone: i.phone,
          relationship: i.relationship,
          preferred_channel: i.preferred_channel,
          alerts_enabled: i.alerts_enabled,
          receives_reports: i.receives_reports,
          is_primary: i.is_primary,
        }),
      }),
      describe: async (i, h) => {
        const g = await findGuardian(h, i.student_id, i.guardian_id);
        return `Update ${g ? `a guardian (${relationshipOf(g)})` : "a guardian"} of ${h.studentName(i.student_id)}`;
      },
      details: async (i, h) => {
        const g = await findGuardian(h, i.student_id, i.guardian_id);
        return [...(g ? [`Guardian: ${plainText(g.full_name, 80)}`] : []), ...changeLines(i, GUARDIAN_LABELS)];
      },
      warning: "Alerts and family reports for this student go by these details.",
      snapshot: (i, h) => findGuardian(h, i.student_id, i.guardian_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { student_id: i.student_id, guardian_id: i.guardian_id };
        for (const k of GUARDIAN_KEYS) if (k in i) prev[k] = b[k] ?? null;
        if ("full_name" in prev && !prev.full_name) return null;
        if ("relationship" in prev && prev.relationship === null) prev.relationship = "";
        if ("preferred_channel" in prev && !prev.preferred_channel) prev.preferred_channel = "email";
        for (const k of ["alerts_enabled", "receives_reports", "is_primary"]) if (k in prev) prev[k] = prev[k] === true;
        return { op: "accountability.update_guardian", input: prev };
      },
    }),
    op({
      name: "accountability.remove_guardian",
      kind: "write",
      risk: "confirm",
      title: "Remove a guardian from a student.",
      doc: "{ student_id, guardian_id }",
      input: z.object({ student_id: uuid, guardian_id: uuid }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "DELETE", url: `/accountability/guardians/${seg(i.guardian_id)}` }),
      describe: async (i, h) => {
        const g = await findGuardian(h, i.student_id, i.guardian_id);
        return `Remove ${g ? `a guardian (${relationshipOf(g)})` : "a guardian"} from ${h.studentName(i.student_id)}'s record`;
      },
      details: async (i, h) => {
        const g = await findGuardian(h, i.student_id, i.guardian_id);
        return g ? [`Guardian: ${plainText(g.full_name, 80)}`] : [];
      },
      warning: "They stop receiving this student's alerts and family reports.",
    }),
  ],
};
