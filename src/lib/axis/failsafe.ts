/**
 * What keeps AxIS from taking the counselor's chat down with it.
 *
 *  - Readiness, before the stream opens. Without ANTHROPIC_API_KEY, or with
 *    the 20261018000001 migration not yet applied, POST /axis/.../messages
 *    answers 503 { code: "axis_unavailable" } before it writes anything, so
 *    the app can send the same message to /chat instead. The schema is
 *    probed with three zero-row reads on the caller's own client; a ready
 *    answer is kept for the life of the process, a missing one for 30
 *    seconds, so applying the migration takes effect without a deploy.
 *  - Schema errors anywhere else (a column dropped, a table renamed) are
 *    recognised by their Postgres / PostgREST codes and turned into the same
 *    503, never a bare 500.
 *  - The SSE turn (runSseTurn): a hard wall clock over the whole turn, the
 *    client closing the panel aborting the model and the tools, every failure
 *    ending with one `error` event carrying a message written for the
 *    counselor, and the stream always ending.
 */
import { HttpError, publicMessage } from "../errors.js";

export const AXIS_UNAVAILABLE = "axis_unavailable";
export const AXIS_UNAVAILABLE_MESSAGE = "AxIS is unavailable right now. Try again in a few minutes.";

/** Wall clock for a whole turn, evidence to verification. The tool phase has its own 40 s (engine.ts). */
export const TURN_TIMEOUT_MS = 90_000;
export const TURN_TIMEOUT_MESSAGE = "AxIS took too long to answer. Try again, or ask a narrower question.";

/**
 * Codes that mean "this build expects schema the database doesn't have":
 * undefined table / column from Postgres, and PostgREST's schema-cache misses
 * (column, table, relationship, function).
 */
const SCHEMA_CODES = new Set(["42P01", "42703", "PGRST200", "PGRST202", "PGRST204", "PGRST205"]);

export function isSchemaMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_CODES.has(code);
}

export const axisUnavailable = (message = AXIS_UNAVAILABLE_MESSAGE) => new HttpError(503, message, AXIS_UNAVAILABLE);

/** The JSON body of the fallback signal: `error` is what the app's ApiError reads, `message` the same text. */
export const unavailableBody = (message = AXIS_UNAVAILABLE_MESSAGE) => ({ error: message, message, code: AXIS_UNAVAILABLE });

export type Readiness = { ok: true } | { ok: false; reason: "no_key" | "schema" | "probe_failed" };

/** Any PostgREST-shaped client: the three probes only need from().select().limit(). */
type ProbeDb = {
  from(table: string): { select(cols: string): { limit(n: number): PromiseLike<{ error: { code?: string; message?: string } | null }> } };
};

/** The columns and table this build reads that 20261018000001 adds. Zero-row reads, so RLS costs nothing. */
export async function probeAxisSchema(db: ProbeDb): Promise<{ code?: string; message?: string } | null> {
  const results = await Promise.all([
    db.from("ai_conversations").select("summary, summary_through, state").limit(0),
    db.from("ai_messages").select("verification").limit(0),
    db.from("axis_actions").select("id").limit(0),
  ]);
  return results.find((r) => r.error)?.error ?? null;
}

const MISSING_TTL_MS = 30_000;
let schemaReady = false;
let missingUntil = 0;

/** Tests only. */
export function resetReadiness(): void {
  schemaReady = false;
  missingUntil = 0;
}

export async function axisReadiness(o: {
  hasKey: boolean;
  probe: () => Promise<{ code?: string; message?: string } | null>;
  now?: number;
  log?: { warn: (obj: object, msg: string) => void };
}): Promise<Readiness> {
  if (!o.hasKey) return { ok: false, reason: "no_key" };
  if (schemaReady) return { ok: true };
  const now = o.now ?? Date.now();
  if (now < missingUntil) return { ok: false, reason: "schema" };
  let error: { code?: string; message?: string } | null;
  try {
    error = await o.probe();
  } catch (err) {
    o.log?.warn({ err }, "axis schema probe failed");
    return { ok: false, reason: "probe_failed" };
  }
  if (!error) {
    schemaReady = true;
    return { ok: true };
  }
  if (isSchemaMissing(error)) {
    missingUntil = now + MISSING_TTL_MS;
    o.log?.warn({ code: error.code }, "axis tables missing: apply supabase/migrations/20261018000001_axis_orchestrator.sql");
    return { ok: false, reason: "schema" };
  }
  // A transient read failure isn't remembered: the next message probes again.
  o.log?.warn({ code: error.code }, "axis schema probe failed");
  return { ok: false, reason: "probe_failed" };
}

/** Logs a failed write that must not end the turn (state, verification, proposal links). */
export function logSkipped(log: { warn: (obj: object, msg: string) => void }, what: string) {
  return (res: { error: { code?: string; message?: string } | null } | void) => {
    if (res && res.error) log.warn({ code: res.error.code }, `axis ${what} not saved`);
  };
}

export type SseSink = {
  write(chunk: string): void;
  end(): void;
  readonly ended: boolean;
};

export type TurnEmit = (event: string, data: unknown) => void;

/**
 * Runs one streamed turn and guarantees how it ends.
 *
 *  - `work` gets a signal that aborts when the client goes away (`clientClosed`)
 *    or the turn passes `timeoutMs`; it is handed to the model stream and the tools.
 *  - A throw before `done` ends with one `error` event; the message is ours
 *    (publicMessage: an HttpError's text, otherwise the fallback), never an
 *    SDK's or Postgres's.
 *  - The timeout ends the stream itself, with an `error` event if `done` hasn't
 *    gone out, even if `work` ignores the signal and never settles.
 *  - Nothing is written after the client has gone.
 */
export function runSseTurn(o: {
  sink: SseSink;
  timeoutMs?: number;
  pingMs?: number;
  log: { error: (obj: object, msg: string) => void };
  work: (ctx: { signal: AbortSignal; emit: TurnEmit; markDone: () => void }) => Promise<void>;
  onSettled?: () => void;
}): { clientClosed: () => void; settled: Promise<void> } {
  const controller = new AbortController();
  let clientGone = false;
  let timedOut = false;
  let doneSent = false;

  const emit: TurnEmit = (event, data) => {
    if (o.sink.ended || clientGone) return;
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch {
      return;
    }
    o.sink.write(`event: ${event}\ndata: ${payload}\n\n`);
  };
  const ping = setInterval(() => {
    if (!o.sink.ended && !clientGone) o.sink.write(": ping\n\n");
  }, o.pingMs ?? 15_000);
  const finish = () => {
    clearInterval(ping);
    clearTimeout(timer);
    if (!o.sink.ended) o.sink.end();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    if (!doneSent) emit("error", { message: TURN_TIMEOUT_MESSAGE });
    finish();
  }, o.timeoutMs ?? TURN_TIMEOUT_MS);

  const settled = (async () => {
    try {
      await o.work({ signal: controller.signal, emit, markDone: () => (doneSent = true) });
    } catch (err) {
      if (!clientGone && !timedOut) {
        o.log.error({ err }, "axis stream failed");
        if (!doneSent) emit("error", { message: publicMessage(err, AXIS_UNAVAILABLE_MESSAGE).slice(0, 300) });
      }
    } finally {
      finish();
      o.onSettled?.();
    }
  })();

  return {
    clientClosed: () => {
      clientGone = true;
      controller.abort();
      finish();
    },
    settled,
  };
}
