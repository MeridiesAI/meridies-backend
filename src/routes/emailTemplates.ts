/**
 * Saved email templates (demo v7, v9), one list per consultant, in two sets:
 * 'families' (Email Blast, and the Contact Pipeline's Follow-up and Contract
 * proposal, found by slug) and 'staff' (Management's blast to consultants).
 *
 * The defaults are seeded the first time a set is opened. "Save template"
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

type Row = Record<string, unknown>;

const SETS = ["families", "staff"] as const;
type TemplateSet = (typeof SETS)[number];

/** Templates other surfaces reach for by name; rewrite them, don't delete them. */
const PINNED_SLUGS = new Set(["follow-up", "contract-proposal"]);

const COLUMNS = "id, template_set, slug, name, subject, body, created_at, updated_at";

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
  };
}

async function listSet(request: FastifyRequest, set: TemplateSet) {
  const seeded = await request.db.rpc("ensure_email_templates", { p_set: set });
  if (seeded.error) throw crmError(seeded.error);
  const { data, error } = await request.db
    .from("email_templates")
    .select(COLUMNS)
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

    if (existing) {
      const { data, error } = await request.db
        .from("email_templates")
        .update({ body: b.body, ...(b.name ? { name: b.name } : {}) })
        .eq("id", existing.id)
        .select(COLUMNS)
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
      .select(COLUMNS)
      .single();
    if (error) throw crmError(error);
    return reply.code(201).send(toTemplate(data as unknown as Row));
  });

  /** Rename in place, or rewrite. */
  app.patch("/:id", { preHandler: [...counselor, limit("templates:write", 60, 60)] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        subject: z.string().trim().max(300).optional(),
        body: z.string().max(20_000).optional(),
      })
      .strict()
      .parse(request.body);
    if (Object.keys(b).length === 0) throw badRequest("Nothing to change");
    const { data, error } = await request.db
      .from("email_templates")
      .update(b)
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .select(COLUMNS)
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
