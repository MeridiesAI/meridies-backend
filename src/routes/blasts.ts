/**
 * Email blast.
 *
 * The Communication tab is gone; this is the popup behind it. Audiences are
 * derived from the roster rather than maintained as lists — entire roster, by
 * class year, by school applied to, by application status — so a counselor
 * never curates a mailing list that silently goes stale.
 *
 * `GET /blasts/audiences` returns the options WITH counts, because the useful
 * question in that popup is "how many people is this?" before you send it.
 *
 * Sending reuses lib/email.ts and therefore `message_deliveries`; the blast
 * tables record the rule that was used and who it actually reached.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { brandedEmail, brandedText, sendEmail } from "../lib/email.js";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toBlast, toBlastRecipient } from "../lib/serialize.js";

type Row = Record<string, unknown>;

/** A blast is a broadcast, not a mail merge campaign. */
const MAX_RECIPIENTS = 500;

// "school" is a college on the students' lists (what AxIS calls "students
// applying to"); "high-school" is the students' own high school.
const AUDIENCE_KINDS = ["roster", "class-year", "high-school", "school", "status", "selection"] as const;

const audienceInput = z
  .object({
    audienceKind: z.enum(AUDIENCE_KINDS),
    audienceValue: z.string().trim().max(200).optional(),
    /** Only for 'selection'. */
    studentIds: z.array(z.string().uuid()).max(MAX_RECIPIENTS).optional(),
  })
  .strict();

type Audience = z.infer<typeof audienceInput>;

type Recipient = {
  studentId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
};

/** The counselor's live roster. RLS scopes it; the filter makes it explicit. */
async function loadRoster(request: FastifyRequest): Promise<Row[]> {
  const { data, error } = await request.db
    .from("profiles")
    .select("id, full_name, email, phone, grad_year, high_school")
    .eq("counselor_id", request.auth.userId)
    .is("archived_at", null)
    .order("full_name");
  if (error) throw fromPostgrest(error);
  return (data ?? []) as Row[];
}

/** One high school however it was typed: trimmed, spaces collapsed, any case. */
function schoolKey(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolve an audience rule to people, right now.
 *
 * Returns the label too: it is frozen onto the blast so "Class of 2027 (14
 * students)" still reads correctly a year later, when the roster has changed.
 */
async function resolveAudience(
  request: FastifyRequest,
  audience: Audience
): Promise<{ label: string; recipients: Recipient[] }> {
  const roster = await loadRoster(request);
  const byId = new Map(roster.map((r) => [r.id as string, r]));

  let selected = roster;
  let label = `Entire roster (${roster.length})`;

  if (audience.audienceKind === "class-year") {
    const year = audience.audienceValue;
    if (!year) throw badRequest("Pick a class year");
    selected = roster.filter((r) => String(r.grad_year ?? "") === year);
    label = `Class of ${year} (${selected.length})`;
  } else if (audience.audienceKind === "high-school") {
    const value = audience.audienceValue;
    if (!value) throw badRequest("Pick a high school");
    const key = schoolKey(value);
    selected = roster.filter((r) => schoolKey(String(r.high_school ?? "")) === key);
    const shown = selected[0] ? String(selected[0].high_school).trim() : value;
    label = `${shown} (${selected.length})`;
  } else if (audience.audienceKind === "school" || audience.audienceKind === "status") {
    const value = audience.audienceValue;
    if (!value) {
      throw badRequest(
        audience.audienceKind === "school" ? "Pick a school" : "Pick an application status"
      );
    }
    const ids = roster.map((r) => r.id as string);
    if (ids.length === 0) return { label: `${value} (0)`, recipients: [] };

    let builder = request.db
      .from("student_colleges")
      .select("student_id, name, status")
      .in("student_id", ids);
    builder =
      audience.audienceKind === "school"
        ? // % and _ in a typed school name are characters, not wildcards: no student nobody picked.
          builder.ilike("name", value.replace(/[%_\\]/g, (c) => `\\${c}`))
        : builder.eq("status", value);

    const { data, error } = await builder.limit(5000);
    if (error) throw fromPostgrest(error);

    const matched = new Set((data ?? []).map((r) => r.student_id as string));
    selected = roster.filter((r) => matched.has(r.id as string));
    label =
      audience.audienceKind === "school"
        ? `Applied to ${value} (${selected.length})`
        : `Status: ${value} (${selected.length})`;
  } else if (audience.audienceKind === "selection") {
    const ids = audience.studentIds ?? [];
    if (ids.length === 0) throw badRequest("Pick at least one student");
    // Silently dropping an id would send to fewer people than the counselor
    // chose without saying so.
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw badRequest("One of those students isn't on your roster");
    selected = ids.map((id) => byId.get(id)!);
    label = `${selected.length} selected`;
  }

  return {
    label,
    recipients: selected.map((r) => ({
      studentId: r.id as string,
      fullName: String(r.full_name ?? ""),
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
    })),
  };
}

function blastTemplate(input: {
  subject: string;
  body: string;
  counselorName: string | null;
  firstName: string | null;
}) {
  const greeting = input.firstName ? `Hi ${input.firstName},` : "Hi,";
  return {
    heading: input.subject,
    paragraphs: [greeting, ...input.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)],
    footnote: input.counselorName
      ? `Sent by ${input.counselorName} through Meridies.`
      : "Sent through Meridies.",
  };
}

export default async function blastRoutes(app: FastifyInstance) {
  /** The popup's dropdowns: every audience that currently means something. */
  app.get(
    "/audiences",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:audiences", 120, 60)] },
    async (request) => {
      const roster = await loadRoster(request);
      const ids = roster.map((r) => r.id as string);

      const classYears = new Map<string, number>();
      const highSchools = new Map<string, { value: string; count: number }>();
      for (const r of roster) {
        const year = String(r.grad_year ?? "").trim();
        if (year) classYears.set(year, (classYears.get(year) ?? 0) + 1);
        const school = String(r.high_school ?? "").trim().replace(/\s+/g, " ");
        if (school) {
          const hit = highSchools.get(schoolKey(school)) ?? { value: school, count: 0 };
          hit.count += 1;
          highSchools.set(schoolKey(school), hit);
        }
      }

      const schools = new Map<string, Set<string>>();
      const statuses = new Map<string, Set<string>>();
      if (ids.length > 0) {
        const { data } = await request.db
          .from("student_colleges")
          .select("student_id, name, status")
          .in("student_id", ids)
          .limit(5000);

        for (const row of data ?? []) {
          const student = row.student_id as string;
          const name = String(row.name ?? "").trim();
          const status = String(row.status ?? "").trim();
          if (name) {
            if (!schools.has(name)) schools.set(name, new Set());
            schools.get(name)!.add(student);
          }
          if (status) {
            if (!statuses.has(status)) statuses.set(status, new Set());
            statuses.get(status)!.add(student);
          }
        }
      }

      const counted = (m: Map<string, Set<string>>) =>
        [...m.entries()]
          .map(([value, set]) => ({ value, count: set.size }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

      return {
        rosterCount: roster.length,
        classYears: [...classYears.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => a.value.localeCompare(b.value)),
        highSchools: [...highSchools.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
        schools: counted(schools),
        statuses: counted(statuses),
      };
    }
  );

  /** Who would get this, before anything is sent. */
  app.post(
    "/preview",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:preview", 60, 60)],
    },
    async (request) => {
      const audience = audienceInput.parse(request.body);
      const { label, recipients } = await resolveAudience(request, audience);

      return {
        label,
        count: recipients.length,
        deliverable: recipients.filter((r) => r.email).length,
        missingEmail: recipients.filter((r) => !r.email).map((r) => r.fullName),
        recipients: recipients.slice(0, 100),
      };
    }
  );

  app.get("/", { preHandler: [app.authenticate, requireRole("counselor"), limit("blasts:list", 120, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("email_blasts")
      .select("*")
      .eq("counselor_id", request.auth.userId)
      .order("created_at", { ascending: false })
      .limit(100);
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
   * Send one.
   *
   * The blast row and its recipients are written BEFORE anything goes out, so a
   * crash halfway through leaves a record of what was attempted rather than a
   * mystery. Each send then updates its own recipient row, and the totals are
   * reconciled at the end.
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
        })
        .strict()
        .parse(request.body);

      const { label, recipients } = await resolveAudience(request, b);
      if (recipients.length === 0) throw badRequest("That audience is empty");
      if (recipients.length > MAX_RECIPIENTS) {
        throw badRequest(`A blast can reach at most ${MAX_RECIPIENTS} students at once`);
      }

      const { data: blast, error } = await request.db
        .from("email_blasts")
        .insert({
          counselor_id: request.auth.userId,
          firm_id: request.profile.firm_id ?? null,
          subject: b.subject,
          body: b.body,
          // email_blasts' CHECK predates high schools: the blast is stored as the
          // students it reached (its recipients are frozen either way), and the
          // label keeps the school ("Harbor View High School (12)").
          audience_kind: b.audienceKind === "high-school" ? "selection" : b.audienceKind,
          audience_value: b.audienceKind === "high-school" ? null : (b.audienceValue ?? null),
          audience_label: label,
          channel: "email",
          status: "sending",
          recipient_count: recipients.length,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      const blastId = blast.id as string;

      const { data: rows, error: rowError } = await request.db
        .from("email_blast_recipients")
        .insert(
          recipients.map((r) => ({
            blast_id: blastId,
            student_id: r.studentId,
            full_name: r.fullName,
            to_email: r.email,
            channel: "email",
            status: r.email ? "queued" : "skipped",
            skip_reason: r.email ? null : "No email address on file",
          }))
        )
        .select("id, student_id, to_email, status");
      if (rowError) throw fromPostgrest(rowError);

      let delivered = 0;
      let failed = 0;
      const byStudent = new Map(recipients.map((r) => [r.studentId, r]));

      for (const row of rows ?? []) {
        if (row.status === "skipped" || !row.to_email) continue;
        const recipient = byStudent.get(row.student_id as string);
        const template = blastTemplate({
          subject: b.subject,
          body: b.body,
          counselorName: request.profile.full_name ?? null,
          firstName: recipient?.fullName.split(/\s+/)[0] ?? null,
        });

        const result = await sendEmail({
          to: row.to_email as string,
          subject: b.subject,
          html: brandedEmail(template),
          text: brandedText(template),
          template: "blast",
          student_id: (row.student_id as string | null) ?? null,
          recipient_id: (row.student_id as string | null) ?? null,
          recipient_kind: "student",
          blast_id: blastId,
          logger: request.log,
        });

        if (result.sent) delivered += 1;
        else failed += 1;

        await request.db
          .from("email_blast_recipients")
          .update({
            status: result.sent ? "sent" : "failed",
            message_delivery_id: result.deliveryId,
            error: result.error,
            sent_at: result.sent ? new Date().toISOString() : null,
          })
          .eq("id", row.id as string);
      }

      const status = failed === 0 ? "sent" : delivered === 0 ? "failed" : "partial";
      const { data: finished } = await request.db
        .from("email_blasts")
        .update({
          status,
          delivered_count: delivered,
          failed_count: failed,
          sent_at: new Date().toISOString(),
        })
        .eq("id", blastId)
        .select("*")
        .maybeSingle();

      return reply.code(201).send({
        ...toBlast((finished ?? blast) as Row),
        skipped: recipients.length - delivered - failed,
      });
    }
  );
}
