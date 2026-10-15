/**
 * What an import may write (spec §4.1): import_fields is the one list, read
 * from the database and cached per process. The parts of a multi-row target
 * ('*' rows) are fixed by its value_type validator (values.ts), so they are
 * described here.
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "../errors.js";

export type FieldDef = { table: string; field: string; valueType: string; sensitivity: number };

export const SINGLE_TABLES = ["student_academics", "student_personal_details"] as const;
export const ROW_TABLES = ["test_scores", "courses", "activities"] as const;
export type RowTable = (typeof ROW_TABLES)[number];

/** Each part of a row target, with the value_type it is cleaned as. */
export const ROW_PARTS: Record<RowTable, Record<string, string>> = {
  test_scores: { exam: "text:200", kind: "enum:test_kind", score: "text:40", taken_on: "date" },
  courses: { name: "text:300", type: "enum:course_type", grade: "text:40", status: "enum:course_status", school_year: "text:40" },
  activities: {
    name: "text:300", position: "text:200", organization: "text:200", category: "text:100",
    hours_per_week: "number:0-168", weeks_per_year: "integer:0-52", description: "text:2000", grade_levels: "text[]",
  },
};

/** The part a row cannot do without. */
export const ROW_REQUIRED: Record<RowTable, string> = { test_scores: "exam", courses: "name", activities: "name" };

export const KEY_KINDS = ["email", "full_name", "first_name", "last_name", "grad_year", "high_school"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

let cache: { at: number; fields: FieldDef[] } | null = null;
const TTL_MS = 10 * 60_000;

/** import_fields, on the caller's client (authenticated may read it). */
export async function loadFields(request: FastifyRequest): Promise<FieldDef[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.fields;
  const { data, error } = await request.db
    .from("import_fields")
    .select("target_table, field, value_type, sensitivity")
    .order("target_table")
    .order("field");
  if (error) throw fromPostgrest(error);
  const fields = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    table: String(r.target_table),
    field: String(r.field),
    valueType: String(r.value_type),
    sensitivity: Number(r.sensitivity),
  }));
  cache = { at: Date.now(), fields };
  return fields;
}

export function findField(fields: FieldDef[], table: string, field: string): FieldDef | undefined {
  return fields.find((f) => f.table === table && f.field === field);
}

/** Single-row fields a column may map to. */
export function singleFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter((f) => (SINGLE_TABLES as readonly string[]).includes(f.table) && f.field !== "*");
}
