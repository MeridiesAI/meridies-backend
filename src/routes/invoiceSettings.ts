/**
 * The invoice composer's practice settings (migration 20261124000003, lib/invoiceSettings.ts):
 *
 *   GET    /pipeline/invoice-options          { composerReady, textAvailable, cardFeeEnabled, canEdit }
 *   GET    /pipeline/payment-methods          { methods, canEdit }  (built-ins seeded on an admin's first read)
 *   PUT    /pipeline/payment-methods          { methods: [{ key, label?, instructions?, enabled?, sort? }] } -> the list
 *   POST   /pipeline/payment-methods          { label, instructions? } -> a custom method (201)
 *   DELETE /pipeline/payment-methods/:key     a custom method (409 builtin_method for a built-in)
 *   GET    /pipeline/invoice-style            { style, fonts, canEdit }
 *   PUT    /pipeline/invoice-style            a partial style -> { style }
 *   GET    /pipeline/package-templates        ?includeArchived=true -> { templates, canEdit }
 *   POST   /pipeline/package-templates        -> 201 template
 *   PUT    /pipeline/package-templates/:id    the fields (and `archived`) -> template
 *   DELETE /pipeline/package-templates/:id    archives it (families set up from it keep their package)
 *
 * Counselors only. Everyone in the practice reads; only a firm owner/admin or the solo counselor writes
 * (403 otherwise, and RLS says the same). Without the migration every route answers 503
 * `invoice_settings_unavailable`, and the invoice flow is what it was.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { cardFeeEnabled } from "../lib/invoiceCardFee.js";
import { loadWorkspace, type Workspace } from "../lib/crm.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { DEFAULT_STYLE, FONT_KEYS, FONTS, styleColumns, styleFields, toStyle } from "../lib/invoiceStyle.js";
import { settingsError, virtualMethods } from "../lib/invoiceSettings.js";
import { limit } from "../lib/limits.js";
import { templateFields, templateProblem, toTemplateDTO } from "../lib/packageTemplates.js";
import {
  builtinRows,
  isCustomKey,
  MAX_CUSTOM_METHODS,
  methodInstructions,
  methodLabel,
  newCustomKey,
  toMethodDTO,
  type PaymentMethodDTO,
} from "../lib/paymentMethods.js";
import { textingAvailable } from "../lib/invoiceTexting.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() }).strict();
const keyParam = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/) }).strict();

function scopeOf(request: FastifyRequest, ws: Workspace) {
  return { firm_id: ws.firmId, counselor_id: request.auth.userId, practice_id: ws.firmId ?? request.auth.userId };
}

function requireAdmin(ws: Workspace): void {
  if (!ws.isAdmin) throw forbidden("Only a firm owner or admin can change the practice's invoice settings");
}

export default async function invoiceSettingsRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const read = (name: string) => [...counselor, limit(name, 120, 60)];
  const write = (name: string) => [...counselor, limit(name, 60, 60)];

  app.get("/invoice-options", { preHandler: read("invoice-settings:options") }, async (request) => {
    const ws = await loadWorkspace(request);
    const probe = await request.db.from("practice_payment_methods").select("id").limit(0);
    return {
      composerReady: !probe.error,
      textAvailable: await textingAvailable(request.auth.userId),
      cardFeeEnabled: cardFeeEnabled(),
      canEdit: ws.isAdmin,
    };
  });

  // ---- Payment methods -------------------------------------------------------------------

  async function methodRows(request: FastifyRequest, ws: Workspace): Promise<PaymentMethodDTO[]> {
    const scope = scopeOf(request, ws);
    const list = () => request.db.from("practice_payment_methods").select("*").eq("practice_id", scope.practice_id).order("sort").order("created_at").limit(100);
    let { data, error } = await list();
    if (error) throw settingsError(error);
    if ((data ?? []).length === 0) {
      // First read: an admin seeds the five built-ins; anyone else sees them unsaved until then.
      if (!ws.isAdmin) return virtualMethods();
      const ins = await request.db.from("practice_payment_methods").upsert(builtinRows(scope), { onConflict: "practice_id,key", ignoreDuplicates: true });
      if (ins.error) throw settingsError(ins.error);
      ({ data, error } = await list());
      if (error) throw settingsError(error);
    }
    return ((data ?? []) as Row[]).map(toMethodDTO);
  }

  app.get("/payment-methods", { preHandler: read("invoice-settings:methods") }, async (request) => {
    const ws = await loadWorkspace(request);
    return { methods: await methodRows(request, ws), canEdit: ws.isAdmin };
  });

  app.put("/payment-methods", { preHandler: write("invoice-settings:methods-write") }, async (request) => {
    const b = z
      .object({
        methods: z
          .array(
            z
              .object({
                key: keyParam.shape.key,
                label: methodLabel.optional(),
                instructions: methodInstructions.optional(),
                enabled: z.boolean().optional(),
                sort: z.number().int().min(0).max(1000).optional(),
              })
              .strict()
          )
          .min(1)
          .max(60),
      })
      .strict()
      .parse(request.body);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    const current = await methodRows(request, ws);
    const byKey = new Map(current.map((m) => [m.key, m]));
    for (const m of b.methods) {
      const have = byKey.get(m.key);
      if (!have) throw notFound(`There's no payment method "${m.key}"`);
      if (m.label !== undefined && have.builtin && m.label !== have.label) throw badRequest("A built-in method keeps its name; add a custom one instead");
      if (m.key === "card" && m.instructions) throw badRequest("Card payments go through Stripe and take no instructions");
    }
    for (const m of b.methods) {
      const patch: Record<string, unknown> = {};
      if (m.label !== undefined) patch.label = m.label;
      if (m.instructions !== undefined) patch.instructions = m.instructions;
      if (m.enabled !== undefined) patch.enabled = m.enabled;
      if (m.sort !== undefined) patch.sort = m.sort;
      if (Object.keys(patch).length === 0) continue;
      const { error } = await request.db.from("practice_payment_methods").update(patch).eq("practice_id", ws.firmId ?? request.auth.userId).eq("key", m.key);
      if (error) throw settingsError(error);
    }
    return { methods: await methodRows(request, ws), canEdit: true };
  });

  app.post("/payment-methods", { preHandler: write("invoice-settings:methods-write") }, async (request, reply) => {
    const b = z.object({ label: methodLabel, instructions: methodInstructions.default("") }).strict().parse(request.body);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    const current = await methodRows(request, ws);
    if (current.filter((m) => !m.builtin).length >= MAX_CUSTOM_METHODS) throw conflict(`A practice can have at most ${MAX_CUSTOM_METHODS} custom payment methods`);
    if (current.some((m) => m.label.toLowerCase() === b.label.toLowerCase())) throw conflict("You already have a payment method with that name");
    const { data, error } = await request.db
      .from("practice_payment_methods")
      .insert({ ...scopeOf(request, ws), key: newCustomKey(), label: b.label, instructions: b.instructions, builtin: false, sort: current.length + 1 })
      .select("*")
      .single();
    if (error) throw settingsError(error);
    return reply.code(201).send(toMethodDTO(data as Row));
  });

  app.delete("/payment-methods/:key", { preHandler: write("invoice-settings:methods-write") }, async (request) => {
    const { key } = keyParam.parse(request.params);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    if (!isCustomKey(key)) throw new HttpError(409, "A built-in method can be switched off, not removed", "builtin_method");
    const { data, error } = await request.db
      .from("practice_payment_methods")
      .delete()
      .eq("practice_id", ws.firmId ?? request.auth.userId)
      .eq("key", key)
      .select("key");
    if (error) throw settingsError(error);
    if (!data || data.length === 0) throw notFound("There's no such payment method");
    return { ok: true };
  });

  // ---- Invoice style ---------------------------------------------------------------------------

  const fonts = FONT_KEYS.map((k) => ({ key: k, label: FONTS[k].label, stack: FONTS[k].stack }));

  app.get("/invoice-style", { preHandler: read("invoice-settings:style") }, async (request) => {
    const ws = await loadWorkspace(request);
    const { data, error } = await request.db.from("practice_invoice_style").select("*").eq("practice_id", ws.firmId ?? request.auth.userId).maybeSingle();
    if (error) throw settingsError(error);
    return { style: data ? toStyle(data as Row) : { ...DEFAULT_STYLE }, fonts, canEdit: ws.isAdmin };
  });

  app.put("/invoice-style", { preHandler: write("invoice-settings:style-write") }, async (request) => {
    const b = z.object(styleFields).partial().strict().parse(request.body);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    const scope = scopeOf(request, ws);
    // Select, then update or insert: an upsert would also write the scope columns, which a client can't update.
    const existing = await request.db.from("practice_invoice_style").select("practice_id").eq("practice_id", scope.practice_id).maybeSingle();
    if (existing.error) throw settingsError(existing.error);
    const { data, error } = existing.data
      ? await request.db.from("practice_invoice_style").update(styleColumns(b)).eq("practice_id", scope.practice_id).select("*").single()
      : await request.db.from("practice_invoice_style").insert({ ...scope, ...styleColumns(b) }).select("*").single();
    if (error) throw settingsError(error);
    return { style: toStyle(data as Row), fonts, canEdit: true };
  });

  // ---- Package templates -------------------------------------------------------------------------

  const templateBody = z
    .object({ ...templateFields, archived: z.boolean().optional() })
    .strict()
    .superRefine((t, ctx) => {
      const problem = templateProblem({ totalCents: t.totalCents, depositCents: t.depositCents ?? 0, installments: t.installments });
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["depositCents"] });
    });

  const templateRow = (b: Omit<z.infer<typeof templateBody>, "archived">) => ({
    name: b.name,
    years_tag: b.yearsTag?.trim() || null,
    total_cents: b.totalCents,
    deposit_cents: b.depositCents ?? 0,
    installments: b.installments,
    duration_months: b.durationMonths ?? null,
    inclusions: b.inclusions ?? [],
  });

  app.get("/package-templates", { preHandler: read("invoice-settings:templates") }, async (request) => {
    const q = z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict().parse(request.query);
    const ws = await loadWorkspace(request);
    let query = request.db.from("pipeline_package_templates").select("*").eq("practice_id", ws.firmId ?? request.auth.userId);
    if (q.includeArchived !== "true") query = query.is("archived_at", null);
    const { data, error } = await query.order("created_at").limit(200);
    if (error) throw settingsError(error);
    return { templates: ((data ?? []) as Row[]).map(toTemplateDTO), canEdit: ws.isAdmin };
  });

  app.post("/package-templates", { preHandler: write("invoice-settings:templates-write") }, async (request, reply) => {
    const b = templateBody.parse(request.body);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    const { data, error } = await request.db.from("pipeline_package_templates").insert({ ...scopeOf(request, ws), ...templateRow(b) }).select("*").single();
    if (error) throw settingsError(error);
    return reply.code(201).send(toTemplateDTO(data as Row));
  });

  app.put("/package-templates/:id", { preHandler: write("invoice-settings:templates-write") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = templateBody.parse(request.body);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    const { archived, ...fields } = b;
    const { data, error } = await request.db
      .from("pipeline_package_templates")
      .update({ ...templateRow(fields), ...(archived !== undefined ? { archived_at: archived ? new Date().toISOString() : null } : {}) })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw settingsError(error);
    if (!data) throw notFound("No package of yours matches that");
    return toTemplateDTO(data as Row);
  });

  app.delete("/package-templates/:id", { preHandler: write("invoice-settings:templates-write") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const ws = await loadWorkspace(request);
    requireAdmin(ws);
    const { data, error } = await request.db.from("pipeline_package_templates").update({ archived_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    if (error) throw settingsError(error);
    if (!data) throw notFound("No package of yours matches that");
    return toTemplateDTO(data as Row);
  });
}

