/**
 * The list-match contract: the fixed vocabulary and numbers the college-matching work shares (the catalog
 * extraction that fills `college_core_features` / `college_opportunities`, the match score, and the learning that
 * will later tune its weights from `list_builder_choices`). Definitions only: nothing here ranks anything yet.
 *
 * Changing a key here changes what stored rows mean. Add keys; don't rename or reuse one.
 */

/**
 * `universal`: more is better for nearly every student, so it can only help a match.
 * `taste`: good for some students and bad for others; only the student's own preference sets the direction.
 */
export type FeaturePolarity = "universal" | "taste";

export type CoreFeature = {
  label: string;
  /** What a value of 1 means. 0 is its absence or opposite. */
  description: string;
  polarity: FeaturePolarity;
};

/**
 * The ten core features every college gets a value for (`college_core_features.feature_key`). A value is 0-1, or
 * null when the sources don't say (unknown, never guessed).
 */
export const CORE_FEATURES = {
  small_classes: {
    label: "Small classes",
    description: "Most classes, first-year ones included, are small and taught by faculty; few large lectures.",
    polarity: "universal",
  },
  undergrad_research: {
    label: "Undergraduate research",
    description: "Undergraduates routinely do research with faculty, with programs or funding open from early on.",
    polarity: "universal",
  },
  coop_internships: {
    label: "Co-ops & internships",
    description: "Co-ops or internships are built into the degree, or a dedicated program places most students.",
    polarity: "universal",
  },
  honors_program: {
    label: "Honors program",
    description: "An honors program or college with its own courses, advising or housing.",
    polarity: "universal",
  },
  study_abroad: {
    label: "Study abroad",
    description: "Study abroad is common and supported: the school's own programs, and credit that transfers.",
    polarity: "universal",
  },
  curriculum_flexibility: {
    label: "Curriculum flexibility",
    description: "Open curriculum: few or no required courses outside the major. 0 is a fixed core curriculum.",
    polarity: "taste",
  },
  greek_life: {
    label: "Greek life",
    description: "Fraternities and sororities are a large part of social life.",
    polarity: "taste",
  },
  athletics_culture: {
    label: "Athletics culture",
    description: "Big-time sports culture: game days and school spirit shape campus life.",
    polarity: "taste",
  },
  preprofessional: {
    label: "Pre-professional focus",
    description: "Career recruiting, internships and job outcomes are central from first year.",
    polarity: "taste",
  },
  residential: {
    label: "Residential campus",
    description: "Housing is guaranteed and most students live on campus all four years.",
    polarity: "taste",
  },
} as const satisfies Record<string, CoreFeature>;

export type CoreFeatureKey = keyof typeof CORE_FEATURES;

export const CORE_FEATURE_KEYS = Object.keys(CORE_FEATURES) as CoreFeatureKey[];

/** One college's value for one core feature: 0-1, or null for unknown. */
export type CoreFeatureValue = number | null;

export type OpportunityCategory = {
  label: string;
  /** Starting weight of a matched opportunity in this category, before any learning. */
  priorWeight: number;
};

/** The categories a `college_opportunities` row can have, with their prior weights. */
export const OPPORTUNITY_CATEGORIES = {
  academic_program: { label: "Academic program", priorWeight: 1.0 },
  research: { label: "Research", priorWeight: 0.9 },
  career: { label: "Career", priorWeight: 0.8 },
  global: { label: "Global", priorWeight: 0.6 },
  community: { label: "Community", priorWeight: 0.4 },
  arts_athletics: { label: "Arts & athletics", priorWeight: 0.4 },
} as const satisfies Record<string, OpportunityCategory>;

export type OpportunityCategoryKey = keyof typeof OPPORTUNITY_CATEGORIES;

export type CardFeatureLink = {
  feature: CoreFeatureKey;
  /** +1: loving the card's situation means wanting more of the feature. -1: wanting less. */
  sign: 1 | -1;
};

/**
 * Preference cards (`preference_cards.card_key`, seeded in 20261105000006) that speak to a core feature. Each card
 * describes a situation, and the sign follows the situation: the `housing` card is "housing guaranteed for one year
 * only, then an apartment in the city", so loving it means wanting a less residential campus (-1).
 */
export const CARD_FEATURE_MAP = {
  "large-lecture": { feature: "small_classes", sign: -1 },
  research: { feature: "undergrad_research", sign: 1 },
  core: { feature: "curriculum_flexibility", sign: -1 },
  greek: { feature: "greek_life", sign: 1 },
  sports: { feature: "athletics_culture", sign: 1 },
  preprofessional: { feature: "preprofessional", sign: 1 },
  housing: { feature: "residential", sign: -1 },
} as const satisfies Record<string, CardFeatureLink>;

export const MATCH_CONFIG = {
  /** Share of a college's match score that comes from core features. */
  coreShare: 0.5,
  /** Share that comes from opportunities. coreShare + opportunityShare = 1. */
  opportunityShare: 0.5,
  /** A college's opportunity score counts only its K best-matching opportunities. */
  topK: 3,
} as const;

/** For the later learning step: when learned weights may replace the priors, and how far. */
export const LEARNING_CONFIG = {
  /** Learned weights are used only once the choice data is this broad. */
  globalGate: {
    /** Distinct counselors who meet minChoicesPerCounselor. */
    minCounselors: 10,
    /** Distinct firms those counselors belong to. */
    minFirms: 3,
    /** Logged choices a counselor needs to count toward minCounselors. */
    minChoicesPerCounselor: 50,
  },
  /** Pull toward the prior: weight = (n * learned + k * prior) / (n + k), with n the evidence count. */
  shrinkageK: 30,
  /** A feature keeps its prior until at least this many choices bear on it. */
  minEvidencePerFeature: 30,
  /** A learned weight never moves further than this from its prior. */
  maxDeltaFromPrior: 0.2,
} as const;
