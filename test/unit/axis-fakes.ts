// Test doubles for the AxIS suites: an in-memory stand-in for the PostgREST
// query builder (enough of its filters to run the real queries), a request,
// and a scripted Messages API for the model loop. Not a test file itself.
import type { FastifyRequest } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesApi, StreamLike, StreamParams } from "../../src/lib/axis/loop.js";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let orderBy: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      let range: [number, number] | null = null;
      let head = false;
      let countMode = false;
      let single: "maybe" | "one" | null = null;
      const cmp = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
      const chain: Record<string, unknown> = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          countMode = !!opts?.count;
          head = !!opts?.head;
          return chain;
        },
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), chain),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
        lte: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) <= 0), chain),
        lt: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) < 0), chain),
        gte: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) >= 0), chain),
        gt: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) > 0), chain),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
        not: (c: string, op: string, v: unknown) => (filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)), chain),
        ilike: (c: string, p: string) => (filters.push((r) => new RegExp(`^${p.replace(/%/g, ".*")}$`, "i").test(String(r[c] ?? ""))), chain),
        order: (c: string, o?: { ascending?: boolean }) => ((orderBy = { col: c, asc: o?.ascending !== false }), chain),
        limit: (n: number) => ((lim = n), chain),
        range: (a: number, b: number) => ((range = [a, b]), chain),
        maybeSingle: () => ((single = "maybe"), chain),
        single: () => ((single = "one"), chain),
        then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (orderBy) {
            const { col, asc } = orderBy;
            rows = rows.slice().sort((a, b) => (asc ? 1 : -1) * cmp(a[col] ?? "", b[col] ?? ""));
          }
          if (range) rows = rows.slice(range[0], range[1] + 1);
          if (lim !== null) rows = rows.slice(0, lim);
          let result: unknown;
          if (countMode && head) result = { data: null, count: rows.length, error: null };
          else if (single === "maybe") result = { data: rows[0] ?? null, error: null };
          else if (single === "one") result = rows[0] ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
          else result = { data: rows, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
    /** An rpc answers with the rows under "rpc:<name>". */
    rpc(name: string, _args: unknown) {
      return Promise.resolve({ data: tables[`rpc:${name}`] ?? [], error: null });
    },
  };
}

export function fakeRequest(tables: Record<string, Row[]>, userId = "counselor-1"): FastifyRequest {
  const quiet = () => undefined;
  return {
    db: fakeDb(tables),
    auth: { userId },
    profile: { role: "counselor", id: userId },
    log: { warn: quiet, info: quiet, error: quiet, debug: quiet },
  } as unknown as FastifyRequest;
}

// ---- A scripted Messages API ------------------------------------------------------------

export type Turn = {
  text?: string;
  tools?: { id: string; name: string; input: unknown }[];
  thinkingOnly?: boolean;
  stop?: "end_turn" | "tool_use" | "refusal" | "max_tokens";
  /** Reject this call instead of answering. */
  fail?: unknown;
  /** Milliseconds between closing the tool blocks and finishing the message. */
  tailMs?: number;
};

export type Recorded = { params: StreamParams; at: number };

export function scriptedApi(turns: Turn[]): { api: MessagesApi; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const api: MessagesApi = {
    stream(params) {
      calls.push({ params: structuredClone(params) as StreamParams, at: Date.now() });
      const turn = turns[Math.min(i++, turns.length - 1)]!;
      const handlers: Record<string, ((x: unknown) => void)[]> = {};
      const fire = (ev: string, x: unknown) => (handlers[ev] ?? []).forEach((h) => h(x));
      const final = (async () => {
        await Promise.resolve();
        if (turn.fail) throw turn.fail;
        fire("streamEvent", { type: "message_start" });
        const content: Anthropic.Beta.BetaContentBlock[] = [];
        if (turn.thinkingOnly) content.push({ type: "thinking", thinking: "", signature: "sig" } as Anthropic.Beta.BetaContentBlock);
        if (turn.text) {
          for (const piece of turn.text.match(/.{1,7}/gs) ?? []) fire("text", piece);
          content.push({ type: "text", text: turn.text, citations: null } as Anthropic.Beta.BetaContentBlock);
        }
        for (const t of turn.tools ?? []) {
          const block = { type: "tool_use", id: t.id, name: t.name, input: t.input } as Anthropic.Beta.BetaContentBlock;
          content.push(block);
          fire("contentBlock", block);
        }
        if (turn.tailMs) await new Promise((r) => setTimeout(r, turn.tailMs));
        return {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content,
          stop_reason: turn.stop ?? (turn.tools?.length ? "tool_use" : "end_turn"),
          stop_details: turn.stop === "refusal" ? { type: "refusal", category: "general_harms", explanation: null } : null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
        } as unknown as Anthropic.Beta.BetaMessage;
      })();
      const stream: StreamLike = {
        on(ev: string, cb: (x: never) => void) {
          (handlers[ev] ??= []).push(cb as (x: unknown) => void);
          return stream;
        },
        finalMessage: () => final,
      } as StreamLike;
      return stream;
    },
  };
  return { api, calls };
}
