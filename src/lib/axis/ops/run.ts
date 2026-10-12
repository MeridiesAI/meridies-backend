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
import { dispatch, failureMessage, isTransient } from "./dispatch.js";
import { getOp, headingOf, riskOf } from "./registry.js";
import type { OpDef, OpHelpers, UndoStep } from "./types.js";

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
function validUndo(step: UndoStep | null | undefined): UndoStep | null {
  if (!step) return null;
  const def = getOp(step.op);
  if (!def || def.kind !== "write") return null;
  return def.input.safeParse(step.input).success ? step : null;
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
    // 23514: the CHECK from 20261018000001 doesn't know 'operation' yet (20261019000001 not applied).
    const schemaMissing = error.code === "23514" || error.code === "42P01" || error.code === "PGRST205";
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
  const res = await dispatch(ctx.request, def.request(input));
  if (res.status >= 400) return { content: failureMessage(res), isError: true, fresh: false };
  const content = def.reply ? def.reply(res.body, input) : "Done.";
  return { content: content || "Nothing found.", fresh: !!content };
}

/** `perform_action`: run it now, or file it for the counselor's Confirm. */
export async function runWrite(ctx: OpContext, name: string, raw: unknown): Promise<OpOutput> {
  const def = getOp(name);
  if (!def || def.kind !== "write") return { content: `There is no action called ${name}. Use an action name from the catalog.`, isError: true, fresh: false };
  if (ctx.turn.writes >= MAX_WRITES_PER_TURN) {
    return { content: `That's ${MAX_WRITES_PER_TURN} changes in one message, the limit. Stop here and tell the counselor what is left to do.`, isError: true, fresh: false };
  }
  let input: Record<string, unknown>;
  try {
    input = prepareInput(def, raw, ctx.studentId);
  } catch (err) {
    if (err instanceof ZodError) return { content: zodText(err, def), isError: true, fresh: false };
    throw err;
  }
  const studentId = await studentFor(ctx, def, input, "edit");
  const h = helpers(ctx.request, ctx.roster);
  // Labels are best effort: a failed lookup of the target falls back to the op's title, never fails the change.
  const summary = clipText((await Promise.resolve(def.describe?.(input, h)).catch(() => null)) ?? def.title, 300);
  const details = ((await Promise.resolve(def.details?.(input, h)).catch(() => null)) ?? []).slice(0, 12).map((d) => clipText(d, 1600));

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

  const warning = risk === "confirm" ? (def.warning ?? null) : null;
  const stored: StoredPayload = { op: def.name, area: headingOf(def.name), summary, details, warning, reason, input };
  const show = (status: OperationStatus, undoable: boolean, message: string | null = null): OperationPayload => ({
    op: stored.op, area: stored.area, summary, details, warning, reason, status, undoable, message,
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

  ctx.turn.autoWrites++;
  const before = def.snapshot ? await def.snapshot(input, h).catch(() => null) : undefined;
  const res = await dispatch(ctx.request, def.request(input));
  if (res.status >= 400) return { content: `Not done: ${failureMessage(res)}`, isError: true, fresh: false };
  const undo = validUndo(def.undo?.(input, res.body, before));
  // Recorded even if the counselor closed the panel: the change happened and the trail must show it.
  const rec = await insertAction(ctx.request, {
    conversationId: ctx.conversationId, studentId, status: "executed", payload: stored, result: { ok: true, ...(undo ? { undo } : {}) },
  });
  if (!ctx.signal.aborted) {
    ctx.onOperation({ id: rec.id ?? `local-${randomUUID()}`, type: "operation", studentId, payload: show("executed", !!(undo && rec.id)) });
  }
  const extra = def.reply ? def.reply(res.body, input) : defaultReply(res.body);
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
  const h = helpers(request, null);
  const before = def.snapshot ? await def.snapshot(input, h).catch(() => null) : undefined;
  const res = await dispatch(request, def.request(input));
  if (isTransient(res.status)) throw new TransientOperationError(failureMessage(res));
  if (res.status >= 400) return { status: "failed", result: { ok: false, message: failureMessage(res) } };
  const undo = validUndo(def.undo?.(input, res.body, before));
  return { status: "confirmed", result: { ok: true, summary: String(p.summary ?? def.title), undoable: !!undo, ...(undo ? { undo } : {}) } };
}

/** Runs the reversal stored on an executed or confirmed row. Throws an HttpError the route passes on. */
export async function undoOperation(request: FastifyRequest, row: { result: unknown }): Promise<void> {
  const r = (row.result ?? {}) as { undo?: UndoStep };
  const step = validUndo(r.undo);
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
    const failed = status === "failed" && typeof res.message === "string" ? `: ${res.message}` : "";
    return `- ${STATUS_WORDS[status] ?? status}${failed} · ${wrapUntrusted("action", clipText(what, 200))}`;
  });
  return `Changes AxIS made or proposed earlier in this chat, newest first:\n${lines.join("\n")}`;
}

/** Ids that are real rows (an unrecorded auto change gets a local id the database never saw). */
export const recordedIds = (ids: string[]) => ids.filter(isUuid);
