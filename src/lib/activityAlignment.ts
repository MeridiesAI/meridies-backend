/**
 * Extracurricular alignment for the Narrative Coherence tool: does the
 * student's activity list span research, service and competitions, and how
 * much of it connects to the major they declared?
 *
 * Deterministic, no model: it reads the Activities and Honors sheets the
 * counselor already sees and sorts each row by its category and its own
 * words. Nothing here writes essay text, and every figure traces to a row.
 * It is a read of the list, not a judgment of the student, so the notes say
 * "no research listed", never "weak".
 */

type Row = Record<string, unknown>;

export type BucketId = "research" | "service" | "competitions";

export type AlignmentBucket = {
  id: BucketId;
  label: string;
  count: number;
  /** Hours across the year, from hours per week x weeks per year; null when none of its rows state them. */
  hoursPerYear: number | null;
  /** Up to six names, so the counselor sees what was counted. */
  examples: string[];
};

export type MajorLink = { activity: string; major: string };

export type ActivityAlignment = {
  majors: string[];
  total: number;
  buckets: AlignmentBucket[];
  /** Rows that connect to a declared major, with the major they matched. */
  majorLinks: MajorLink[];
  /** How many activities and honors were read. */
  read: { activities: number; honors: number };
  /** Bullets addressed to the counselor: what is missing, what connects. */
  notes: string[];
};

const BUCKETS: { id: BucketId; label: string }[] = [
  { id: "research", label: "Research" },
  { id: "service", label: "Service" },
  { id: "competitions", label: "Competitions" },
];

const RESEARCH_TEXT = /\b(research|laborator(y|ies)|lab assistant|published|publication|thesis|investigat\w+|reu)\b/i;
const SERVICE_TEXT = /\b(volunteer\w*|community service|service project|tutor\w*|food (bank|pantry)|nonprofit|non-profit|charit\w+|shelter|mentor\w*)\b/i;
const COMPETITION_TEXT =
  /\b(competition|compet\w+|olympiad|hackathon|contest|tournament|championship|invitational|science fair|model un|debate|league|finalist)\b/i;
const HONOR_PLACE = /\b(winner|1st|first place|2nd|3rd|place|medal\w*|finalist|champion\w*|semifinal\w*|qualif\w+|honorable mention)\b/i;

const CATEGORY_BUCKET: [RegExp, BucketId][] = [
  [/^research$/i, "research"],
  [/volunteer|community service/i, "service"],
  [/debate|speech/i, "competitions"],
];

/** Words that say a row belongs with a field, beyond the major's own words. */
const FIELD_WORDS: [RegExp, string[]][] = [
  [/computer|software|informatics|data science|cyber/i, ["coding", "programming", "software", "app", "hackathon", "robotics", "computer", "python", "java", "web", "data", "ai", "machine learning", "cyber", "game"]],
  [/engineer/i, ["engineering", "robotics", "build", "circuit", "mechanical", "electrical", "cad", "3d print", "stem", "fabrication"]],
  [/biolog|pre-?med|health|nursing|neuroscience|medic/i, ["biology", "hospital", "clinic", "medical", "health", "patient", "lab", "anatomy", "hosa", "emt", "nursing", "neuroscience"]],
  [/chemi/i, ["chemistry", "chemical", "lab", "olympiad"]],
  [/physic|astronom/i, ["physics", "astronomy", "telescope", "olympiad", "lab"]],
  [/math|statistic/i, ["math", "mathematics", "amc", "aime", "statistics", "proof", "olympiad", "tutor"]],
  [/econom|business|financ|market|account/i, ["business", "finance", "investment", "stock", "entrepreneur", "marketing", "startup", "economics", "deca", "fbla"]],
  [/politic|government|public policy|law|pre-?law|international/i, ["government", "policy", "debate", "model un", "campaign", "legislat", "law", "civic", "advocacy", "politic"]],
  [/english|literature|journal|communicat|writing|media/i, ["writing", "journal", "newspaper", "editor", "literary", "publication", "poetry", "media", "podcast"]],
  [/psycholog|sociolog|social/i, ["psychology", "counsel", "peer", "mental health", "social", "research"]],
  [/art|design|architect/i, ["art", "design", "studio", "gallery", "portfolio", "architecture", "drawing", "film"]],
  [/music/i, ["music", "orchestra", "band", "choir", "instrument", "symphony"]],
  [/environment|sustainab|ecolog|climate/i, ["environment", "sustainab", "climate", "conservation", "recycl", "ecology"]],
  [/educat|teach/i, ["tutor", "teach", "mentor", "education", "camp counselor"]],
];

const GENERIC = new Set(["and", "the", "of", "in", "science", "sciences", "studies", "general", "undecided", "major", "undeclared"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The words that tie a row to this major: its own meaningful words plus the field's usual ones. */
export function majorWords(major: string): string[] {
  const own = major
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w));
  const field = FIELD_WORDS.filter(([re]) => re.test(major)).flatMap(([, words]) => words);
  return [...new Set([...own, ...field])];
}

function mentions(text: string, word: string): boolean {
  // Short words must stand alone ("app", "ai", "web"); longer ones may be a stem ("sustainab").
  if (word.length <= 4) return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
  return text.includes(word);
}

function bucketsOf(row: Row, honor: boolean): BucketId[] {
  const out = new Set<BucketId>();
  const category = str(row.category);
  const text = honor
    ? str(row.name)
    : [str(row.organization), str(row.position), str(row.description), str(row.uc_description), category].join(" ");
  for (const [re, id] of CATEGORY_BUCKET) if (re.test(category)) out.add(id);
  if (str(row.uc_category) === "volunteer") out.add("service");
  if (RESEARCH_TEXT.test(text)) out.add("research");
  if (SERVICE_TEXT.test(text)) out.add("service");
  if (COMPETITION_TEXT.test(text)) out.add("competitions");
  // An honor is a competition result only when it reads like one.
  if (honor && !COMPETITION_TEXT.test(text) && HONOR_PLACE.test(text)) out.add("competitions");
  return [...out];
}

function yearHours(row: Row): number | null {
  const perWeek = num(row.hours_per_week);
  const weeks = num(row.weeks_per_year);
  return perWeek !== null && weeks !== null ? Math.round(perWeek * weeks) : null;
}

export function alignActivities(input: { activities: Row[]; honors: Row[]; majors: string[] }): ActivityAlignment {
  const majors = input.majors.map((m) => m.trim()).filter(Boolean);
  const counts = new Map<BucketId, { count: number; hours: number; stated: boolean; examples: string[] }>(
    BUCKETS.map((b) => [b.id, { count: 0, hours: 0, stated: false, examples: [] }])
  );

  const rows: { name: string; text: string; honor: boolean; row: Row }[] = [
    ...input.activities.map((row) => ({
      name: str(row.organization) || str(row.position) || "Untitled activity",
      text: [str(row.organization), str(row.position), str(row.description), str(row.uc_description), str(row.category)].join(" ").toLowerCase(),
      honor: false,
      row,
    })),
    ...input.honors.map((row) => ({ name: str(row.name) || "Untitled honor", text: str(row.name).toLowerCase(), honor: true, row })),
  ];

  for (const r of rows) {
    for (const id of bucketsOf(r.row, r.honor)) {
      const b = counts.get(id)!;
      b.count += 1;
      const hours = r.honor ? null : yearHours(r.row);
      if (hours !== null) {
        b.hours += hours;
        b.stated = true;
      }
      if (b.examples.length < 6) b.examples.push(r.name);
    }
  }

  const words = majors.map((m) => ({ major: m, words: majorWords(m) }));
  const majorLinks: MajorLink[] = [];
  for (const r of rows) {
    const hit = words.find((m) => m.words.some((w) => mentions(r.text, w)));
    if (hit) majorLinks.push({ activity: r.name, major: hit.major });
  }

  const buckets: AlignmentBucket[] = BUCKETS.map(({ id, label }) => {
    const b = counts.get(id)!;
    return { id, label, count: b.count, hoursPerYear: b.stated ? b.hours : null, examples: b.examples };
  });

  const notes: string[] = [];
  const empty = buckets.filter((b) => b.count === 0).map((b) => b.label.toLowerCase());
  if (rows.length === 0) notes.push("No activities or honors are on the sheets yet.");
  else if (empty.length > 0) notes.push(`Nothing listed under ${empty.join(", ")}.`);
  else notes.push("The list spans research, service and competitions.");
  if (rows.length > 0) {
    if (majors.length === 0) notes.push("No intended major is on file, so nothing can be tied to one.");
    else if (majorLinks.length === 0) notes.push(`No listed activity or honor connects to ${majors.join(" or ")}.`);
    else notes.push(`${majorLinks.length} of ${rows.length} entries connect to ${[...new Set(majorLinks.map((l) => l.major))].join(" or ")}.`);
  }

  return {
    majors,
    total: rows.length,
    buckets,
    majorLinks,
    read: { activities: input.activities.length, honors: input.honors.length },
    notes,
  };
}
