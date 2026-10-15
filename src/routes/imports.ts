/**
 * Import pipeline routes (spec §5).
 *
 * Step 1: the held-data queue ("Ready to apply", for every counselor, never
 * behind the rollout flag), the status poll, commit and undo.
 * Step 2 (the CSV/XLSX path): start, upload, register, mapping, staging,
 * review, invitations, discard, templates. These answer 403
 * imports_not_enabled outside the rollout and 503 imports_unavailable before
 * the 20261023020001-3 migrations or without IMPORT_DATABASE_URL
 * (lib/imports/availability.ts). Handlers stay thin; the logic is in
 * src/lib/imports/.
 *
 * The browser never runs a save, undo, apply or staging itself: it asks, and
 * the work runs on the import_worker connection or through definer functions
 * that re-check access.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, hasAnthropic, hasImportWorker } from "../env.js";
import { sendEmail } from "../lib/email.js";
import { conflict, fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { assertImportsReady, step2Migrated, unavailableNow } from "../lib/imports/availability.js";
import { MAX_FILE_BYTES } from "../lib/imports/caps.js";
import { fromImportRpc } from "../lib/imports/errors.js";
import { createUploadUrl, excludeFile, loadImportRow, registerFile, startImport, UPLOAD_TYPES } from "../lib/imports/files.js";
import { sendImportInvitations } from "../lib/imports/invitations.js";
import { kickImportJob } from "../lib/imports/jobs.js";
import { savePlan, suggestPlan } from "../lib/imports/mapping.js";
import { namesMatch, normalizeName } from "../lib/imports/names.js";
import { importDetail, listImports, listTemplates } from "../lib/imports/overview.js";
import { parsePlanSchema } from "../lib/imports/plan.js";
import { importsAiEnabled, importsEnabledFor } from "../lib/imports/rollout.js";
import { reviewGroups, reviewPage, updateReview } from "../lib/imports/review.js";
import { stageImport } from "../lib/imports/stage.js";
import { limit } from "../lib/limits.js";
import { redactText } from "../lib/requestLog.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ itemId: z.string().uuid() });
const fileParam = z.object({ id: z.string().uuid(), fileId: z.string().uuid() });
const applyBody = z
  .object({
    decisions: z.record(z.string().uuid(), z.enum(["accept", "keep_old", "reject"])),
    confirmName: z.string().trim().max(200).optional(),
  })
  .strict();

const startBody = z.object({ permissionConfirmed: z.literal(true) }).strict();
const uploadBody = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(UPLOAD_TYPES),
    sizeBytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  })
  .strict();
const registerBody = z
  .object({ fileId: z.string().uuid(), path: z.string().min(3).max(600), fileName: z.string().trim().min(1).max(300) })
  .strict();
const planBody = z
  .object({
    plan: parsePlanSchema,
    saveTemplate: z.object({ name: z.string().trim().min(1).max(200) }).strict().optional(),
  })
  .strict();
const reviewQuery = z
  .object({
    section: z.enum(["summary", "groups", "changes", "suggested", "invites", "skipped", "problems"]).default("summary"),
    cursor: z.string().regex(/^\d{1,6}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const fixValue = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(10),
  z.record(z.union([z.string().max(2000), z.number(), z.array(z.string().max(200)).max(10)])),
]);
const reviewBody = z
  .object({
    changes: z.record(z.string().uuid(), z.enum(["accept", "keep_old", "reject"])).optional(),
    patterns: z.record(z.string().min(1).max(200), z.enum(["accept", "keep_old"])).optional(),
    items: z
      .record(
        z.string().uuid(),
        z.discriminatedUnion("action", [
          z.object({ action: z.literal("confirm"), studentId: z.string().uuid() }).strict(),
          z.object({ action: z.literal("skip") }).strict(),
          z.object({ action: z.literal("invite") }).strict(),
        ])
      )
      .optional(),
    fixes: z.record(z.string().uuid(), fixValue).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b.changes ?? {}).length <= 500, "At most 500 decisions at once")
  .refine((b) => Object.keys(b.patterns ?? {}).length <= 100, "At most 100 column decisions at once")
  .refine((b) => Object.keys(b.items ?? {}).length <= 500, "At most 500 rows at once")
  .refine((b) => Object.keys(b.fixes ?? {}).length <= 200, "At most 200 fixes at once");
const commitBody = z.object({ invitations: z.number().int().min(0).max(5000) }).strict();

type HeldChange = {
  id: string;
  targetTable: string;
  field: string;
  op: "set_field" | "insert_row";
  newValue: unknown;
  currentValue: unknown;
  /** "intake" when the current value is still what the student's questionnaire wrote (20261023010003). */
  currentSource?: "intake" | null;
  defaultDecision: "accept" | "keep_old";
};

type HeldEntry = {
  itemId: string;
  importId: string;
  importedName: string | null;
  studentId: string;
  studentName: string;
  studentEmail: string;
  heldUntil: string;
  jobError: unknown;
  changes: HeldChange[];
  nameMismatch: boolean;
  /** The student's GPA scale now, so a GPA is never shown without its scale. */
  gpaScale: string | null;
};

function requireWorker(): void {
  if (!hasImportWorker) throw unavailable("Imports aren't set up on this server yet");
}

async function heldQueue(request: FastifyRequest): Promise<HeldEntry[]> {
  const { data, error } = await request.db.rpc("import_held_queue");
  if (error) throw fromPostgrest(error);
  const entries = (data ?? []) as Omit<HeldEntry, "nameMismatch" | "gpaScale">[];
  const ids = [...new Set(entries.map((e) => e.studentId))];
  const scales = new Map<string, string | null>();
  // Best effort under RLS: a scale the counselor can't read shows as unknown.
  for (let i = 0; i < ids.length; i += 100) {
    const { data: rows } = await request.db.from("student_academics").select("student_id, gpa_scale").in("student_id", ids.slice(i, i + 100));
    for (const r of (rows ?? []) as Row[]) scales.set(String(r.student_id), (r.gpa_scale as string | null) ?? null);
  }
  return entries.map((e) => ({
    ...e,
    nameMismatch: e.importedName ? !namesMatch(e.importedName, e.studentName) : false,
    gpaScale: scales.get(e.studentId) ?? null,
  }));
}

function toImportStatus(r: Row) {
  return {
    id: String(r.id),
    status: String(r.status),
    committedAt: (r.committed_at as string | null) ?? null,
    undoUntil: (r.undo_until as string | null) ?? null,
    undoneAt: (r.undone_at as string | null) ?? null,
    jobError: r.job_error ?? null,
    jobResult: r.job_result ?? null,
  };
}

/** One email to Meridies when a first import's invitations wait for a check (§5.1). Counts only. */
async function notifyInviteReview(request: FastifyRequest, importId: string, count: number): Promise<void> {
  const to = env.ACCESS_REVIEW_EMAIL ?? "team@meridiesai.com";
  const lines = [
    `A counselor's first import would send ${count} invitations, so they are held for a check.`,
    `Counselor: ${request.profile.full_name ?? "(no name)"} <${request.profile.email ?? request.auth.email ?? ""}>`,
    `Import: ${importId}`,
    `To approve, as postgres: update public.roster_imports set invites_approved_at = now() where id = '${importId}';`,
  ];
  await sendEmail({
    to,
    subject: "Import invitations waiting for a check",
    html: lines.map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`).join(""),
    text: lines.join("\n"),
    template: "import-invites-review",
    recipient_kind: "counselor",
    logger: request.log,
  }).catch((err: unknown) => request.log.warn({ err: redactText(String(err)) }, "import invite review email failed"));
}

export default async function importRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  // ---- step 2: is the Import page on for this caller? ------------------------

  async function availability(request: FastifyRequest) {
    const enabled = await importsEnabledFor(request);
    const available = enabled ? (await step2Migrated(request)) && hasImportWorker : false;
    return { enabled, available, aiAvailable: available && importsAiEnabled() && hasAnthropic };
  }

  app.get("/availability", { preHandler: [...counselor] }, async (request) => availability(request));

  app.get("/", { preHandler: [...counselor, limit("imports:list", 120, 60)] }, async (request) => {
    const a = await availability(request);
    if (!a.enabled || !a.available) return { ...a, imports: [], templates: [] };
    const [imports, templates] = await Promise.all([listImports(request), listTemplates(request)]);
    return { ...a, imports, templates };
  });

  // Shares roster:import's budget (20 an hour per user) while both flows exist (§5.1).
  app.post("/", { preHandler: [...counselor, limit("roster:import", 20, 3600)] }, async (request, reply) => {
    startBody.parse(request.body);
    await assertImportsReady(request);
    return reply.code(201).send(await startImport(request));
  });

  app.post("/:id/files/upload-url", { preHandler: [...counselor, limit("imports:upload", 60, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = uploadBody.parse(request.body);
    await assertImportsReady(request);
    return createUploadUrl(request, id, body);
  });

  app.post("/:id/files", { preHandler: [...counselor, limit("imports:register", 60, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = registerBody.parse(request.body);
    await assertImportsReady(request);
    return registerFile(request, id, body);
  });

  app.delete("/:id/files/:fileId", { preHandler: [...counselor, limit("imports:exclude", 60, 60)] }, async (request) => {
    const { id, fileId } = fileParam.parse(request.params);
    await assertImportsReady(request);
    await excludeFile(request, id, fileId);
    return { excluded: true };
  });

  app.post("/:id/plan", { preHandler: [...counselor, limit("imports:plan", 30, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await assertImportsReady(request);
    return suggestPlan(request, id);
  });

  app.put("/:id/plan", { preHandler: [...counselor, limit("imports:plan-edit", 600, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = planBody.parse(request.body);
    await assertImportsReady(request);
    return savePlan(request, id, body.plan, body.saveTemplate);
  });

  app.post("/:id/stage", { preHandler: [...counselor, limit("imports:stage", 30, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await assertImportsReady(request);
    const stats = await stageImport(request, id);
    return { status: "review", stats };
  });

  app.get("/:id/review", { preHandler: [...counselor, limit("imports:review", 600, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const q = reviewQuery.parse(request.query);
    await assertImportsReady(request);
    if (q.section === "summary") {
      const imp = await loadImportRow(request, id, "id, status, source_system, stats, job_error, plan, filename, counselor_id, ai_spend_cents, expires_at, invites_held_reason, invites_approved_at");
      return { section: "summary", status: imp.status, jobError: imp.job_error ?? null, ...(await importDetail(request, imp)) };
    }
    if (q.section === "groups") return { section: "groups", groups: await reviewGroups(request, id) };
    const page = (await reviewPage(request, id, q.section, Number(q.cursor ?? 0), q.limit)) as { items: unknown[]; total: number; nextOffset: number | null };
    return { section: q.section, items: page.items, total: page.total, nextCursor: page.nextOffset === null ? null : String(page.nextOffset) };
  });

  app.patch("/:id/review", { preHandler: [...counselor, limit("imports:decide", 600, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = reviewBody.parse(request.body);
    await assertImportsReady(request);
    return { stats: await updateReview(request, id, body) };
  });

  app.post("/:id/invitations", { preHandler: [...counselor, limit("imports:invite", 30, 3600)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    // Not behind the rollout flag: a saved import's invitations must still go out.
    if (!(await step2Migrated(request))) throw unavailableNow();
    return sendImportInvitations(request, id);
  });

  app.delete("/templates/:id", { preHandler: [...counselor, limit("imports:templates", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await step2Migrated(request))) throw unavailableNow();
    const { error } = await request.db.rpc("delete_import_template", { p_template: id });
    if (error) throw fromImportRpc(error);
    return { deleted: true };
  });

  app.delete("/:id", { preHandler: [...counselor, limit("imports:discard", 30, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await step2Migrated(request))) throw unavailableNow();
    const { error } = await request.db.rpc("discard_import", { p_import: id });
    if (error?.code === "55000" && /step of the import/.test(error.message ?? "")) {
      throw conflict("Only an import that isn't saved can be discarded. Undo it instead.");
    }
    if (error) throw fromImportRpc(error);
    return { discarded: true };
  });

  // ---- step 1 ---------------------------------------------------------------

  app.get("/held", { preHandler: [...counselor, limit("imports:held", 120, 60)] }, async (request) =>
    heldQueue(request)
  );

  app.get("/:id", { preHandler: [...counselor, limit("imports:status", 600, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("roster_imports")
      .select("id, status, committed_at, undo_until, undone_at, job_error, job_result, permission_confirmed_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That import isn't on your account");
    const row = data as Row;
    const base = toImportStatus(row);
    if (!row.permission_confirmed_at || !(await step2Migrated(request))) return base;
    const full = await loadImportRow(request, id, "id, filename, source_system, expires_at, stats, plan, ai_spend_cents, counselor_id, invites_held_reason, invites_approved_at");
    return { ...base, ...(await importDetail(request, full)) };
  });

  app.post("/:id/commit", { preHandler: [...counselor, limit("imports:commit", 20, 3600)] }, async (request, reply) => {
    requireWorker();
    const { id } = idParam.parse(request.params);
    const body = request.body === undefined || request.body === null ? null : commitBody.parse(request.body);
    // Say how many invitations this will send before anything moves; the
    // RPC checks the same count again under its lock (MI001).
    const { count, error: countErr } = await request.db
      .from("import_items")
      .select("id", { count: "exact", head: true })
      .eq("import_id", id)
      .eq("match_status", "new_invite");
    if (countErr) throw fromPostgrest(countErr);
    const invites = count ?? 0;
    const confirmation = (n: number) => ({
      error: n === 1 ? "Confirm the invitation this import will send" : `Confirm the ${n} invitations this import will send`,
      code: "confirm-invitations",
      count: n,
    });
    if ((invites > 0 || body) && body?.invitations !== invites) return reply.code(409).send(confirmation(invites));

    const { error } = await request.db.rpc("request_import_commit", { p_import: id, p_invitations: body ? body.invitations : null });
    if (error) {
      if (error.code === "MI001") {
        const again = await request.db.from("import_items").select("id", { count: "exact", head: true }).eq("import_id", id).eq("match_status", "new_invite");
        return reply.code(409).send(confirmation(again.count ?? 0));
      }
      throw fromImportRpc(error);
    }
    kickImportJob("commit", id, request.auth.userId, request.log);
    if (invites > 50) {
      const { data: held } = await request.db.from("roster_imports").select("invites_held_reason").eq("id", id).maybeSingle();
      if (held?.invites_held_reason === "first-import-review") void notifyInviteReview(request, id, invites);
    }
    return reply.code(202).send({ status: "committing" });
  });

  app.post("/:id/undo", { preHandler: [...counselor, limit("imports:undo", 20, 3600)] }, async (request, reply) => {
    requireWorker();
    const { id } = idParam.parse(request.params);
    const { error } = await request.db.rpc("request_import_undo", { p_import: id });
    if (error) throw fromImportRpc(error);
    kickImportJob("undo", id, request.auth.userId, request.log);
    return reply.code(202).send({ status: "undoing" });
  });

  app.post(
    "/held/:itemId/apply",
    { preHandler: [...counselor, limit("imports:apply", 120, 3600)] },
    async (request, reply) => {
      requireWorker();
      const { itemId } = itemParam.parse(request.params);
      const body = applyBody.parse(request.body);

      const entry = (await heldQueue(request)).find((e) => e.itemId === itemId);
      if (!entry) throw notFound("That data is no longer waiting to be applied");
      // Dismissing (every change rejected) writes nothing, so it needs no typed name.
      const dismiss = entry.changes.length > 0 && entry.changes.every((c) => body.decisions[c.id] === "reject");
      if (entry.nameMismatch && !dismiss) {
        // A guard against mistakes, not a security boundary: request_held_apply
        // is also reachable directly by the same authorized manager.
        const want = normalizeName(entry.studentName);
        const typed = want ? normalizeName(body.confirmName ?? "") : (body.confirmName ?? "").trim().toLocaleLowerCase();
        const expected = want || entry.studentName.trim().toLocaleLowerCase();
        if (typed === "" || typed !== expected) {
          const sentence = `The account is ${entry.studentName}, but the file says ${entry.importedName}. Type ${entry.studentName} to confirm.`;
          // `error` is the shape every client reads; `message` stays for older callers.
          return reply.code(409).send({ error: sentence, code: "name-confirmation-required", message: sentence });
        }
      }

      const { error } = await request.db.rpc("request_held_apply", { p_item: itemId, p_decisions: body.decisions });
      if (error) throw fromImportRpc(error);
      kickImportJob("apply", itemId, request.auth.userId, request.log);
      return reply.code(202).send({ status: "applying" });
    }
  );
}
