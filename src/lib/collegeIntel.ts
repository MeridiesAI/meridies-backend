/**
 * The pure parts of AI-in-search (BACKEND_TODO §5): turning a model's parsed
 * filters into a validated search, deciding which proposed catalog changes are
 * allowed, and the per-student college summary, which is built from catalog
 * facts alone (no model, so nothing in it can be invented).
 */

import { NET_PRICE_BANDS, fitFor, studentOdds, type ListSchool, type StudentNumbers } from "./collegesV10.js";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

// ---- Natural-language search -------------------------------------------------------

/** The tool the model fills in: the §3 filters, nothing else. */
export const NL_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: 120, description: "Only a school name or alias the request names. Empty otherwise." },
    states: { type: "array", maxItems: 60, items: { type: "string", pattern: "^[A-Z]{2}$" }, description: "Two-letter states; expand regions (New England -> CT, ME, MA, NH, RI, VT)." },
    control: { type: "array", items: { type: "string", enum: ["public", "private", "private-for-profit"] } },
    testPolicy: { type: "array", items: { type: "string", enum: ["required", "optional", "blind", "recommended"] } },
    setting: { type: "array", items: { type: "string", enum: ["city", "suburb", "town", "rural"] } },
    majors: { type: "array", maxItems: 10, items: { type: "string", maxLength: 80 }, description: "Fields of study named, in plain words (computer science)." },
    admitMin: { type: "number", minimum: 0, maximum: 1 },
    admitMax: { type: "number", minimum: 0, maximum: 1, description: "0-1. 'Selective' is about 0.3 or lower; 'less selective' 0.6 or higher." },
    enrollmentMin: { type: "integer", minimum: 0 },
    enrollmentMax: { type: "integer", minimum: 0, description: "Undergraduates. Small is under 5,000; medium 5,000-15,000; large over 15,000." },
    netPriceMax: { type: "integer", minimum: 0, maximum: 200000, description: "Dollars per year, when a price ceiling is named." },
    band: { type: "string", enum: [...NET_PRICE_BANDS], description: "The family's income band, only when the request gives one." },
    hbcu: { type: "boolean" },
    hsi: { type: "boolean" },
    womenOnly: { type: "boolean" },
    religious: { type: "boolean" },
    superscore: { type: "array", items: { type: "string", enum: ["sat", "act", "both", "none"] } },
    cssProfile: { type: "boolean" },
    sort: { type: "string", enum: ["relevance", "name", "admit-rate", "net-price", "enrollment"] },
    unsupported: { type: "array", maxItems: 5, items: { type: "string", maxLength: 120 }, description: "Parts of the request no filter can express (e.g. 'good vibes'). Never guess a filter for these." },
  },
  required: ["unsupported"],
} as const;

export const NL_SEARCH_SYSTEM = [
  "You turn a counselor's request for colleges into search filters by calling the tool.",
  "Use only the filters the tool offers. Set a filter only when the request asks for it; leave everything else out.",
  "Never name schools that weren't named, and never answer with a list of colleges: the search runs on the filters.",
  "Anything the filters can't express goes in `unsupported`, word for word.",
].join("\n");

/** The model's tool input -> the query-string shape searchQuery validates. */
export function nlFiltersToQuery(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const list = (k: string) => {
    const v = input[k];
    if (Array.isArray(v) && v.length) out[k] = v.map(String).join(",");
  };
  for (const k of ["states", "control", "testPolicy", "setting", "majors", "superscore"]) list(k);
  for (const k of ["admitMin", "admitMax", "enrollmentMin", "enrollmentMax", "netPriceMax"]) {
    if (typeof input[k] === "number" && Number.isFinite(input[k])) out[k] = String(input[k]);
  }
  for (const k of ["hbcu", "hsi", "womenOnly", "religious", "cssProfile"]) if (input[k] === true) out[k] = "true";
  if (typeof input.band === "string" && input.band) out.band = input.band;
  if (typeof input.sort === "string" && input.sort) out.sort = input.sort;
  if (typeof input.q === "string" && input.q.trim()) out.q = input.q.trim();
  // Commas inside a major would split it; keep majors as words.
  if (out.majors) out.majors = out.majors.split(",").map((m) => m.replace(/[^\p{L}\p{N} ]/gu, " ").trim()).filter(Boolean).join(",");
  return out;
}

// ---- Catalog change proposals ------------------------------------------------------------

export const PROPOSAL_FIELDS = {
  test_policy: ["required", "optional", "blind", "recommended"],
  superscore: ["sat", "act", "both", "none"],
  self_report_scores: ["true", "false"],
  css_profile_required: ["true", "false"],
  stars_required: ["true", "false"],
  fairtest_status: ["required", "optional", "blind", "flexible"],
} as const;
export type ProposalField = keyof typeof PROPOSAL_FIELDS;

export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposals: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: { type: "string", enum: Object.keys(PROPOSAL_FIELDS) },
          proposedValue: { type: "string", maxLength: 40 },
          sourceUrl: { type: "string", maxLength: 2000 },
          evidence: { type: "string", maxLength: 600, description: "The cited sentence the change rests on, copied." },
        },
        required: ["field", "proposedValue", "sourceUrl", "evidence"],
      },
    },
  },
  required: ["proposals"],
} as const;

export type Proposal = { field: ProposalField; proposedValue: string; sourceUrl: string; evidence: string };

/**
 * Which proposals survive: a known field, an allowed value, a source that the
 * research answer actually cited, and a value that differs from what's on file.
 */
export function acceptProposals(raw: unknown, citedUrls: Set<string>, current: Partial<Record<ProposalField, string | null>>): Proposal[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as Row).proposals) ? ((raw as Row).proposals as Row[]) : [];
  const out: Proposal[] = [];
  for (const p of list) {
    const field = String(p.field) as ProposalField;
    if (!(field in PROPOSAL_FIELDS)) continue;
    const value = String(p.proposedValue ?? "").trim().toLowerCase();
    if (!(PROPOSAL_FIELDS[field] as readonly string[]).includes(value)) continue;
    const url = String(p.sourceUrl ?? "").trim();
    if (!citedUrls.has(url)) continue;
    if ((current[field] ?? null) === value) continue;
    if (out.some((o) => o.field === field)) continue;
    out.push({ field, proposedValue: value, sourceUrl: url, evidence: String(p.evidence ?? "").slice(0, 1000) });
  }
  return out;
}

// ---- Per-student college summary ------------------------------------------------------

export type SummaryBullet = {
  text: string;
  /** Where the fact behind it comes from. */
  basis: "scorecard" | "ipeds" | "meridies-curated" | "meridies-estimate" | "student-record";
  sourceUrl: string | null;
};

/** parent AGI (cents) -> the Scorecard income band. */
export function incomeBand(agiCents: number | null): (typeof NET_PRICE_BANDS)[number] | null {
  if (agiCents == null) return null;
  const d = agiCents / 100;
  if (d <= 30000) return "0-30000";
  if (d <= 48000) return "30001-48000";
  if (d <= 75000) return "48001-75000";
  if (d <= 110000) return "75001-110000";
  return "110001-plus";
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

/**
 * Counselor-facing bullets about one school for one student, from catalog
 * facts only. Every bullet names its basis; nothing is said where no fact is
 * on file.
 */
export function studentCollegeSummary(input: {
  collegeName: string;
  student: StudentNumbers & { act?: number | null; intendedMajors: string[]; agiCents: number | null };
  stats: Row | null;
  factors: Row | null;
  policies: Row | null;
  requirements: Row | null;
  majorAdmits: Row[];
  majors: Row[];
}): { bullets: SummaryBullet[]; fit: "reach" | "target" | "likely" | null; odds: number | null } {
  const { stats, student } = input;
  const bullets: SummaryBullet[] = [];
  const statsUrl = stats ? String(stats.source_url ?? "") : null;
  const admit = num(stats?.admit_rate);
  const sat25 = num(stats?.sat_total_25);
  const sat75 = num(stats?.sat_total_75);

  if (admit != null) bullets.push({ text: `Admits ${pct(admit)} of applicants.`, basis: "scorecard", sourceUrl: statsUrl });

  if (student.sat != null && sat25 != null && sat75 != null) {
    const where = student.sat < sat25 ? "below" : student.sat > sat75 ? "above" : "inside";
    bullets.push({
      text: `SAT ${student.sat} is ${where} the middle 50% (${sat25}–${sat75}).`,
      basis: "scorecard",
      sourceUrl: statsUrl,
    });
  } else if (student.sat == null && sat25 != null && sat75 != null) {
    bullets.push({ text: `No SAT on file; admitted middle 50% is ${sat25}–${sat75}.`, basis: "scorecard", sourceUrl: statsUrl });
  }

  const testPolicy = (input.factors?.test_policy as string | null) ?? null;
  if (testPolicy) {
    const words: Record<string, string> = { required: "requires test scores", optional: "considers scores but doesn't require them", blind: "doesn't consider test scores", recommended: "recommends test scores" };
    bullets.push({ text: `Per IPEDS ${String(input.factors?.data_year ?? "")}, the school ${words[testPolicy]}.`.replace("IPEDS ,", "IPEDS,"), basis: "ipeds", sourceUrl: String(input.factors?.source_url ?? "") || null });
  }

  const band = incomeBand(student.agiCents);
  const byIncome = (stats?.net_price_by_income ?? {}) as Record<string, number>;
  if (band && byIncome[band] != null) {
    bullets.push({ text: `Average net price for families in the ${band.replace("-", "–")} band: ${usd(byIncome[band])}/yr.`, basis: "scorecard", sourceUrl: statsUrl });
  } else if (num(stats?.avg_net_price) != null) {
    bullets.push({ text: `Average net price: ${usd(Number(stats!.avg_net_price))}/yr (no family income on file to narrow it).`, basis: "scorecard", sourceUrl: statsUrl });
  }

  const pol = input.policies;
  const polSources = (pol?.sources ?? {}) as Record<string, { url?: string }>;
  if (pol?.css_profile_required === true) bullets.push({ text: "Uses the CSS Profile for institutional aid.", basis: "meridies-curated", sourceUrl: polSources.css_profile_required?.url ?? null });
  if (pol?.superscore) bullets.push({ text: `Superscores: ${String(pol.superscore).toUpperCase()}.`, basis: "meridies-curated", sourceUrl: polSources.superscore?.url ?? null });
  if (pol?.stars_required === true) bullets.push({ text: "Requires a STARS self-reported transcript.", basis: "meridies-curated", sourceUrl: polSources.stars_required?.url ?? null });

  // The student's intended majors against what the school teaches and admits.
  const wants = student.intendedMajors.map((m) => m.toLowerCase());
  for (const m of wants.slice(0, 3)) {
    const words = m.split(/\s+/).filter((w) => w.length > 2);
    const rate = input.majorAdmits.find((r) => words.every((w) => String(r.major).toLowerCase().includes(w)));
    if (rate && num(rate.admit_rate) != null) {
      bullets.push({
        text: `${rate.major} admit rate (${rate.entry_year}${rate.residency !== "all" ? `, ${rate.residency}` : ""}): ${pct(Number(rate.admit_rate))}${rate.impacted ? "; impacted" : ""}.`,
        basis: "meridies-curated",
        sourceUrl: String(rate.source_url ?? "") || null,
      });
      continue;
    }
    const offered = input.majors.find((f) => words.every((w) => String(f.title).toLowerCase().includes(w)));
    if (input.majors.length) {
      bullets.push(
        offered
          ? { text: `Offers ${offered.title} (bachelor's).`, basis: "scorecard", sourceUrl: statsUrl }
          : { text: `No bachelor's program matching "${m}" in federal data.`, basis: "scorecard", sourceUrl: statsUrl }
      );
    }
  }

  // Fit, the same estimate the list builder and search use.
  let odds: number | null = null;
  let fit: "reach" | "target" | "likely" | null = null;
  if (admit != null && (student.sat != null || student.gpaUnweighted != null)) {
    const shape = { admit: admit * 100, satMid: sat25 != null && sat75 != null ? (sat25 + sat75) / 2 : null, gpaMid: null } as unknown as ListSchool;
    odds = studentOdds(student, shape, testPolicy !== "blind");
    fit = fitFor(shape, odds);
    if (odds != null) {
      bullets.push({ text: `Meridies estimate: ${fit} (about ${Math.round(odds)}% odds from the admit rate and this student's numbers).`, basis: "meridies-estimate", sourceUrl: null });
    }
  }
  return { bullets, fit, odds };
}
