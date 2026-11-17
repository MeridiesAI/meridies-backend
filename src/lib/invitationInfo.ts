/**
 * What a counselor fills in for a student who has not joined yet
 * (`invitations.info`, `20261127000001`). The keys are the info card's own
 * (`infoPatchSchema`) minus `gradYear` (that is `invitations.grad_year`), plus
 * `highSchoolId` (the catalog link, set by the server) and `privateNote`. The
 * routes and the carry-over to a re-invite use these pure parts.
 */

import { z } from "zod";
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
