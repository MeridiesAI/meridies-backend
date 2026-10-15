/**
 * Matching (spec §2, §4.3, §4.4): records into items, items to the uploader's
 * own students. Pure; stage_import re-checks every student id it is given.
 *
 * - Rows with the same email and a matching name are one student (a
 *   long-format file gives many rows per student). The same email with names
 *   that don't match is a shared parent address: never merged, never matched
 *   or invited on its own.
 * - Email and name match: matched. Email match, name differs: suggested, and
 *   the counselor confirms it one by one.
 * - No email match: name plus birthday plus school, or name plus graduation
 *   year plus school: suggested (high when the school matches exactly).
 * - Otherwise an email is invited; no email is skipped.
 * - Within an item, single-row values that disagree become one change
 *   flagged conflict_in_file, with the alternatives, for the counselor to pick.
 */

import { MAX_CHANGES_PER_ITEM } from "./caps.js";
import { namesMatch, normalizeName } from "./names.js";
import type { RecordKey, RecordValue, SheetRecord } from "./rows.js";
import type { Json } from "./values.js";

export type RosterStudent = {
  id: string;
  name: string | null;
  email: string | null;
  gradYear: string | null;
  highSchool: string | null;
  birthday: string | null;
  archived: boolean;
};

export type StagedChange = {
  target: string;
  field: string;
  op: "set_field" | "insert_row";
  value: Json;
  sourceRef: string;
  sourceColumn: string;
  patternKey: string;
  flags: string[];
  alternatives: Array<{ value: Json; sourceRef: string }> | null;
  invalid: boolean;
};

export type MatchStatus = "matched_email" | "suggested" | "new_invite" | "skipped";

export type StageItem = {
  key: string;
  fileId: string | null;
  locator: { sourceRef: string; rows: number };
  importedName: string | null;
  matchStatus: MatchStatus;
  confidence: "high" | "medium" | "low" | null;
  reasons: string[];
  studentId: string | null;
  candidates: Array<{ id: string; why: string }>;
  matchKey: { email: string | null; name: string | null; birthday: string | null; gradYear: number | null; highSchool: string | null };
  skipReason: string | null;
  flags: string[];
  changes: StagedChange[];
};

export class TooManyChangesError extends Error {
  constructor(public readonly rowRef: string) {
    super("Too many values for one student");
    this.name = "TooManyChangesError";
  }
}

const SCHOOL_WORDS = new Set(["high", "school", "hs", "academy", "the", "of", "senior", "secondary", "charter", "prep", "preparatory", "college"]);

function schoolTokens(s: string): string[] {
  return normalizeName(s).replace(/[-,]/g, " ").split(" ").filter((w) => w && !SCHOOL_WORDS.has(w));
}

/** "exact", "fuzzy" or null. Fuzzy: the distinctive words mostly agree. */
export function schoolMatch(a: string | null, b: string | null): "exact" | "fuzzy" | null {
  if (!a || !b) return null;
  if (normalizeName(a) === normalizeName(b)) return "exact";
  const x = schoolTokens(a);
  const y = schoolTokens(b);
  if (x.length === 0 || y.length === 0) return null;
  if (x.join(" ") === y.join(" ")) return "exact";
  const inter = x.filter((w) => y.includes(w)).length;
  const union = new Set([...x, ...y]).size;
  return inter / union >= 0.5 ? "fuzzy" : null;
}

/** Equal for "do these rows disagree": numbers by value, strings trimmed. */
function canonical(v: Json): string {
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "string") return `s:${v.trim()}`;
  if (Array.isArray(v)) return `a:${JSON.stringify(v)}`;
  if (v && typeof v === "object") return `o:${JSON.stringify(Object.keys(v).sort().map((k) => [k, (v as Record<string, Json>)[k]]))}`;
  return `x:${JSON.stringify(v)}`;
}

type Cluster = { records: SheetRecord[]; name: string | null; email: string | null; shared: boolean };

/** Clusters in the order their first row appears in the file. */
function clusterRecords(records: SheetRecord[]): Cluster[] {
  const out: Cluster[] = [];
  const emailGroups = new Map<string, { named: Cluster[]; nameless: SheetRecord[] }>();
  const noEmail = new Map<string, Cluster>();
  for (const r of records) {
    if (r.key.email) {
      const g = emailGroups.get(r.key.email) ?? { named: [], nameless: [] };
      emailGroups.set(r.key.email, g);
      if (!r.key.name) {
        g.nameless.push(r);
        continue;
      }
      const c = g.named.find((x) => x.name && namesMatch(r.key.name as string, x.name));
      if (c) c.records.push(r);
      else {
        const fresh: Cluster = { records: [r], name: r.key.name, email: r.key.email, shared: false };
        g.named.push(fresh);
        out.push(fresh);
      }
    } else if (r.key.name) {
      const k = `${normalizeName(r.key.name)}|${r.key.birthday ?? ""}|${r.key.gradYear ?? ""}`;
      const c = noEmail.get(k);
      if (c) c.records.push(r);
      else {
        const fresh: Cluster = { records: [r], name: r.key.name, email: null, shared: false };
        noEmail.set(k, fresh);
        out.push(fresh);
      }
    } else {
      out.push({ records: [r], name: null, email: null, shared: false });
    }
  }
  for (const [email, g] of emailGroups) {
    if (g.named.length === 1) g.named[0].records.push(...g.nameless);
    else if (g.nameless.length > 0) {
      const rest: Cluster = { records: g.nameless, name: null, email, shared: false };
      g.named.push(rest);
      out.push(rest);
    }
    if (g.named.length > 1) g.named.forEach((c) => (c.shared = true));
  }
  return out;
}

function mergedKey(c: Cluster): RecordKey {
  const first = <K extends keyof RecordKey>(k: K): RecordKey[K] => (c.records.find((r) => r.key[k] !== null)?.key[k] ?? null) as RecordKey[K];
  return { email: c.email, name: c.name, birthday: first("birthday"), gradYear: first("gradYear"), highSchool: first("highSchool") };
}

function changesOf(c: Cluster): StagedChange[] {
  const single = new Map<string, RecordValue[]>();
  const rows: RecordValue[] = [];
  for (const r of c.records) {
    for (const v of r.values) {
      if (v.op === "insert_row") rows.push(v);
      else {
        const k = `${v.table}.${v.field}`;
        const list = single.get(k) ?? [];
        list.push(v);
        single.set(k, list);
      }
    }
  }
  const out: StagedChange[] = [];
  for (const list of single.values()) {
    const valid = list.filter((v) => !v.invalid);
    const flags = [...new Set(list.flatMap((v) => v.flags))];
    if (valid.length === 0) {
      const v = list[0];
      out.push({ target: v.table, field: v.field, op: "set_field", value: v.value, sourceRef: v.sourceRef, sourceColumn: v.sourceColumn, patternKey: v.patternKey, flags, alternatives: null, invalid: true });
      continue;
    }
    const distinct = new Map<string, RecordValue>();
    for (const v of valid) if (!distinct.has(canonical(v.value))) distinct.set(canonical(v.value), v);
    const first = valid[0];
    const conflict = distinct.size > 1;
    out.push({
      target: first.table,
      field: first.field,
      op: "set_field",
      value: first.value,
      sourceRef: first.sourceRef,
      sourceColumn: first.sourceColumn,
      patternKey: first.patternKey,
      flags: conflict ? [...flags, "conflict_in_file"] : flags,
      alternatives: conflict ? [...distinct.values()].slice(0, 10).map((v) => ({ value: v.value, sourceRef: v.sourceRef })) : null,
      invalid: false,
    });
  }
  const seenRows = new Set<string>();
  for (const v of rows) {
    const k = `${v.table}|${canonical(v.value)}`;
    if (seenRows.has(k)) continue;
    seenRows.add(k);
    out.push({ target: v.table, field: "*", op: "insert_row", value: v.value, sourceRef: v.sourceRef, sourceColumn: v.sourceColumn, patternKey: v.patternKey, flags: v.flags, alternatives: null, invalid: v.invalid });
  }
  if (out.length > MAX_CHANGES_PER_ITEM) throw new TooManyChangesError(c.records[0].rowRef);
  return out;
}

export function matchRecords(records: SheetRecord[], roster: RosterStudent[]): StageItem[] {
  const byEmail = new Map<string, RosterStudent>();
  for (const s of roster) if (s.email) byEmail.set(s.email.toLowerCase(), s);
  const clusters = clusterRecords(records);
  const items: StageItem[] = clusters.map((c, i) => {
    const key = mergedKey(c);
    const base = {
      key: `i${i}`,
      fileId: c.records[0].fileId,
      locator: { sourceRef: c.records[0].rowRef, rows: c.records.length },
      importedName: key.name,
      matchKey: key,
      changes: changesOf(c),
      flags: c.shared ? ["shared_email"] : [],
    };
    const onRoster = key.email ? byEmail.get(key.email) : undefined;
    if (onRoster) {
      const nameOk = key.name ? namesMatch(key.name, onRoster.name ?? "") : false;
      const why = !key.name ? "The email matches; the file has no name" : nameOk ? "The email and name match" : "The email matches; the name differs";
      if (c.shared || !nameOk) {
        return {
          ...base,
          matchStatus: "suggested" as const,
          confidence: "low" as const,
          reasons: ["email", ...(c.shared ? ["shared_email"] : []), key.name ? (nameOk ? "name" : "name_mismatch") : "no_name"],
          studentId: null,
          candidates: [{ id: onRoster.id, why }],
          skipReason: null,
        };
      }
      if (onRoster.archived) {
        return { ...base, matchStatus: "skipped" as const, confidence: null, reasons: ["email", "name"], studentId: null, candidates: [], skipReason: "This student is archived" };
      }
      return { ...base, matchStatus: "matched_email" as const, confidence: "high" as const, reasons: ["email", "name"], studentId: onRoster.id, candidates: [], skipReason: null };
    }

    // No email match: name and birthday or graduation year, and the school.
    const candidates: Array<{ s: RosterStudent; conf: "high" | "medium"; reasons: string[] }> = [];
    if (key.name) {
      for (const s of roster) {
        if (s.archived || !s.name || !namesMatch(key.name, s.name)) continue;
        const bday = key.birthday !== null && s.birthday === key.birthday;
        const year = key.gradYear !== null && Number(s.gradYear) === key.gradYear;
        const school = schoolMatch(key.highSchool, s.highSchool);
        if (!(bday || year) || !school) continue;
        candidates.push({ s, conf: school === "exact" ? "high" : "medium", reasons: ["name", bday ? "birthday" : "grad_year", school === "exact" ? "school" : "school_fuzzy"] });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => (a.conf === b.conf ? 0 : a.conf === "high" ? -1 : 1));
      const best = candidates[0];
      return {
        ...base,
        matchStatus: "suggested" as const,
        confidence: best.conf,
        reasons: best.reasons,
        studentId: null,
        candidates: candidates.slice(0, 5).map((x) => ({
          id: x.s.id,
          why: `The name, ${x.reasons.includes("birthday") ? "birthday" : "graduation year"} and ${x.conf === "high" ? "school" : "a similar school"} match`,
        })),
        skipReason: null,
      };
    }
    if (key.email && c.shared) {
      return { ...base, matchStatus: "skipped" as const, confidence: null, reasons: ["shared_email"], studentId: null, candidates: [], skipReason: "Shares an email with another student in this file" };
    }
    if (key.email) {
      return { ...base, matchStatus: "new_invite" as const, confidence: null, reasons: [], studentId: null, candidates: [], skipReason: null };
    }
    return { ...base, matchStatus: "skipped" as const, confidence: null, reasons: [], studentId: null, candidates: [], skipReason: key.name ? "No email to invite" : "No email or name in this row" };
  });

  // One item per student: a second email match to the same student is a suggestion.
  const taken = new Set<string>();
  for (const it of items) {
    if (it.matchStatus !== "matched_email" || !it.studentId) continue;
    if (taken.has(it.studentId)) {
      it.candidates = [{ id: it.studentId, why: "Another row is already matched to this student" }];
      it.matchStatus = "suggested";
      it.confidence = "low";
      it.reasons = [...it.reasons, "duplicate"];
      it.studentId = null;
    } else {
      taken.add(it.studentId);
    }
  }
  // A fallback suggestion never points at a student an email already matched.
  for (const it of items) {
    if (it.matchStatus !== "suggested" || it.reasons.includes("email") || it.reasons.includes("duplicate")) continue;
    it.candidates = it.candidates.filter((c) => !taken.has(c.id));
    if (it.candidates.length === 0) {
      Object.assign(it, it.matchKey.email
        ? { matchStatus: "new_invite", confidence: null, reasons: [] }
        : { matchStatus: "skipped", confidence: null, reasons: [], skipReason: "No email to invite" });
    }
  }
  // Rows that carry nothing to import and match no one are noise.
  for (const it of items) {
    if (it.changes.length === 0 && it.matchStatus === "skipped") it.skipReason = it.skipReason ?? "Nothing to import in this row";
  }
  return items;
}

/** stage_import's payload (snake_case keys, as the SQL reads them). */
export function toPayload(items: StageItem[], counts: { rows: number; blocked: number }) {
  return {
    items: items.map((it) => ({
      key: it.key,
      file_id: it.fileId,
      locator: it.locator,
      imported_name: it.importedName,
      match_status: it.matchStatus,
      confidence: it.confidence,
      reasons: it.reasons,
      student_id: it.studentId,
      candidates: it.candidates,
      match_key: it.matchKey,
      skip_reason: it.skipReason,
      flags: it.flags,
    })),
    changes: items.flatMap((it) =>
      it.matchStatus === "skipped" && !it.flags.includes("shared_email")
        ? []
        : it.changes.map((c) => ({
            item: it.key,
            target: c.target,
            field: c.field,
            op: c.op,
            value: c.value,
            source_ref: c.sourceRef,
            source_column: c.sourceColumn,
            pattern_key: c.patternKey,
            flags: c.flags,
            alternatives: c.alternatives,
            invalid: c.invalid,
          }))
    ),
    counts,
  };
}
