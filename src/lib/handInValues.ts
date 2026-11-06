/**
 * The values AxIS copies off a handed-in file (20261110000006, AxIS security PR B; spec section 4): a weighted and
 * an unweighted GPA, a class rank and a test score, as printed. They are a list on the check
 * (`deliverable_tracker_checks.extracted_values`), unverified until a counselor who can edit the student confirms
 * them. Confirm (`POST /tasks/:id/checks/:checkId/values/confirm`) also adds them to the profile, under the info
 * card's rules (`infoPatchFrom`, the app's old "Apply to profile" parser, and the GPA-scale check), and only where
 * the profile still holds what the card showed (`apply_hand_in_values`).
 *
 * A model's reading of a scan is never written anywhere on its own: an accepted hand-in only completes its task.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReviewResult } from "./submissionReview.js";
import { serviceClient } from "./supabase.js";

export type HandInKey = "weightedGpa" | "unweightedGpa" | "classRank" | "testScore";
export const HAND_IN_KEYS: readonly HandInKey[] = ["weightedGpa", "unweightedGpa", "classRank", "testScore"];

export type HandInValue = {
  key: HandInKey;
  label: string;
  printed: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmedByName: string | null;
};
/** As the app reads it: with the profile's value now for the column the key writes. */
export type HandInValueRead = HandInValue & { current: string | number | null };

export type HandInPatch = { gpaWeighted?: number; gpaUnweighted?: number; classRank?: string; sat?: number; act?: number };
export type AcademicsColumn = "gpa_weighted" | "gpa_unweighted" | "class_rank" | "sat_superscore" | "act_composite";

export const HAND_IN_VALUES_MIGRATION = "20261110000006_hand_in_values";
export const HAND_IN_VALUES_MISSING = `Confirming hand-in values needs the database update ${HAND_IN_VALUES_MIGRATION}.`;
export const HAND_IN_CHANGED = "This hand-in changed. Reload to see it.";

const LABELS: Record<HandInKey, string> = {
  weightedGpa: "Weighted GPA",
  unweightedGpa: "Unweighted GPA",
  classRank: "Class rank",
  testScore: "Test score",
};
const KEY_BY_LABEL = new Map(Object.entries(LABELS).map(([k, l]) => [l, k as HandInKey]));
const unverifiedLine = (label: string, value: string) => `${label} (unverified, from the student's file): ${value}`;

// ---- The info card's rules (were the app's figuresToInfoPatch) ----

const gpa = (printed: string): number | null => {
  const t = printed.trim();
  if (!/^\d(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 6 ? n : null;
};
const rank = (printed: string): string | null => {
  const t = printed.trim();
  return t.length <= 40 && /^\d+\s*(of|\/)\s*\d+$/.test(t) ? t : null;
};
// A section named before the number ("SAT Math 720", "ACT Science 30") is not the total the profile keeps.
const SAT_SECTION = /math|reading|writing|ebrw|verbal|section/i;
const ACT_SECTION = /english|math|reading|science|writing|section/i;
const score = (printed: string): { sat: number } | { act: number } | null => {
  const sat = /\bSAT\b([^\d]*)(\d{3,4})\b/i.exec(printed);
  if (sat) {
    const n = Number(sat[2]);
    return !SAT_SECTION.test(sat[1] ?? "") && n >= 400 && n <= 1600 && n % 10 === 0 ? { sat: n } : null;
  }
  const act = /\bACT\b([^\d]*)(\d{1,2})\b/i.exec(printed);
  if (act) {
    const n = Number(act[2]);
    return !ACT_SECTION.test(act[1] ?? "") && n >= 1 && n <= 36 ? { act: n } : null;
  }
  return null;
};

/**
 * The profile patch the values make: only plausible ones (a GPA 0-6, "N of M" up to 40 characters, an SAT total
 * 400-1600 by 10, an ACT composite 1-36; a section score is neither).
 */
export function infoPatchFrom(values: Pick<HandInValue, "key" | "printed">[]): HandInPatch {
  const patch: HandInPatch = {};
  for (const v of values) {
    if (v.key === "weightedGpa" || v.key === "unweightedGpa") {
      const n = gpa(v.printed);
      if (n === null) continue;
      if (v.key === "weightedGpa") patch.gpaWeighted = n;
      else patch.gpaUnweighted = n;
    } else if (v.key === "classRank") {
      const r = rank(v.printed);
      if (r) patch.classRank = r;
    } else {
      Object.assign(patch, score(v.printed) ?? {});
    }
  }
  return patch;
}

/** The academics column a value writes, or null when the profile can't take it. */
export function columnFor(key: HandInKey, printed: string): AcademicsColumn | null {
  if (key === "weightedGpa") return "gpa_weighted";
  if (key === "unweightedGpa") return "gpa_unweighted";
  if (key === "classRank") return "class_rank";
  const s = score(printed);
  return s === null ? null : "sat" in s ? "sat_superscore" : "act_composite";
}

/** The value the patch writes to a column. */
export function patchValue(patch: HandInPatch, column: AcademicsColumn): string | number | undefined {
  switch (column) {
    case "gpa_weighted": return patch.gpaWeighted;
    case "gpa_unweighted": return patch.gpaUnweighted;
    case "class_rank": return patch.classRank;
    case "sat_superscore": return patch.sat;
    case "act_composite": return patch.act;
  }
}

// ---- From a review ----

/** Which printed test score becomes the value: the first the profile can take, else the first. */
function chosenTestScore(result: ReviewResult): string | null {
  const scores = result.facts.filter((f) => f.label === LABELS.testScore).map((f) => f.value);
  return scores.find((s) => score(s) !== null) ?? scores[0] ?? null;
}

/** The values a review read off the file, one per key, unverified. */
export function valuesFrom(result: ReviewResult): HandInValue[] {
  const test = chosenTestScore(result);
  const out: HandInValue[] = [];
  for (const key of HAND_IN_KEYS) {
    const printed = key === "testScore" ? test : (result.facts.find((f) => f.label === LABELS[key])?.value ?? null);
    if (printed) out.push({ key, label: LABELS[key], printed, confirmedAt: null, confirmedBy: null, confirmedByName: null });
  }
  return out;
}

/** The check's findings and the counselor's notice: every value as a labelled line, then what AxIS noticed. */
export function fallbackFindings(result: ReviewResult): string[] {
  return [...result.facts.map((f) => unverifiedLine(f.label, f.value)), ...result.findings].slice(0, 14);
}

// ---- Stored and read ----

/** The stored list, re-validated (it is jsonb the server wrote, read back). Null when the column isn't there. */
export function storedValues(raw: unknown): HandInValue[] | null {
  if (!Array.isArray(raw)) return null;
  const out: HandInValue[] = [];
  for (const item of raw) {
    const v = (item ?? {}) as Record<string, unknown>;
    const key = typeof v.key === "string" && (HAND_IN_KEYS as readonly string[]).includes(v.key) ? (v.key as HandInKey) : null;
    if (!key || typeof v.printed !== "string" || out.some((o) => o.key === key)) continue;
    out.push({
      key,
      label: typeof v.label === "string" && KEY_BY_LABEL.has(v.label) ? v.label : LABELS[key],
      printed: v.printed,
      confirmedAt: typeof v.confirmedAt === "string" ? v.confirmedAt : null,
      confirmedBy: typeof v.confirmedBy === "string" ? v.confirmedBy : null,
      confirmedByName: typeof v.confirmedByName === "string" ? v.confirmedByName : null,
    });
  }
  return out;
}

/** Each value with the profile's value now for its column (`academics` is the student's student_academics row). */
export function withCurrent(values: HandInValue[], academics: Record<string, unknown> | null | undefined): HandInValueRead[] {
  return values.map((v) => {
    const column = columnFor(v.key, v.printed);
    const now = column && academics ? academics[column] : null;
    return { ...v, current: typeof now === "number" || typeof now === "string" ? now : null };
  });
}

/** The academics columns a read needs, for every student in it, in one query. */
export const ACADEMICS_COLUMNS = "student_id, gpa_weighted, gpa_unweighted, class_rank, sat_superscore, act_composite";

/**
 * Marks the confirmed keys on the check (service client: the column has no client grant). The route has checked
 * the caller may edit the student, that the check is the task's, and what each value was.
 */
export async function stampConfirmed(
  checkId: string,
  values: HandInValue[],
  keys: HandInKey[],
  by: { id: string; name: string | null }
): Promise<HandInValue[]> {
  const svc = serviceClient();
  if (!svc) throw new Error("hand-in values: no service client");
  if (keys.length === 0) return values;
  const at = new Date().toISOString();
  const next = values.map((v) => (keys.includes(v.key) ? { ...v, confirmedAt: at, confirmedBy: by.id, confirmedByName: by.name } : v));
  const { error } = await svc.from("deliverable_tracker_checks").update({ extracted_values: next }).eq("id", checkId);
  if (error) throw new Error(`hand-in values stamp: ${error.message}`);
  return next;
}

/**
 * The academics rows a read's values are compared with, by student: one query, and none when no check has values.
 * An unreadable row reads as no value now (the card then shows the value without the profile's beside it).
 */
export async function academicsFor(db: SupabaseClient, checks: Record<string, unknown>[]): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(checks.filter((c) => Array.isArray(c.extracted_values) && c.extracted_values.length > 0).map((c) => String(c.student_id)))];
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from("student_academics").select(ACADEMICS_COLUMNS).in("student_id", ids);
  if (error) return out;
  for (const row of (data ?? []) as Record<string, unknown>[]) out.set(String(row.student_id), row);
  return out;
}
