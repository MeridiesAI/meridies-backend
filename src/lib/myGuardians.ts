/**
 * A student's own parents and guardians (`/me/guardians`, migration 20261122000001).
 *
 * The rows are `public.guardians`, the same ones the counselor's Communication page, Parent contacts, blasts and
 * alerts read: a parent the student adds is on the counselor's screens with nothing copied. What the student may do
 * is what the database allows them (the migration's policies and trigger), mirrored here so the app can say it
 * before it tries:
 *
 *   added by the student, not switched on   name, relationship, email, phone; remove      editable "all"
 *   added by the student, switched on       name and relationship only                    editable "name"
 *   added by the counselor (or unknown)      nothing; "Ask your counselor"                editable "none"
 *
 * "Switched on" is `alerts_enabled`: a student's addition starts off and only the counselor turns it on, so a
 * student can never redirect the alerts their counselor sends (20261007000006). Writes go through the caller's
 * client, so RLS is the last word; these checks only give a clearer answer first.
 *
 * Adding a parent (or changing an address) emails them a short notice once (lib/parentNotice.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError, fromPostgrest } from "./errors.js";
import { normEmail } from "./parentCopy.js";

export const MAX_PARENTS = 4;
export const RELATIONSHIPS = ["Mother", "Father", "Guardian", "Other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

const digits = (s: string) => s.replace(/\D/g, "").length;

const name = z.string().trim().min(1, "Add their name").max(120, "Use 120 characters or fewer");
const email = z
  .string()
  .trim()
  .max(254)
  .email("That email doesn't look right")
  .transform((v) => v.toLowerCase());
const phone = z
  .string()
  .trim()
  .max(40)
  .refine((v) => v === "" || (digits(v) >= 7 && digits(v) <= 15), "That phone number doesn't look right")
  .refine((v) => /^[\d\s()+.\-x]*$/i.test(v), "Use digits, spaces, ( ) + - . only")
  .transform((v) => (v === "" ? null : v));

export const addGuardianBody = z
  .object({ name, relationship: z.enum(RELATIONSHIPS), email, phone: phone.nullable().optional() })
  .strict();

export const editGuardianBody = z
  .object({ name, relationship: z.enum(RELATIONSHIPS), email, phone: phone.nullable() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

export type AddGuardianInput = z.infer<typeof addGuardianBody>;
export type EditGuardianInput = z.infer<typeof editGuardianBody>;

/** One guardian row as this module reads it. */
export type GuardianRow = {
  id: string;
  student_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  alerts_enabled: boolean;
  added_by: string | null;
  created_at: string;
};

export type MyGuardian = {
  id: string;
  name: string;
  relationship: string | null;
  email: string | null;
  phone: string | null;
  /** The student added them (onboarding or Settings), not the counselor. */
  addedByMe: boolean;
  /** The counselor has switched messages on for them. */
  receivesMessages: boolean;
  /** What the student may change: everything, the name and relationship only, or nothing. */
  editable: "all" | "name" | "none";
  removable: boolean;
};

export function toMyGuardian(r: GuardianRow, me: string): MyGuardian {
  const mine = r.added_by === me;
  const on = r.alerts_enabled === true;
  return {
    id: r.id,
    name: r.full_name,
    relationship: r.relationship ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    addedByMe: mine,
    receivesMessages: on,
    editable: mine ? (on ? "name" : "all") : "none",
    removable: mine && !on,
  };
}

export const unavailableError = () =>
  new HttpError(503, "Adding parents isn't switched on yet", "guardians_unavailable");
export const lockedError = (who: string) =>
  new HttpError(403, `Your counselor manages ${who}'s details. Ask them to change it.`, "guardian_locked");
export const contactLockedError = () =>
  new HttpError(
    403,
    "Your counselor has switched this parent on, so ask them to change the email or phone.",
    "guardian_contact_locked"
  );
export const notFoundError = () => new HttpError(404, "That parent isn't on your list", "guardian_not_found");
export const duplicateError = (address: string) =>
  new HttpError(409, `${address} is already on your list`, "guardian_exists");
export const fullError = () =>
  new HttpError(409, `You can add up to ${MAX_PARENTS} parents or guardians`, "guardians_full");

/** The storage the routes need. `supabaseGuardianStore` is the real one; tests pass a memory store. */
export interface GuardianStore {
  list(studentId: string): Promise<GuardianRow[]>;
  insert(row: { student_id: string; full_name: string; email: string; phone: string | null; relationship: string }): Promise<GuardianRow>;
  update(id: string, studentId: string, values: Partial<Pick<GuardianRow, "full_name" | "email" | "phone" | "relationship">>): Promise<GuardianRow | null>;
  remove(id: string, studentId: string): Promise<boolean>;
}

const COLUMNS = "id, student_id, full_name, email, phone, relationship, alerts_enabled, added_by, created_at";
/** Postgres "undefined column": the migration isn't applied. */
const notApplied = (e: { code?: string } | null) => e?.code === "42703" || e?.code === "PGRST204";

function fail(error: { code?: string; message?: string }): HttpError {
  if (notApplied(error)) return unavailableError();
  // The trigger's refusal of an email or phone change on a switched-on parent.
  if (error.code === "42501" && /switched this parent on/i.test(error.message ?? "")) return contactLockedError();
  return fromPostgrest(error);
}

/** Through the caller's client: RLS decides, the migration's trigger stamps `added_by`. */
export function supabaseGuardianStore(db: SupabaseClient): GuardianStore {
  return {
    async list(studentId) {
      const { data, error } = await db
        .from("guardians")
        .select(COLUMNS)
        .eq("student_id", studentId)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw fail(error);
      return (data ?? []) as GuardianRow[];
    },
    async insert(row) {
      const { data, error } = await db.from("guardians").insert(row).select(COLUMNS).single();
      if (error) throw fail(error);
      return data as GuardianRow;
    },
    async update(id, studentId, values) {
      const { data, error } = await db
        .from("guardians")
        .update(values)
        .eq("id", id)
        .eq("student_id", studentId)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw fail(error);
      return (data as GuardianRow | null) ?? null;
    },
    async remove(id, studentId) {
      const { data, error } = await db.from("guardians").delete().eq("id", id).eq("student_id", studentId).select("id");
      if (error) throw fail(error);
      return (data ?? []).length > 0;
    },
  };
}

/** The list must come from an API that knows who added each row; a store without `added_by` is "not switched on". */
function assertKnowsAddedBy(rows: GuardianRow[]): void {
  if (rows.some((r) => !("added_by" in r))) throw unavailableError();
}

export async function listMine(store: GuardianStore, me: string): Promise<MyGuardian[]> {
  const rows = await store.list(me);
  assertKnowsAddedBy(rows);
  return rows.map((r) => toMyGuardian(r, me));
}

export type Written = { guardian: MyGuardian; /** The address to send the notice to, when one is due. */ notifyEmail: string | null };

export async function addMine(store: GuardianStore, me: string, input: AddGuardianInput): Promise<Written> {
  const rows = await store.list(me);
  assertKnowsAddedBy(rows);
  const address = normEmail(input.email) as string;
  if (rows.some((r) => normEmail(r.email) === address)) throw duplicateError(address);
  if (rows.length >= MAX_PARENTS) throw fullError();
  const row = await store.insert({
    student_id: me,
    full_name: input.name,
    email: address,
    phone: input.phone ?? null,
    relationship: input.relationship,
  });
  return { guardian: toMyGuardian(row, me), notifyEmail: address };
}

export async function editMine(store: GuardianStore, me: string, id: string, input: EditGuardianInput): Promise<Written> {
  const rows = await store.list(me);
  assertKnowsAddedBy(rows);
  const current = rows.find((r) => r.id === id);
  if (!current) throw notFoundError();
  const view = toMyGuardian(current, me);
  if (view.editable === "none") throw lockedError(current.full_name);

  const values: Partial<Pick<GuardianRow, "full_name" | "email" | "phone" | "relationship">> = {};
  if (input.name !== undefined && input.name !== current.full_name) values.full_name = input.name;
  if (input.relationship !== undefined && input.relationship !== current.relationship) values.relationship = input.relationship;
  const nextEmail = input.email !== undefined ? normEmail(input.email) : normEmail(current.email);
  const emailChanged = input.email !== undefined && nextEmail !== normEmail(current.email);
  if (emailChanged) values.email = nextEmail;
  const phoneChanged = input.phone !== undefined && (input.phone ?? null) !== (current.phone ?? null);
  if (phoneChanged) values.phone = input.phone ?? null;

  if ((emailChanged || phoneChanged) && view.editable !== "all") throw contactLockedError();
  if (emailChanged && rows.some((r) => r.id !== id && normEmail(r.email) === nextEmail)) throw duplicateError(nextEmail as string);
  if (Object.keys(values).length === 0) return { guardian: view, notifyEmail: null };

  const row = await store.update(id, me, values);
  if (!row) throw notFoundError();
  return { guardian: toMyGuardian(row, me), notifyEmail: emailChanged ? nextEmail : null };
}

export async function removeMine(store: GuardianStore, me: string, id: string): Promise<void> {
  const rows = await store.list(me);
  assertKnowsAddedBy(rows);
  const current = rows.find((r) => r.id === id);
  if (!current) throw notFoundError();
  const view = toMyGuardian(current, me);
  if (view.editable === "none") throw lockedError(current.full_name);
  if (!view.removable) {
    throw new HttpError(403, `Your counselor has switched ${current.full_name} on. Ask them to remove them.`, "guardian_locked");
  }
  if (!(await store.remove(id, me))) throw notFoundError();
}
