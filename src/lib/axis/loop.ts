/**
 * The model loop: one streaming conversation with Haiku 5.5 and its tools.
 *
 * What it does beyond call, run tools, repeat:
 *
 *  - Early dispatch. Tool inputs stream as they are generated, and a read-only
 *    lookup starts the moment its block closes, while the model is still
 *    writing the rest of its turn. With two or three calls in one turn the
 *    first is usually done by the time the turn ends. Results are only sent
 *    when the turn really ended on tool_use; a refused or truncated turn
 *    throws its early work away, and a write (propose_action) never starts
 *    early.
 *  - Parallel results in one message, so the model keeps calling in parallel.
 *  - Novelty stop. A round whose lookups all came back empty, failed or
 *    repeated brings nothing new; after two such rounds the next call must
 *    answer (tool_choice none) instead of searching a fourth way for
 *    something that isn't there.
 *  - Budgets: a cap on model calls and a wall-clock deadline for the tool
 *    phase; the last call always answers. The deadline holds inside a round
 *    too: a read-only lookup still running when it passes is told to stop
 *    (its signal aborts) and goes back to the model as "ran out of time". A
 *    write is always waited for: cutting it off wouldn't undo it, and the
 *    model would be told a change failed that may have happened.
 *  - Filler held back. Text the model writes in a round that ends in tool
 *    calls ("Let me check her deadlines.") is not shown: while a round may
 *    still call tools its text waits until it ends, or until it is clearly an
 *    answer (RELEASE_CHARS, or a line break), then streams live. A round that
 *    must answer streams from the first word. Tool steps and status events are
 *    callbacks of their own and are never held.
 *  - Graceful degradation. If the API rejects the per-message effort or the
 *    mode system message (an account or platform without them), the first
 *    call is retried once without them and the features stay off for the
 *    process.
 *  - Thinking blocks go back exactly as they came (Haiku 5.5 checks that the
 *    history before a thinking block is unchanged), and the history is only
 *    ever appended to.
 *
 * The client is injected, so the loop is tested with a scripted fake.
 */
import type { Hold } from "../aiBudget.js";
import Anthropic from "@anthropic-ai/sdk";
import { disableFeature, featureOn, LOWER_RATE_PROMPT_TOKENS, MAX_TOKENS, type Effort } from "./models.js";
import type { ToolOutput } from "./tools.js";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type StreamParams = Omit<Anthropic.Beta.Messages.MessageCreateParamsStreaming, "stream">;

/** The part of a MessageStream the loop uses. */
export type StreamLike = {
  on(event: "text", cb: (delta: string) => void): unknown;
  on(event: "contentBlock", cb: (block: BetaContentBlock) => void): unknown;
  on(event: "streamEvent", cb: (event: unknown) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
};

export type MessagesApi = { stream(params: StreamParams, options?: { signal?: AbortSignal }): StreamLike };

/** Tokens and billed calls, summed over some model calls. */
export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  /** Every cache write. The two below split it by lifetime (they bill differently) when the API reports the split. */
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Responses that came back: the billed calls, specialists' included. */
  calls: number;
};
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "calls"] as const satisfies readonly (keyof Tokens)[];
const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, calls: 0 });

/**
 * What the model calls of a run cost, summed. `longPrompt` is the part from calls whose prompt
 * passed Haiku 5.5's lower rate card: those are billed at the higher rate on every token, so the
 * cost report (scripts/axis/axis-cost-report.sql) needs their tokens apart, not just a count.
 */
export type Usage = Tokens & { longPrompt: Tokens };
export const emptyUsage = (): Usage => ({ ...noTokens(), longPrompt: noTokens() });

/** The usage block of one response, beta or not. */
type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
};

/** One response's usage, as one billed call. */
export function usageFromApi(u: ApiUsage): Usage {
  const one: Tokens = {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    calls: 1,
  };
  // The rate card counts the whole prompt, cached tokens included.
  const long = one.input + one.cacheRead + one.cacheWrite > LOWER_RATE_PROMPT_TOKENS;
  return { ...one, longPrompt: long ? { ...one } : noTokens() };
}

function addTokens(into: Tokens, x: Tokens): void {
  for (const k of TOKEN_KEYS) into[k] += x[k];
}

/** Adds every count of `x` into `into`, the long-prompt part included. */
export function addUsage(into: Usage, x: Usage): void {
  addTokens(into, x);
  addTokens(into.longPrompt, x.longPrompt);
}

/** One call's usage as the API reported it (what the gate settles with). */
const callUsage = (m: BetaMessage): Usage => usageFromApi(m.usage);

export type ToolCall = { id: string; name: string; input: unknown };

/**
 * Wraps every model call (lib/aiBudget.ts): `before` reserves, `after` settles with that call's usage, "unused" when
 * the API refused the request before answering (nothing billed), or null when it isn't known (a stream stopped or
 * failed after it started, which may still be billed: the reservation stays).
 */
export type CallGate = { before(params: StreamParams): Promise<Hold>; after(hold: Hold, usage: Usage | "unused" | null): Promise<void> };

export type LoopOptions = {
  api: MessagesApi;
  /** Everything but messages, max_tokens and tool_choice, which the loop sets. */
  base: Omit<StreamParams, "messages" | "max_tokens" | "tool_choice">;
  /** Appended to in place: the conversation so far, ending with the user turn (and its mode message). */
  messages: BetaMessageParam[];
  effort: Effort;
  maxCalls: number;
  /** Epoch ms after which the next call must answer. */
  deadline: number;
  signal: AbortSignal;
  exec: (call: ToolCall, signal: AbortSignal) => Promise<ToolOutput>;
  /** The budget gate around every model call: reserved per call, not per turn. */
  gate?: CallGate;
  readOnly: (name: string) => boolean;
  onText?: (delta: string) => void;
  onFirstEvent?: () => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (call: ToolCall, out: ToolOutput) => void;
};

export type LoopResult = {
  text: string;
  usage: Usage;
  calls: number;
  tools: string[];
  stop: "end_turn" | "refusal" | "max_tokens" | "budget" | "other";
  refusalCategory: string | null;
};

/** Two rounds that brought nothing new end the tool phase. */
export const STALE_ROUNDS = 2;
const JSON_RETRIES = 2;
/** Held text this long, or with a line break, is an answer rather than filler before a tool call: it streams from there. */
export const RELEASE_CHARS = 120;
/** What a read-only lookup still running at the deadline returns to the model. */
export const TIMED_OUT: ToolOutput = {
  content: "This lookup ran out of time and was stopped. Answer with what you have and say what you couldn't check.",
  isError: true,
  fresh: false,
};

/** Folds the optional system messages into plain request shape after the API refused them. */
export function degrade(messages: BetaMessageParam[]): { changed: boolean; usedPerMessageEffort: boolean; usedSystemMessages: boolean } {
  let usedPerMessageEffort = false;
  let usedSystemMessages = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "system") continue;
    const isEffortOnly = Array.isArray(m.content) && m.content.length === 0;
    if (isEffortOnly) usedPerMessageEffort = true;
    else {
      usedSystemMessages = true;
      // The operator note moves into the preceding user turn, marked as ours.
      const text = typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("\n");
      const prev = messages[i - 1];
      if (prev && prev.role === "user") {
        const note = { type: "text" as const, text: `(AxIS operator note: ${text})` };
        prev.content = typeof prev.content === "string" ? [{ type: "text", text: prev.content }, note] : [...prev.content, note];
      }
    }
    messages.splice(i, 1);
  }
  return { changed: usedPerMessageEffort || usedSystemMessages, usedPerMessageEffort, usedSystemMessages };
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const usage = emptyUsage();
  const tools: string[] = [];
  let text = "";
  let calls = 0;
  let stale = 0;
  let jsonRetries = 0;
  let degraded = false;
  let firstEventSeen = false;
  let pendingBreak = false;
  let askedForText = false;
  // Set when the in-round cutoff fired (a timer can fire a millisecond before Date.now() reaches the deadline).
  let pastDeadline = false;
  let topEffort = o.base.output_config?.effort ?? o.effort;

  for (;;) {
    calls++;
    const mustAnswer = calls >= o.maxCalls || pastDeadline || Date.now() >= o.deadline || stale >= STALE_ROUNDS;
    const round = new AbortController();
    const relay = () => round.abort();
    o.signal.addEventListener("abort", relay, { once: true });
    // Read-only lookups have their own signal: the deadline stops them without touching a write.
    const reads = new AbortController();
    round.signal.addEventListener("abort", () => reads.abort(), { once: true });
    const early = new Map<string, Promise<ToolOutput>>();
    const params: StreamParams = {
      ...o.base,
      output_config: { ...o.base.output_config, effort: topEffort },
      max_tokens: MAX_TOKENS[o.effort],
      tool_choice: mustAnswer ? { type: "none" } : { type: "auto" },
      messages: o.messages,
    };

    const hold = o.gate ? await o.gate.before(params) : null;
    let used: Usage | "unused" | null = null;
    let roundStarted = false;
    let msg: BetaMessage;
    let roundText = "";
    // A round that may still call tools holds its text until it is clearly an answer or the round ends.
    let live = mustAnswer;
    let held = "";
    let toolRound = false;
    const show = (piece: string) => {
      if (pendingBreak) {
        pendingBreak = false;
        text += "\n\n";
        o.onText?.("\n\n");
      }
      text += piece;
      o.onText?.(piece);
    };
    try {
      const stream = o.api.stream(params, { signal: o.signal });
      stream.on("streamEvent", (ev) => {
        roundStarted = true;
        const e = ev as { type?: string; content_block?: { type?: string } } | null;
        if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") toolRound = true;
        if (!firstEventSeen) {
          firstEventSeen = true;
          o.onFirstEvent?.();
        }
      });
      stream.on("text", (delta) => {
        roundText += delta;
        if (live) return show(delta);
        // Text after a tool call started belongs to a tool round: never shown.
        if (toolRound) return;
        held += delta;
        if (held.length >= RELEASE_CHARS || held.includes("\n")) {
          live = true;
          const piece = held;
          held = "";
          show(piece);
        }
      });
      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") toolRound = true;
        if (mustAnswer || block.type !== "tool_use" || !o.readOnly(block.name)) return;
        early.set(block.id, o.exec({ id: block.id, name: block.name, input: block.input }, reads.signal));
      });
      msg = await stream.finalMessage();
      used = callUsage(msg);
      jsonRetries = 0;
    } catch (err) {
      // An HTTP error or a lost connection before any event: the API answered nothing and bills nothing.
      if (!o.signal.aborted && !roundStarted && err instanceof Anthropic.APIError && !(err instanceof Anthropic.APIUserAbortError)) used = "unused";
      round.abort();
      o.signal.removeEventListener("abort", relay);
      if (o.signal.aborted) throw err;
      if (err instanceof Anthropic.BadRequestError && calls === 1 && !degraded && !roundText) {
        const d = degrade(o.messages);
        if (d.changed) {
          degraded = true;
          if (d.usedPerMessageEffort) {
            disableFeature("perMessageEffort");
            topEffort = o.effort;
          }
          if (d.usedSystemMessages) disableFeature("systemMessages");
          calls = 0;
          continue;
        }
      }
      // With streamed tool inputs, an input that isn't JSON at all rejects here; the turn is asked again.
      if (!(err instanceof Anthropic.APIError) && jsonRetries < JSON_RETRIES && !roundText) {
        jsonRetries++;
        calls--;
        continue;
      }
      throw err;
    } finally {
      if (hold) await o.gate!.after(hold, used);
    }
    o.signal.removeEventListener("abort", relay);
    addUsage(usage, usageFromApi(msg.usage));

    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason === "tool_use" && uses.length && !mustAnswer) {
      o.messages.push({ role: "assistant", content: msg.content });
      const callsThisRound = uses.map((u) => ({ id: u.id, name: u.name, input: u.input }));
      for (const c of callsThisRound) {
        tools.push(c.name);
        o.onToolStart?.(c);
      }
      // The deadline holds during the round: a lookup still running then is stopped; a write is waited for.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cutoff = new Promise<ToolOutput>((resolve) => {
        timer = setTimeout(() => {
          // Settled first, so a lookup that answers its abort with a result doesn't win the race.
          pastDeadline = true;
          resolve(TIMED_OUT);
          reads.abort();
        }, Math.max(0, o.deadline - Date.now()));
      });
      const outs = await Promise.all(
        callsThisRound.map((c) => {
          if (!o.readOnly(c.name)) return o.exec(c, round.signal);
          return Promise.race([early.get(c.id) ?? o.exec(c, reads.signal), cutoff]);
        })
      ).finally(() => clearTimeout(timer));
      callsThisRound.forEach((c, i) => o.onToolEnd?.(c, outs[i]!));
      o.messages.push({
        role: "user",
        content: callsThisRound.map((c, i) => ({
          type: "tool_result" as const,
          tool_use_id: c.id,
          content: outs[i]!.content,
          ...(outs[i]!.isError ? { is_error: true } : {}),
        })),
      });
      stale = outs.some((x) => x.fresh) ? 0 : stale + 1;
      if (text.trim()) pendingBreak = true;
      continue;
    }
    // Anything started early for a turn that didn't end on tool_use is dropped unsent.
    round.abort();
    // Not a tool round after all: the held text is the answer (or its start), shown now.
    if (held) {
      const piece = held;
      held = "";
      show(piece);
    }

    if (msg.stop_reason === "refusal") {
      const piece = `${text ? "\n\n" : ""}I can't help with that one.`;
      text += piece;
      o.onText?.(piece);
      return { text, usage, calls, tools, stop: "refusal", refusalCategory: msg.stop_details?.category ?? null };
    }
    if (msg.stop_reason === "max_tokens") {
      const piece = text.trim() ? "\n\n(Cut short. Ask me to continue.)" : "I ran out of room before answering. Ask again with a narrower question.";
      text += piece;
      o.onText?.(piece);
      return { text, usage, calls, tools, stop: "max_tokens", refusalCategory: null };
    }
    if (!text.trim() && !askedForText) {
      // A turn that ended in thinking only: ask once for the answer itself. Appending a user
      // message keeps the history append-only, so the thinking blocks before it stay valid.
      askedForText = true;
      if (msg.content.length) o.messages.push({ role: "assistant", content: msg.content });
      o.messages.push({ role: "user", content: "Please write your answer to my question now." });
      calls = Math.max(calls, o.maxCalls - 1);
      continue;
    }
    const stop: LoopResult["stop"] = msg.stop_reason === "end_turn" ? "end_turn" : mustAnswer ? "budget" : "other";
    return { text, usage, calls, tools, stop, refusalCategory: null };
  }
}

/** True when the request may carry the per-message features (they are on and the account accepted them so far). */
export const canUsePerMessageEffort = () => featureOn("perMessageEffort");
export const canUseSystemMessages = () => featureOn("systemMessages");
