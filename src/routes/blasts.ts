/**
 * Email blast.
 *
 * The Communication tab is gone; this is the popup behind it. Audiences are
 * derived from the roster rather than maintained as lists: three filters that
 * combine (class year, colleges the students are applying to, application
 * status), then the students left ticked, then who it goes to (the students or
 * their parents). A counselor never curates a mailing list that silently goes
 * stale.
 *
 * `GET /blasts/audiences` returns the filter options WITH counts, because the
 * useful question in that popup is "how many people is this?" before you send.
 *
 * A blast goes now, or is scheduled for a time (optionally every year): a
 * scheduled one is a `scheduled` row the `email-blasts` cron sends (lib/blasts.ts).
 *
 * Sending reuses lib/email.ts and therefore `message_deliveries`; the blast
 * tables record the rule that was used and who it actually reached.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_RECIPIENTS,
  audienceInput,
  deliverBlast,
  resolveAudience,
  scheduleReady,
  scheduleUnavailable,
  validScheduleTime,
} from "../lib/blasts.js";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toBlast, toBlastRecipient } from "../lib/serialize.js";

type Row = Record<string, unknown>;

export default async function blastRoutes(app: FastifyInstance) {
  /** The popup's filters: every value that currently means something, with how many students it holds. */
  app.get(
    "/audiences",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:audiences", 120, 60)] },
    async (request) => {
      const { data: roster, error: rosterError } = await request.db
        .from("profiles")
        .select("id, grad_year")
        .eq("counselor_id", request.auth.userId)
        .is("archived_at", null);
      if (rosterError) throw fromPostgrest(rosterError);
      const ids = (roster ?? []).map((r) => r.id as string);

      const classYears = new Map<string, number>();
      for (const r of roster ?? []) {
        const year = String(r.grad_year ?? "").trim();
        if (year) classYears.set(year, (classYears.get(year) ?? 0) + 1);
      }

      const schools = new Map<string, { value: string; students: Set<string> }>();
      const statuses = new Map<string, Set<string>>();
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await request.db
          .from("student_colleges")
          .select("student_id, name, status")
          .in("student_id", ids.slice(i, i + 200))
          .limit(5000);
        if (error) throw fromPostgrest(error);

        for (const row of data ?? []) {
          const student = row.student_id as string;
          const name = String(row.name ?? "").trim().replace(/\s+/g, " ");
          const status = String(row.status ?? "").trim();
          if (name) {
            // One school however it was typed: the filter matches it the same way.
            const hit = schools.get(name.toLowerCase()) ?? { value: name, students: new Set<string>() };
            hit.students.add(student);
            schools.set(name.toLowerCase(), hit);
          }
          if (status) {
            if (!statuses.has(status)) statuses.set(status, new Set());
            statuses.get(status)!.add(student);
          }
        }
      }

      const byCount = (a: { value: string; count: number }, b: { value: string; count: number }) =>
        b.count - a.count || a.value.localeCompare(b.value);

      return {
        rosterCount: ids.length,
        classYears: [...classYears.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => a.value.localeCompare(b.value)),
        schools: [...schools.values()].map((s) => ({ value: s.value, count: s.students.size })).sort(byCount),
        statuses: [...statuses.entries()].map(([value, set]) => ({ value, count: set.size })).sort(byCount),
      };
    }
  );

  /** Who would get this, before anything is sent: the students the filters match, and the totals for the ticked ones. */
  app.post(
    "/preview",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:preview", 120, 60)],
    },
    async (request) => {
      const audience = audienceInput.parse(request.body);
      const { label, students, selected, recipients } = await resolveAudience(request.db, request.auth.userId, audience);

      return {
        label,
        count: selected,
        deliverable: recipients.filter((r) => r.email).length,
        missingEmail: recipients.filter((r) => !r.email).map((r) => r.fullName),
        students,
      };
    }
  );

  /** The counselor's blasts, newest first; `?status=scheduled` is the Queued tab, soonest first. */
  app.get("/", { preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:list", 120, 60)] }, async (request) => {
    const { status } = z.object({ status: z.enum(["scheduled"]).optional() }).parse(request.query);
    let builder = request.db.from("email_blasts").select("*").eq("counselor_id", request.auth.userId);
    if (status === "scheduled") {
      if (!(await scheduleReady(request.db))) return [];
      builder = builder.eq("status", "scheduled").order("scheduled_for", { ascending: true });
    } else {
      builder = builder.order("created_at", { ascending: false });
    }
    const { data, error } = await builder.limit(100);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toBlast(r as Row));
  });

  app.get("/:id", { preHandler: [app.authenticate, requireRole("counselor")] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const { data, error } = await request.db
      .from("email_blasts")
      .select("*")
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That blast isn't on file");

    const { data: recipients } = await request.db
      .from("email_blast_recipients")
      .select("*")
      .eq("blast_id", id)
      .order("full_name")
      .limit(1000);

    return {
      ...toBlast(data as Row),
      recipients: (recipients ?? []).map((r) => toBlastRecipient(r as Row)),
    };
  });

  /**
   * Send one now, or schedule it (`scheduledFor`, optionally `repeatYearly`).
   *
   * The blast row and its recipients are written BEFORE anything goes out, so a
   * crash halfway through leaves a record of what was attempted rather than a
   * mystery. A scheduled blast writes only its row: the cron resolves who it
   * reaches when its time comes.
   */
  app.post(
    "/",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("blasts:send", 10, 3600, "You've sent several blasts this hour. Give it a moment."),
      ],
    },
    async (request, reply) => {
      const b = audienceInput
        .extend({
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20_000),
          scheduledFor: z.string().datetime({ offset: true }).optional(),
          repeatYearly: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);

      if (b.repeatYearly && !b.scheduledFor) throw badRequest("Pick a date to repeat from");
      if (b.scheduledFor && !validScheduleTime(b.scheduledFor)) {
        throw badRequest("Pick a time in the future, within the next five years");
      }

      const { label, selected, recipients } = await resolveAudience(request.db, request.auth.userId, b);
      if (selected === 0) throw badRequest("That audience is empty");
      if (recipients.length > MAX_RECIPIENTS) {
        throw badRequest(`A blast can reach at most ${MAX_RECIPIENTS} people at once`);
      }

      // Without the migration a blast sent now is stored as the people it reached, as before.
      const ready = await scheduleReady(request.db);
      if (b.scheduledFor && !ready) throw scheduleUnavailable();

      const { data: blast, error } = await request.db
        .from("email_blasts")
        .insert({
          counselor_id: request.auth.userId,
          firm_id: request.profile.firm_id ?? null,
          subject: b.subject,
          body: b.body,
          audience_kind: ready ? "filters" : "selection",
          audience_label: label,
          channel: "email",
          status: b.scheduledFor ? "scheduled" : "sending",
          recipient_count: recipients.length,
          ...(ready
            ? {
                recipient_type: b.recipientType,
                filters: { classYears: b.classYears, colleges: b.colleges, statuses: b.statuses },
                student_ids: b.studentIds ?? null,
                scheduled_for: b.scheduledFor ?? null,
                repeat_yearly: b.repeatYearly === true,
              }
            : {}),
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);

      if (b.scheduledFor) return reply.code(201).send({ ...toBlast(blast as Row), skipped: 0 });

      const blastId = blast.id as string;
      const result = await deliverBlast({
        db: request.db,
        blastId,
        subject: b.subject,
        body: b.body,
        counselorName: request.profile.full_name ?? null,
        replyTo: request.profile.email ?? undefined,
        recipients,
        logger: request.log,
        keyPrefix: `blast:${blastId}`,
      });

      const { data: finished } = await request.db
        .from("email_blasts")
        .update({
          status: result.status,
          delivered_count: result.delivered,
          failed_count: result.failed,
          sent_at: new Date().toISOString(),
        })
        .eq("id", blastId)
        .select("*")
        .maybeSingle();

      return reply.code(201).send({
        ...toBlast((finished ?? blast) as Row),
        skipped: result.skipped,
      });
    }
  );

  /** Take a queued blast out of the queue. A yearly one stops repeating. */
  app.post(
    "/:id/cancel",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:cancel", 60, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const { data: blast, error } = await request.db
        .from("email_blasts")
        .select("id, status")
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!blast) throw notFound("That blast isn't on file");
      if (blast.status !== "scheduled") throw conflict("Only a queued blast can be cancelled");

      // Conditional, so a run that claimed it a moment ago and finished isn't reopened as cancelled.
      const { data: cancelled, error: updateError } = await request.db
        .from("email_blasts")
        .update({ status: "cancelled", repeat_yearly: false, claimed_at: null })
        .eq("id", id)
        .eq("status", "scheduled")
        .select("*")
        .maybeSingle();
      if (updateError) throw fromPostgrest(updateError);
      if (!cancelled) throw conflict("That blast was just sent");
      return toBlast(cancelled as Row);
    }
  );
}
