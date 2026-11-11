/**
 * What a student's parents receive: the counselor's per-student switches for the kinds of information that
 * Meridies sends a family on its own (there is no parent login or portal; a family only ever receives email and
 * text). Every switch is on by default, which is exactly what was sent before the switches existed.
 *
 * The kinds are the ones something automatic actually sends today:
 *  - `tasks`     the weekly family report's "Finished this week" and "Coming up or overdue" sections, and the
 *                escalation sweep's parent alert about stalled work (its subject names the task);
 *  - `colleges`  the weekly report's "College deadlines in the next two weeks" (it names schools on the list);
 *  - `essays`    the weekly report's essay word counts (never essay text: the digest never carries any).
 * The composer, a hand-sent parent alert, a blast and a meeting the counselor invites the parents to are written
 * or decided by the counselor at that moment, so they are not filtered (the composer shows the switches as a
 * reminder).
 *
 * Stored on `student_alert_prefs` (counselor-written, student-readable), one boolean column per kind
 * (`parents_get_tasks`, `parents_get_colleges`, `parents_get_essays`, all `not null default true`). Until that
 * migration is applied the columns aren't there: reads answer `available: false` with everything on (what is sent
 * today), and a save answers 503 `family_visibility_unavailable`.
 *
 * Decided at send time and failing closed: a read that errors throws (the caller holds or refuses the send), the
 * same rule as `loadAlertPrefs`. An absent row is the default; an errored query is not.
 *
 * The weekly report is filtered from its stored text, section by section (`DIGEST_HEADERS`), so with every switch
 * on the text is returned untouched: nothing a family receives changes until a counselor switches something off.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fromPostgrest } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import { DIGEST_HEADERS } from "./weeklyDigestContent.js";

export const FAMILY_CATEGORIES = ["tasks", "colleges", "essays"] as const;
export type FamilyCategory = (typeof FAMILY_CATEGORIES)[number];
export type FamilyVisibility = Record<FamilyCategory, boolean>;

/** The column on `student_alert_prefs` that holds each switch. */
export const FAMILY_COLUMNS: Record<FamilyCategory, string> = {
  tasks: "parents_get_tasks",
  colleges: "parents_get_colleges",
  essays: "parents_get_essays",
};

/** How a kind is named to the counselor, in a reason or a "left out" line. */
export const FAMILY_LABELS: Record<FamilyCategory, string> = {
  tasks: "Tasks and overdue work",
  colleges: "College deadlines",
  essays: "Essay progress",
};

/** Everything on: what a family received before these switches existed. */
export const DEFAULT_FAMILY_VISIBILITY: FamilyVisibility = { tasks: true, colleges: true, essays: true };

export const FAMILY_VISIBILITY_UNAVAILABLE = "family_visibility_unavailable";
export const FAMILY_VISIBILITY_UNAVAILABLE_MESSAGE = "Choosing what the parents receive isn't switched on yet";

export type FamilyVisibilityState = { available: boolean; visibility: FamilyVisibility; updatedAt: string | null };

/**
 * A row's switches. Only an explicit `true` (or a column that isn't on the row at all, which is the default)
 * reads as on; any other value reads as off, so a value nobody expected never widens what a family receives.
 */
export function visibilityFromRow(row: Record<string, unknown> | null | undefined): FamilyVisibility {
  const out = { ...DEFAULT_FAMILY_VISIBILITY };
  if (!row) return out;
  for (const c of FAMILY_CATEGORIES) {
    const v = row[FAMILY_COLUMNS[c]];
    out[c] = v === undefined || v === true;
  }
  return out;
}

/**
 * The student's switches. Throws on a read error (fail closed). Before the migration the columns are missing,
 * which reads as `available: false` and everything on: nothing can have been switched off yet.
 */
export async function loadFamilyVisibility(db: SupabaseClient, studentId: string): Promise<FamilyVisibilityState> {
  const cols = ["updated_at", ...FAMILY_CATEGORIES.map((c) => FAMILY_COLUMNS[c])].join(", ");
  const { data, error } = await db.from("student_alert_prefs").select(cols).eq("student_id", studentId).maybeSingle();
  if (error) {
    if (isResultsNotApplied(error)) return { available: false, visibility: { ...DEFAULT_FAMILY_VISIBILITY }, updatedAt: null };
    throw fromPostgrest(error);
  }
  const row = (data ?? null) as Record<string, unknown> | null;
  return {
    available: true,
    visibility: visibilityFromRow(row),
    updatedAt: row && typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export const hiddenCategories = (v: FamilyVisibility): FamilyCategory[] => FAMILY_CATEGORIES.filter((c) => !v[c]);
export const allShown = (v: FamilyVisibility): boolean => hiddenCategories(v).length === 0;

/** "Essay progress" / "Tasks and overdue work and Essay progress", for a reason. */
export function labelList(categories: FamilyCategory[]): string {
  const names = categories.map((c) => FAMILY_LABELS[c]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---- The weekly report -----------------------------------------------------------------------------------------

/** Which kind a body paragraph (a digest section) belongs to, by its first words; null for the intro or anything else. */
export function sectionCategory(paragraph: string): FamilyCategory | null {
  const p = paragraph.trimStart();
  if (p.startsWith(DIGEST_HEADERS.finished) || p.startsWith(DIGEST_HEADERS.upcoming)) return "tasks";
  if (p.startsWith(DIGEST_HEADERS.collegeDeadlines)) return "colleges";
  if (p.startsWith(DIGEST_HEADERS.essays)) return "essays";
  return null;
}

/** Which kind one of the summary's or highlights' counts belongs to ("2 tasks finished", "essays +120 words"). */
export function phraseCategory(phrase: string): FamilyCategory | null {
  const p = phrase.trim();
  if (/^\d+ tasks? finished$/.test(p) || /^\d+ overdue$/.test(p) || /^\d+ due in the next two weeks$/.test(p)) return "tasks";
  if (/^\d+ college deadlines? coming up$/.test(p)) return "colleges";
  if (/^essays [+-]\d+ words$/.test(p) || /: \d+ words, [+-]\d+ this week$/.test(p)) return "essays";
  return null;
}

const paragraphs = (body: string) => body.split(/\n{2,}/);

/**
 * The summary (the text a parent's phone receives) with the hidden kinds' counts taken out:
 * "Maya's week (Nov 2 to Nov 8): 2 tasks finished, essays +120 words." With nothing hidden it is returned as is.
 * A count that can't be told apart is dropped too, and a summary that isn't the digest's shape becomes null (the
 * text then falls back to the filtered body), so filtering never keeps something it can't vouch for.
 */
export function filterDigestSummary(summary: string | null, v: FamilyVisibility): string | null {
  if (summary === null || allShown(v)) return summary;
  const at = summary.indexOf("): ");
  if (at < 0 || !summary.endsWith(".")) return null;
  const prefix = summary.slice(0, at + 1);
  const kept = summary
    .slice(at + 3, -1)
    .split(", ")
    .filter((part) => {
      const c = phraseCategory(part);
      return c !== null && v[c];
    });
  return kept.length ? `${prefix}: ${kept.join(", ")}.` : `${prefix}.`;
}

export type DigestReport = { title: string; summary: string | null; body: string | null; highlights?: string[] | null };

export type FilteredReport<T extends DigestReport> = {
  report: T;
  /** Kinds that were switched off AND had something in this report: what was left out. */
  leftOut: FamilyCategory[];
  /** Every section of the report was left out: nothing would be worth sending. */
  nothingLeft: boolean;
};

/** A weekly report as this family may receive it now. Every switch on: the report itself, untouched. */
export function applyToWeeklyReport<T extends DigestReport>(report: T, v: FamilyVisibility): FilteredReport<T> {
  if (allShown(v)) return { report, leftOut: [], nothingLeft: false };
  const leftOut = new Set<FamilyCategory>();
  let sections = 0;
  let keptSections = 0;
  let body = report.body;
  if (body !== null) {
    const kept = paragraphs(body).filter((p) => {
      const c = sectionCategory(p);
      if (c === null) return true;
      sections += 1;
      if (v[c]) {
        keptSections += 1;
        return true;
      }
      leftOut.add(c);
      return false;
    });
    body = kept.join("\n\n");
  }
  const highlights = Array.isArray(report.highlights)
    ? report.highlights.filter((h) => {
        const c = phraseCategory(h);
        if (c !== null && !v[c]) leftOut.add(c);
        return c !== null && v[c];
      })
    : report.highlights;
  return {
    report: { ...report, body, summary: filterDigestSummary(report.summary, v), highlights },
    leftOut: FAMILY_CATEGORIES.filter((c) => leftOut.has(c)),
    nothingLeft: sections > 0 && keptSections === 0,
  };
}

/**
 * Whether a message already written from a weekly report (its email body, or its text) carries something of a kind
 * that is now switched off: a section of that kind, or one of its counts. Dispatch asks this just before it sends,
 * so a switch turned off after the counselor approved still holds.
 */
export function revealsHidden(text: string | null, v: FamilyVisibility): FamilyCategory[] {
  if (!text || allShown(v)) return [];
  const found = new Set<FamilyCategory>();
  for (const p of paragraphs(text)) {
    const c = sectionCategory(p);
    if (c !== null && !v[c]) found.add(c);
  }
  // A text carries the one-line summary; its counts are read only from a one-line text, so a task title in an
  // email body can't be mistaken for one.
  const at = text.includes("\n") ? -1 : text.indexOf("): ");
  if (at >= 0) {
    for (const part of text.slice(at + 3).replace(/[.…]$/, "").split(", ")) {
      const c = phraseCategory(part);
      if (c !== null && !v[c]) found.add(c);
    }
  }
  return FAMILY_CATEGORIES.filter((c) => found.has(c));
}
