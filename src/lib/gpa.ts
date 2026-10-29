/**
 * GPA with its scale (spec §4.1). Since 20261014000001 a 92 on a 100-point
 * scale can sit next to a 3.8 on a 4.0 scale, so nothing may compare, chart
 * or rank a GPA without reading `student_academics.gpa_scale`. Fit, odds,
 * class rank and scholarship minimums are 4/5-point models: anything else is
 * "unknown" to them rather than a guess.
 */

export type GpaScaleKind = "four" | "five" | "ten" | "hundred" | "other" | "unknown";

export function gpaScaleKind(scale: string | null | undefined): GpaScaleKind {
  const s = (scale ?? "").trim();
  if (!s) return "unknown";
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return "other";
  if (n === 4) return "four";
  if (n === 5) return "five";
  if (n === 10) return "ten";
  if (n === 100) return "hundred";
  return "other";
}

export function fourPointGpa(
  value: number | null | undefined,
  scale: string | null | undefined
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const kind = gpaScaleKind(scale);
  if (kind === "four" || kind === "five") return value;
  if (kind === "unknown" && value <= 5.5) return value;
  return null;
}

export function gpaLabel(
  value: number | null | undefined,
  scale: string | null | undefined
): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const shown = Number(value.toFixed(3)).toString();
  const kind = gpaScaleKind(scale);
  if (kind === "unknown") return shown;
  if (kind === "hundred") return `${shown} (100-point scale)`;
  return `${shown} (${(scale ?? "").trim()} scale)`;
}

/** The number a scale names ("4.0", "5 scale", "100-point"), or null when it names none. */
export function gpaScaleNumber(scale: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(scale ?? "");
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Why a GPA doesn't fit its scale, or null when it does (or there is no scale
 * to check against). Unweighted up to the scale, weighted up to the scale plus
 * one (bug hunt 2026-10-28, S2-M2). The same rule is the database's
 * `student_academics_gpa_within_scale` (20261029000002).
 */
export function gpaOverScale(value: number | null | undefined, scale: string | null | undefined, kind: "weighted" | "unweighted"): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const s = gpaScaleNumber(scale);
  if (s === null) return null;
  const max = kind === "weighted" ? s + 1 : s;
  if (value <= max) return null;
  const label = (scale ?? "").trim();
  return `${kind === "unweighted" ? "An" : "A"} ${kind} GPA can be at most ${Number(max.toFixed(3))} on a ${label} scale`;
}
