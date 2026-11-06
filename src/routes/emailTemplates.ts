/**
 * Saved email templates (demo v7, v9), one list per consultant, in two sets:
 * 'families' (Email Blast, and the Contact Pipeline's Follow-up and Contract
 * proposal, found by slug) and 'staff' (Management's blast to consultants).
 *
 * The defaults are seeded the first time a set is opened, the families set with the nine
 * seasonal drafts (a stage, a suggested month and day and the class each is for;
 * `lib/stageTemplates.ts`, migration 20261110000003). A draft's date, class and audience
 * are edited here like its text, and `POST /email-templates/stages/restore` puts back any
 * that were deleted without touching one that is there. "Save template"
 * with a subject that already exists updates that template in place, as the
 * demo does. "Create new template" asks AxIS (`POST /email-templates/draft`),
 * a real Haiku call that returns a subject and body for the counselor to edit;
 * nothing is saved or sent until they do.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { runStructured } from "../lib/anthropic.js";
import { crmError } from "../lib/crm.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { STAGE_COLUMNS, stageColumnsReady, stageUnavailable, validMonthDay } from "../lib/stageTemplates.js";

type Row = Record<string, unknown>;

const SETS = ["families", "staff"] as const;
type TemplateSet = (typeof SETS)[number];

/** Templates other surfaces reach for by name; rewrite them, don't delete them. */
const PINNED_SLUGS = new Set(["follow-up", "contract-proposal"]);

const BASE_COLUMNS = "id, template_set, slug, name, subject, body, created_at, updated_at";

/** The columns to read: the stage ones only on a database that has them, so every picker works either way. */
async function columnsFor(request: FastifyRequest): Promise<string> {
  return (await stageColumnsReady(request.db)) ? `${BASE_COLUMNS}, ${STAGE_COLUMNS}` : BASE_COLUMNS;
}

function toTemplate(r: Row) {
  return {
    id: String(r.id),
    set: String(r.template_set) as TemplateSet,
    slug: (r.slug as string | null) ?? null,
    name: String(r.name),
    subject: String(r.subject),
    body: String(r.body),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    // Seasonal drafts only (null on an everyday template, and everywhere before the migration).
    stage: (r.stage as string | null) ?? null,
    sendMonth: typeof r.send_month === "number" ? r.send_month : null,
    sendDay: typeof r.send_day === "number" ? r.send_day : null,
    classOffset: typeof r.class_offset === "number" ? r.class_offset : null,
    audience: (r.audience === "students" ? "students" : "parents") as "parents" | "students",
  };
}

async function listSet(request: FastifyRequest, set: TemplateSet) {
  const seeded = await request.db.rpc("ensure_email_templates", { p_set: set });
  if (seeded.error) throw crmError(seeded.error);
  const { data, error } = await request.db
    .from("email_templates")
    .select(await columnsFor(request))
    .eq("counselor_id", request.auth.userId)
    .eq("template_set", set)
    .order("created_at")
    .limit(200);
  if (error) throw crmError(error);
  return ((data ?? []) as unknown as Row[]).map(toTemplate);
}

const DRAFT_SYSTEM = [
  "You draft short email templates for an independent college admissions counselor.",
  "Families templates go to students and parents; staff templates go to the counselor's own colleagues.",
  "Write plainly and warmly, like a professional counselor, in 60 to 160 words.",
  "Use the literal placeholder {first} where the recipient's first name belongs (or address a group as 'Hi everyone,' / 'Hi team,'), and end with a sign-off followed by {me} on its own line.",
  "When writing to a student's parents, use the literal placeholder {student} where the student's first name belongs.",
  "Never invent specific dates, prices, school names, statistics or links; describe them generically if needed.",
  "Never write any part of a student's college essay or application prose.",
  "Return a subject line (under 80 characters) and the body as plain text with blank lines between paragraphs.",
].join(" ");

export default async function emailTemplateRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [...counselor, limit("templates:read", 120, 60)] }, async (request) => {
    const { set } = z.object({ set: z.enum(SETS).default("families") }).strict().parse(request.query);
    return listSet(request, set);
  });

  /** Save the editor as a template; the same subject updates in place. */
  app.post("/", { preHandler: [...counselor, limit("templates:write", 60, 60)] }, async (request, reply) => {
    const b = z
      .object({
        set: z.enum(SETS),
        name: z.string().trim().min(1).max(200).optional(),
        subject: z.string().trim().max(300),
        body: z.string().max(20_000),
      })
      .strict()
      .parse(request.body);
    const existing = (await listSet(request, b.set)).find((t) => t.subject.trim() === b.subject.trim() && b.subject.trim());
    const columns = await columnsFor(request);

    if (existing) {
      const { data, error } = await request.db
        .from("email_templates")
        .update({ body: b.body, ...(b.name ? { name: b.name } : {}) })
        .eq("id", existing.id)
        .select(columns)
        .single();
      if (error) throw crmError(error);
      return toTemplate(data as unknown as Row);
    }

    const { data, error } = await request.db
      .from("email_templates")
      .insert({
        counselor_id: request.auth.userId,
        template_set: b.set,
        name: b.name || b.subject || "Untitled template",
        subject: b.subject,
        body: b.body,
      })
      .select(columns)
      .single();
    if (error) throw crmError(error);
    return reply.code(201).send(toTemplate(data as unknown as Row));
  });

  /**
   * Put back any seasonal draft that was deleted. A draft that is there, edited or not, is never
   * touched, and one the counselor deleted stays deleted until they ask. Answers how many came back.
   */
  app.post("/stages/restore", { preHandler: [...counselor, limit("templates:write", 60, 60)] }, async (request) => {
    z.object({}).strict().parse(request.body ?? {});
    if (!(await stageColumnsReady(request.db))) throw stageUnavailable();
    const { data, error } = await request.db.rpc("restore_stage_templates");
    if (error) throw crmError(error);
    return { restored: typeof data === "number" ? data : 0 };
  });

  /** Rename in place, or rewrite. A seasonal draft's date, class and audience change here too. */
  app.patch("/:id", { preHandler: [...counselor, limit("templates:write", 60, 60)] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        subject: z.string().trim().max(300).optional(),
        body: z.string().max(20_000).optional(),
        sendMonth: z.number().int().min(1).max(12).optional(),
        sendDay: z.number().int().min(1).max(31).optional(),
        classOffset: z.number().int().min(0).max(3).optional(),
        audience: z.enum(["parents", "students"]).optional(),
      })
      .strict()
      .parse(request.body);
    if (Object.keys(b).length === 0) throw badRequest("Nothing to change");

    const { sendMonth, sendDay, classOffset, audience, ...text } = b;
    const stagePatch =
      sendMonth !== undefined || sendDay !== undefined || classOffset !== undefined || audience !== undefined;
    const columns = await columnsFor(request);

    if (stagePatch) {
      if (!(await stageColumnsReady(request.db))) throw stageUnavailable();
      // A month and day are valid together or not at all, so read what the other half is now.
      const { data: current, error: readError } = await request.db
        .from("email_templates")
        .select(STAGE_COLUMNS)
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .maybeSingle();
      if (readError) throw crmError(readError);
      if (!current) throw notFound("That template isn't yours");
      const now = current as Row;
      if (now.stage == null) throw badRequest("Only a seasonal draft has a date and a class");
      if (!validMonthDay(sendMonth ?? Number(now.send_month), sendDay ?? Number(now.send_day))) {
        throw badRequest("That day doesn't exist in that month");
      }
    }

    const { data, error } = await request.db
      .from("email_templates")
      .update({
        ...text,
        ...(sendMonth !== undefined ? { send_month: sendMonth } : {}),
        ...(sendDay !== undefined ? { send_day: sendDay } : {}),
        ...(classOffset !== undefined ? { class_offset: classOffset } : {}),
        ...(audience !== undefined ? { audience } : {}),
      })
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select(columns)
      .maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("That template isn't yours");
    return toTemplate(data as unknown as Row);
  });

  app.delete("/:id", { preHandler: [...counselor, limit("templates:write", 60, 60)] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params);
    const { data: row, error: readError } = await request.db
      .from("email_templates")
      .select("slug")
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (readError) throw crmError(readError);
    if (!row) throw notFound("That template isn't yours");
    if (PINNED_SLUGS.has(String((row as Row).slug ?? ""))) {
      throw conflict("The Contact Pipeline uses this template. Rewrite it instead of deleting it.");
    }
    const { error } = await request.db.from("email_templates").delete().eq("id", id);
    if (error) throw crmError(error);
    return reply.code(204).send();
  });

  /** AxIS drafts a template from a one-line prompt. Nothing is saved. */
  app.post("/draft", { preHandler: [...counselor, limit("ai:email-template", 20, 60)] }, async (request) => {
    const b = z
      .object({ set: z.enum(SETS), prompt: z.string().trim().min(3).max(500) })
      .strict()
      .parse(request.body);

    return runStructured<{ subject: string; body: string }>({
      request,
      module: "email-template",
      system: DRAFT_SYSTEM,
      prompt: [
        `Template set: ${b.set === "staff" ? "staff (to the counselor's colleagues)" : "families (to students and parents)"}.`,
        `The counselor asked for: ${b.prompt}`,
      ].join("\n"),
      toolName: "email_template",
      schema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Subject line, under 80 characters." },
          body: { type: "string", description: "Plain-text body with {first} and {me} placeholders." },
        },
        required: ["subject", "body"],
      },
      maxTokens: 800,
      validate: (value) =>
        z
          .object({ subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(4000) })
          .parse(value),
    });
  });
}
