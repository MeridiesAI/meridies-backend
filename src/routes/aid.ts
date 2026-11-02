/**
 * Financial Aid & Scholarships.
 *
 * Split the way the product is: `/aid/colleges/*` is the shared informational
 * layer (sticker price, need met, CSS requirement, all source-linked), and
 * everything else is the student's own working layer.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerCollection } from "../lib/collection.js";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { resultsUnavailable } from "../lib/resultsAvailability.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

const money = z.number().int().min(0).max(100_000_000);
const studentQuery = z.object({ studentId: z.string().uuid().optional() });

/**
 * v8 (see migration 20261005030002): the FAFSA carries its status and due date
 * and nothing else — no filing date, no EFC, no SSN, no detail from the form.
 * The CSS Profile sits beside it with the same two facts.
 */
const aidProfileBody = z
  .object({
    fafsa_status: z.enum(["not-started", "in-progress", "submitted"]),
    fafsa_due_date: z.string().date().nullable(),
    css_status: z.enum(["not-started", "in-progress", "submitted", "not-required", "not-applicable"]),
    css_submitted_at: z.string().date().nullable(),
    css_due_date: z.string().date().nullable(),
    sai_estimate: z.number().int().min(-1_500).max(1_000_000).nullable(),
    household_size: z.number().int().min(1).max(20).nullable(),
    number_in_college: z.number().int().min(0).max(20).nullable(),
    income_band: z.string().trim().max(60).nullable(),
    assets_band: z.string().trim().max(60).nullable(),
    dependency_status: z.enum(["dependent", "independent"]).nullable(),
    state_of_residence: z.string().trim().max(60).nullable(),
    aid_types_pursued: z.array(z.string().trim().max(60)).max(20),
    special_circumstances: z.string().trim().max(4000).nullable(),
    npc_inputs: z.record(z.unknown()),
    parent_agi_cents: z.number().int().min(0).max(100_000_000_000).nullable(),
    home_equity: z.enum(["renting", "under-100k", "100k-300k", "over-300k", "declined"]).nullable(),
    family_business: z.enum(["none", "under-100", "100-plus", "farm", "declined"]).nullable(),
    parent_status: z
      .enum(["married", "divorced-separated", "single", "remarried", "declined"])
      .nullable(),
    siblings_in_college: z.enum(["none", "one", "two-plus", "declined"]).nullable(),
  })
  .partial()
  .strict();

const checklistBody = z
  .object({
    student_college_id: z.string().uuid().nullable().optional(),
    // No "fafsa": the per-school FAFSA row was deleted in v5 and stays deleted.
    item: z.enum([
      "css-profile", "idoc", "verification", "institutional-form",
      "award-letter", "appeal", "scholarship-application", "tax-transcript",
    ]),
    status: z
      .enum(["todo", "in-progress", "submitted", "received", "waived", "not-applicable"])
      .optional(),
    due_date: z.string().date().nullable().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .partial({ item: true })
  .strict();

const awardLetterBody = z
  .object({
    school_name: z.string().trim().min(1).max(300),
    student_college_id: z.string().uuid().nullable().optional(),
    college_id: z.string().uuid().nullable().optional(),
    document_id: z.string().uuid().nullable().optional(),
    entry_mode: z.enum(["manual", "upload"]).optional(),
    academic_year: z.string().trim().max(20).optional(),
    cost_of_attendance_cents: money.nullable().optional(),
    grants_cents: money.optional(),
    scholarships_cents: money.optional(),
    work_study_cents: money.optional(),
    loans_subsidized_cents: money.optional(),
    loans_unsubsidized_cents: money.optional(),
    parent_loan_cents: money.optional(),
    renewal_requirements: z.string().trim().max(4000).optional(),
    appeal_deadline: z.string().date().nullable().optional(),
    received_at: z.string().date().nullable().optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .partial({ school_name: true })
  .strict();

const appealBody = z
  .object({
    school_name: z.string().trim().min(1).max(300),
    student_college_id: z.string().uuid().nullable().optional(),
    award_letter_id: z.string().uuid().nullable().optional(),
    basis: z.array(z.string().trim().max(80)).max(10).optional(),
    competing_offers: z.array(z.record(z.unknown())).max(20).optional(),
    circumstances: z.string().trim().max(8000).optional(),
    draft_body: z.string().max(20_000).optional(),
    status: z.enum(["draft", "counselor-review", "approved", "sent", "declined"]).optional(),
  })
  .partial({ school_name: true })
  .strict();

export default async function aidRoutes(app: FastifyInstance) {
  // ---- Informational layer (shared catalog, read-only to users) ------------

  app.get("/colleges/:collegeId", { preHandler: app.authenticate }, async (request) => {
    const { collegeId } = z.object({ collegeId: z.string().uuid() }).parse(request.params);

    const { data, error } = await request.db
      .from("college_aid_profiles")
      .select("*, college:colleges(id, name, slug, state, control)")
      .eq("college_id", collegeId)
      .maybeSingle();

    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("No aid data on file for that college yet");
    return data;
  });

  // ---- The student's aid profile ------------------------------------------

  app.get("/profile", { preHandler: app.authenticate }, async (request) => {
    const { studentId } = studentQuery.parse(request.query);
    const student = await resolveStudentId(request, studentId, "view");

    const { data, error } = await request.db
      .from("student_aid_profiles")
      .select("*")
      .eq("student_id", student)
      .maybeSingle();

    if (error) throw fromPostgrest(error);
    return data ?? { student_id: student, fafsa_status: "not-started", css_status: "not-started" };
  });

  app.put(
    "/profile",
    { preHandler: [app.authenticate, limit("aid:profile", 120, 60)] },
    async (request) => {
      const raw = (request.body ?? {}) as { studentId?: string } & Record<string, unknown>;
      const { studentId, ...rest } = raw;
      const patch = aidProfileBody.parse(rest);
      const student = await resolveStudentId(request, studentId, "edit");

      const { data, error } = await request.db
        .from("student_aid_profiles")
        .upsert({ ...patch, student_id: student }, { onConflict: "student_id" })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return data;
    }
  );

  // ---- Checklist, award letters, appeals -----------------------------------

  registerCollection(app, {
    path: "checklist", table: "student_aid_checklist", body: checklistBody,
    toDto: (r) => r, orderBy: { column: "due_date", ascending: true },
  });

  registerCollection(app, {
    path: "award-letters", table: "award_letters", body: awardLetterBody,
    toDto: (r) => r, orderBy: { column: "created_at", ascending: false },
  });

  registerCollection(app, {
    path: "appeals", table: "award_appeals", body: appealBody,
    toDto: (r) => r, orderBy: { column: "created_at", ascending: false },
  });

  /**
   * The comparator. Returns every award letter with its line items and the
   * matching net price estimate, ready to render side by side. Net price here
   * counts gift aid only — the generated column deliberately does not treat a
   * loan as a discount, because a family repaying it later is not aid.
   */
  app.get("/comparison", { preHandler: [app.authenticate, limit("aid:comparison", 240, 60)] }, async (request) => {
    const { studentId } = studentQuery.parse(request.query);
    const student = await resolveStudentId(request, studentId, "view");

    const [letters, items, estimates] = await Promise.all([
      request.db.from("award_letters").select("*").eq("student_id", student).order("school_name"),
      request.db.from("award_letter_items").select("*").eq("student_id", student).order("sort_order"),
      request.db
        .from("net_price_estimates")
        .select("*")
        .eq("student_id", student)
        .order("computed_at", { ascending: false }),
    ]);

    if (letters.error) throw fromPostgrest(letters.error);

    const byLetter = new Map<string, Record<string, unknown>[]>();
    for (const item of items.data ?? []) {
      const key = item.award_letter_id as string;
      if (!byLetter.has(key)) byLetter.set(key, []);
      byLetter.get(key)!.push(item as Record<string, unknown>);
    }

    // Newest estimate per college wins.
    const estimateByCollege = new Map<string, Record<string, unknown>>();
    for (const e of estimates.data ?? []) {
      const key = (e.college_id ?? e.student_college_id) as string | null;
      if (key && !estimateByCollege.has(key)) estimateByCollege.set(key, e as Record<string, unknown>);
    }

    return (letters.data ?? []).map((letter) => {
      const lineItems = byLetter.get(letter.id as string) ?? [];
      return {
        ...letter,
        items: lineItems,
        // Surfaced so the UI can flag "renewable" vs "one-time" without
        // re-deriving it in three different components.
        hasRenewableAward: lineItems.some((i) => i.renewable === true),
        hasOneTimeAward: lineItems.some((i) => i.renewable === false),
        meritTotalCents: lineItems
          .filter((i) => i.basis === "merit")
          .reduce((sum, i) => sum + Number(i.amount_cents ?? 0), 0),
        needTotalCents: lineItems
          .filter((i) => i.basis === "need")
          .reduce((sum, i) => sum + Number(i.amount_cents ?? 0), 0),
        estimate:
          estimateByCollege.get((letter.college_id as string) ?? "") ??
          estimateByCollege.get((letter.student_college_id as string) ?? "") ??
          null,
      };
    });
  });

  // ---- Award letter line items --------------------------------------------

  const itemBody = z
    .object({
      award_letter_id: z.string().uuid(),
      label: z.string().trim().min(1).max(200),
      category: z.enum(["grant", "scholarship", "work-study", "loan", "parent-loan", "other"]),
      basis: z.enum(["need", "merit", "both", "unknown"]).optional(),
      amount_cents: z.number().int().min(-100_000_000).max(100_000_000),
      renewable: z.boolean().nullable().optional(),
      renewal_note: z.string().trim().max(1000).optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
    })
    .partial({ award_letter_id: true, label: true, category: true, amount_cents: true })
    .strict();

  registerCollection(app, {
    path: "award-letter-items", table: "award_letter_items", body: itemBody,
    toDto: (r) => r,
  });

  // ---- Scholarship matches -------------------------------------------------

  app.get("/scholarships", { preHandler: [app.authenticate, limit("aid:scholarships", 240, 60)] }, async (request) => {
    const { studentId } = studentQuery.parse(request.query);
    const student = await resolveStudentId(request, studentId, "view");

    const { data, error } = await request.db
      .from("scholarship_matches")
      .select("*")
      .eq("student_id", student)
      .neq("status", "dismissed")
      .order("deadline", { ascending: true, nullsFirst: false })
      .limit(200);

    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  // Scholarship tracking (migration 20261028000001): a hand-entered award, and the
  // amount, deadline, outcome and requirements checklist on any of them.
  const requirement = z
    .object({ id: z.string().trim().min(1).max(64), label: z.string().trim().min(1).max(200), done: z.boolean() })
    .strict();
  const awardMoney = z.number().int().min(0).max(100_000_000);
  const SCHOLARSHIP_STATUSES = ["suggested", "saved", "applying", "applied", "awarded", "not-awarded", "dismissed"] as const;

  const createScholarshipBody = z
    .object({
      studentId: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(200),
      sponsor: z.string().trim().max(200).optional(),
      // Rendered as a link to students: http(s) only, as routes/events.ts requires (zod's .url() accepts javascript: and data:).
      url: z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address").optional(),
      amountCents: awardMoney.optional(),
      deadline: z.string().date().nullable().optional(),
      requirements: z.array(requirement).max(30).optional(),
    })
    .strict();

  app.post(
    "/scholarships",
    { preHandler: [app.authenticate, limit("aid:scholarship-create", 60, 60)] },
    async (request, reply) => {
      const b = createScholarshipBody.parse(request.body);
      const student = await resolveStudentId(request, b.studentId, "edit");
      const { data, error } = await request.db
        .from("scholarship_matches")
        .insert({
          student_id: student,
          name: b.name,
          sponsor: b.sponsor ?? null,
          url: b.url ?? null,
          amount_cents: b.amountCents ?? null,
          deadline: b.deadline ?? null,
          status: "saved",
          requirements: b.requirements ?? [],
        })
        .select("*")
        .single();
      if (error) throw resultsUnavailable(error) ?? fromPostgrest(error);
      return reply.code(201).send(data);
    }
  );

  const patchScholarshipBody = z
    .object({
      status: z.enum(SCHOLARSHIP_STATUSES),
      amountCents: awardMoney.nullable(),
      awardedCents: awardMoney.nullable(),
      deadline: z.string().date().nullable(),
      requirements: z.array(requirement).max(30),
    })
    .partial()
    .strict();

  app.patch(
    "/scholarships/:id",
    { preHandler: [app.authenticate, limit("aid:scholarship-status", 240, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = patchScholarshipBody.parse(request.body);
      if (Object.keys(b).length === 0) throw badRequest("Nothing to change");

      const { data: existing } = await request.db
        .from("scholarship_matches")
        .select("student_id, status, amount_cents, awarded_cents")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound();
      await resolveStudentId(request, existing.student_id as string, "edit");

      const update: Record<string, unknown> = {};
      if (b.status !== undefined) update.status = b.status;
      if (b.amountCents !== undefined) update.amount_cents = b.amountCents;
      if (b.deadline !== undefined) update.deadline = b.deadline;
      if (b.requirements !== undefined) update.requirements = b.requirements;

      // The amount won only means something on an awarded scholarship: winning
      // one with no figure yet assumes the amount applied for, and any other
      // outcome carries no winnings.
      const status = (b.status ?? existing.status) as string;
      const amount = (b.amountCents !== undefined ? b.amountCents : existing.amount_cents) as number | null;
      const won = (b.awardedCents !== undefined ? b.awardedCents : existing.awarded_cents) as number | null;
      if (b.awardedCents !== undefined || b.status !== undefined || b.amountCents !== undefined) {
        update.awarded_cents = status === "awarded" ? (won ?? amount ?? null) : null;
      }

      const { data, error } = await request.db
        .from("scholarship_matches")
        .update(update)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) {
        const touchesNew =
          b.awardedCents !== undefined || b.requirements !== undefined || b.status === "not-awarded" || "awarded_cents" in update;
        throw (touchesNew ? resultsUnavailable(error) : null) ?? fromPostgrest(error);
      }
      if (!data) throw notFound();
      return data;
    }
  );
}
