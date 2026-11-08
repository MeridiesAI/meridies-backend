/**
 * Curated per-school datasets, loaded from CSVs the team compiles each year
 * (scripts/ingest/curated-csv.ts). Every row names the school by IPEDS unitid
 * and carries a source_url; a row without one is refused, because a fact we
 * can't trace is a fact we don't serve.
 *
 * CSV columns (header row, any order; blank = unknown):
 *
 *   policies            unitid, superscore (sat|act|both|none),
 *                       self_report_scores, css_profile_required, stars_required,
 *                       personal_statement_read (true|false),
 *                       fairtest_status (required|optional|blind|flexible),
 *                       test_reporting (official-only|self-report|score-send|not-applicable),
 *                       source_url, checked_on (YYYY-MM-DD)
 *   requirements        unitid, cycle (2026-27), platforms (common-app;uc;...),
 *                       application_fee (dollars), fee_waiver, personal_essay_required,
 *                       supplement_count, teacher_recs, counselor_rec,
 *                       testing (required|optional|blind|flexible),
 *                       portfolio (required|optional|some-programs), stars_required, source_url, checked_on
 *   major-admit-rates   unitid, system (uc|csu|other), major, cip_code, entry_year,
 *                       residency (all|in-state|out-of-state|international),
 *                       applicants, admits, admit_rate (0-1; derived when blank),
 *                       impacted, open_major, eligibility_index, source_url, checked_on
 *   supplements         unitid, cycle (2026-27 or 2026-2027), sort_order (0, 1, ...),
 *                       title (up to 120), prompt (up to 2000), word_limit (1-5000),
 *                       scope (universal|major|scholarship; blank = universal),
 *                       major_or_program, required (blank = true),
 *                       source_url (https, REQUIRED), checked_on (REQUIRED)
 *                       One row per prompt; a school, cycle and sort_order name one
 *                       college_supplements slot, so a file may name each only once.
 */

export const DATASETS = ["policies", "requirements", "major-admit-rates", "supplements"] as const;
export type Dataset = (typeof DATASETS)[number];

type Out = { unitid: number; row: Record<string, unknown> };
export type MapResult = { ok: Out[]; errors: string[] };

const blank = (v: string | undefined) => v === undefined || v.trim() === "";
const bool = (v: string | undefined, field: string, errs: string[]): boolean | null => {
  if (blank(v)) return null;
  const s = v!.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  errs.push(`${field}: "${v}" isn't true/false`);
  return null;
};
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], field: string, errs: string[]): T | null => {
  if (blank(v)) return null;
  const s = v!.trim().toLowerCase() as T;
  if (allowed.includes(s)) return s;
  errs.push(`${field}: "${v}" isn't one of ${allowed.join("/")}`);
  return null;
};
const int = (v: string | undefined, field: string, errs: string[], min = 0, max = 10_000_000): number | null => {
  if (blank(v)) return null;
  const n = Number(v!.replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n < min || n > max) {
    errs.push(`${field}: "${v}" isn't a number between ${min} and ${max}`);
    return null;
  }
  return Math.round(n);
};
const checkedAt = (v: string | undefined, errs: string[], required = false): string => {
  if (blank(v)) {
    if (required) errs.push("checked_on is required (YYYY-MM-DD, the day someone checked the page)");
    return new Date().toISOString();
  }
  const s = v!.trim();
  const d = new Date(`${s}T12:00:00Z`);
  // 2026-02-30 parses as March 2: a day that doesn't exist is a typo, not a date.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    errs.push(`checked_on: "${v}" isn't YYYY-MM-DD`);
    return new Date().toISOString();
  }
  return d.toISOString();
};
const sourceUrl = (v: string | undefined, errs: string[], httpsOnly = false): string | null => {
  const re = httpsOnly ? /^https:\/\/\S+$/ : /^https?:\/\/\S+$/;
  if (blank(v) || !re.test(v!.trim())) {
    errs.push(httpsOnly ? "source_url is required (an https address)" : "source_url is required (an http(s) address)");
    return null;
  }
  return v!.trim();
};
const text = (v: string | undefined, field: string, errs: string[], max: number, required: boolean): string | null => {
  const s = (v ?? "").trim();
  if (!s) {
    if (required) errs.push(`${field} is required`);
    return null;
  }
  if (s.length > max) {
    errs.push(`${field} is longer than ${max} characters`);
    return null;
  }
  return s;
};
// "2026-27" (as requirements spell it) or "2026-2027" (as college_supplements stores it).
const fullCycle = (v: string | undefined, errs: string[]): string => {
  const m = /^(\d{4})-(\d{2}|\d{4})$/.exec((v ?? "").trim());
  const start = m ? Number(m[1]) : NaN;
  const end = m ? (m[2].length === 2 ? Math.floor(start / 100) * 100 + Number(m[2]) : Number(m[2])) : NaN;
  if (!m || end !== start + 1) {
    errs.push(`cycle: "${v ?? ""}" isn't like 2026-27`);
    return "";
  }
  return `${start}-${end}`;
};

export function mapCuratedRow(dataset: Dataset, r: Record<string, string>, line: number): { out: Out | null; errors: string[] } {
  const errs: string[] = [];
  const unitid = Number(r.unitid);
  if (!Number.isInteger(unitid) || unitid <= 0) errs.push(`unitid: "${r.unitid}" isn't an IPEDS id`);
  // Supplements are copied into students' essays: an untraced or undated prompt is refused.
  const strict = dataset === "supplements";
  const url = sourceUrl(r.source_url, errs, strict);
  const at = checkedAt(r.checked_on, errs, strict);
  let row: Record<string, unknown> = {};

  if (dataset === "policies") {
    const fields = {
      superscore: oneOf(r.superscore, ["sat", "act", "both", "none"] as const, "superscore", errs),
      self_report_scores: bool(r.self_report_scores, "self_report_scores", errs),
      css_profile_required: bool(r.css_profile_required, "css_profile_required", errs),
      stars_required: bool(r.stars_required, "stars_required", errs),
      personal_statement_read: bool(r.personal_statement_read, "personal_statement_read", errs),
      fairtest_status: oneOf(r.fairtest_status, ["required", "optional", "blind", "flexible"] as const, "fairtest_status", errs),
      test_reporting: oneOf(r.test_reporting, ["official-only", "self-report", "score-send", "not-applicable"] as const, "test_reporting", errs),
    };
    // Only the fields this row answers, each stamped with this row's source.
    row = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    row.__sources = Object.fromEntries(Object.keys(row).map((k) => [k, { url, checkedAt: at.slice(0, 10) }]));
  } else if (dataset === "requirements") {
    if (!/^\d{4}-\d{2}$/.test((r.cycle ?? "").trim())) errs.push(`cycle: "${r.cycle}" isn't like 2026-27`);
    const platforms = (r.platforms ?? "").split(/[;|]/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const allowed = ["common-app", "coalition", "uc", "cal-state-apply", "applytexas", "institution"];
    for (const p of platforms) if (!allowed.includes(p)) errs.push(`platforms: "${p}" isn't one of ${allowed.join("/")}`);
    const fee = int(r.application_fee, "application_fee", errs, 0, 1000);
    row = {
      cycle: (r.cycle ?? "").trim(),
      platforms,
      application_fee_cents: fee === null ? null : fee * 100,
      fee_waiver: bool(r.fee_waiver, "fee_waiver", errs),
      personal_essay_required: bool(r.personal_essay_required, "personal_essay_required", errs),
      supplement_count: int(r.supplement_count, "supplement_count", errs, 0, 30),
      teacher_recs: int(r.teacher_recs, "teacher_recs", errs, 0, 5),
      counselor_rec: bool(r.counselor_rec, "counselor_rec", errs),
      testing: oneOf(r.testing, ["required", "optional", "blind", "flexible"] as const, "testing", errs),
      portfolio: oneOf(r.portfolio, ["required", "optional", "some-programs"] as const, "portfolio", errs),
      stars_required: bool(r.stars_required, "stars_required", errs),
      source_url: url,
      source_verified_at: at,
    };
  } else if (dataset === "supplements") {
    const sort = int(r.sort_order, "sort_order", errs, 0, 1000);
    if (blank(r.sort_order)) errs.push("sort_order is required");
    row = {
      admission_cycle: fullCycle(r.cycle, errs),
      sort_order: sort,
      title: text(r.title, "title", errs, 120, true),
      prompt: text(r.prompt, "prompt", errs, 2000, true),
      word_limit: int(r.word_limit, "word_limit", errs, 1, 5000),
      scope: oneOf(r.scope, ["universal", "major", "scholarship"] as const, "scope", errs) ?? "universal",
      major_or_program: text(r.major_or_program, "major_or_program", errs, 200, false),
      required: bool(r.required, "required", errs) ?? true,
      source_url: url,
      source_verified_at: at,
    };
  } else {
    const major = (r.major ?? "").trim();
    if (!major || major.length > 200) errs.push("major is required");
    const cip = (r.cip_code ?? "").trim();
    if (cip && !/^\d{4}$/.test(cip)) errs.push(`cip_code: "${cip}" isn't 4 digits`);
    const applicants = int(r.applicants, "applicants", errs);
    const admits = int(r.admits, "admits", errs);
    if (applicants !== null && admits !== null && admits > applicants) errs.push("admits is more than applicants");
    let rate: number | null = null;
    if (!blank(r.admit_rate)) {
      rate = Number(r.admit_rate!.replace("%", ""));
      if (r.admit_rate!.includes("%")) rate = rate / 100;
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        errs.push(`admit_rate: "${r.admit_rate}" isn't 0-1 or a percent`);
        rate = null;
      }
    } else if (applicants && admits !== null) rate = Math.round((admits / applicants) * 10000) / 10000;
    row = {
      system: oneOf(r.system, ["uc", "csu", "other"] as const, "system", errs),
      major,
      cip_code: cip || null,
      entry_year: int(r.entry_year, "entry_year", errs, 2000, 2100),
      residency: oneOf(r.residency, ["all", "in-state", "out-of-state", "international"] as const, "residency", errs) ?? "all",
      applicants,
      admits,
      admit_rate: rate,
      impacted: bool(r.impacted, "impacted", errs),
      open_major: bool(r.open_major, "open_major", errs),
      eligibility_index: blank(r.eligibility_index) ? null : Number(r.eligibility_index),
      source_url: url,
      source_verified_at: at,
    };
    if (row.system === null) errs.push("system is required");
    if (row.entry_year === null) errs.push("entry_year is required");
  }

  if (errs.length) return { out: null, errors: errs.map((e) => `line ${line}: ${e}`) };
  return { out: { unitid, row }, errors: [] };
}

export function mapCuratedCsv(dataset: Dataset, rows: Record<string, string>[]): MapResult {
  const ok: Out[] = [];
  const errors: string[] = [];
  const slots = new Map<string, number>();
  rows.forEach((r, i) => {
    const line = i + 2;
    const { out, errors: e } = mapCuratedRow(dataset, r, line);
    errors.push(...e);
    if (!out) return;
    if (dataset === "supplements") {
      // One upsert can't write the same slot twice, and two answers for one slot is a mistake in the file.
      const key = `${out.unitid}|${out.row.admission_cycle}|${out.row.sort_order}`;
      const first = slots.get(key);
      if (first !== undefined) {
        errors.push(`line ${line}: unitid ${out.unitid}, cycle ${out.row.admission_cycle}, sort_order ${out.row.sort_order} is already on line ${first}`);
        return;
      }
      slots.set(key, line);
    }
    ok.push(out);
  });
  return { ok, errors };
}
