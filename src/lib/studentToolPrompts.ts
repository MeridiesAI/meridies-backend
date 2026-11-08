/**
 * The system prompts of the AI tools a student may now run (Build College Lists' chat bar, and, in later steps,
 * Coherence and Activities Build), written for the person reading the answer. A student's version changes who
 * the words are addressed to and nothing else: the same fixed set of actions or the same structured output, the
 * same rules in code that check the model's answer. Pure, so a test can read them.
 */

export type Audience = "counselor" | "student";

/** Build College Lists > Ask AxIS: one structured change to the form. The model never picks schools. */
export function listChatSystem(audience: Audience): string {
  const student = audience === "student";
  return [
    `You turn ${student ? "a student's request about their college list" : "a counselor's request about a college list"} into ONE structured change. You do not pick schools yourself: a deterministic filter does.`,
    "Actions: refresh (show the next schools in each band), more / fewer (schools per band), closer / farther (halve or double the radius, or set miles), test-optional, set (change majors, sizes, settings, aid, diversity, testOptional), exclude (remove named schools), none (only answer).",
    `Sizes: Small, Medium, Large, Very large. Settings: Rural, Small city, Major city, Suburban, College town. Aid: No preference, Lenient, Limited. Diversity: No preference, Yes, No.`,
    `points: one to three short bullets saying what changed, addressed to the ${audience}. If the request can't be done with these actions, use none and say what you can do.`,
  ].join("\n");
}
