/**
 * The column mapping (spec §5.3): a saved template by header fingerprint,
 * then header presets, then the AI fallback for what is left (when the kill
 * switch and the practice allow it, and under the 200-cent cap). Every plan
 * is stored through import_set_plan on the worker, after validatePlan.
 *
 * withWorkerTransaction runs inside an approved counselor's own request,
 * with p_actor = that counselor; the SQL re-checks can_manage_import.
 */

import type { FastifyRequest } from "fastify";
import { hasAnthropic } from "../../env.js";
import { conflict, fromPostgrest } from "../errors.js";
import { aiPlan } from "./aiPlan.js";
import { withWorkerTransaction } from "./db.js";
import { fromImportRpc } from "./errors.js";
import { loadFields } from "./fields.js";
import { loadImportRow } from "./files.js";
import {
  planFromTemplate, templateFrom, templatePlanSchema, validatePlan,
  type Forced, type ParsePlan, type PlanSheet, type ProfiledFile, type SourceSystem,
} from "./plan.js";
import { detectSourceSystem, presetSheet, unmappedColumns } from "./presets.js";
import type { FileProfile } from "./profile.js";
import { importsAiEnabled } from "./rollout.js";

type Row = Record<string, unknown>;

export type PlanSource = "template" | "preset" | "ai" | "manual";
export type PlanAnswer = { plan: ParsePlan; source: PlanSource; reason: string | null; templateName: string | null; forced: Forced[]; problems: string[] };

export async function profiledFiles(request: FastifyRequest, importId: string): Promise<ProfiledFile[]> {
  const { data, error } = await request.db
    .from("import_files")
    .select("id, filename, profile, status")
    .eq("import_id", importId)
    .eq("status", "profiled")
    .order("created_at");
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[])
    .filter((r) => r.profile && typeof r.profile === "object")
    .map((r) => ({ fileId: String(r.id), filename: String(r.filename), profile: r.profile as FileProfile }));
}

async function setPlan(request: FastifyRequest, importId: string, plan: ParsePlan, templateId: string | null): Promise<void> {
  await withWorkerTransaction((c) =>
    c.query("select public.import_set_plan($1, $2, $3, $4, $5)", [importId, request.auth.userId, plan, plan.sourceSystem, templateId])
  ).catch((err: unknown) => {
    throw fromImportRpc(err as { code?: string; message?: string });
  });
}

async function addSpend(request: FastifyRequest, importId: string, cents: number): Promise<number> {
  return withWorkerTransaction(async (c) => {
    const { rows } = await c.query("select public.import_add_ai_spend($1, $2, $3) as total", [importId, request.auth.userId, cents]);
    return Number(rows[0].total);
  });
}

export async function suggestPlan(request: FastifyRequest, importId: string): Promise<PlanAnswer> {
  const imp = await loadImportRow(request, importId, "id, status, ai_spend_cents");
  // Not from review: a fresh suggestion would throw away what was staged and
  // decided. Changing the mapping then is PUT /plan, which the app confirms.
  if (!["draft", "mapping"].includes(String(imp.status))) throw conflict("Change the mapping instead of starting it again");
  const files = await profiledFiles(request, importId);
  if (files.length === 0) throw conflict("Add a file that can be read first");
  const fields = await loadFields(request);

  const { data: templates, error } = await request.db
    .from("import_templates")
    .select("id, name, source_system, fingerprint, parse_plan")
    .eq("counselor_id", request.auth.userId)
    .in("fingerprint", files.map((f) => f.profile.fingerprint));
  if (error) throw fromPostgrest(error);

  const sheets: PlanSheet[] = [];
  let template: Row | null = null;
  const untemplated: ProfiledFile[] = [];
  for (const file of files) {
    const t = ((templates ?? []) as Row[]).find((x) => x.fingerprint === file.profile.fingerprint);
    const parsed = t ? templatePlanSchema.safeParse(t.parse_plan) : null;
    const applied = parsed?.success ? planFromTemplate(parsed.data, file) : null;
    if (t && applied) {
      template ??= t;
      sheets.push(...applied);
    } else {
      untemplated.push(file);
      sheets.push(...file.profile.sheets.map((s) => presetSheet(file.fileId, s)));
    }
  }
  const templatePlan = template ? templatePlanSchema.parse(template.parse_plan) : null;
  const headers = files.flatMap((f) => f.profile.sheets.flatMap((s) => s.columns.map((c) => c.header)));
  let plan: ParsePlan = {
    version: 1,
    sheets,
    constants: templatePlan?.constants ?? {},
    sourceSystem: (templatePlan?.sourceSystem ?? detectSourceSystem(headers)) as SourceSystem,
  };

  let reason: string | null = null;
  let usedAi = false;
  const unmapped = unmappedColumns(plan, untemplated);
  if (unmapped.length > 0 && importsAiEnabled() && hasAnthropic) {
    const ai = await aiPlan(request, unmapped, fields, {
      addSpend: (cents) => addSpend(request, importId, cents),
      spent: Number(imp.ai_spend_cents ?? 0),
    });
    if (ai.manual) reason = ai.reason;
    else {
      for (const a of ai.columns) {
        const s = plan.sheets.find((x) => x.fileId === a.fileId && x.sheet === a.sheet);
        if (s && !s.columns.some((c) => c.index === a.column.index)) {
          s.columns.push(a.column);
          usedAi = true;
        }
      }
      if (plan.sourceSystem === "unknown" && ai.sourceSystem) plan = { ...plan, sourceSystem: ai.sourceSystem };
    }
  }

  const check = validatePlan(plan, files, fields);
  await setPlan(request, importId, check.plan, template ? String(template.id) : null);
  const anyMapped = check.plan.sheets.some((s) => s.columns.some((c) => c.target.kind !== "ignore"));
  const source: PlanSource = usedAi ? "ai" : untemplated.length === 0 ? "template" : anyMapped ? "preset" : "manual";
  request.log.info({ importId, source, columns: check.plan.sheets.reduce((n, s) => n + s.columns.length, 0) }, "import plan suggested");
  return {
    plan: check.plan,
    source,
    reason,
    templateName: template ? String(template.name) : null,
    forced: check.forced,
    problems: check.problems,
  };
}

/**
 * The counselor's own mapping (every edit autosaves here). A plan that isn't
 * finished yet is still stored, with its problems; staging refuses until
 * there are none. "Remember this layout" saves one template per file.
 */
export async function savePlan(
  request: FastifyRequest,
  importId: string,
  input: ParsePlan,
  saveTemplate: { name: string } | undefined
): Promise<{ plan: ParsePlan; forced: Forced[]; problems: string[]; templateSaved: boolean }> {
  const imp = await loadImportRow(request, importId, "id, status, template_id");
  if (!["draft", "mapping", "review"].includes(String(imp.status))) throw conflict("That can't be done at this step of the import");
  const files = await profiledFiles(request, importId);
  const fields = await loadFields(request);
  const check = validatePlan(input, files, fields);
  let templateId = (imp.template_id as string | null) ?? null;
  if (saveTemplate) {
    const ids = await withWorkerTransaction(async (c) => {
      const out: string[] = [];
      for (const file of files) {
        if (!check.plan.sheets.some((s) => s.fileId === file.fileId)) continue;
        const { rows } = await c.query("select public.import_save_template($1, $2, $3, $4, $5) as id", [
          request.auth.userId, saveTemplate.name, check.plan.sourceSystem, file.profile.fingerprint, templateFrom(check.plan, file),
        ]);
        out.push(String(rows[0].id));
      }
      return out;
    }).catch((err: unknown) => {
      throw fromImportRpc(err as { code?: string; message?: string });
    });
    templateId = ids[0] ?? templateId;
  }
  await setPlan(request, importId, check.plan, templateId);
  return { plan: check.plan, forced: check.forced, problems: check.problems, templateSaved: Boolean(saveTemplate) };
}
