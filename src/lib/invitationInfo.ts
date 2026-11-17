/**
 * What a counselor fills in for a student who has not joined yet
 * (`invitations.info`, `20261127000001`). The keys are the info card's own
 * (`infoPatchSchema`) minus `gradYear` (that is `invitations.grad_year`), plus
 * `highSchoolId` (the catalog link, set by the server) and `privateNote`. The
 * routes and the carry-over to a re-invite use these pure parts.
 */

import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { sameStudentName } from "./imports/heldAddresses.js";
import { infoPatchSchema, type StudentInfo } from "./studentPage.js";

/** The info card's edit plus the private note; strict, so an unknown key (a guardian id, a school link) is refused. */
export const draftInfoPatchSchema = infoPatchSchema.extend({
  privateNote: z.string().max(4000).nullable().optional(),
});

export type DraftInfoPatch = z.infer<typeof draftInfoPatchSchema>;

/**
 * One patch as the database merge takes it: values to store (`set`), keys to
 * drop (`remove`), and the invitation's own class year. A null or "" clears a
 * key, anything else (false and 0 included) is a value.
 */
export function splitDraftPatch(
  patch: DraftInfoPatch,
  highSchoolId?: string | null
): { set: Record<string, unknown>; remove: string[]; gradYear?: number | null } {
  const { gradYear, ...fields } = patch;
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  const put = (key: string, value: unknown) => {
    if (value === null || value === "") remove.push(key);
    else set[key] = value;
  };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) put(key, value);
  // The link follows the typed name: a name with no catalog match, or a cleared one, drops it.
  if (fields.highSchool !== undefined) put("highSchoolId", fields.highSchool && highSchoolId ? highSchoolId : null);
  return gradYear === undefined ? { set, remove } : { set, remove, gradYear: gradYear ? Number(gradYear) : null };
}

/** A stored value read as the info card's own field rule would accept it, else null. */
const read = <T>(field: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): Exclude<T, undefined> | null => {
  const parsed = field.safeParse(value);
  return parsed.success ? ((parsed.data ?? null) as Exclude<T, undefined> | null) : null;
};

/** The invitation as the student page's info card: the draft's values, everything a draft cannot know left empty. */
export function draftInfoView(inv: {
  id: string;
  email: string;
  full_name: string | null;
  grad_year: number | null;
  info: Record<string, unknown> | null;
}): StudentInfo {
  const info = inv.info ?? {};
  const shape = draftInfoPatchSchema.shape;
  const contact = read(shape.email, info.email) || null;
  return {
    studentId: inv.id,
    fullName: inv.full_name ?? "",
    loginEmail: inv.email,
    email: contact ?? inv.email,
    contactEmailSet: contact !== null,
    phone: read(shape.phone, info.phone),
    address: read(shape.address, info.address),
    guardianId: null,
    parentName: read(shape.parentName, info.parentName),
    parentEmail: read(shape.parentEmail, info.parentEmail) || null,
    parentPhone: read(shape.parentPhone, info.parentPhone),
    gender: read(shape.gender, info.gender),
    birthday: read(shape.birthday, info.birthday),
    citizenship: read(shape.citizenship, info.citizenship),
    firstGen: read(shape.firstGen, info.firstGen),
    livingWithParent: read(shape.livingWithParent, info.livingWithParent),
    maritalStatus: read(shape.maritalStatus, info.maritalStatus),
    collegesPlanned: read(shape.collegesPlanned, info.collegesPlanned),
    highSchool: read(shape.highSchool, info.highSchool),
    highSchoolId: typeof info.highSchoolId === "string" ? info.highSchoolId : null,
    gradYear: inv.grad_year === null ? null : String(inv.grad_year),
    gpaWeighted: read(shape.gpaWeighted, info.gpaWeighted),
    gpaUnweighted: read(shape.gpaUnweighted, info.gpaUnweighted),
    gpaScale: read(shape.gpaScale, info.gpaScale),
    classRank: read(shape.classRank, info.classRank),
    classRankDerived: null,
    classRankUnavailableReason: "Available once they join",
    sat: read(shape.sat, info.sat),
    act: read(shape.act, info.act),
    rigor: read(shape.rigor, info.rigor),
    intendedMajors: read(shape.intendedMajors, info.intendedMajors) ?? [],
    applications: 0,
    fromQuestionnaire: [],
  };
}

/** PostgREST's "no such column" answers (invites.ts has the same set; importing it here would be circular). */
const NO_INFO_COLUMN = new Set(["42703", "PGRST204"]);

/**
 * Whose info follows a new invitation: the superseded row's, only for the card's Resend (`resendOf`) or the same
 * non-blank name. Parents often share one address, so a sibling invited there later must never get another child's
 * details. A Resend match wins over a name match; a row with no info is skipped. Null = nothing to carry.
 */
export function pickInfoToCarry(
  rows: { id: string; full_name: string | null; info: unknown }[],
  { newFullName, resendOf }: { newFullName: string | null; resendOf?: string }
): Record<string, unknown> | null {
  const filled = rows.filter((r) => r.info && typeof r.info === "object" && !Array.isArray(r.info) && Object.keys(r.info).length > 0);
  const row = filled.find((r) => r.id === resendOf) ?? filled.find((r) => sameStudentName(r.full_name, newFullName));
  return row ? (row.info as Record<string, unknown>) : null;
}

/**
 * Copy the replaced invitation's `info` onto the new one when `pickInfoToCarry` says it belongs there. The old
 * row keeps its own copy. Best effort and never throws: the invitation is already made, so a failure costs the
 * counselor a re-type, not the invite. Logs the error code only (info holds a minor's birthday and a family's contacts).
 */
export async function carryInvitationInfo(
  request: FastifyRequest,
  supersededIds: string[],
  toId: string,
  newFullName: string | null,
  resendOf?: string
): Promise<void> {
  if (supersededIds.length === 0) return;
  try {
    const { data, error } = await request.db
      .from("invitations")
      .select("id, full_name, info")
      .eq("counselor_id", request.auth.userId)
      .in("id", supersededIds);
    if (error) {
      if (!NO_INFO_COLUMN.has(error.code ?? "")) request.log.warn({ code: error.code }, "invitation info not carried: read failed");
      return;
    }
    const info = pickInfoToCarry((data ?? []) as unknown as Parameters<typeof pickInfoToCarry>[0], { newFullName, resendOf });
    if (!info) return;
    const { error: writeError } = await request.db
      .from("invitations")
      .update({ info })
      .eq("id", toId)
      .eq("counselor_id", request.auth.userId);
    if (writeError) request.log.warn({ code: writeError.code }, "invitation info not carried: write failed");
  } catch (e) {
    request.log.warn({ code: (e as { code?: string })?.code }, "invitation info not carried");
  }
}
