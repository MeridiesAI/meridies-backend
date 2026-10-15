/**
 * A student's College list and Application sections (v8-v10), which an alum's
 * page reads too (read-only, no tools). Where an alum went is the overview
 * area's /alumni/:id. Registered under /application.
 *
 *   College list   GET/POST /college-list, PATCH/DELETE /college-list/:id,
 *                  the Recommended column under /college-list/recommendations
 *   Essays         GET /essays, POST /essays, PATCH/DELETE /essays/:id,
 *                  POST /essays/from-document, POST /essays/sync,
 *                  POST /supplement-docs (a real Google Doc per school)
 *   Sheets         GET /sheets, CRUD /activities and /honors
 *
 * The AI pieces (AxIS recommended schools, Narrative Coherence, Activities
 * Build) live in routes/applicationAi.ts under the same prefix.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerCollection } from "../lib/collection.js";
import { readDocumentText } from "../lib/documentText.js";
import { loadCollegePhotos } from "../lib/collegePhotos.js";
import { badRequest, conflict, forbidden, fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { getRemoteFile, exportGoogleDocText } from "../lib/suiteApi.js";
import {
  catalogDeadline,
  ESSAY_SELECT,
  GRADES,
  initialsOf,
  LIST_SELECT,
  RECOGNITION,
  STAGE_STATUS,
  TIMINGS,
  toEssayDoc,
  toListCollege,
  toRecommendation,
  toSheetActivity,
  toSheetHonor,
  toSupplementDoc,
  toSupplementPrompt,
  UC_CATEGORIES,
  UC_LEVELS,
} from "../lib/studentApplication.js";
import {
  createSupplementDoc,
  currentCycle,
  docTitle,
  exportDocText,
  googleDocIdFromUrl,
  splitAnswers,
  type DocPrompt,
} from "../lib/supplementDocs.js";

type Row = Record<string, unknown>;

const uuid = z.string().uuid();
const studentQuery = z.object({ studentId: uuid.optional() });
const idParam = z.object({ id: uuid });
const trimmed = (max: number) => z.string().trim().max(max);

const ROUNDS = ["ED", "ED2", "EA", "REA", "SCEA", "RD", "rolling", "priority"] as const;
const STATUSES = [
  "not-started", "in-progress", "submitted", "accepted", "denied",
  "waitlisted", "deferred", "enrolled", "withdrawn",
] as const;
const DECISIONS = new Set(["accepted", "denied", "waitlisted", "deferred", "enrolled", "withdrawn"]);
const STAGES = ["interested", "applying", "applied"] as const;
const FITS = ["reach", "target", "likely"] as const;
const TESTING = ["required", "optional", "flexible", "blind"] as const;

const MAX_SHEET_ROWS = 30;

// ---- shared reads ----------------------------------------------------------------

async function supplementCounts(request: FastifyRequest, collegeIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (collegeIds.length === 0) return out;
  const { data, error } = await request.db
    .from("college_supplements")
    .select("college_id")
    .in("college_id", collegeIds)
    .eq("admission_cycle", currentCycle());
  if (error) throw fromPostgrest(error);
  for (const r of data ?? []) {
    const id = String((r as Row).college_id);
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

async function listRows(request: FastifyRequest, studentId: string): Promise<Row[]> {
  const { data, error } = await request.db
    .from("student_colleges")
    .select(LIST_SELECT)
    .eq("student_id", studentId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw fromPostgrest(error);
  return (data ?? []) as Row[];
}

async function loadListRow(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db.from("student_colleges").select(LIST_SELECT).eq("id", id).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That school isn't on the list");
  return data as Row;
}

/**
 * Every path that answers with list rows (the board, add, update, accept a
 * recommendation) loads photos the same way, so a row the app swaps in
 * after an edit keeps its photo. The photo read never throws.
 */
async function serializeOne(request: FastifyRequest, row: Row) {
  const ids = row.college_id ? [String(row.college_id)] : [];
  const [counts, photos] = await Promise.all([supplementCounts(request, ids), loadCollegePhotos(request.db, ids, request.log)]);
  return toListCollege(row, counts, photos);
}

/** The student's name and email, for a Doc's title and who it is shared with. */
async function studentContact(request: FastifyRequest, studentId: string): Promise<{ name: string; email: string | null }> {
  const { data } = await request.db.from("profiles").select("full_name, email").eq("id", studentId).maybeSingle();
  if (!data) throw notFound("That student isn't on your roster");
  return { name: String(data.full_name ?? "Student"), email: (data.email as string | null) ?? null };
}

const isStudent = (request: FastifyRequest) => request.profile.role === "student";

/**
 * Put a school on a list. Used by "Add" and by accepting a recommendation, so
 * both dedupe the same way: by catalog identity, then by name.
 */
export async function addToList(
  request: FastifyRequest,
  studentId: string,
  input: {
    collegeId?: string | null;
    name?: string | null;
    round?: (typeof ROUNDS)[number] | null;
    fit?: (typeof FITS)[number] | null;
    status?: (typeof STATUSES)[number];
    intendedMajor?: string | null;
    deadline?: string | null;
  }
): Promise<Row> {
  let catalog: Row | null = null;
  if (input.collegeId) {
    const { data, error } = await request.db
      .from("colleges")
      .select("id, name, initials, brand_color, deadlines")
      .eq("id", input.collegeId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That college isn't in the catalog");
    catalog = data as Row;
  }
  const name = (catalog ? String(catalog.name) : (input.name ?? "")).trim();
  if (!name) throw badRequest("Name the school");

  const existing = await request.db
    .from("student_colleges")
    .select("id, college_id, name")
    .eq("student_id", studentId)
    .limit(200);
  if (existing.error) throw fromPostgrest(existing.error);
  const clash = (existing.data ?? []).find(
    (r) =>
      (catalog && r.college_id === catalog.id) || String(r.name).trim().toLowerCase() === name.toLowerCase()
  );
  if (clash) throw conflict("That school is already on the list");

  const round = input.round ?? "RD";
  const maxOrder = (existing.data ?? []).length;
  const insert: Row = {
    student_id: studentId,
    college_id: catalog ? catalog.id : null,
    name,
    initials: catalog?.initials ?? initialsOf(name),
    brand_color: catalog?.brand_color ?? null,
    round,
    status: input.status ?? "not-started",
    deadline: input.deadline ?? (catalog ? catalogDeadline(catalog.deadlines, round) : null),
    intended_major: input.intendedMajor ?? null,
    added_by: request.auth.userId,
    sort_order: Math.min(maxOrder, 999),
  };
  // Fit is the counselor's call (the database refuses it from a student too).
  if (!isStudent(request) && input.fit) insert.fit = input.fit;

  const { data, error } = await request.db.from("student_colleges").insert(insert).select(LIST_SELECT).single();
  if (error) throw fromPostgrest(error);
  return data as Row;
}

/** Record that a draft moved, as records.ts does: the accountability engine reads it. */
async function logEssayProgress(request: FastifyRequest, studentId: string, row: Row, action: "insert" | "update") {
  const words = Number(row.word_count ?? 0);
  await request.db.from("progress_events").insert({
    student_id: studentId,
    entity_type: "essay",
    entity_id: row.id as string,
    event: action === "insert" ? "created" : "word-count-changed",
    word_count: words,
    actor_id: request.auth.userId,
  });
  await request.db
    .from("deliverables")
    .update({ current_words: words, last_activity_at: new Date().toISOString() })
    .eq("essay_id", row.id as string);
}

function essayDto(request: FastifyRequest, row: Row) {
  const dto = toEssayDoc(row);
  return { ...dto, linkIsMine: row.link_owner_id === request.auth.userId };
}

// ---- bodies ----------------------------------------------------------------------

const addCollegeBody = z
  .object({
    studentId: uuid,
    collegeId: uuid.nullable().optional(),
    name: trimmed(300).nullable().optional(),
    round: z.enum(ROUNDS).nullable().optional(),
    fit: z.enum(FITS).nullable().optional(),
    stage: z.enum(STAGES).optional(),
    intendedMajor: trimmed(200).nullable().optional(),
  })
  .strict();

const patchCollegeBody = z
  .object({
    round: z.enum(ROUNDS).nullable(),
    fit: z.enum(FITS).nullable(),
    status: z.enum(STATUSES),
    stage: z.enum(STAGES),
    deadline: z.string().date().nullable(),
    customDeadline: z.string().date().nullable(),
    intendedMajor: trimmed(200).nullable(),
    recsRequired: z.number().int().min(0).max(10).nullable(),
    recsInHand: z.number().int().min(0).max(10).nullable(),
    testing: z.enum(TESTING).nullable(),
    applicationFeeCents: z.number().int().min(0).max(100000).nullable(),
    binding: z.boolean(),
    notes: trimmed(4000).nullable(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .partial()
  .strict();

const recommendBody = z
  .object({
    studentId: uuid,
    collegeId: uuid.nullable().optional(),
    name: trimmed(300).nullable().optional(),
    fit: z.enum(FITS).nullable().optional(),
    why: trimmed(600).nullable().optional(),
  })
  .strict();

const essayCreateBody = z
  .object({
    studentId: uuid,
    essayKind: z.enum(["personal-statement", "supplement", "other"]).optional(),
    title: trimmed(300).nullable().optional(),
    prompt: trimmed(2000).nullable().optional(),
    studentCollegeId: uuid.nullable().optional(),
    collegeSupplementId: uuid.nullable().optional(),
    wordLimit: z.number().int().min(1).max(20000).nullable().optional(),
    body: z.string().max(60_000).nullable().optional(),
    externalUrl: z.string().trim().url().max(2000).startsWith("https://").nullable().optional(),
    status: z.enum(["not-started", "drafting", "review", "final"]).optional(),
    dueDate: z.string().date().nullable().optional(),
  })
  .strict();

const essayPatchBody = z
  .object({
    essayKind: z.enum(["personal-statement", "supplement", "other"]),
    title: trimmed(300),
    prompt: trimmed(2000).nullable(),
    studentCollegeId: uuid.nullable(),
    wordLimit: z.number().int().min(1).max(20000).nullable(),
    body: z.string().max(60_000).nullable(),
    externalUrl: z.string().trim().url().max(2000).startsWith("https://").nullable(),
    status: z.enum(["not-started", "drafting", "review", "final"]),
    dueDate: z.string().date().nullable(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .partial()
  .strict();

const fromDocumentBody = z
  .object({
    studentId: uuid,
    documentId: uuid,
    essayKind: z.enum(["personal-statement", "supplement", "other"]).optional(),
    studentCollegeId: uuid.nullable().optional(),
    collegeSupplementId: uuid.nullable().optional(),
    title: trimmed(300).nullable().optional(),
  })
  .strict();

// Sheet bodies, snake_case like every registerCollection body. Every field can
// be cleared, so a cell edited back to empty saves as empty.
const activityBody = z
  .object({
    category: trimmed(100).nullable(),
    grade_levels: z.array(z.enum(GRADES)).max(5),
    timing: z.array(z.enum(TIMINGS)).max(1),
    hours_per_week: z.number().min(0).max(168).nullable(),
    weeks_per_year: z.number().int().min(0).max(52).nullable(),
    continuing: z.boolean().nullable(),
    position: z.string().max(300).nullable(),
    organization: z.string().max(300).nullable(),
    description: z.string().max(2000).nullable(),
    uc_category: z.enum(UC_CATEGORIES).nullable(),
    uc_org_description: z.string().max(2000).nullable(),
    uc_description: z.string().max(2000).nullable(),
    sort_order: z.number().int().min(0).max(999),
  })
  .partial()
  .strict();

const honorBody = z
  .object({
    name: z.string().trim().max(300).nullable().transform((v) => (v ? v : null)),
    grade_levels: z.array(z.enum(GRADES)).max(5),
    recognition_levels: z.array(z.enum(RECOGNITION)).max(4),
    uc_type: z.enum(["academic", "non-academic"]).nullable(),
    uc_level: z.enum(UC_LEVELS).nullable(),
    uc_criteria: z.string().max(2000).nullable(),
    uc_earned: z.string().max(2000).nullable(),
    sort_order: z.number().int().min(0).max(999),
  })
  .partial()
  .strict();

function capRows(table: "activities" | "awards") {
  return async (request: FastifyRequest, studentId: string, values: Row, action: "insert" | "update") => {
    // On the sheet the organization is the activity's name; older readers
    // (the AI brief, the profile) still read `name`, so keep the two together.
    if (table === "activities" && values.organization !== undefined) {
      const org = typeof values.organization === "string" ? values.organization.trim() : "";
      values.name = org ? org.slice(0, 300) : null;
    }
    if (action !== "insert") return;
    const { count, error } = await request.db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("student_id", studentId);
    if (error) throw fromPostgrest(error);
    if ((count ?? 0) >= MAX_SHEET_ROWS) throw badRequest(`A sheet holds at most ${MAX_SHEET_ROWS} rows`);
  };
}

export default async function applicationRoutes(app: FastifyInstance) {
  // ==== College list ============================================================

  app.get(
    "/college-list",
    { preHandler: [app.authenticate, limit("application:college-list", 240, 60)] },
    async (request) => {
      const q = studentQuery.parse(request.query);
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const rows = await listRows(request, studentId);
      const collegeIds = rows.map((r) => r.college_id).filter((v): v is string => typeof v === "string");
      const [counts, photos] = await Promise.all([
        supplementCounts(request, collegeIds),
        loadCollegePhotos(request.db, collegeIds, request.log),
      ]);

      const recs = await request.db
        .from("student_college_recommendations")
        .select("*")
        .eq("student_id", studentId)
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .limit(100);
      if (recs.error) throw fromPostgrest(recs.error);

      const by = [...new Set((recs.data ?? []).map((r) => r.recommended_by).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      if (by.length > 0) {
        const { data } = await request.db.from("profiles").select("id, full_name").in("id", by);
        for (const p of data ?? []) names.set(String(p.id), String(p.full_name ?? ""));
      }
      const onList = (r: Row) =>
        rows.some(
          (l) =>
            (r.college_id && l.college_id === r.college_id) ||
            String(l.name).trim().toLowerCase() === String(r.name).trim().toLowerCase()
        );

      return {
        rows: rows.map((r) => toListCollege(r, counts, photos)),
        recommendations: (recs.data ?? [])
          .filter((r) => !onList(r as Row))
          .map((r) =>
            toRecommendation({ ...(r as Row), recommended_by_name: names.get(String(r.recommended_by)) ?? null })
          ),
      };
    }
  );

  app.post(
    "/college-list",
    { preHandler: [app.authenticate, limit("application:college-add", 120, 60)] },
    async (request, reply) => {
      const b = addCollegeBody.parse(request.body);
      if (!b.collegeId && !b.name) throw badRequest("Pick a school or type its name");
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const row = await addToList(request, studentId, {
        collegeId: b.collegeId,
        name: b.name,
        round: b.round,
        fit: b.fit,
        status: b.stage ? STAGE_STATUS[b.stage] : undefined,
        intendedMajor: b.intendedMajor,
      });
      return reply.code(201).send(await serializeOne(request, row));
    }
  );

  app.patch(
    "/college-list/:id",
    { preHandler: [app.authenticate, limit("application:college-update", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = patchCollegeBody.parse(request.body);
      const current = await loadListRow(request, id);
      await resolveStudentId(request, String(current.student_id), "edit");
      if (isStudent(request) && (b.fit !== undefined || b.customDeadline !== undefined)) {
        throw forbidden("Your counselor sets fit and the counselor deadline");
      }

      const update: Row = {};
      if (b.round !== undefined) {
        update.round = b.round;
        // A round change moves the deadline with it, unless the counselor had
        // already typed their own date over the catalog's.
        const college = (current.college ?? null) as Row | null;
        if (b.deadline === undefined && college) {
          const was = catalogDeadline(college.deadlines, (current.round as string | null) ?? null);
          if (current.deadline == null || current.deadline === was) {
            update.deadline = catalogDeadline(college.deadlines, b.round);
          }
        }
      }
      if (b.fit !== undefined) update.fit = b.fit;
      if (b.status !== undefined) update.status = b.status;
      if (b.stage !== undefined) {
        // Dropping onto Applied keeps a decision already recorded.
        const now = String(current.status);
        if (!(b.stage === "applied" && (now === "submitted" || DECISIONS.has(now)))) {
          update.status = STAGE_STATUS[b.stage];
        }
      }
      if (b.deadline !== undefined) update.deadline = b.deadline;
      if (b.customDeadline !== undefined) update.custom_deadline = b.customDeadline;
      if (b.intendedMajor !== undefined) update.intended_major = b.intendedMajor;
      if (b.recsRequired !== undefined) update.recs_required = b.recsRequired;
      if (b.recsInHand !== undefined) update.recs_in_hand = b.recsInHand;
      if (b.testing !== undefined) update.testing = b.testing;
      if (b.applicationFeeCents !== undefined) update.application_fee_cents = b.applicationFeeCents;
      if (b.binding !== undefined) update.binding = b.binding;
      if (b.notes !== undefined) update.notes = b.notes;
      if (b.sortOrder !== undefined) update.sort_order = b.sortOrder;
      // "1 of 2 in hand" can't outlive a requirement lowered under it.
      const required = (update.recs_required ?? current.recs_required) as number | null;
      const inHand = (update.recs_in_hand ?? current.recs_in_hand) as number | null;
      if (inHand !== null && (required === null || inHand > required)) {
        if (b.recsInHand !== undefined) throw badRequest("Recommendations in hand can't exceed those required");
        update.recs_in_hand = required === null ? null : Math.min(inHand, required);
      }
      if (Object.keys(update).length === 0) return serializeOne(request, current);

      const { data, error } = await request.db
        .from("student_colleges")
        .update(update)
        .eq("id", id)
        .select(LIST_SELECT)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That school isn't on the list");
      return serializeOne(request, data as Row);
    }
  );

  app.delete(
    "/college-list/:id",
    { preHandler: [app.authenticate, limit("application:college-delete", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const current = await loadListRow(request, id);
      await resolveStudentId(request, String(current.student_id), "edit");
      const { error } = await request.db.from("student_colleges").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  // ---- Recommended column ---------------------------------------------------

  /** Counselor (or the College List Builder) puts a school in Recommended. */
  app.post(
    "/college-list/recommendations",
    { preHandler: [app.authenticate, limit("application:recommend", 120, 60)] },
    async (request, reply) => {
      const b = recommendBody.parse(request.body);
      if (isStudent(request)) throw forbidden("Your counselor recommends schools");
      const studentId = await resolveStudentId(request, b.studentId, "edit");

      let name = (b.name ?? "").trim();
      if (b.collegeId) {
        const { data } = await request.db.from("colleges").select("name").eq("id", b.collegeId).maybeSingle();
        if (!data) throw notFound("That college isn't in the catalog");
        name = String(data.name);
      }
      if (!name) throw badRequest("Name the school");

      const listed = await listRows(request, studentId);
      if (listed.some((r) => (b.collegeId && r.college_id === b.collegeId) || String(r.name).toLowerCase() === name.toLowerCase())) {
        throw conflict("That school is already on the list");
      }

      const { data: existing } = await request.db
        .from("student_college_recommendations")
        .select("*")
        .eq("student_id", studentId)
        .ilike("name", name.replace(/[%_\\]/g, (c) => `\\${c}`))
        .maybeSingle();
      if (existing) {
        const { data, error } = await request.db
          .from("student_college_recommendations")
          .update({ status: "open", fit: b.fit ?? existing.fit, why: b.why ?? existing.why })
          .eq("id", existing.id)
          .select("*")
          .single();
        if (error) throw fromPostgrest(error);
        return reply.code(200).send(toRecommendation(data as Row));
      }

      const { data, error } = await request.db
        .from("student_college_recommendations")
        .insert({
          student_id: studentId,
          college_id: b.collegeId ?? null,
          name,
          fit: b.fit ?? null,
          why: b.why ?? null,
          suggested_by: "counselor",
          recommended_by: request.auth.userId,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toRecommendation(data as Row));
    }
  );

  app.patch(
    "/college-list/recommendations/:id",
    { preHandler: [app.authenticate, limit("application:recommend-update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({ status: z.enum(["open", "dismissed"]).optional(), fit: z.enum(FITS).nullable().optional() })
        .strict()
        .parse(request.body);
      if (isStudent(request)) throw forbidden("Your counselor manages recommendations");
      const { data: rec } = await request.db.from("student_college_recommendations").select("student_id").eq("id", id).maybeSingle();
      if (!rec) throw notFound();
      await resolveStudentId(request, String(rec.student_id), "edit");
      const update: Row = {};
      if (b.status !== undefined) update.status = b.status;
      if (b.fit !== undefined) update.fit = b.fit;
      const { data, error } = await request.db
        .from("student_college_recommendations")
        .update(update)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toRecommendation(data as Row);
    }
  );

  /** Drag from Recommended onto the board: the school joins the list. */
  app.post(
    "/college-list/recommendations/:id/accept",
    { preHandler: [app.authenticate, limit("application:recommend-accept", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({ stage: z.enum(STAGES).optional(), intendedMajor: trimmed(200).nullable().optional() })
        .strict()
        .parse(request.body ?? {});
      const { data: rec } = await request.db.from("student_college_recommendations").select("*").eq("id", id).maybeSingle();
      if (!rec) throw notFound();
      const studentId = await resolveStudentId(request, String(rec.student_id), "edit");
      if (isStudent(request)) throw forbidden("Your counselor manages recommendations");

      const row = await addToList(request, studentId, {
        collegeId: (rec.college_id as string | null) ?? null,
        name: String(rec.name),
        fit: (rec.fit as (typeof FITS)[number] | null) ?? null,
        status: STAGE_STATUS[b.stage ?? "interested"],
        intendedMajor: b.intendedMajor ?? null,
      });
      await request.db.from("student_college_recommendations").update({ status: "added" }).eq("id", id);
      return serializeOne(request, row);
    }
  );

  // ==== Essays =================================================================

  app.get(
    "/essays",
    { preHandler: [app.authenticate, limit("application:essays", 240, 60)] },
    async (request) => {
      const q = studentQuery.parse(request.query);
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const cycle = currentCycle();
      const rows = await listRows(request, studentId);
      const collegeIds = rows.map((r) => r.college_id).filter((v): v is string => typeof v === "string");

      const [essays, prompts, docs] = await Promise.all([
        request.db
          .from("essays")
          .select(ESSAY_SELECT)
          .eq("student_id", studentId)
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(300),
        collegeIds.length > 0
          ? request.db
              .from("college_supplements")
              .select("*")
              .in("college_id", collegeIds)
              .eq("admission_cycle", cycle)
              .order("sort_order")
          : Promise.resolve({ data: [] as Row[], error: null }),
        request.db.from("supplement_docs").select("*").eq("student_id", studentId).order("created_at").limit(100),
      ]);
      if (essays.error) throw fromPostgrest(essays.error);
      if (prompts.error) throw fromPostgrest(prompts.error);
      if (docs.error) throw fromPostgrest(docs.error);

      return {
        cycle,
        colleges: rows.map((r) => ({
          id: String(r.id),
          collegeId: (r.college_id as string | null) ?? null,
          name: String(r.name),
          initials: String(r.initials ?? "") || initialsOf(String(r.name)),
          color: String(r.brand_color ?? "") || "#176b45",
        })),
        essays: (essays.data ?? []).map((r) => essayDto(request, r as Row)),
        prompts: (prompts.data ?? []).map((r) => toSupplementPrompt(r as Row)),
        docs: (docs.data ?? []).map((r) => ({
          ...toSupplementDoc(r as Row, cycle),
          ownedByMe: (r as Row).owner_id === request.auth.userId,
        })),
      };
    }
  );

  /** Defaults an essay takes from its prompt, its school, or its kind. */
  async function essayDefaults(
    request: FastifyRequest,
    studentId: string,
    input: { essayKind?: string; collegeSupplementId?: string | null; studentCollegeId?: string | null }
  ): Promise<Row> {
    const out: Row = {};
    if (input.essayKind === "personal-statement") {
      out.title = "Personal Statement";
      out.word_limit = 650;
      out.school = null;
      out.student_college_id = null;
    }
    let collegeId: string | null = null;
    if (input.collegeSupplementId) {
      const { data } = await request.db
        .from("college_supplements")
        .select("id, college_id, title, prompt, word_limit")
        .eq("id", input.collegeSupplementId)
        .maybeSingle();
      if (!data) throw notFound("That prompt isn't in the catalog");
      out.title = data.title;
      out.prompt = data.prompt;
      out.word_limit = data.word_limit;
      collegeId = String(data.college_id);
    }
    let listRow: Row | null = null;
    if (input.studentCollegeId) {
      const { data } = await request.db
        .from("student_colleges")
        .select("id, name, college_id, student_id")
        .eq("id", input.studentCollegeId)
        .maybeSingle();
      if (!data || data.student_id !== studentId) throw badRequest("That school is not on this student's list");
      listRow = data as Row;
    } else if (collegeId) {
      const { data } = await request.db
        .from("student_colleges")
        .select("id, name, college_id")
        .eq("student_id", studentId)
        .eq("college_id", collegeId)
        .maybeSingle();
      listRow = (data as Row | null) ?? null;
    }
    if (listRow) {
      out.student_college_id = listRow.id;
      out.school = listRow.name;
    }
    return out;
  }

  app.post(
    "/essays",
    { preHandler: [app.authenticate, limit("application:essay-create", 120, 60)] },
    async (request, reply) => {
      const b = essayCreateBody.parse(request.body);
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const defaults = await essayDefaults(request, studentId, b);
      const insert: Row = {
        student_id: studentId,
        essay_kind: b.essayKind ?? "supplement",
        ...defaults,
        college_supplement_id: b.collegeSupplementId ?? null,
      };
      if (b.title) insert.title = b.title;
      if (!insert.title) insert.title = "Untitled essay";
      if (b.prompt !== undefined && b.prompt !== null) insert.prompt = b.prompt;
      if (b.wordLimit !== undefined) insert.word_limit = b.wordLimit ?? insert.word_limit ?? null;
      if (insert.word_limit == null && insert.essay_kind === "supplement") insert.word_limit = 350;
      if (b.body !== undefined) insert.body = b.body;
      if (b.externalUrl !== undefined) insert.external_url = b.externalUrl;
      if (b.status) insert.status = b.status;
      if (b.dueDate !== undefined) insert.due_date = b.dueDate;

      const { data, error } = await request.db.from("essays").insert(insert).select(ESSAY_SELECT).single();
      if (error) throw fromPostgrest(error);
      await logEssayProgress(request, studentId, data as Row, "insert");
      return reply.code(201).send(essayDto(request, data as Row));
    }
  );

  app.patch(
    "/essays/:id",
    { preHandler: [app.authenticate, limit("application:essay-update", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = essayPatchBody.parse(request.body);
      const { data: current, error: readError } = await request.db
        .from("essays")
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      if (!current) throw notFound();
      const studentId = await resolveStudentId(request, String(current.student_id), "edit");

      const update: Row = {};
      if (b.essayKind !== undefined) update.essay_kind = b.essayKind;
      if (b.title !== undefined) update.title = b.title || "Untitled essay";
      if (b.prompt !== undefined) update.prompt = b.prompt;
      if (b.studentCollegeId !== undefined) {
        Object.assign(update, b.studentCollegeId ? await essayDefaults(request, studentId, { studentCollegeId: b.studentCollegeId }) : { student_college_id: null, school: null });
      }
      if (b.wordLimit !== undefined) update.word_limit = b.wordLimit;
      if (b.body !== undefined) {
        update.body = b.body;
        update.text_status = "read";
      }
      if (b.externalUrl !== undefined) update.external_url = b.externalUrl;
      if (b.status !== undefined) update.status = b.status;
      if (b.dueDate !== undefined) update.due_date = b.dueDate;
      if (b.sortOrder !== undefined) update.sort_order = b.sortOrder;

      const { data, error } = await request.db.from("essays").update(update).eq("id", id).select(ESSAY_SELECT).maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();
      if (b.body !== undefined) await logEssayProgress(request, studentId, data as Row, "update");
      return essayDto(request, data as Row);
    }
  );

  /** Takes the essay off the student's list; a file it came from stays in Files. */
  app.delete(
    "/essays/:id",
    { preHandler: [app.authenticate, limit("application:essay-delete", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data: current } = await request.db.from("essays").select("student_id").eq("id", id).maybeSingle();
      if (!current) throw notFound();
      await resolveStudentId(request, String(current.student_id), "edit");
      const { error } = await request.db.from("essays").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  /**
   * File a document already in Files (an upload or a Drive / OneDrive import)
   * as an essay, counted from its own text.
   */
  app.post(
    "/essays/from-document",
    { preHandler: [app.authenticate, limit("application:essay-from-document", 60, 60)] },
    async (request, reply) => {
      const b = fromDocumentBody.parse(request.body);
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const { data: doc, error: docError } = await request.db
        .from("documents")
        .select("*")
        .eq("id", b.documentId)
        .maybeSingle();
      if (docError) throw fromPostgrest(docError);
      if (!doc || doc.student_id !== studentId) throw notFound("That document isn't filed to this student");

      let text: string | null = null;
      const parsed = (doc.parsed_data ?? {}) as Row;
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        text = parsed.text;
      } else if (doc.external_provider === "google" && doc.external_file_id && doc.owner_id === request.auth.userId) {
        const file = await getRemoteFile(request.auth.userId, "google", String(doc.external_file_id), null, request.log).catch(() => null);
        text = file ? await exportGoogleDocText(request.auth.userId, file, request.log).catch(() => null) : null;
      }
      if (text === null && doc.storage_path) {
        const dl = await request.db.storage.from(String(doc.bucket ?? "student-documents")).download(String(doc.storage_path));
        if (!dl.error && dl.data) {
          const bytes = Buffer.from(await dl.data.arrayBuffer());
          text = readDocumentText(bytes, String(doc.filename ?? ""), (doc.mime_type as string | null) ?? null);
        }
      }

      const defaults = await essayDefaults(request, studentId, {
        essayKind: b.essayKind,
        collegeSupplementId: b.collegeSupplementId,
        studentCollegeId: b.studentCollegeId,
      });
      const insert: Row = {
        student_id: studentId,
        essay_kind: b.essayKind ?? "supplement",
        ...defaults,
        college_supplement_id: b.collegeSupplementId ?? null,
        document_id: b.documentId,
        title: b.title || defaults.title || String(doc.title ?? doc.filename ?? "Essay").replace(/\.[^.]+$/, ""),
        body: text ?? "",
        text_status: text === null ? "unreadable" : "read",
        text_synced_at: new Date().toISOString(),
        status: text ? "drafting" : "not-started",
      };
      if (insert.word_limit == null && insert.essay_kind === "supplement") insert.word_limit = 350;

      const { data, error } = await request.db.from("essays").insert(insert).select(ESSAY_SELECT).single();
      if (error) throw fromPostgrest(error);
      await logEssayProgress(request, studentId, data as Row, "insert");
      return reply.code(201).send(essayDto(request, data as Row));
    }
  );

  /**
   * Re-read the Docs behind a student's essays, so every word count counts the
   * words in the document. Reads only with the caller's own grant: the
   * supplement Docs they created, and links they set themselves.
   */
  app.post(
    "/essays/sync",
    { preHandler: [app.authenticate, limit("application:essays-sync", 20, 60)] },
    async (request) => {
      const b = z.object({ studentId: uuid }).strict().parse(request.body);
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const me = request.auth.userId;
      const now = new Date().toISOString();
      let updated = 0;
      const failed: string[] = [];

      const { data: docs } = await request.db
        .from("supplement_docs")
        .select("*")
        .eq("student_id", studentId)
        .eq("owner_id", me)
        .limit(25);
      const { data: essays } = await request.db
        .from("essays")
        .select("id, body, supplement_doc_id, college_supplement_id, prompt, external_url, link_owner_id, document_id")
        .eq("student_id", studentId)
        .limit(300);

      const jobs: (() => Promise<void>)[] = [];
      for (const d of docs ?? []) {
        jobs.push(async () => {
          const text = await exportDocText(me, String(d.external_file_id), request.log).catch(() => null);
          if (text === null) {
            failed.push(String(d.college_name));
            return;
          }
          const mine = (essays ?? []).filter((e) => e.supplement_doc_id === d.id);
          const prompts: DocPrompt[] = mine.map((e) => ({ title: "", prompt: String(e.prompt ?? ""), wordLimit: null }));
          const answers = splitAnswers(text, prompts);
          for (let i = 0; i < mine.length; i++) {
            const answer = answers[i];
            if (answer == null || answer === (mine[i]!.body ?? "")) continue;
            const { error } = await request.db
              .from("essays")
              .update({ body: answer, text_status: "read", text_synced_at: now, status: answer ? "drafting" : "not-started" })
              .eq("id", mine[i]!.id);
            if (!error) updated++;
          }
          await request.db.from("supplement_docs").update({ text_synced_at: now }).eq("id", d.id);
        });
      }
      for (const e of (essays ?? []).filter((x) => x.external_url && x.link_owner_id === me && !x.supplement_doc_id && !x.document_id).slice(0, 25)) {
        const fileId = googleDocIdFromUrl(String(e.external_url));
        if (!fileId) continue;
        jobs.push(async () => {
          const text = await exportDocText(me, fileId, request.log).catch(() => null);
          if (text === null) {
            failed.push(String(e.id));
            return;
          }
          if (text === (e.body ?? "")) return;
          const { error } = await request.db
            .from("essays")
            .update({ body: text, text_status: "read", text_synced_at: now })
            .eq("id", e.id);
          if (!error) updated++;
        });
      }

      // Four at a time, like lib/liveDocuments.ts: polite to the provider.
      for (let i = 0; i < jobs.length; i += 4) {
        await Promise.all(jobs.slice(i, i + 4).map((job) => job().catch(() => undefined)));
      }

      const { data: fresh, error } = await request.db
        .from("essays")
        .select(ESSAY_SELECT)
        .eq("student_id", studentId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(300);
      if (error) throw fromPostgrest(error);
      return {
        updated,
        failed: failed.length,
        essays: (fresh ?? []).map((r) => essayDto(request, r as Row)),
      };
    }
  );

  /**
   * "+ Add essay" on a school with nothing on file: one Google Doc for that
   * school, every prompt in it, shared with the student; and one essay row per
   * prompt pointing at it. Without Google connected the route answers 409
   * with the reason, and the app files the essays as records instead
   * (POST /essays per prompt, optionally with a link).
   */
  app.post(
    "/supplement-docs",
    { preHandler: [app.authenticate, limit("application:supplement-doc", 30, 60)] },
    async (request, reply) => {
      const b = z.object({ studentId: uuid, studentCollegeId: uuid }).strict().parse(request.body);
      if (isStudent(request)) throw forbidden("Your counselor creates the supplement Docs");
      const studentId = await resolveStudentId(request, b.studentId, "edit");
      const cycle = currentCycle();

      const list = await loadListRow(request, b.studentCollegeId);
      if (list.student_id !== studentId) throw badRequest("That school is not on this student's list");
      const collegeName = String(list.name);

      const { data: existing } = await request.db
        .from("supplement_docs")
        .select("*")
        .eq("student_id", studentId)
        .eq("admission_cycle", cycle)
        .ilike("college_name", collegeName.replace(/[%_\\]/g, (c) => `\\${c}`))
        .maybeSingle();
      if (existing) throw conflict("That school's Doc already exists");

      const { data: prompts } = list.college_id
        ? await request.db
            .from("college_supplements")
            .select("*")
            .eq("college_id", String(list.college_id))
            .eq("admission_cycle", cycle)
            .order("sort_order")
        : { data: [] as Row[] };
      const docPrompts: DocPrompt[] = (prompts ?? []).map((p) => ({
        title: String(p.title),
        prompt: String(p.prompt),
        wordLimit: (p.word_limit as number | null) ?? null,
      }));

      const contact = await studentContact(request, studentId);
      const title = docTitle(contact.name, collegeName, cycle);
      const created = await createSupplementDoc(
        request.auth.userId,
        { title, prompts: docPrompts, shareWith: contact.email },
        request.log
      );

      const { data: doc, error } = await request.db
        .from("supplement_docs")
        .insert({
          student_id: studentId,
          student_college_id: list.id,
          college_id: list.college_id ?? null,
          college_name: collegeName,
          admission_cycle: cycle,
          title,
          owner_id: request.auth.userId,
          external_file_id: created.fileId,
          web_url: created.webUrl,
          shared_with: created.shareStatus === "shared" ? contact.email : null,
          share_status: created.shareStatus,
          prompts: docPrompts,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);

      // One row per prompt; a school with no prompts on file gets one row for
      // the Doc itself, so the school still shows something to open.
      const rows: Row[] = (prompts ?? []).length > 0
        ? (prompts ?? []).map((p, i) => ({
            student_id: studentId,
            essay_kind: "supplement",
            title: p.title,
            prompt: p.prompt,
            word_limit: p.word_limit,
            school: collegeName,
            student_college_id: list.id,
            college_supplement_id: p.id,
            supplement_doc_id: doc.id,
            body: "",
            sort_order: i,
          }))
        : [{
            student_id: studentId,
            essay_kind: "supplement",
            title: `${collegeName} supplements`,
            school: collegeName,
            student_college_id: list.id,
            supplement_doc_id: doc.id,
            word_limit: 350,
            body: "",
          }];
      const ins = await request.db.from("essays").insert(rows).select(ESSAY_SELECT);
      if (ins.error) throw fromPostgrest(ins.error);

      return reply.code(201).send({
        doc: { ...toSupplementDoc(doc as Row, cycle), ownedByMe: true },
        essays: (ins.data ?? []).map((r) => essayDto(request, r as Row)),
      });
    }
  );

  // ==== Activities and Awards & Honors sheets ==================================

  app.get(
    "/sheets",
    { preHandler: [app.authenticate, limit("application:sheets", 240, 60)] },
    async (request) => {
      const q = studentQuery.parse(request.query);
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const [activities, honors] = await Promise.all([
        request.db.from("activities").select("*").eq("student_id", studentId).order("sort_order").order("created_at").limit(100),
        request.db.from("awards").select("*").eq("student_id", studentId).order("sort_order").order("created_at").limit(100),
      ]);
      if (activities.error) throw fromPostgrest(activities.error);
      if (honors.error) throw fromPostgrest(honors.error);
      return {
        activities: (activities.data ?? []).map((r) => toSheetActivity(r as Row)),
        honors: (honors.data ?? []).map((r) => toSheetHonor(r as Row)),
      };
    }
  );

  registerCollection(app, {
    path: "activities",
    table: "activities",
    body: activityBody,
    toDto: toSheetActivity,
    beforeWrite: capRows("activities"),
  });
  registerCollection(app, {
    path: "honors",
    table: "awards",
    body: honorBody,
    toDto: toSheetHonor,
    beforeWrite: capRows("awards"),
  });
}
