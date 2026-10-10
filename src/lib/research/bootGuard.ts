/**
 * The research test double (`RESEARCH_FAKE`) swaps the web research, the match model and the link check for canned
 * answers, so a server that has it set by mistake would show counselors invented recommendations. It is allowed only
 * when NODE_ENV is explicitly `development` or `test`: production is refused, and so is anything else (staging,
 * preview, a typo, unset), because "not production" is not the same as "a test machine".
 * Pure on purpose: index.ts calls it with the raw process environment and logs the answer; seamFor uses the same
 * table; the unit test feeds it env values.
 */
export const FAKE_ALLOWED_ENVS: readonly string[] = ["development", "test"];

export type FakeEnv = { RESEARCH_FAKE?: string | undefined; NODE_ENV?: string | undefined };

/** True when the fake may run: it is asked for, and NODE_ENV is development or test. */
export function researchFakeAllowed(e: FakeEnv): boolean {
  return !!e.RESEARCH_FAKE && e.NODE_ENV !== undefined && FAKE_ALLOWED_ENVS.includes(e.NODE_ENV);
}

export function researchFakeRefusal(e: FakeEnv): string | null {
  if (!e.RESEARCH_FAKE) return null;
  if (e.NODE_ENV === "production") {
    return "refusing to start: RESEARCH_FAKE is for tests only and must not be set when NODE_ENV=production";
  }
  if (!researchFakeAllowed(e)) {
    return "refusing to start: RESEARCH_FAKE is for tests only and needs NODE_ENV=development or NODE_ENV=test";
  }
  return null;
}
