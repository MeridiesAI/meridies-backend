// Test doubles for the AxIS suites: an in-memory stand-in for the PostgREST
// query builder (enough of its filters to run the real queries), a request,
// and a scripted Messages API for the model loop. Not a test file itself.
import type { FastifyRequest } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesApi, StreamLike, StreamParams } from "../../src/lib/axis/loop.js";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

/** One query the fake ran: what it did and which columns it filtered on (an update's filters say which rows it may touch). */
export type DbCall = { table: string; op: "select" | "update" | "insert" | "delete"; patch?: Row; filters: string[] };

let fakeIds = 0;
/** A uuid-shaped id, unique within the test process. */
export const fakeId = () => `00000000-0000-4000-8000-${String(++fakeIds).padStart(12, "0")}`;

/**
 * Columns the fake database doesn't have, as `{ table, column }` rows under "missing:columns". By default
 * ai_messages.outside_quotes (20261108000004), so a suite runs today's rules unless it passes [] to turn the
 * free-text rule on (lib/axis/failsafe.ts flagsReady).
 */
const DEFAULT_MISSING: Row[] = [{ table: "ai_messages", column: "outside_quotes" }];

let stamps = 0;
/** A strictly later timestamp on every call. */
export const nextStamp = () => new Date(Date.UTC(2026, 10, 8, 12, 0, 0) + ++stamps).toISOString();

export function fakeDb(tables: Record<string, Row[]>, calls?: DbCall[]) {
  return {
    from(table: string) {
      let selected = "";
      const filters: Filter[] = [];
      const cols: string[] = [];
      let patch: Row | null = null;
      let inserting: Row[] | null = null;
      let deleting = false;
      let orderBy: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      let range: [number, number] | null = null;
      let head = false;
      let countMode = false;
      let single: "maybe" | "one" | null = null;
      const cmp = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
      const chain: Record<string, unknown> = {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          selected = cols ?? "";
          countMode = !!opts?.count;
          head = !!opts?.head;
          return chain;
        },
        update: (p: Row) => ((patch = p), chain),
        insert: (r: Row | Row[]) => ((inserting = (Array.isArray(r) ? r : [r]).map((x) => ({ ...x }))), chain),
        delete: () => ((deleting = true), chain),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), cols.push(c), chain),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), chain),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
        lte: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) <= 0), chain),
        lt: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) < 0), chain),
        gte: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) >= 0), chain),
        gt: (c: string, v: unknown) => (filters.push((r) => r[c] != null && cmp(r[c], v) > 0), chain),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), cols.push(c), chain),
        not: (c: string, op: string, v: unknown) => (filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)), cols.push(c), chain),
        // PostgREST's or=(a.is.null,a.lt."<value>"): enough of it for is, eq and lt.
        or: (expr: string) => {
          const parts = expr.split(",").map((part) => {
            const [c, op, ...rest] = part.split(".");
            return { c: c!, op: op!, v: rest.join(".").replace(/^"|"$/g, "") };
          });
          filters.push((r) =>
            parts.some(({ c, op, v }) =>
              op === "is" ? (r[c] ?? null) === (v === "null" ? null : v) : op === "eq" ? String(r[c]) === v : op === "lt" ? r[c] != null && cmp(r[c], v) < 0 : false
            )
          );
          cols.push(...parts.map((p) => p.c));
          return chain;
        },
        ilike: (c: string, p: string) => (filters.push((r) => new RegExp(`^${p.replace(/%/g, ".*")}$`, "i").test(String(r[c] ?? ""))), chain),
        order: (c: string, o?: { ascending?: boolean }) => ((orderBy = { col: c, asc: o?.ascending !== false }), chain),
        limit: (n: number) => ((lim = n), chain),
        range: (a: number, b: number) => ((range = [a, b]), chain),
        maybeSingle: () => ((single = "maybe"), chain),
        single: () => ((single = "one"), chain),
        then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
          if (inserting) {
            const t = (tables[table] ??= []);
            for (const r of inserting) {
              r.id ??= fakeId();
              r.created_at ??= new Date().toISOString();
              t.push(r);
            }
            calls?.push({ table, op: "insert", filters: [] });
            const out = single ? { data: inserting[0] ?? null, error: null } : { data: inserting, error: null };
            return Promise.resolve(out).then(resolve, reject);
          }
          const asked = selected.split(",").map((c) => c.trim());
          const gone = (tables["missing:columns"] ?? DEFAULT_MISSING).find((m) => m.table === table && asked.includes(String(m.column)));
          if (gone) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${String(gone.column)} does not exist` } }).then(resolve, reject);
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (orderBy) {
            const { col, asc } = orderBy;
            rows = rows.slice().sort((a, b) => (asc ? 1 : -1) * cmp(a[col] ?? "", b[col] ?? ""));
          }
          if (range) rows = rows.slice(range[0], range[1] + 1);
          if (lim !== null) rows = rows.slice(0, lim);
          calls?.push({ table, op: patch ? "update" : "select", ...(patch ? { patch } : {}), filters: cols.slice() });
          if (patch) {
            // Tables listed under "touch:updated_at" move updated_at on every write, like the set_updated_at trigger.
            const touch = (tables["touch:updated_at"] ?? []).some((t) => t.table === table);
            for (const r of rows) Object.assign(r, patch, touch ? { updated_at: nextStamp() } : {});
          }
          if (deleting) {
            tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
            calls?.push({ table, op: "delete", filters: cols.slice() });
          }
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
  /** Replaces fields of this message's usage (the default is 100 in, 20 out, 80 read from cache). */
  usage?: Record<string, unknown>;
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
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, ...turn.usage },
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

// ---- A request that can run operations (app.inject through dispatch) ---------------------------------

export type Injected = { method: string; url: string; payload?: string };

/** fakeRequest plus `server.inject`: every API call AxIS makes is recorded and answered by `answer` (default 200 with an id). */
export function fakeOpsRequest(tables: Record<string, Row[]>, o: { userId?: string; answer?: (call: Injected) => { status: number; body: unknown } } = {}) {
  const injected: Injected[] = [];
  const request = fakeRequest(tables, o.userId) as unknown as Record<string, unknown>;
  (request.auth as Record<string, unknown>).token = "tok";
  request.headers = {};
  request.server = {
    inject: async (call: Injected) => {
      injected.push(call);
      const a = o.answer?.(call) ?? { status: 200, body: { id: fakeId() } };
      return { statusCode: a.status, body: JSON.stringify(a.body) };
    },
  };
  return { request: request as unknown as FastifyRequest, injected };
}
