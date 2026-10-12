/**
 * My Work Queue (routes/workItems.ts): the counselor's own list. Nobody else
 * sees an item unless it is assigned to a colleague, so adding, editing and
 * ticking off run at once. Deleting asks, and so does putting an item on a
 * colleague's queue (Management), since that lands on someone else's desk.
 */
import { z } from "zod";
import { op, type OpGroup } from "../types.js";
import { asArray, asRecord, changeLines, clock, day, dayLabel, defined, idOf, listReply, plainText, qs, seg, str, untrusted, uuid } from "../util.js";

const KINDS = ["task", "note", "deadline"] as const;
const REPEATS = ["none", "daily", "weekly", "monthly"] as const;

const LABELS = { title: "Title", detail: "Notes", due_date: "Due", due_time: "Time", repeat: "Repeats", kind: "Kind", done: "Done", student_id: "Student" };

const toBody = (i: Record<string, unknown>) =>
  defined({
    studentId: i.student_id,
    kind: i.kind,
    title: i.title,
    detail: i.detail,
    dueDate: i.due_date,
    dueTime: i.due_time,
    repeat: i.repeat,
    done: i.done,
    assigneeId: i.assignee_id,
  });

type Item = { id?: string; title?: string; detail?: string | null; dueDate?: string | null; dueTime?: string | null; repeat?: string; kind?: string; done?: boolean; studentId?: string | null };

async function findItem(h: { get<T>(url: string): Promise<T | null> }, id: string): Promise<Item | null> {
  const rows = await h.get<unknown[]>("/work-items?includeDone=true");
  const hit = asArray(rows).find((r) => r.id === id);
  return hit ? (asRecord(hit) as Item) : null;
}

export const workQueue: OpGroup = {
  heading: "My Work Queue",
  ops: [
    op({
      name: "work_queue.list",
      kind: "read",
      title: "The counselor's own queue items with ids (optionally one student's, or include done ones).",
      doc: "{ student_id?, include_done? bool }",
      input: z.object({ student_id: uuid.optional(), include_done: z.boolean().optional() }).strict(),
      request: (i) => ({ method: "GET", url: `/work-items${qs({ studentId: i.student_id, includeDone: i.include_done ? "true" : undefined })}` }),
      reply: (body) =>
        listReply(
          asArray(body).filter((r) => r.origin === "work-item"),
          (w) => `id ${str(w.id)}: [${str(w.kind)}${w.done ? ", done" : ""}] ${w.dueDate ? `due ${str(w.dueDate)} ` : ""}${untrusted(w.title)}${w.studentName ? ` · student ${untrusted(w.studentName, "roster")}` : ""}`,
          "My Work Queue is empty."
        ),
    }),
    op({
      name: "work_queue.add",
      kind: "write",
      risk: (i) => (i.assignee_id ? "confirm" : "auto"),
      title: "Add a to-do or note to My Work Queue (or, with assignee_id, to a colleague's queue).",
      doc: "{ title ≤300, detail? ≤2000, student_id?, kind?: task|note|deadline, due_date? YYYY-MM-DD, due_time? HH:MM, repeat?: none|daily|weekly|monthly, assignee_id? (a colleague, from management.consultants) }",
      input: z
        .object({
          title: z.string().trim().min(1).max(300),
          detail: z.string().trim().max(2000).nullable().optional(),
          student_id: uuid.nullable().optional(),
          kind: z.enum(KINDS).optional(),
          due_date: day.nullable().optional(),
          due_time: clock.nullable().optional(),
          repeat: z.enum(REPEATS).optional(),
          assignee_id: uuid.optional(),
        })
        .strict(),
      request: (i) => ({ method: "POST", url: "/work-items", body: { ...toBody(i), source: "AxIS" } }),
      describe: (i, h) =>
        `${i.assignee_id ? "Assign to a colleague" : "Add to My Work Queue"}: "${plainText(i.title, 90)}"${i.student_id ? ` (${h.studentName(i.student_id)})` : ""}${i.due_date ? `, due ${dayLabel(i.due_date)}` : ""}`,
      details: (i) => (i.detail ? [plainText(i.detail, 400)] : []),
      warning: "It goes onto your colleague's queue.",
      reply: (body) => `Added (id ${idOf(body) ?? "unknown"}).`,
      undo: (_i, body) => {
        const id = idOf(body);
        return id ? { op: "work_queue.delete", input: { item_id: id } } : null;
      },
    }),
    op({
      name: "work_queue.update",
      kind: "write",
      risk: "auto",
      title: "Change a queue item, or tick it off with done: true.",
      doc: "{ item_id, title?, detail?, student_id?|null, kind?, due_date?|null, due_time?|null, repeat?, done? bool }",
      input: z
        .object({
          item_id: uuid,
          title: z.string().trim().min(1).max(300).optional(),
          detail: z.string().trim().max(2000).nullable().optional(),
          student_id: uuid.nullable().optional(),
          kind: z.enum(KINDS).optional(),
          due_date: day.nullable().optional(),
          due_time: clock.nullable().optional(),
          repeat: z.enum(REPEATS).optional(),
          done: z.boolean().optional(),
        })
        .strict(),
      request: (i) => ({ method: "PATCH", url: `/work-items/${seg(i.item_id)}`, body: toBody(i) }),
      describe: async (i, h) => {
        const w = await findItem(h, i.item_id);
        const what = w ? `"${plainText(w.title, 80)}"` : "a queue item";
        return i.done === true && Object.keys(i).length === 2 ? `Tick off ${what}` : `Update ${what}`;
      },
      details: (i) => changeLines(i, LABELS),
      snapshot: (i, h) => findItem(h, i.item_id),
      undo: (i, _body, before) => {
        const b = asRecord(before);
        if (!b.id) return null;
        const from: Record<string, string> = { title: "title", detail: "detail", student_id: "studentId", kind: "kind", due_date: "dueDate", due_time: "dueTime", repeat: "repeat", done: "done" };
        const prev: Record<string, unknown> = { item_id: i.item_id };
        for (const [k, dto] of Object.entries(from)) if (k in i) prev[k] = b[dto] ?? null;
        if ("title" in prev && !prev.title) return null;
        if ("repeat" in prev && !prev.repeat) prev.repeat = "none";
        if ("done" in prev) prev.done = prev.done === true;
        return { op: "work_queue.update", input: prev };
      },
    }),
    op({
      name: "work_queue.delete",
      kind: "write",
      risk: "confirm",
      title: "Delete a queue item.",
      doc: "{ item_id }",
      input: z.object({ item_id: uuid }).strict(),
      request: (i) => ({ method: "DELETE", url: `/work-items/${seg(i.item_id)}` }),
      describe: async (i, h) => {
        const w = await findItem(h, i.item_id);
        return `Delete ${w ? `"${plainText(w.title, 80)}"` : "a queue item"} from My Work Queue`;
      },
      warning: "The item is deleted, not ticked off.",
    }),
  ],
};
