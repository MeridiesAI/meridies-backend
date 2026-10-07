/**
 * Curated per-school datasets, loaded from CSVs the team compiles each year
 * (scripts/ingest/curated-csv.ts). Every row names the school by IPEDS unitid
 * and carries a source_url; a row without one is refused, because a fact we
 * can't trace is a fact we don't serve.
 *
 * CSV columns (header row, any order; blank = unknown):
 *
 *   policies            unitid, superscore (sat|act|both|none),
 *                       self_report_scores, css_profile_required, stars_required (true|false),
 *                       fairtest_status (required|optional|blind|flexible), source_url, checked_on (YYYY-MM-DD)
 *   requirements        unitid, cycle (2026-27), platforms (common-app;uc;...),
 *                       application_fee (dollars), fee_waiver, personal_essay_required,
 *                       supplement_count, teacher_recs, counselor_rec,
 *                       testing (required|optional|blind|flexible),
 *                       portfolio (required|optional|some-programs), stars_required, source_url, checked_on
 *   major-admit-rates   unitid, system (uc|csu|other), major, cip_code, entry_year,
 *                       residency (all|in-state|out-of-state|international),
 *                       applicants, admits, admit_rate (0-1; derived when blank),
 *                       impacted, open_major, eligibility_index, source_url, checked_on
 */

export type Dataset = "policies" | "requirements" | "major-admit-rates";

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
const checkedAt = (v: string | undefined, errs: string[]): string => {
  if (blank(v)) return new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v!.trim())) {
    errs.push(`checked_on: "${v}" isn't YYYY-MM-DD`);
    return new Date().toISOString();
  }
  return new Date(`${v!.trim()}T12:00:00Z`).toISOString();
};
const sourceUrl = (v: string | undefined, errs: string[]): string | null => {
  if (blank(v) || !/^https?:\/\/\S+$/.test(v!.trim())) {
    errs.push("source_url is required (an http(s) address)");
    return null;
  }
  return v!.trim();
};

export function mapCuratedRow(dataset: Dataset, r: Record<string, string>, line: number): { out: Out | null; errors: string[] } {
  const errs: string[] = [];
  const unitid = Number(r.unitid);
  if (!Number.isInteger(unitid) || unitid <= 0) errs.push(`unitid: "${r.unitid}" isn't an IPEDS id`);
  const url = sourceUrl(r.source_url, errs);
  const at = checkedAt(r.checked_on, errs);
  let row: Record<string, unknown> = {};

  if (dataset === "policies") {
    const fields = {
      superscore: oneOf(r.superscore, ["sat", "act", "both", "none"] as const, "superscore", errs),
      self_report_scores: bool(r.self_report_scores, "self_report_scores", errs),
      css_profile_required: bool(r.css_profile_required, "css_profile_required", errs),
      stars_required: bool(r.stars_required, "stars_required", errs),
      fairtest_status: oneOf(r.fairtest_status, ["required", "optional", "blind", "flexible"] as const, "fairtest_status", errs),
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
  rows.forEach((r, i) => {
    const { out, errors: e } = mapCuratedRow(dataset, r, i + 2);
    if (out) ok.push(out);
    errors.push(...e);
  });
  return { ok, errors };
}
