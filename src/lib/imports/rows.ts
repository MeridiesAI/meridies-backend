/**
 * Apply a confirmed plan to parsed rows (spec §5.4): each spreadsheet row
 * becomes a record of student keys and cleaned values. Deterministic: no
 * model, no conversion. A value that still fails its value_type after
 * cleanup is kept, marked invalid, for a manual fix in review; a value with
 * an SSN shape is dropped outright and only counted (§7.4).
 */

import { findField, ROW_PARTS, ROW_REQUIRED, type FieldDef, type RowTable } from "./fields.js";
import type { ParsePlan, PlanColumn } from "./plan.js";
import { blockValue, flagValue } from "./sensitive.js";
import type { ParsedSheet } from "./sheet.js";
import { isEmailShape } from "./textShapes.js";
import { cleanCell, cleanEnum, parseDate, parseNumber, testKindOf, valueOk, type Json } from "./values.js";

export type RecordKey = {
  email: string | null;
  name: string | null;
  birthday: string | null;
  gradYear: number | null;
  highSchool: string | null;
};

export type RecordValue = {
  table: string;
  field: string;
  op: "set_field" | "insert_row";
  value: Json;
  invalid: boolean;
  sourceRef: string;
  sourceColumn: string;
  patternKey: string;
  flags: string[];
};

export type SheetRecord = {
  fileId: string;
  sheet: string;
  rowRef: string;
  key: RecordKey;
  values: RecordValue[];
};

export type ParsedFile = { fileId: string; filename: string; sheets: ParsedSheet[] };

export type ApplyResult = {
  records: SheetRecord[];
  rows: number;
  blocked: number;
  /** Files mapped by a template where 20% or more of the mapped cells failed (§5.4). */
  drift: string[];
};

export function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function gradYearOf(raw: string): number | null {
  const m = /(?:^|\D)((?:19|20|21)\d{2})(?:\D|$)/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1990 && y <= 2100 ? y : null;
}

function nameFrom(full: string | null, first: string | null, last: string | null, order: "first-last" | "last-first" | undefined): string | null {
  if (full && full.trim()) {
    const f = full.trim().replace(/\s+/g, " ");
    if (order === "last-first" && !f.includes(",")) {
      const parts = f.split(" ");
      return parts.length > 1 ? `${parts.slice(1).join(" ")} ${parts[0]}` : f;
    }
    return f;
  }
  const n = [first?.trim(), last?.trim()].filter(Boolean).join(" ");
  return n || null;
}

/** One part of a row target, cleaned. Null when it doesn't parse. */
function cleanPart(type: string, raw: string, date: PlanColumn["parse"]): Json | null {
  const s = raw.trim();
  if (type.startsWith("text:")) {
    const v = s.replace(/\s+/g, " ");
    return v.length <= Number(type.slice(5)) ? v : null;
  }
  switch (type) {
    case "enum:test_kind": return cleanEnum("test_kind", s);
    case "enum:course_type": return cleanEnum("course_type", s);
    case "enum:course_status": return cleanEnum("course_status", s);
    case "date": return parseDate(s, date?.date);
    case "number:0-168": {
      const n = parseNumber(s, date?.number === "comma-decimal");
      return n !== null && n >= 0 && n <= 168 ? n : null;
    }
    case "integer:0-52": {
      const n = parseNumber(s);
      return n !== null && Number.isInteger(n) && n >= 0 && n <= 52 ? n : null;
    }
    case "text[]": {
      const c = cleanCell("text[]", s);
      return c.ok ? c.value : null;
    }
  }
  return null;
}

export function applyPlan(plan: ParsePlan, files: ParsedFile[], fields: FieldDef[], templateFiles: Set<string> = new Set()): ApplyResult {
  const records: SheetRecord[] = [];
  let rows = 0;
  let blocked = 0;
  const cells = new Map<string, { total: number; invalid: number }>();

  for (const ps of plan.sheets) {
    const file = files.find((f) => f.fileId === ps.fileId);
    const sheet = file?.sheets.find((s) => s.name === ps.sheet);
    if (!file || !sheet) continue;
    const mapsScale = ps.columns.some((c) => c.target.kind === "field" && c.target.field === "gpa_scale");
    const tally = cells.get(file.fileId) ?? { total: 0, invalid: 0 };
    cells.set(file.fileId, tally);

    sheet.rows.forEach((r, ri) => {
      const rowNumber = sheet.rowNumbers[ri];
      const rowRef = cap(`${sheet.name}!${rowNumber}`, 200);
      const cell = (c: PlanColumn) => (r[c.index] ?? "").trim();
      const keyCol = (k: string) => ps.columns.find((c) => c.target.kind === "key" && c.target.key === k);
      const raw = (k: string) => {
        const c = keyCol(k);
        return c ? cell(c) || null : null;
      };
      const emailRaw = raw("email")?.toLowerCase() ?? null;
      const fullCol = keyCol("full_name");
      const key: RecordKey = {
        email: emailRaw && emailRaw.length <= 320 && isEmailShape(emailRaw) ? emailRaw : null,
        name: cap(nameFrom(raw("full_name"), raw("first_name"), raw("last_name"), fullCol?.parse?.name) ?? "", 200) || null,
        birthday: null,
        gradYear: raw("grad_year") ? gradYearOf(raw("grad_year") as string) : null,
        highSchool: raw("high_school") ? cap((raw("high_school") as string).replace(/\s+/g, " "), 200) : null,
      };
      const values: RecordValue[] = [];
      const groups = new Map<string, { table: RowTable; parts: Record<string, Json>; bad: Record<string, string>; cols: string[]; flags: Set<string> }>();
      let gpaScaleFromCell: string | null = null;
      let hasGpa = false;

      for (const c of ps.columns) {
        const t = c.target;
        if (t.kind === "ignore" || t.kind === "key") continue;
        const v = cell(c);
        if (v === "") continue;
        const header = sheet.headers[c.index] ?? "";
        if (blockValue(v, header)) {
          blocked += 1;
          continue;
        }
        const flags = flagValue(v, header) ? ["nine_digit_id"] : [];
        const ref = cap(`${sheet.name}!${columnLetter(c.index)}${rowNumber}`, 200);
        const sourceColumn = cap(header, 200);
        tally.total += 1;

        if (t.kind === "field") {
          const def = findField(fields, t.table, t.field);
          if (!def) continue;
          const cleaned = cleanCell(def.valueType, v, { date: c.parse?.date, commaDecimal: c.parse?.number === "comma-decimal" });
          if (!cleaned.ok) tally.invalid += 1;
          values.push({
            table: t.table,
            field: t.field,
            op: "set_field",
            value: cleaned.ok ? cleaned.value : cap(v, 2000),
            invalid: !cleaned.ok,
            sourceRef: ref,
            sourceColumn,
            patternKey: cap(`${t.table}.${t.field}|${sheet.name}!${columnLetter(c.index)}`, 200),
            flags,
          });
          if (cleaned.ok && def.valueType === "gpa") hasGpa = true;
          if (cleaned.ok && cleaned.scale) gpaScaleFromCell = cleaned.scale;
          if (t.table === "student_personal_details" && t.field === "birthday" && cleaned.ok) key.birthday = cleaned.value as string;
        } else if (t.kind === "row") {
          const gk = `${t.table}:${t.group}`;
          const g = groups.get(gk) ?? { table: t.table as RowTable, parts: {}, bad: {}, cols: [], flags: new Set<string>() };
          groups.set(gk, g);
          const type = ROW_PARTS[t.table as RowTable][t.part];
          const cleaned = cleanPart(type, v, c.parse);
          if (cleaned === null) g.bad[t.part] = cap(v, 2000);
          else g.parts[t.part] = cleaned;
          g.cols.push(columnLetter(c.index));
          flags.forEach((f) => g.flags.add(f));
        } else {
          const score = v.length <= 40 ? v : null;
          const row = { exam: t.exam, kind: t.testKind, ...(score ? { score } : {}) };
          const ok = score !== null && valueOk("row:test_score", row);
          if (!ok) tally.invalid += 1;
          values.push({
            table: "test_scores",
            field: "*",
            op: "insert_row",
            value: ok ? row : { exam: t.exam, kind: t.testKind, score: cap(v, 2000) },
            invalid: !ok,
            sourceRef: ref,
            sourceColumn,
            patternKey: cap(`test_scores|${sheet.name}!${columnLetter(c.index)}`, 200),
            flags,
          });
        }
      }

      for (const g of groups.values()) {
        const parts: Record<string, Json> = { ...g.parts };
        if (g.table === "test_scores" && typeof parts.exam === "string" && parts.kind === undefined) parts.kind = testKindOf(parts.exam);
        const invalid = Object.keys(g.bad).length > 0 || !(ROW_REQUIRED[g.table] in parts) || !valueOk(`row:${g.table === "test_scores" ? "test_score" : g.table === "courses" ? "course" : "activity"}`, parts);
        if (invalid) tally.invalid += 1;
        values.push({
          table: g.table,
          field: "*",
          op: "insert_row",
          value: invalid ? { ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])), ...g.bad } : parts,
          invalid,
          sourceRef: rowRef,
          sourceColumn: cap(g.cols.join(", "), 200),
          patternKey: cap(`${g.table}|${sheet.name}!${g.cols.join("")}`, 200),
          flags: [...g.flags],
        });
      }

      // The scale a GPA was written on: from "3.8/4.0" in the cell, else the
      // plan's constant, unless a column already maps it.
      const scale = mapsScale ? null : gpaScaleFromCell ?? (hasGpa ? plan.constants.gpaScale ?? null : null);
      if (scale && hasGpa) {
        values.push({
          table: "student_academics",
          field: "gpa_scale",
          op: "set_field",
          value: scale,
          invalid: false,
          sourceRef: rowRef,
          sourceColumn: "GPA scale",
          patternKey: cap(`student_academics.gpa_scale|${sheet.name}!scale`, 200),
          flags: [],
        });
      }

      rows += 1;
      if (values.length > 0 || key.email || key.name) {
        records.push({ fileId: file.fileId, sheet: sheet.name, rowRef, key, values });
      }
    });
  }

  const drift = [...cells.entries()]
    .filter(([fileId, t]) => templateFiles.has(fileId) && t.total >= 5 && t.invalid / t.total >= 0.2)
    .map(([fileId]) => fileId);
  return { records, rows, blocked, drift };
}
