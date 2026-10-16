/**
 * Deadlines (routes/deadlines.ts). A student's dated items: applications,
 * tests, aid forms. The student sees them on their calendar; no message goes
 * out when one is added or moved, so edits run at once. Deleting one asks.
 */
import { z } from "zod";
import { op, type OpGroup } from "../types.js";
import { asArray, asRecord, changeLines, dayLabel, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

const TYPES = ["application", "essay", "test", "financial", "meeting", "document"] as const;
const LEVELS = ["overdue", "critical", "warning", "upcoming", "done"] as const;

/** The route's own date check (`z.string().date()`): a real calendar day, so 2026-02-30 is refused here, not after a Confirm. */
const isoDay = z.string().date("YYYY-MM-DD, a real date");

const fields = {
  title: z.string().trim().min(1).max(300),
  type: z.enum(TYPES),
  due_date: isoDay.nullable(),
  school: z.string().trim().max(200).nullable(),
  description: z.string().trim().max(2000),
  owner: z.enum(["counselor", "student"]),
  level: z.enum(LEVELS),
};

const LABELS = { title: "Title", type: "Type", due_date: "Due", school: "School", description: "Notes", owner: "Owner", level: "Urgency", done: "Done" };

type Deadline = { title?: string; dueDate?: string | null; studentId?: string };
const label = (d: Deadline | null) => (d ? `"${plainText(d.title, 80)}"${d.dueDate ? ` (${dayLabel(d.dueDate)})` : ""}` : "a deadline");

const toBody = (i: Partial<Record<keyof typeof fields | "done", unknown>>) =>
  defined({ title: i.title, type: i.type, dueDate: i.due_date, school: i.school, description: i.description, owner: i.owner, level: i.level, done: i.done });

export const deadlines: OpGroup = {
  heading: "Deadlines",
  ops: [
    op({
      name: "deadlines.list",
      kind: "read",
      outside: true,
      title: "A student's open deadlines with ids (add include_done for finished ones).",
      doc: "{ student_id, include_done? bool }",
      input: z.object({ student_id: uuid, include_done: z.boolean().optional() }).strict(),
      takesStudent: true,
      request: (i) => ({ method: "GET", url: `/deadlines${qs({ studentId: i.student_id, includeDone: i.include_done ? "true" : undefined })}` }),
      reply: (body) =>
        listReply(
          asArray(body),
          (d) => `id ${str(d.id)}: ${d.dueDate ?? "no date"} [${str(d.type)}${d.done ? ", done" : ""}] ${untrusted(d.title)}${d.school ? ` · ${untrusted(d.school)}` : ""}`,
          "No open deadlines."
        ),
    }),
    op({
      name: "deadlines.create",
      kind: "write",
      risk: "auto",
      title: "Add a deadline to a student's calendar.",
      doc: "{ student_id, title ≤300, type: application|essay|test|financial|meeting|document, due_date? YYYY-MM-DD, school?, description?, owner?: counselor|student, level?: overdue|critical|warning|upcoming }",
      input: z
        .object({
          student_id: uuid,
          title: fields.title,
          type: fields.type,
          due_date: fields.due_date.optional(),
          school: fields.school.optional(),
          description: fields.description.optional(),
          owner: fields.owner.optional(),
          level: fields.level.optional(),
        })
        .strict(),
      takesStudent: true,
      request: (i) => ({ method: "POST", url: "/deadlines", body: { studentId: i.student_id, ...toBody(i) } }),
      describe: (i, h) => `Add deadline "${plainText(i.title, 80)}"${i.due_date ? ` due ${dayLabel(i.due_date)}` : ""} for ${h.studentName(i.student_id)}`,
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "deadlines.delete", input: { deadline_id: id } } : null;
      },
    }),
    op({
      name: "deadlines.update",
      kind: "write",
      risk: "auto",
      title: "Change a deadline: title, date, type, school, notes, urgency, or mark it done.",
      doc: "{ deadline_id, title?, type?, due_date? YYYY-MM-DD|null, school?, description?, owner?, level?: overdue|critical|warning|upcoming, done? bool }",
      input: z
        .object({
          deadline_id: uuid,
          title: fields.title.optional(),
          type: fields.type.optional(),
          due_date: fields.due_date.optional(),
          school: fields.school.optional(),
          description: fields.description.optional(),
          owner: fields.owner.optional(),
          level: fields.level.optional(),
          done: z.boolean().optional(),
        })
        .strict(),
      request: (i) => ({ method: "PATCH", url: `/deadlines/${seg(i.deadline_id)}`, body: toBody(i) }),
      describe: async (i, h) => {
        const d = await findDeadline(h, i.deadline_id);
        return `Update ${label(d)}${d?.studentId ? ` for ${h.studentName(d.studentId)}` : ""}`;
      },
      details: (i) => changeLines(i, LABELS),
      snapshot: (i, h) => findDeadline(h, i.deadline_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const prev: Record<string, unknown> = { deadline_id: i.deadline_id };
        const from: Record<string, string> = { title: "title", type: "type", due_date: "dueDate", school: "school", description: "description", owner: "owner", level: "level", done: "done" };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        // Marking it done also sets its urgency to "done" (the route does): putting it back restores the old urgency.
        if ("done" in i && (LEVELS as readonly string[]).includes(String(b.level))) prev.level = b.level;
        if ("description" in prev && prev.description === null) prev.description = "";
        if ("done" in prev) prev.done = prev.done === true;
        if ("title" in prev && !prev.title) return null;
        return { op: "deadlines.update", input: prev };
      },
    }),
    op({
      name: "deadlines.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a deadline.",
      doc: "{ deadline_id }",
      input: z.object({ deadline_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/deadlines/${seg(i.deadline_id)}` }),
      describe: async (i, h) => {
        const d = await findDeadline(h, i.deadline_id);
        return `Delete ${label(d)}${d?.studentId ? ` from ${h.studentName(d.studentId)}'s calendar` : ""}`;
      },
      warning: "The deadline is removed from the student's calendar.",
    }),
  ],
};

/** The routes have no single-deadline GET; the roster-wide list is one call and RLS-scoped. */
async function findDeadline(h: { get<T>(url: string): Promise<T | null> }, id: string): Promise<Deadline | null> {
  const rows = await h.get<unknown[]>("/deadlines?includeDone=true");
  const hit = asArray(rows).find((r) => r.id === id);
  return hit ? (asRecord(hit) as Deadline) : null;
}
