/**
 * School-specific scholarships (20261111000006): a school's own awards, typed in by a counselor. Meridies never
 * curates these; a counselor's row is unverified until an editor (service role) stamps it, and the counselor's own
 * edit clears that stamp again. Counselor only; everything runs on the caller's client (`request.db`), so RLS
 * decides who sees and writes what (see the migration for the rules).
 *
 *   POST   /scholarships/internal          add one (a school is required)                  -> 201 SchoolScholarship
 *   PATCH  /scholarships/internal/:id      change your own                                 -> SchoolScholarship
 *   DELETE /scholarships/internal/:id      remove your own (soft: is_active = false)       -> { id, removed: true }
 *   GET    /colleges/:id/scholarships      what you can see for one school                  -> { collegeId, scholarships }
 *
 * Students see their practice's rows in their scholarship scan (`matchedOn: "school"`), for a school on their list.
 * Before the migration every route answers 503 `school_scholarships_unavailable`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { enforceRateLimit, limit } from "../lib/limits.js";

/** Active rows one counselor may keep. The database holds the same line (errcode 54000). */
export const SCHOLARSHIP_CAP = 200;
/** Writes (add, change, remove) per counselor per hour. */
export const SCHOLARSHIP_WRITES_PER_HOUR = 60;

const COLUMNS =
  "id, college_id, name, sponsor, amount_cents, amount_note, renewable, opens_at, deadline, url, eligibility_text, description, tags, essay_required, source, owner_counselor_id, source_verified_at, updated_at";

const NOT_APPLIED = new Set(["42703", "PGRST204", "PGRST200"]);
const unavailableSchool = () =>
  new HttpError(503, "School scholarships aren't switched on yet", "school_scholarships_unavailable");
const capReached = () =>
  new HttpError(409, `You have ${SCHOLARSHIP_CAP} school scholarships saved. Remove one before adding another.`, "scholarship_cap");

function dbError(error: { code?: string; message?: string }): HttpError {
  if (NOT_APPLIED.has(String(error.code))) return unavailableSchool();
  if (error.code === "54000") return capReached();
  return fromPostgrest(error);
}

const httpsUrl = z
  .string()
  .trim()
  .max(2048, "That link is too long")
  .refine((u) => {
    if (/\s/.test(u)) return false;
    try {
      const x = new URL(u);
      return x.protocol === "https:" && x.hostname.length > 0;
    } catch {
      return false;
    }
  }, "Links must start with https://");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "That date doesn't exist");

const optText = (max: number) => z.string().trim().max(max).nullable().optional();

const fields = {
  name: z.string().trim().min(1, "Give the scholarship a name").max(200),
  collegeId: z.string().uuid("Pick a school"),
  sponsor: optText(200),
  amountCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  amountNote: optText(200),
  renewable: z.boolean().nullable().optional(),
  opensAt: isoDate.nullable().optional(),
  deadline: isoDate.nullable().optional(),
  url: httpsUrl.nullable().optional(),
  eligibility: optText(2000),
  notes: optText(2000),
  basis: z.enum(["merit", "need", "both"]).nullable().optional(),
  essayRequired: z.boolean().nullable().optional(),
};

const createBody = z.object(fields).strict();
const patchBody = z.object(fields).partial().strict();
const idParam = z.object({ id: z.string().uuid("Not a valid id") });

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export type SchoolScholarship = {
  id: string;
  collegeId: string | null;
  name: string;
  sponsor: string | null;
  amountCents: number | null;
  amountNote: string | null;
  renewable: boolean | null;
  opensAt: string | null;
  deadline: string | null;
  url: string | null;
  /** Who it is for, in the counselor's words. Students read it. */
  eligibility: string | null;
  /** The counselor's notes. Students read these too. */
  notes: string | null;
  basis: "merit" | "need" | "both" | null;
  essayRequired: boolean | null;
  source: "catalog" | "counselor";
  /** `you`: the caller's; `firm`: a colleague's in the caller's firm; `meridies`: the catalog. */
  ownedBy: "you" | "firm" | "meridies";
  /** Only an editor's stamp makes it true. */
  verified: boolean;
  verifiedAt: string | null;
  canEdit: boolean;
  updatedAt: string | null;
};

export function toSchoolScholarship(r: Row, callerId: string): SchoolScholarship {
  const owner = s(r.owner_counselor_id);
  const ownedBy = owner === null ? "meridies" : owner === callerId ? "you" : "firm";
  const source = r.source === "counselor" ? "counselor" : "catalog";
  const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [];
  const basis = (tags.find((t) => t === "merit" || t === "need" || t === "both") ?? null) as SchoolScholarship["basis"];
  return {
    id: String(r.id),
    collegeId: s(r.college_id),
    name: String(r.name),
    sponsor: s(r.sponsor),
    amountCents: r.amount_cents == null ? null : Number(r.amount_cents),
    amountNote: s(r.amount_note),
    renewable: typeof r.renewable === "boolean" ? r.renewable : null,
    opensAt: s(r.opens_at),
    deadline: s(r.deadline),
    url: s(r.url),
    eligibility: s(r.eligibility_text),
    notes: s(r.description),
    basis,
    essayRequired: typeof r.essay_required === "boolean" ? r.essay_required : null,
    source,
    ownedBy,
    verified: s(r.source_verified_at) !== null,
    verifiedAt: s(r.source_verified_at),
    canEdit: ownedBy === "you" && source === "counselor",
    updatedAt: s(r.updated_at),
  };
}

/** The columns a body sets. Only what the body names, so a PATCH leaves the rest alone. */
function rowFrom(b: z.infer<typeof patchBody>): Row {
  const out: Row = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.collegeId !== undefined) out.college_id = b.collegeId;
  if (b.sponsor !== undefined) out.sponsor = b.sponsor || null;
  if (b.amountCents !== undefined) out.amount_cents = b.amountCents;
  if (b.amountNote !== undefined) out.amount_note = b.amountNote || null;
  if (b.renewable !== undefined) out.renewable = b.renewable;
  if (b.opensAt !== undefined) out.opens_at = b.opensAt;
  if (b.deadline !== undefined) out.deadline = b.deadline;
  if (b.url !== undefined) out.url = b.url || null;
  if (b.eligibility !== undefined) out.eligibility_text = b.eligibility || null;
  if (b.notes !== undefined) out.description = b.notes || null;
  if (b.basis !== undefined) out.tags = b.basis ? [b.basis] : [];
  if (b.essayRequired !== undefined) out.essay_required = b.essayRequired;
  return out;
}

async function assertCollege(request: FastifyRequest, collegeId: string) {
  const { data, error } = await request.db.from("colleges").select("id").eq("id", collegeId).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That school isn't in the catalog");
}

const throttle = (request: FastifyRequest) =>
  enforceRateLimit(
    `scholarships:write:${request.auth.userId}`,
    SCHOLARSHIP_WRITES_PER_HOUR,
    3600,
    "You've changed a lot of scholarships this hour. Give it a moment."
  );

export default async function schoolScholarshipRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.post("/scholarships/internal", { preHandler: counselor }, async (request, reply) => {
    const b = createBody.parse(request.body);
    await throttle(request);
    const uid = request.auth.userId;

    const { count, error: countError } = await request.db
      .from("scholarships")
      .select("id", { count: "exact", head: true })
      .eq("owner_counselor_id", uid)
      .eq("is_active", true);
    if (countError) throw dbError(countError);
    if ((count ?? 0) >= SCHOLARSHIP_CAP) throw capReached();
    await assertCollege(request, b.collegeId);

    const { data, error } = await request.db
      .from("scholarships")
      .insert({ ...rowFrom(b), source: "counselor", owner_counselor_id: uid })
      .select(COLUMNS)
      .single();
    if (error) throw dbError(error);
    reply.code(201);
    return toSchoolScholarship(data as Row, uid);
  });

  app.patch("/scholarships/internal/:id", { preHandler: counselor }, async (request) => {
    const { id } = idParam.parse(request.params);
    const raw = request.body;
    if (raw && typeof raw === "object" && ("sourceVerifiedAt" in raw || "verified" in raw)) {
      throw badRequest("Only a Meridies editor can mark a scholarship verified");
    }
    const b = patchBody.parse(raw ?? {});
    const patch = rowFrom(b);
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to change");
    await throttle(request);
    if (b.collegeId) await assertCollege(request, b.collegeId);
    const uid = request.auth.userId;

    const { data, error } = await request.db
      .from("scholarships")
      .update(patch)
      .eq("id", id)
      .eq("owner_counselor_id", uid)
      .eq("source", "counselor")
      .eq("is_active", true)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw notFound("That scholarship isn't one of yours");
    return toSchoolScholarship(data as Row, uid);
  });

  app.delete("/scholarships/internal/:id", { preHandler: counselor }, async (request) => {
    const { id } = idParam.parse(request.params);
    await throttle(request);
    // A count, not RETURNING: the reply needs no row, and only the owner may read a removed one anyway.
    const { count, error } = await request.db
      .from("scholarships")
      .update({ is_active: false }, { count: "exact" })
      .eq("id", id)
      .eq("owner_counselor_id", request.auth.userId)
      .eq("source", "counselor")
      .eq("is_active", true);
    if (error) throw dbError(error);
    if (!count) throw notFound("That scholarship isn't one of yours");
    return { id, removed: true };
  });

  app.get(
    "/colleges/:id/scholarships",
    { preHandler: [...counselor, limit("scholarships:college", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db
        .from("scholarships")
        .select(COLUMNS)
        .eq("college_id", id)
        .eq("is_active", true)
        .order("deadline", { ascending: true, nullsFirst: false })
        .order("name", { ascending: true })
        .limit(500);
      if (error) throw dbError(error);
      return {
        collegeId: id,
        scholarships: ((data ?? []) as Row[]).map((r) => toSchoolScholarship(r, request.auth.userId)),
      };
    }
  );
}

