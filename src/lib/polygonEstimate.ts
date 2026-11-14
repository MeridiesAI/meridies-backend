/**
 * Estimate with AI: the prompt, the schema and the checks on the model's answer for scoring a
 * student's stat polygon (POST /ai/polygon-estimate). Pure: no db, no model client.
 *
 * The model reads the student's record (the `student-ai` context, which leaves the polygon out
 * so it can't anchor on the numbers it is replacing) and returns one 0-100 read per axis with a
 * reason. Code keeps only axes the student really has, clamps the score and bounds the reason.
 * `null` means "too little data to judge": the axis keeps its formula score instead of a guess.
 */

import { unavailable } from "./errors.js";

export type EstimateAxis = { key: string; label: string; description: string | null };
export type AxisEstimate = { key: string; score: number | null; rationale: string | null };

export const RATIONALE_MAX = 240;

/** How the model should read each default axis; a custom axis is judged from its label and description. */
const AXIS_GUIDE: Record<string, string> = {
  grades: "Weighted and unweighted GPA against its scale, class rank and grade trend. Course difficulty belongs to rigor, not here.",
  academics: "Weighted and unweighted GPA against its scale, class rank, grade trend, and the rigor of the courses taken.",
  rigor: "How demanding the course load is for what this student's school offers: AP, IB, honors, dual enrollment.",
  testing: "SAT, ACT and AP/IB exam results. Test-optional with no scores on file is null, not low.",
  extracurriculars:
    "Activities and awards read together: depth and duration over a long list, leadership, measurable impact, " +
    "and level (school, local, state, national, international). Hours per week and years matter; a title alone does not.",
  essays: "Only what the record shows: status and progress. Without essay text on file, score progress, not prose quality.",
  narrative: "Whether activities, courses, intended major and goals tell one coherent story, with a visible through-line.",
  intangibles: "Context that sets the student apart or explains their record: first-generation status, obstacles, initiative, demonstrated interest.",
};

/**
 * The 3D solid's extra nodes, scored in the same call as the axes. They are not polygon axes (the 2D chart and
 * the ten-axis cap don't change): they live in `student_stat_nodes` (20261125000003). The keys are that table's CHECK.
 */
export const EXTRA_NODE_GUIDE = {
  leadership: "Positions and titles held (founder, captain, president, editor), how many people or how large a program they led, and what changed because of it.",
  awards: "Honors and awards by level: school, city, state or regional, national, international. Higher levels and selective ones count for more; many school-level awards do not add up to a national one.",
  service: "Community service: hours per week x weeks per year, years of consistency, a role beyond showing up, and the reach of what they did.",
  research: "Research and independent inquiry: projects, a mentor or lab, output (a paper, a poster, a presentation), and the level it was presented at. Science club alone is not research.",
  arts: "Art, music, dance, theater or writing: years of training, performances, portfolio, recognition. Null when the record has none of it.",
  "school-fit": "How well the colleges on the student's list suit this student's profile: a sensible spread of reach, target and likely schools for their academics, and whether the list matches their stated interests. Null when no colleges are listed.",
} as const;
export type ExtraNodeKey = keyof typeof EXTRA_NODE_GUIDE;
export const EXTRA_NODE_KEYS = Object.keys(EXTRA_NODE_GUIDE) as ExtraNodeKey[];

export const POLYGON_ESTIMATE_SYSTEM = [
  "You estimate where a high school student stands on each axis of their college-admissions strength profile, for their counselor.",
  // The same scale as a college's "typical admitted student" polygon (college_admitted_profiles: Stanford and MIT
  // sit at 95-99, NYU, Michigan and Berkeley at 85-94), so a counselor can lay the two shapes over each other.
  "Scale, 0-100: the same one the app uses to draw a college's typical admitted student, so the counselor can compare the two shapes. Anchors: " +
    "97-99 is the typical admitted student at MIT, Stanford or Caltech; 85-94 is the typical admitted student at a selective university such as Berkeley, Michigan or NYU; " +
    "75 is strong and competitive for many selective schools without being typical of them; 60 is a solid college-bound student; " +
    "40 is well below typical for a college-bound student; under 25 is rare. Use the whole range: an exceptional record can pass 90, a thin one should land low.",
  "Score only from the record you are given. Never assume facts that are not in it.",
  "Be calibrated, not flattering: a long list with little depth is not a high score, and a short list with real impact can be.",
  "Return null for an axis only when the record holds no evidence for it at all, and say what is missing. When the evidence is partial, " +
    "score what you can see and name what is missing in the reason; a counselor would rather have a reasoned estimate than a blank.",
  "Give each reason in one or two plain sentences, under 200 characters, naming the specific evidence (a GPA, an activity, a number of hours).",
  "Do not write or rewrite any essay or application text.",
].join("\n");

export function polygonEstimatePrompt(axes: EstimateAxis[], brief: string): string {
  const lines = axes.map((a) => {
    const guide = AXIS_GUIDE[a.key] ?? a.description ?? "No definition given: judge from the label only, and return null if it can't be read from the record.";
    return `- ${a.key} (${a.label}): ${guide}`;
  });
  const nodes = EXTRA_NODE_KEYS.map((k) => `- ${k}: ${EXTRA_NODE_GUIDE[k]}`);
  return (
    `Score each of these axes for this student.\n\nAxes:\n${lines.join("\n")}\n\n` +
    `Then score these detail nodes the same way (they sit under the axes above and show what a score is made of):\n${nodes.join("\n")}\n\n` +
    `Student record:\n${brief}`
  );
}

export function polygonEstimateSchema(keys: string[]) {
  return {
    type: "object",
    properties: {
      axes: {
        type: "array",
        maxItems: keys.length,
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: keys },
            score: { type: ["integer", "null"], minimum: 0, maximum: 100 },
            rationale: { type: "string", maxLength: RATIONALE_MAX },
          },
          required: ["key", "score", "rationale"],
        },
      },
      nodes: {
        type: "array",
        maxItems: EXTRA_NODE_KEYS.length,
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: EXTRA_NODE_KEYS },
            score: { type: ["integer", "null"], minimum: 0, maximum: 100 },
            rationale: { type: "string", maxLength: RATIONALE_MAX },
          },
          required: ["key", "score", "rationale"],
        },
      },
    },
    required: ["axes", "nodes"],
  } as const;
}

/** A reason within RATIONALE_MAX, cut at a word and marked, never mid-word. */
function bound(text: string): string {
  if (text.length <= RATIONALE_MAX) return text;
  const cut = text.slice(0, RATIONALE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > RATIONALE_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Last line of defence over the model's answer. Unknown keys, repeats and non-numbers are dropped, a score
 * is rounded and held to 0-100, a reason is trimmed and bounded. An answer with nothing usable in it is
 * refused rather than stored as "no change".
 */
export function cleanEstimate(value: unknown, axes: { key: string }[]): AxisEstimate[] {
  const raw = value && typeof value === "object" ? (value as { axes?: unknown }).axes : undefined;
  const out = cleanItems(raw, new Set(axes.map((a) => a.key)));
  if (out.length === 0) throw unavailable("The AI's answer couldn't be read. Try again.");
  return out;
}

/**
 * The detail nodes half of the same answer. Lenient on purpose: they are a bonus on top of the axes, so an
 * absent, malformed or empty `nodes` is "no nodes this time", never a failed estimate.
 */
export function cleanNodeEstimate(value: unknown): AxisEstimate[] {
  const raw = value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
  return cleanItems(raw, new Set<string>(EXTRA_NODE_KEYS));
}

function cleanItems(raw: unknown, known: Set<string>): AxisEstimate[] {
  const out: AxisEstimate[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue;
    const { key, score, rationale } = item as Record<string, unknown>;
    if (typeof key !== "string" || !known.has(key) || seen.has(key)) continue;
    seen.add(key);
    const n = typeof score === "number" && Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null;
    const why = typeof rationale === "string" ? bound(rationale.replace(/\s+/g, " ").trim()) : "";
    out.push({ key, score: n, rationale: why || null });
  }
  return out;
}
