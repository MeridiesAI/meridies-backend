/**
 * AxIS's model settings, in one place.
 *
 * Everything AxIS asks a model runs on Claude Haiku 5.5: the answer, the
 * specialists, the adjudicator, the memory fold and the cache pre-warm. One
 * model is one prompt cache (caches are model-scoped), so a turn that needs
 * more reasoning raises effort rather than switching model.
 *
 * Effort is pinned at the top level and set per turn with an effort-only
 * system message (beta mid-conversation-output-config-2026-07-01). Changing
 * the top-level value between requests would drop the cached messages and,
 * depending on how the model renders its thinking settings, the cached tools
 * and system prompt too. The per-message form keeps every cache tier.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const AXIS_MODEL = "claude-haiku-5-5";

export type Effort = "low" | "medium" | "high";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

/** The top-level effort on every AxIS request, so the cached prefix never moves. Turns set their own with effortMessage(). */
export const PINNED_EFFORT: Effort = "high";
export const PER_MESSAGE_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";

/** Adaptive thinking with its text omitted (the model's default): AxIS shows its tool trace, not its reasoning. */
export const THINKING: Anthropic.Beta.BetaThinkingConfigParam = { type: "adaptive" };

/** Thinking counts toward max_tokens on Haiku 5.5, so each cap leaves it room. */
export const MAX_TOKENS: Record<Effort, number> = { low: 8_000, medium: 16_000, high: 24_000 };

/**
 * Prompts stay under Haiku 5.5's lower rate card (100K tokens). The new
 * tokenizer runs about 30% more tokens than Haiku 4.5's, so characters / 3 is
 * the conservative estimate used for the budget.
 */
export const PROMPT_TOKEN_BUDGET = 90_000;
/** Where Haiku 5.5's lower rate card ends: a call whose prompt passes it is billed at the higher rate. */
export const LOWER_RATE_PROMPT_TOKENS = 100_000;
export const estimateTokens = (chars: number) => Math.ceil(chars / 3);

export function stepEffort(e: Effort, by: number): Effort {
  const i = Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(e) + by));
  return EFFORTS[i]!;
}

/**
 * API features an account or platform may not have yet. The first 400 that
 * rejects a request carrying them turns them off for this process and the call
 * is retried without them (lib/axis/loop.ts), so a missing beta costs one
 * request, once, instead of breaking AxIS.
 */
const features = { perMessageEffort: true, systemMessages: true };
export type Feature = keyof typeof features;
export const featureOn = (f: Feature): boolean => features[f];
export function disableFeature(f: Feature): void {
  features[f] = false;
}
/** Tests only: put both features back on. */
export function resetFeatures(): void {
  features.perMessageEffort = true;
  features.systemMessages = true;
}

/** Sets the effort for the user turn that follows it. */
export function effortMessage(effort: Effort): Anthropic.Beta.BetaMessageParam {
  return { role: "system", content: [], output_config: { effort } };
}

/** An operator instruction for this turn, after the user's message: the injection-safe channel for the mode. */
export function modeMessage(text: string): Anthropic.Beta.BetaMessageParam {
  return { role: "system", content: text };
}
