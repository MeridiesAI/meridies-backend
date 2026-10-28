/**
 * Contact Pipeline email sequences (migration 20261028000004).
 *
 * A sequence is an ordered list of emails ("send this, then this three days
 * later"), written once and enrolled many times. Enrolling takes an optional
 * start date, so a counselor can line up peak season weeks ahead. The cron
 * (`POST /internal/pipeline-sequences/dispatch`) sends each email when it is
 * due; this file only writes sequences and enrollments, never sends.
 *
 * Same workspace rules as the contact (RLS: crm_can_access). Registered under
 * /pipeline beside routes/pipeline.ts.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { crmError, loadWorkspace, todayIn } from "../lib/crm.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  ENROLLMENT_COLUMNS,
  SEQUENCE_COLUMNS,
  STEP_COLUMNS,
  addDays,
  firstSendAt,
  requireSequences,
  toEnrollment,
  toSequence,
} from "../lib/pipelineSequences.js";

type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid }).strict();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

const stepBody = z
  .object({
    offsetDays: z.number().int().min(0).max(365),
    to: z.enum(["student", "parent", "both"]).default("both"),
    subject: z.string().trim().min(1, "Every email needs a subject").max(300),
    body: z.string().trim().min(1, "Every email needs a body").max(20_000),
  })
  .strict();

const sequenceBody = z
  .object({
    name: z.string().trim().min(1, "Name the sequence").max(120),
    sendHour: z.number().int().min(0).max(23).default(9),
    steps: z.array(stepBody).min(1, "Add at least one email").max(20),
  })
  .strict()
  .superRefine((b, ctx) => {
    b.steps.forEach((s, i) => {
      if (i > 0 && s.offsetDays < 1) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "offsetDays"], message: "Wait at least a day between emails" });
      }
    });
  });

async function loadSequence(request: FastifyRequest, id: string): Promise<{ sequence: Row; steps: Row[] }> {
  const { data, error } = await request.db.from("pipeline_sequences").select(SEQUENCE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw crmError(error);
  if (!data) throw notFound("That sequence isn't in your pipeline");
  const steps = await request.db.from("pipeline_sequence_steps").select(STEP_COLUMNS).eq("sequence_id", id).order("position");
  if (steps.error) throw crmError(steps.error);
  return { sequence: data as unknown as Row, steps: (steps.data ?? []) as unknown as Row[] };
}

async function assertContact(request: FastifyRequest, id: string): Promise<void> {
  const { data, error } = await request.db.from("pipeline_contacts").select("id").eq("id", id).maybeSingle();
  if (error) throw crmError(error);
  if (!data) throw notFound("That contact isn't in your pipeline");
}

function stepRows(sequenceId: string, steps: z.infer<typeof stepBody>[]) {
  return steps.map((s, i) => ({
    sequence_id: sequenceId,
    position: i + 1,
    offset_days: s.offsetDays,
    to_who: s.to,
    subject: s.subject,
    body: s.body,
  }));
}

export default async function pipelineSequenceRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const read = (name: string, max = 120) => [...counselor, limit(name, max, 60)];
  const write = (name: string, max = 60) => [...counselor, limit(name, max, 60)];

  // ---- Sequences -------------------------------------------------------------

  app.get("/sequences", { preHandler: read("pipeline:sequences") }, async (request) => {
    await requireSequences(request);
    const [seqs, steps, live] = await Promise.all([
      request.db.from("pipeline_sequences").select(SEQUENCE_COLUMNS).order("created_at", { ascending: false }).limit(200),
      request.db.from("pipeline_sequence_steps").select(STEP_COLUMNS).limit(4000),
      request.db.from("pipeline_sequence_enrollments").select("sequence_id").eq("status", "active").limit(10000),
    ]);
    if (seqs.error) throw crmError(seqs.error);
    if (steps.error) throw crmError(steps.error);
    if (live.error) throw crmError(live.error);
    const stepsBy = new Map<string, Row[]>();
    for (const s of (steps.data ?? []) as unknown as Row[]) {
      const k = String(s.sequence_id);
      stepsBy.set(k, [...(stepsBy.get(k) ?? []), s]);
    }
    const active = new Map<string, number>();
    for (const e of (live.data ?? []) as unknown as Row[]) {
      const k = String(e.sequence_id);
      active.set(k, (active.get(k) ?? 0) + 1);
    }
    return {
      sequences: ((seqs.data ?? []) as unknown as Row[]).map((r) =>
        toSequence(r, stepsBy.get(String(r.id)) ?? [], active.get(String(r.id)) ?? 0)
      ),
    };
  });

  app.post("/sequences", { preHandler: write("pipeline:sequences:write") }, async (request, reply) => {
    const b = sequenceBody.parse(request.body);
    await requireSequences(request);
    const ws = await loadWorkspace(request);
    const created = await request.db
      .from("pipeline_sequences")
      .insert({ firm_id: ws.firmId, counselor_id: request.auth.userId, name: b.name, send_hour: b.sendHour })
      .select(SEQUENCE_COLUMNS)
      .single();
    if (created.error) throw crmError(created.error);
    const id = String((created.data as unknown as Row).id);
    const steps = await request.db.from("pipeline_sequence_steps").insert(stepRows(id, b.steps)).select(STEP_COLUMNS);
    if (steps.error) {
      // A sequence with no emails is useless and can't be enrolled; don't leave one behind.
      await request.db.from("pipeline_sequences").delete().eq("id", id);
      throw crmError(steps.error);
    }
    return reply.code(201).send(toSequence(created.data as unknown as Row, (steps.data ?? []) as unknown as Row[]));
  });

  /**
   * Replace a sequence's name, hour and emails. Contacts already in it keep
   * their place by position: if the sequence is now shorter than their place,
   * they finish.
   */
  app.put("/sequences/:id", { preHandler: write("pipeline:sequences:write") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = sequenceBody.parse(request.body);
    await requireSequences(request);
    await loadSequence(request, id);

    const updated = await request.db
      .from("pipeline_sequences")
      .update({ name: b.name, send_hour: b.sendHour })
      .eq("id", id)
      .select(SEQUENCE_COLUMNS)
      .single();
    if (updated.error) throw crmError(updated.error);

    // Update the emails that already hold a position, add the new ones, drop the rest. (Not an
    // upsert: the client may not move a step to another sequence, so sequence_id isn't updatable.)
    const existing = new Map(
      (await loadSequence(request, id)).steps.map((s) => [Number(s.position), String(s.id)] as const)
    );
    const saved: Row[] = [];
    for (const row of stepRows(id, b.steps)) {
      const stepId = existing.get(row.position);
      const { sequence_id: _sequenceId, ...fields } = row;
      const res = stepId
        ? await request.db.from("pipeline_sequence_steps").update(fields).eq("id", stepId).select(STEP_COLUMNS).single()
        : await request.db.from("pipeline_sequence_steps").insert(row).select(STEP_COLUMNS).single();
      if (res.error) throw crmError(res.error);
      saved.push(res.data as unknown as Row);
    }
    const trimmed = await request.db.from("pipeline_sequence_steps").delete().eq("sequence_id", id).gt("position", b.steps.length);
    if (trimmed.error) throw crmError(trimmed.error);
    return toSequence(updated.data as unknown as Row, saved);
  });

  app.delete("/sequences/:id", { preHandler: write("pipeline:sequences:write") }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await requireSequences(request);
    await loadSequence(request, id);
    const { error } = await request.db.from("pipeline_sequences").delete().eq("id", id);
    if (error) throw crmError(error);
    return reply.code(204).send();
  });

  // ---- Enrollments -----------------------------------------------------------

  /** Everyone currently in a sequence (active or paused), for the board's chips. */
  app.get("/sequence-enrollments", { preHandler: read("pipeline:sequences") }, async (request) => {
    await requireSequences(request);
    const [enr, seqs, steps] = await Promise.all([
      request.db.from("pipeline_sequence_enrollments").select(ENROLLMENT_COLUMNS).in("status", ["active", "paused"]).limit(5000),
      request.db.from("pipeline_sequences").select("id, name").limit(500),
      request.db.from("pipeline_sequence_steps").select("sequence_id").limit(4000),
    ]);
    if (enr.error) throw crmError(enr.error);
    if (seqs.error) throw crmError(seqs.error);
    if (steps.error) throw crmError(steps.error);
    const names = new Map(((seqs.data ?? []) as unknown as Row[]).map((s) => [String(s.id), String(s.name)]));
    const counts = new Map<string, number>();
    for (const s of (steps.data ?? []) as unknown as Row[]) {
      counts.set(String(s.sequence_id), (counts.get(String(s.sequence_id)) ?? 0) + 1);
    }
    return {
      enrollments: ((enr.data ?? []) as unknown as Row[]).map((r) =>
        toEnrollment(r, names.get(String(r.sequence_id)) ?? "", counts.get(String(r.sequence_id)) ?? 0)
      ),
    };
  });

  /** One contact's enrollments, newest first, with whether the family has unsubscribed. */
  app.get("/contacts/:id/sequences", { preHandler: read("pipeline:sequences") }, async (request) => {
    const { id } = idParam.parse(request.params);
    await requireSequences(request);
    const contact = await request.db.from("pipeline_contacts").select("id, email_opted_out_at").eq("id", id).maybeSingle();
    if (contact.error) throw crmError(contact.error);
    if (!contact.data) throw notFound("That contact isn't in your pipeline");
    const [enr, seqs, steps] = await Promise.all([
      request.db.from("pipeline_sequence_enrollments").select(ENROLLMENT_COLUMNS).eq("contact_id", id).order("created_at", { ascending: false }).limit(50),
      request.db.from("pipeline_sequences").select("id, name").limit(500),
      request.db.from("pipeline_sequence_steps").select("sequence_id").limit(4000),
    ]);
    if (enr.error) throw crmError(enr.error);
    if (seqs.error) throw crmError(seqs.error);
    if (steps.error) throw crmError(steps.error);
    const names = new Map(((seqs.data ?? []) as unknown as Row[]).map((s) => [String(s.id), String(s.name)]));
    const counts = new Map<string, number>();
    for (const s of (steps.data ?? []) as unknown as Row[]) {
      counts.set(String(s.sequence_id), (counts.get(String(s.sequence_id)) ?? 0) + 1);
    }
    return {
      optedOut: Boolean((contact.data as unknown as Row).email_opted_out_at),
      enrollments: ((enr.data ?? []) as unknown as Row[]).map((r) =>
        toEnrollment(r, names.get(String(r.sequence_id)) ?? "", counts.get(String(r.sequence_id)) ?? 0)
      ),
    };
  });

  /** Enroll a contact. `startOn` lines the first email up for a future day. */
  app.post("/contacts/:id/sequences", { preHandler: write("pipeline:sequences:enroll", 120) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = z.object({ sequenceId: uuid, startOn: isoDate.optional() }).strict().parse(request.body);
    await requireSequences(request);
    await assertContact(request, id);
    const { sequence, steps } = await loadSequence(request, b.sequenceId);
    const first = steps[0];
    if (!first) throw badRequest("Add at least one email to the sequence first");

    const tz = request.profile.timezone;
    const today = todayIn(tz);
    if (b.startOn && b.startOn < today) throw badRequest("The start date can't be in the past");
    if (b.startOn && b.startOn > addDays(today, 365)) throw badRequest("Pick a start date within the next year");

    const { data, error } = await request.db
      .from("pipeline_sequence_enrollments")
      .insert({
        contact_id: id,
        sequence_id: b.sequenceId,
        next_send_at: firstSendAt(b.startOn, Number(first.offset_days), Number(sequence.send_hour), tz),
      })
      .select(ENROLLMENT_COLUMNS)
      .single();
    if (error) {
      if (error.code === "23505") throw conflict("That contact is already in this sequence");
      throw crmError(error);
    }
    return reply.code(201).send(toEnrollment(data as unknown as Row, String(sequence.name), steps.length));
  });

  /** Pause, resume or stop one enrollment. Ended ones stay as they are. */
  app.patch("/sequence-enrollments/:id", { preHandler: write("pipeline:sequences:enroll", 120) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z.object({ action: z.enum(["pause", "resume", "stop"]) }).strict().parse(request.body);
    await requireSequences(request);
    const current = await request.db.from("pipeline_sequence_enrollments").select(ENROLLMENT_COLUMNS).eq("id", id).maybeSingle();
    if (current.error) throw crmError(current.error);
    if (!current.data) throw notFound("That enrollment isn't in your pipeline");
    const row = current.data as unknown as Row;
    if (row.status === "completed" || row.status === "stopped") throw conflict("That enrollment has ended");

    const patch: Row =
      b.action === "pause"
        ? { status: "paused" }
        : b.action === "stop"
          ? { status: "stopped", stop_reason: "removed" }
          : {
              status: "active",
              // Resuming never sends in the past on a stale clock: an overdue email goes at the next run.
              next_send_at: new Date(Math.max(Date.parse(String(row.next_send_at)), Date.now())).toISOString(),
            };
    const { data, error } = await request.db
      .from("pipeline_sequence_enrollments")
      .update(patch)
      .eq("id", id)
      .select(ENROLLMENT_COLUMNS)
      .single();
    if (error) throw crmError(error);

    const [seq, steps] = await Promise.all([
      request.db.from("pipeline_sequences").select("name").eq("id", String(row.sequence_id)).maybeSingle(),
      request.db.from("pipeline_sequence_steps").select("id", { count: "exact", head: true }).eq("sequence_id", String(row.sequence_id)),
    ]);
    return toEnrollment(data as unknown as Row, String((seq.data as unknown as Row | null)?.name ?? ""), steps.count ?? 0);
  });
}
