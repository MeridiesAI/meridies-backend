/**
 * Contact Pipeline history and follow-ups (migration 20261028000002).
 *
 * A contact's timeline: the notes, calls, meetings and emails a counselor
 * logs, beside everything the database itself saw (created, stage moves,
 * won/lost, invitations, follow-ups, invoices, payments, conversion). The
 * system entries come from triggers, so this file can only add the four
 * manual kinds and never edits or removes an entry.
 *
 * Follow-ups are dated to-dos on a contact, assigned to a consultant in the
 * workspace. Same workspace rules as the contact (RLS: crm_can_access).
 *
 * Registered under /pipeline beside routes/pipeline.ts.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { crmError, todayIn } from "../lib/crm.js";
import { notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  ACTIVITY_COLUMNS,
  FOLLOWUP_COLUMNS,
  MANUAL_ACTIVITY_KINDS,
  requirePipelineExtras,
  toActivity,
  toFollowup,
} from "../lib/pipelineExtras.js";
import { consultants } from "./pipeline.js";

type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid }).strict();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const title = z.string().trim().min(1, "Say what to follow up on").max(300);

/** A contact the caller can see, so "no such contact" reads the same as "not yours". */
async function assertContact(request: FastifyRequest, id: string): Promise<void> {
  const { data, error } = await request.db.from("pipeline_contacts").select("id").eq("id", id).maybeSingle();
  if (error) throw crmError(error);
  if (!data) throw notFound("That contact isn't in your pipeline");
}

async function loadFollowup(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db.from("pipeline_followups").select(FOLLOWUP_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw crmError(error);
  if (!data) throw notFound("That follow-up isn't in your pipeline");
  return data as unknown as Row;
}

export default async function pipelineActivityRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const read = (name: string, max = 120) => [...counselor, limit(name, max, 60)];
  const write = (name: string, max = 120) => [...counselor, limit(name, max, 60)];

  // ---- Timeline --------------------------------------------------------------

  /** Newest first. Page back with `before` (the last entry's createdAt). */
  app.get("/contacts/:id/activities", { preHandler: read("pipeline:activities") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(request.query);
    await requirePipelineExtras(request);
    await assertContact(request, id);

    let query = request.db.from("pipeline_activities").select(ACTIVITY_COLUMNS).eq("contact_id", id);
    if (q.before) query = query.lt("created_at", q.before);
    const [{ data, error }, people] = await Promise.all([
      query.order("created_at", { ascending: false }).limit(q.limit),
      consultants(request),
    ]);
    if (error) throw crmError(error);
    const names = new Map(people.map((p) => [p.id, p.name]));
    const activities = ((data ?? []) as unknown as Row[]).map((r) => toActivity(r, names));
    return {
      activities,
      nextBefore: activities.length === q.limit ? (activities[activities.length - 1]?.createdAt ?? null) : null,
    };
  });

  /** Log a note, call, meeting or email by hand. Entries can't be edited or removed. */
  app.post("/contacts/:id/activities", { preHandler: write("pipeline:activities", 120) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({ kind: z.enum(MANUAL_ACTIVITY_KINDS), body: z.string().trim().min(1, "Write something first").max(4000) })
      .strict()
      .parse(request.body);
    await requirePipelineExtras(request);
    await assertContact(request, id);

    const { data, error } = await request.db
      .from("pipeline_activities")
      .insert({ contact_id: id, kind: b.kind, body: b.body })
      .select(ACTIVITY_COLUMNS)
      .single();
    if (error) throw crmError(error);
    const people = await consultants(request);
    return reply.code(201).send(toActivity(data as unknown as Row, new Map(people.map((p) => [p.id, p.name]))));
  });

  // ---- Follow-ups ------------------------------------------------------------

  /** One contact's follow-ups: open first (soonest due), then done. */
  app.get("/contacts/:id/followups", { preHandler: read("pipeline:followups") }, async (request) => {
    const { id } = idParam.parse(request.params);
    await requirePipelineExtras(request);
    await assertContact(request, id);
    const { data, error } = await request.db
      .from("pipeline_followups")
      .select(FOLLOWUP_COLUMNS)
      .eq("contact_id", id)
      .order("done", { ascending: true })
      .order("due_on", { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) throw crmError(error);
    const today = todayIn(request.profile.timezone);
    return { followups: ((data ?? []) as unknown as Row[]).map((r) => toFollowup(r, today)) };
  });

  /**
   * The caller's own open follow-ups across the workspace, soonest due first,
   * each with the contact's name: what to do today.
   */
  app.get("/followups/mine", { preHandler: read("pipeline:followups-mine") }, async (request) => {
    await requirePipelineExtras(request);
    const { data, error } = await request.db
      .from("pipeline_followups")
      .select(FOLLOWUP_COLUMNS)
      .eq("assignee_id", request.auth.userId)
      .eq("done", false)
      .order("due_on", { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) throw crmError(error);
    const rows = (data ?? []) as unknown as Row[];
    const names = new Map<string, string>();
    const contactIds = [...new Set(rows.map((r) => String(r.contact_id)))];
    if (contactIds.length > 0) {
      const contacts = await request.db.from("pipeline_contacts").select("id, student_name").in("id", contactIds).limit(200);
      if (contacts.error) throw crmError(contacts.error);
      for (const c of (contacts.data ?? []) as unknown as Row[]) names.set(String(c.id), String(c.student_name ?? ""));
    }
    const today = todayIn(request.profile.timezone);
    return {
      followups: rows.map((r) => ({ ...toFollowup(r, today), contactName: names.get(String(r.contact_id)) ?? "" })),
    };
  });

  app.post("/contacts/:id/followups", { preHandler: write("pipeline:followups", 120) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({ title, dueOn: isoDate.nullable().optional(), assigneeId: uuid.nullable().optional() })
      .strict()
      .parse(request.body);
    await requirePipelineExtras(request);
    await assertContact(request, id);

    const { data, error } = await request.db
      .from("pipeline_followups")
      .insert({
        contact_id: id,
        title: b.title,
        due_on: b.dueOn ?? null,
        // Null lets the database pick: the contact's owner, else the caller.
        assignee_id: b.assigneeId ?? null,
      })
      .select(FOLLOWUP_COLUMNS)
      .single();
    if (error) throw crmError(error);
    return reply.code(201).send(toFollowup(data as unknown as Row, todayIn(request.profile.timezone)));
  });

  app.patch("/followups/:id", { preHandler: write("pipeline:followups", 240) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({
        title: title.optional(),
        dueOn: isoDate.nullable().optional(),
        assigneeId: uuid.nullable().optional(),
        done: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    await requirePipelineExtras(request);
    const current = await loadFollowup(request, id);

    const update: Row = {};
    if (b.title !== undefined) update.title = b.title;
    if (b.dueOn !== undefined) update.due_on = b.dueOn;
    if (b.assigneeId !== undefined) update.assignee_id = b.assigneeId;
    if (b.done !== undefined) update.done = b.done;
    const today = todayIn(request.profile.timezone);
    if (Object.keys(update).length === 0) return toFollowup(current, today);

    const { data, error } = await request.db
      .from("pipeline_followups")
      .update(update)
      .eq("id", id)
      .select(FOLLOWUP_COLUMNS)
      .maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("That follow-up isn't in your pipeline");
    return toFollowup(data as unknown as Row, today);
  });

  app.delete("/followups/:id", { preHandler: write("pipeline:followups", 120) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await requirePipelineExtras(request);
    await loadFollowup(request, id);
    const { error } = await request.db.from("pipeline_followups").delete().eq("id", id);
    if (error) throw crmError(error);
    return reply.code(204).send();
  });
}
