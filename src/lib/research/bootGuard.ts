/**
 * Boot check for the research test double. `RESEARCH_FAKE` swaps the web research, the match model and the link
 * check for canned answers, so a production server that has it set would show counselors invented recommendations.
 * Pure on purpose: index.ts calls it and logs the answer; the unit test feeds it env values.
 */
export function researchFakeRefusal(e: { RESEARCH_FAKE?: string | undefined; NODE_ENV?: string | undefined }): string | null {
  if (e.RESEARCH_FAKE && e.NODE_ENV === "production") {
    return "refusing to start: RESEARCH_FAKE is for tests only and must not be set when NODE_ENV=production";
  }
  return null;
}
