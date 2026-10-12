/**
 * Running operations: the two AxIS tools (`lookup`, `perform_action`), the
 * counselor's Confirm and Undo, and the line of recent changes each turn reads.
 *
 * A write goes one of two ways:
 *  - auto: it runs now, an `axis_actions` row records what ran (status
 *    `executed`, with the reversal), and the card says Done with an Undo;
 *  - confirm: an `axis_actions` row waits (status `pending`) and nothing else
 *    happens until the counselor clicks Confirm, which runs the same request.
 *
 * An auto write is turned into a confirm one when the turn has read outside
 * content (documents, mail, connected files), so text in a file can't make
 * AxIS change anything without a click, and after five auto writes in one
 * turn, so a runaway loop stops at a card. A turn holds twenty writes at most.
 */
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "../../errors.js";
import { resolveStudentId } from "../../guards.js";
import { wrapUntrusted } from "../../context/pack.js";
import { assertAllowedCall, dispatch, failureMessage, isTransient } from "./dispatch.js";
import { getOp, headingOf, riskOf } from "./registry.js";
import type { OpCall, OpDef, OpHelpers, UndoStep } from "./types.js";

export const MAX_WRITES_PER_TURN = 20;
export const MAX_AUTO_WRITES_PER_TURN = 5;

/** Shared by every tool call in one turn (the object is passed by reference). */
export type TurnBudget = {
  /** Outside content (documents, mail, connected files) reached the model this turn. */
  tainted: boolean;
  writes: number;
  autoWrites: number;
};

export const newTurnBudget = (tainted = false): TurnBudget => ({ tainted, writes: 0, autoWrites: 0 });

export type OperationStatus = "pending" | "executed" | "confirmed" | "dismissed" | "failed" | "undone";

/** What the app gets in the `action` event and from GET /axis/actions. Never the raw input. */
export type OperationPayload = {
  op: string;
  area: string;
  summary: string;
  details: string[];
  warning: string | null;
  status: OperationStatus;
  undoable: boolean;
  /** Why an action that normally runs at once is waiting: AxIS read outside content, or made many changes. */
  reason: "outside-content" | "many-changes" | null;
  message?: string | null;
};

export type OperationEvent = { id: string; type: "operation"; studentId: string | null; payload: OperationPayload };

export type OpContext = {
  request: FastifyRequest;
  conversationId: string;
  /** The chat's student; the default for an op that takes `student_id`. */
  studentId: string | null;
  roster: { get(id: string): { name: string } | undefined };
  turn: TurnBudget;
  signal: AbortSignal;
  onOperation: (e: OperationEvent) => void;
};

export type OpOutput = { content: string; isError?: boolean; fresh: boolean };

/** The row as it is stored. `input` is only ever read back by Confirm, never sent to the app. */
type StoredPayload = Omit<OperationPayload, "status" | "undoable" | "message"> & { input: Record<string, unknown> };

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * A catalog hook (describe, details, snapshot, undo, reply) run so that its
 * failure, thrown or rejected, sync or async, is a null rather than a thrown
 * turn. After a write has gone through this matters most: a throw there would
 * read as "failed" to the model (which may then repeat the change) or release
 * a Confirm claim (so a second click would run it twice).
 */
async function safely<T>(f: () => T | Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}
function safelySync<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** The row's payload must fit the 32 KB CHECK (20261019000001); bytes, not characters. */
export const PAYLOAD_MAX_BYTES = 30_000;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Drops card detail lines (newest last first) until the stored payload fits; null when even the input alone doesn't. */
export function fitPayload(p: StoredPayload): StoredPayload | null {
  if (bytes(p) <= PAYLOAD_MAX_BYTES) return p;
  const details = p.details.slice();
  while (details.length) {
    details.pop();
    const trimmed = { ...p, details: [...details, "(More detail than a card holds; see the request.)"] };
    if (bytes(trimmed) <= PAYLOAD_MAX_BYTES) return trimmed;
  }
  const bare = { ...p, details: [] };
  return bytes(bare) <= PAYLOAD_MAX_BYTES ? bare : null;
}

const notRun = (why: string): OpOutput => ({ content: `Not done: ${why}`, isError: true, fresh: false });
const STOPPED = "the answer was stopped before this change ran. Nothing was changed.";
const writeLimit = (): OpOutput => ({
  content: `That's ${MAX_WRITES_PER_TURN} changes in one message, the limit. Stop here and tell the counselor what is left to do.`,
  isError: true,
  fresh: false,
});

export function helpers(request: FastifyRequest, roster: OpContext["roster"] | null): OpHelpers {
  return {
    studentName: (id) => (id && roster?.get(id)?.name) || "the student",
    get: async <T>(url: string): Promise<T | null> => {
      try {
        const r = await dispatch(request, { method: "GET", url });
        return r.status < 300 ? (r.body as T) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Fills the chat's student into an op that takes one, then validates. Throws ZodError on bad input. */
export function prepareInput(def: OpDef, raw: unknown, chatStudentId: string | null): Record<string, unknown> {
  const obj: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (def.takesStudent && (obj.student_id === undefined || obj.student_id === null || obj.student_id === "") && chatStudentId) {
    obj.student_id = chatStudentId;
  }
  return def.input.parse(obj) as Record<string, unknown>;
}

function zodText(err: ZodError, def: OpDef): string {
  const issues = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  return `Invalid input for ${def.name}: ${issues}. Expected ${def.doc}. Fix it and call again.`;
}

/** A reversal that names a real write op with a valid input; anything else is dropped. */
function validUndo(step: unknown): UndoStep | null {
  if (!step || typeof step !== "object") return null;
  const s = step as Partial<UndoStep>;
  if (typeof s.op !== "string") return null;
  const def = getOp(s.op);
  if (!def || def.kind !== "write") return null;
  return def.input.safeParse(s.input).success ? (s as UndoStep) : null;
}

/** The reversal stored on a row's result, if it is one Undo would run. */
export const undoStepOf = (result: unknown): UndoStep | null =>
  validUndo(result && typeof result === "object" ? (result as { undo?: unknown }).undo : null);

/** The reversal a catalog op computes after its write. Never throws: the write already happened. */
function reversalOf(def: OpDef, input: Record<string, unknown>, body: unknown, before: unknown): UndoStep | null {
  return safelySync(() => validUndo(def.undo?.(input, body, before)));
}

function defaultReply(body: unknown): string {
  const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).id : null;
  return typeof id === "string" || typeof id === "number" ? `New id ${String(id)}.` : "";
}

async function studentFor(ctx: Pick<OpContext, "request">, def: OpDef, input: Record<string, unknown>, mode: "view" | "edit"): Promise<string | null> {
  if (!def.takesStudent) return null;
  const id = input.student_id;
  if (typeof id !== "string") return null;
  return resolveStudentId(ctx.request, id, mode);
}

async function insertAction(
  request: FastifyRequest,
  row: { conversationId: string; studentId: string | null; status: OperationStatus; payload: StoredPayload; result?: Record<string, unknown> }
): Promise<{ id: string | null; schemaMissing: boolean }> {
  const { data, error } = await request.db
    .from("axis_actions")
    .insert({
      owner_id: request.auth.userId,
      conversation_id: row.conversationId,
      student_id: row.studentId,
      type: "operation",
      payload: row.payload,
      status: row.status,
      ...(row.result ? { result: row.result } : {}),
      ...(row.status === "pending" ? {} : { decided_at: new Date().toISOString() }),
    })
    .select("id")
    .single();
  if (error) {
    // 23514 from the type/status CHECK of 20261018000001, which doesn't know 'operation' yet
    // (20261019000001 not applied). The payload size CHECK raises 23514 too, and isn't a missing migration.
    const checkFailed = error.code === "23514" && !/payload/i.test(String((error as { message?: string }).message ?? ""));
    const schemaMissing = checkFailed || error.code === "42P01" || error.code === "PGRST205";
    request.log.warn({ code: error.code }, "axis operation not recorded");
    return { id: null, schemaMissing };
  }
  return { id: String(data.id), schemaMissing: false };
}

/** `lookup`: a read op, as the counselor, with only the fields its reply keeps. */
export async function runRead(ctx: OpContext, name: string, raw: unknown): Promise<OpOutput> {
  const def = getOp(name);
  if (!def || def.kind !== "read") return { content: `There is no lookup called ${name}. Use a (lookup) name from the catalog.`, isError: true, fresh: false };
  let input: Record<string, unknown>;
  try {
    input = prepareInput(def, raw, ctx.studentId);
  } catch (err) {
    if (err instanceof ZodError) return { content: zodText(err, def), isError: true, fresh: false };
    throw err;
  }
  await studentFor(ctx, def, input, "view");
  const call = def.request(input);
  // `lookup` starts before the model's turn is complete and is answered from memory on a repeat:
  // only a GET may run that way, whatever a catalog entry says.
  if (call.method !== "GET") return { content: `${name} isn't a lookup AxIS can run.`, isError: true, fresh: false };
  const res = await dispatch(ctx.request, call);
  if (res.status >= 400) return { content: failureMessage(res), isError: true, fresh: false };
  const content = def.reply ? (safelySync(() => def.reply!(res.body, input)) ?? "That lookup's answer couldn't be read.") : "Done.";
  return { content: content || "Nothing found.", fresh: !!content };
}

/** `perform_action`: run it now, or file it for the counselor's Confirm. */
export async function runWrite(ctx: OpContext, name: string, raw: unknown): Promise<OpOutput> {
  const def = getOp(name);
  if (!def || def.kind !== "write") return { content: `There is no action called ${name}. Use an action name from the catalog.`, isError: true, fresh: false };
  if (ctx.turn.writes >= MAX_WRITES_PER_TURN) return writeLimit();
  let input: Record<string, unknown>;
  try {
    input = prepareInput(def, raw, ctx.studentId);
  } catch (err) {
    if (err instanceof ZodError) return { content: zodText(err, def), isError: true, fresh: false };
    throw err;
  }
  // The request this becomes, checked now: a card for a path AxIS may not call (or essay prose) is never filed.
  const call: OpCall = def.request(input);
  assertAllowedCall(call);
  const studentId = await studentFor(ctx, def, input, "edit");
  const h = helpers(ctx.request, ctx.roster);
  // Labels are best effort: a failed lookup of the target falls back to the op's title, never fails the change.
  const described = await safely(() => def.describe?.(input, h));
  const summary = clipText(typeof described === "string" && described.trim() ? described : def.title, 300);
  const detailLines = await safely(() => def.details?.(input, h));
  const details = (Array.isArray(detailLines) ? detailLines : []).slice(0, 12).map((d) => clipText(String(d), 1600));

  // From here to the reservation below nothing awaits, so calls running side by side in one round
  // can't all pass the checks before any of them counts.
  if (ctx.signal.aborted) return notRun(STOPPED);
  if (ctx.turn.writes >= MAX_WRITES_PER_TURN) return writeLimit();
  let risk = riskOf(def, input);
  let reason: OperationPayload["reason"] = null;
  if (risk === "auto" && ctx.turn.tainted) {
    risk = "confirm";
    reason = "outside-content";
  } else if (risk === "auto" && ctx.turn.autoWrites >= MAX_AUTO_WRITES_PER_TURN) {
    risk = "confirm";
    reason = "many-changes";
  }
  ctx.turn.writes++;
  if (risk === "auto") ctx.turn.autoWrites++;

  const warning = risk === "confirm" ? (def.warning ?? null) : null;
  const stored = fitPayload({ op: def.name, area: headingOf(def.name), summary, details, warning, reason, input });
  if (!stored) return notRun("that change is too large for AxIS to file or record. Nothing was changed; tell the counselor to make it in the app.");
  const show = (status: OperationStatus, undoable: boolean, message: string | null = null): OperationPayload => ({
    op: stored.op, area: stored.area, summary, details: stored.details, warning, reason, status, undoable, message,
  });

  if (risk === "confirm") {
    const rec = await insertAction(ctx.request, { conversationId: ctx.conversationId, studentId, status: "pending", payload: stored });
    if (!rec.id) {
      return {
        content: rec.schemaMissing
          ? "Changes that need the counselor's confirmation can't be filed until a database update (20261019000001) is applied. Tell the counselor; nothing was changed."
          : "That change couldn't be filed for confirmation. Nothing was changed; tell the counselor.",
        isError: true,
        fresh: false,
      };
    }
    if (!ctx.signal.aborted) ctx.onOperation({ id: rec.id, type: "operation", studentId, payload: show("pending", false) });
    const why = reason === "outside-content" ? " (it would normally run at once, but this turn read outside content)" : reason === "many-changes" ? " (many changes in one message)" : "";
    return {
      content: `Filed for the counselor's confirmation${why}: ${wrapUntrusted("action", summary)}. Card ${rec.id}. It has NOT happened yet; say it is waiting for them to confirm.`,
      fresh: true,
    };
  }

  const before = def.snapshot ? await safely(() => def.snapshot!(input, h)) : undefined;
  // A call that timed out, or a panel the counselor closed, must not start a change the model was told didn't happen.
  if (ctx.signal.aborted) return notRun(STOPPED);
  const res = await dispatch(ctx.request, call);
  if (res.status >= 400) return notRun(failureMessage(res));
  // From here on the change has happened: nothing below may throw, or the model would be told it failed.
  const undo = reversalOf(def, input, res.body, before);
  // Recorded even if the counselor closed the panel: the change happened and the trail must show it.
  const rec = await insertAction(ctx.request, {
    conversationId: ctx.conversationId, studentId, status: "executed", payload: stored, result: { ok: true, ...(undo ? { undo } : {}) },
  }).catch((): { id: null; schemaMissing: false } => ({ id: null, schemaMissing: false }));
  if (!ctx.signal.aborted) {
    ctx.onOperation({ id: rec.id ?? `local-${randomUUID()}`, type: "operation", studentId, payload: show("executed", !!(undo && rec.id)) });
  }
  const extra = (def.reply ? safelySync(() => def.reply!(res.body, input)) : null) ?? defaultReply(res.body);
  return { content: `Done: ${wrapUntrusted("action", summary)}.${extra ? ` ${extra}` : ""}`, fresh: true };
}

// ---- The counselor's click ---------------------------------------------------------

export type DecisionResult =
  | { status: "confirmed"; result: { ok: true; summary: string; undoable: boolean; undo?: UndoStep } }
  | { status: "failed"; result: { ok: false; message: string } };

/** A failure the counselor may simply retry: the route releases its claim and answers with this. */
export class TransientOperationError extends HttpError {
  constructor(message: string) {
    super(503, message);
  }
}

/**
 * Runs a confirmed proposal. Everything is checked again at the click: the
 * operation must still exist, its stored input must still validate, and the
 * counselor must still be able to edit the student.
 */
export async function confirmOperation(request: FastifyRequest, row: { student_id: string | null; payload: unknown }): Promise<DecisionResult> {
  const p = (row.payload ?? {}) as Partial<StoredPayload>;
  const def = typeof p.op === "string" ? getOp(p.op) : undefined;
  if (!def || def.kind !== "write") return { status: "failed", result: { ok: false, message: "AxIS can no longer do that. Ask again." } };
  const parsed = def.input.safeParse(p.input ?? {});
  if (!parsed.success) return { status: "failed", result: { ok: false, message: "That proposal no longer fits. Ask AxIS again." } };
  const input = parsed.data as Record<string, unknown>;
  try {
    await studentFor({ request }, def, input, "edit");
  } catch (err) {
    if (err instanceof HttpError && err.statusCode < 500) return { status: "failed", result: { ok: false, message: err.message } };
    throw err;
  }
  // A request that can't be built, or a path AxIS may not call, will never run: fail the card rather
  // than hand the claim back for another click.
  let call: OpCall;
  try {
    call = def.request(input);
    assertAllowedCall(call);
  } catch (err) {
    return { status: "failed", result: { ok: false, message: err instanceof HttpError && err.statusCode < 500 ? err.message : "AxIS can no longer do that. Ask again." } };
  }
  const h = helpers(request, null);
  const before = def.snapshot ? await safely(() => def.snapshot!(input, h)) : undefined;
  const res = await dispatch(request, call);
  if (isTransient(res.status)) throw new TransientOperationError(failureMessage(res));
  if (res.status >= 400) return { status: "failed", result: { ok: false, message: failureMessage(res) } };
  // The change has happened. A throw from here would release the claim and let a second Confirm run it again.
  const undo = reversalOf(def, input, res.body, before);
  return { status: "confirmed", result: { ok: true, summary: String(p.summary ?? def.title), undoable: !!undo, ...(undo ? { undo } : {}) } };
}

/** Runs the reversal stored on an executed or confirmed row. Throws an HttpError the route passes on. */
export async function undoOperation(request: FastifyRequest, row: { result: unknown }): Promise<void> {
  const step = undoStepOf(row.result);
  if (!step) throw new HttpError(409, "That change can't be undone from here.");
  const def = getOp(step.op)!;
  const input = def.input.parse(step.input) as Record<string, unknown>;
  const res = await dispatch(request, def.request(input));
  if (isTransient(res.status)) throw new TransientOperationError(failureMessage(res));
  if (res.status >= 400) throw new HttpError(res.status === 404 ? 409 : res.status, `Couldn't undo: ${failureMessage(res)}`);
}

// ---- What AxIS remembers between turns ----------------------------------------------------

const STATUS_WORDS: Record<string, string> = {
  pending: "waiting for the counselor's confirmation (not done)",
  executed: "done",
  confirmed: "confirmed by the counselor and done",
  dismissed: "dismissed by the counselor (not done)",
  failed: "failed",
  undone: "undone by the counselor",
};

/**
 * The changes AxIS made or proposed in this chat, newest first, so a follow-up
 * knows what the counselor confirmed, dismissed or undid since the last answer.
 * Goes in the user turn (not the cached system prompt). Empty when there are none.
 */
export async function recentActionsText(request: FastifyRequest, conversationId: string): Promise<string> {
  const { data, error } = await request.db
    .from("axis_actions")
    .select("id, type, status, payload, result, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(12);
  if (error || !data?.length) return "";
  const lines = data.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const res = (r.result ?? {}) as Record<string, unknown>;
    const what =
      r.type === "operation"
        ? String(p.summary ?? p.op ?? "a change")
        : r.type === "email_draft"
          ? `Email draft: ${String(p.subject ?? "")}`
          : `Work Queue item: ${String(p.title ?? "")}`;
    const status = String(r.status);
    // The failure reason is a route's text kept on the row (and `result` is writable by the client): data, like the summary.
    const failed = status === "failed" && typeof res.message === "string" && res.message.trim() ? ` ${wrapUntrusted("reason", clipText(res.message, 300))}` : "";
    return `- ${STATUS_WORDS[status] ?? "unknown"}${failed} · ${wrapUntrusted("action", clipText(what, 200))}`;
  });
  return `Changes AxIS made or proposed earlier in this chat, newest first:\n${lines.join("\n")}`;
}

/** Ids that are real rows (an unrecorded auto change gets a local id the database never saw). */
export const recordedIds = (ids: string[]) => ids.filter(isUuid);
