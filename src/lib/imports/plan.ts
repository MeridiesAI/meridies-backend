/**
 * The parse plan (spec §5.3): which column of which sheet goes where, plus
 * parsing hints. It parses; it never converts a value. It is kept on
 * roster_imports.plan and, per file, in a template.
 *
 * validatePlan is the gate every plan passes, whoever wrote it (presets, a
 * template, the model or the counselor): unknown files, sheets, columns and
 * fields are refused, and a column whose header names a never-stored
 * category is forced to ignore.
 */

import { z } from "zod";
import { MAX_COLUMNS } from "./caps.js";
import { findField, KEY_KINDS, ROW_PARTS, ROW_REQUIRED, ROW_TABLES, SINGLE_TABLES, type FieldDef, type RowTable } from "./fields.js";
import type { FileProfile } from "./profile.js";
import { TEST_KINDS } from "./values.js";

export const SOURCE_SYSTEMS = [
  "naviance", "scoir", "cialfo", "hubspot", "collegeplannerpro", "counselmore", "gradbetter", "other", "unknown",
] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ignore") }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(KEY_KINDS) }).strict(),
  z.object({ kind: z.literal("field"), table: z.enum(SINGLE_TABLES), field: z.string().min(1).max(63) }).strict(),
  z.object({
    kind: z.literal("row"),
    table: z.enum(ROW_TABLES),
    group: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/),
    part: z.string().min(1).max(40),
  }).strict(),
  z.object({ kind: z.literal("score_column"), exam: z.string().trim().min(1).max(80), testKind: z.enum(TEST_KINDS) }).strict(),
]);
export type Target = z.infer<typeof targetSchema>;

export const parseHintsSchema = z
  .object({
    date: z.enum(["MDY", "DMY", "YMD", "excel1900", "excel1904"]).optional(),
    number: z.enum(["plain", "comma-decimal"]).optional(),
    name: z.enum(["first-last", "last-first"]).optional(),
  })
  .strict();

export const columnSchema = z
  .object({
    index: z.number().int().min(0).max(MAX_COLUMNS - 1),
    target: targetSchema,
    parse: parseHintsSchema.optional(),
    source: z.enum(["preset", "template", "ai", "counselor"]),
  })
  .strict();
export type PlanColumn = z.infer<typeof columnSchema>;

const sheetSchema = z
  .object({
    fileId: z.string().uuid(),
    sheet: z.string().min(1).max(60),
    layout: z.enum(["row-per-student", "row-per-student-per-record"]).optional(),
    columns: z.array(columnSchema).max(MAX_COLUMNS),
  })
  .strict();
export type PlanSheet = z.infer<typeof sheetSchema>;

export const constantsSchema = z.object({ gpaScale: z.string().trim().min(1).max(20).optional() }).strict();

export const parsePlanSchema = z
  .object({
    version: z.literal(1),
    sheets: z.array(sheetSchema).max(400),
    constants: constantsSchema,
    sourceSystem: z.enum(SOURCE_SYSTEMS),
  })
  .strict();
export type ParsePlan = z.infer<typeof parsePlanSchema>;

/** A template: one file's sheets, in order, with no file id or sheet names. */
export const templatePlanSchema = z
  .object({
    version: z.literal(1),
    sheets: z.array(z.object({ columns: z.array(columnSchema).max(MAX_COLUMNS) }).strict()).max(50),
    constants: constantsSchema,
    sourceSystem: z.enum(SOURCE_SYSTEMS),
  })
  .strict();
export type TemplatePlan = z.infer<typeof templatePlanSchema>;

export type ProfiledFile = { fileId: string; filename: string; profile: FileProfile };

export type Forced = { fileId: string; sheet: string; index: number; header: string };
export type PlanCheck = { plan: ParsePlan; problems: string[]; forced: Forced[] };

const label = (t: Target): string =>
  t.kind === "field" ? `${t.table}.${t.field}` : t.kind === "key" ? `key ${t.key}` : t.kind === "row" ? `${t.table}.${t.part}` : t.kind;

/**
 * Check a plan against the files and import_fields. Returns the plan with
 * sensitive columns forced to ignore, and every problem (empty: valid).
 */
export function validatePlan(input: ParsePlan, files: ProfiledFile[], fields: FieldDef[]): PlanCheck {
  const problems: string[] = [];
  const forced: Forced[] = [];
  const seenSheets = new Set<string>();
  const sheets: PlanSheet[] = [];
  for (const s of input.sheets) {
    const file = files.find((f) => f.fileId === s.fileId);
    const prof = file?.profile.sheets.find((p) => p.name === s.sheet);
    if (!file || !prof) {
      problems.push("The mapping names a sheet that isn't in this import");
      continue;
    }
    const sheetKey = `${s.fileId}|${s.sheet}`;
    if (seenSheets.has(sheetKey)) {
      problems.push(`${s.sheet} is mapped twice`);
      continue;
    }
    seenSheets.add(sheetKey);
    const columns: PlanColumn[] = [];
    const seenIndex = new Set<number>();
    const seenTargets = new Map<string, number>();
    for (const c of s.columns) {
      const col = prof.columns[c.index];
      if (!col) {
        problems.push(`${s.sheet} has no column ${c.index + 1}`);
        continue;
      }
      if (seenIndex.has(c.index)) {
        problems.push(`${s.sheet}: the column "${col.header}" is mapped twice`);
        continue;
      }
      seenIndex.add(c.index);
      if (col.sensitive && c.target.kind !== "ignore") {
        forced.push({ fileId: s.fileId, sheet: s.sheet, index: c.index, header: col.header });
        columns.push({ ...c, target: { kind: "ignore" } });
        continue;
      }
      const t = c.target;
      if (t.kind === "field") {
        const f = findField(fields, t.table, t.field);
        if (!f || f.field === "*") {
          problems.push(`${t.table}.${t.field} isn't something an import can fill`);
          continue;
        }
      }
      if (t.kind === "row" && !(t.part in ROW_PARTS[t.table as RowTable])) {
        problems.push(`${t.table} has no part called ${t.part}`);
        continue;
      }
      if (t.kind !== "ignore" && t.kind !== "score_column") {
        const k = t.kind === "row" ? `row:${t.table}:${t.group}:${t.part}` : label(t);
        if (seenTargets.has(k)) {
          problems.push(`${s.sheet}: two columns are mapped to ${label(t)}`);
          continue;
        }
        seenTargets.set(k, c.index);
      }
      columns.push(c);
    }
    // Every row group needs its required part.
    const groups = new Map<string, Set<string>>();
    for (const c of columns) {
      if (c.target.kind !== "row") continue;
      const g = `${c.target.table}:${c.target.group}`;
      if (!groups.has(g)) groups.set(g, new Set());
      groups.get(g)!.add(c.target.part);
    }
    for (const [g, parts] of groups) {
      const table = g.split(":")[0] as RowTable;
      if (!parts.has(ROW_REQUIRED[table])) {
        problems.push(`${s.sheet}: ${table.replace("_", " ")} need a column for the ${ROW_REQUIRED[table]}`);
      }
    }
    const keys = new Set(columns.flatMap((c) => (c.target.kind === "key" ? [c.target.key] : [])));
    const mapsData = columns.some((c) => c.target.kind !== "ignore" && c.target.kind !== "key");
    if (mapsData && !(keys.has("email") || keys.has("full_name") || (keys.has("first_name") && keys.has("last_name")))) {
      problems.push(`${s.sheet}: map a column to the student's email or name`);
    }
    sheets.push({ ...s, columns });
  }
  if (!sheets.some((s) => s.columns.some((c) => c.target.kind !== "ignore" && c.target.kind !== "key"))) {
    problems.push("Map at least one column to something to import");
  }
  return { plan: { ...input, sheets }, problems, forced };
}

/** Drop row-part mappings whose group lacks its required part (a preset or the model guessed alone). */
export function dropIncompleteGroups(columns: PlanColumn[]): PlanColumn[] {
  const parts = new Map<string, Set<string>>();
  for (const c of columns) {
    if (c.target.kind !== "row") continue;
    const g = `${c.target.table}:${c.target.group}`;
    if (!parts.has(g)) parts.set(g, new Set());
    parts.get(g)!.add(c.target.part);
  }
  return columns.filter((c) => {
    if (c.target.kind !== "row") return true;
    return parts.get(`${c.target.table}:${c.target.group}`)?.has(ROW_REQUIRED[c.target.table as RowTable]) ?? false;
  });
}

/** A template's columns applied to one file (sheet i to sheet i). */
export function planFromTemplate(t: TemplatePlan, file: ProfiledFile): PlanSheet[] | null {
  if (t.sheets.length !== file.profile.sheets.length) return null;
  return file.profile.sheets.map((s, i) => ({
    fileId: file.fileId,
    sheet: s.name,
    columns: t.sheets[i].columns
      .filter((c) => c.index < s.columns.length)
      .map((c) => ({ ...c, source: "template" as const })),
  }));
}

/** The plan's sheets for one file, as a template. */
export function templateFrom(plan: ParsePlan, file: ProfiledFile): TemplatePlan {
  return {
    version: 1,
    sheets: file.profile.sheets.map((s) => ({
      columns: plan.sheets.find((p) => p.fileId === file.fileId && p.sheet === s.name)?.columns ?? [],
    })),
    constants: plan.constants,
    sourceSystem: plan.sourceSystem,
  };
}
