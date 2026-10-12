/**
 * AxIS over HTTP. Conversations are the existing ai_conversations rows
 * (/chat/conversations lists, creates, renames and deletes them); this adds
 * the orchestrated turn, the cache pre-warm, and the confirm-or-dismiss step
 * for what AxIS proposes.
 *
 * POST /axis/conversations/:id/messages streams Server-Sent Events. The
 * events the app already reads keep their names and shapes (status, sources,
 * context, reasoning, delta, done, error); the rest are additive (route,
 * tool, citations, grounding, action, verification).
 *
 * An `action` is an email draft (propose_action) or an operation
 * (perform_action, lib/axis/ops): one that already ran (status executed, with
 * Undo) or one waiting here for Confirm. Confirm, Dismiss and Undo are the
 * counselor's clicks; the model can't reach these routes (lib/axis/ops/dispatch.ts).
 */
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { TtlLru } from "../lib/axis/cache.js";
import { runAxisTurn, warmInputs } from "../lib/axis/engine.js";
import { chargeCall, prewarm } from "../lib/axis/llm.js";
import {
  axisReadiness,
  axisUnavailable,
  isSchemaMissing,
  logSkipped,
  probeAxisSchema,
  runSseTurn,
  unavailableBody,
} from "../lib/axis/failsafe.js";
import { foldIfLong, saveState } from "../lib/axis/memory.js";
import { adjudicate } from "../lib/axis/verify.js";
import { confirmOperation, recordedIds, TransientOperationError, undoOperation, type OperationPayload, type OperationStatus } from "../lib/axis/ops/run.js";
import { hasAnthropic } from "../env.js";
import { badRequest, conflict, forbidden, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

const messageSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    studentId: z.string().uuid().optional(),
  })
  .strict();

const warmSchema = z.object({ studentId: z.string().uuid().optional() }).strict();

const confirmSchema = z
  .object({
    // The counselor may edit a proposal before confirming it.
    title: z.string().trim().min(1).max(300).optional(),
    detail: z.string().max(2000).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

const idParam = (request: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(request.params).id;

/** axis_actions comes with 20261018000001: before it is applied these routes answer the fallback 503, not a 500. */
const actionsError = (error: { code?: string; message?: string }) => (isSchemaMissing(error) ? axisUnavailable() : fromPostgrest(error));

/** One pre-warm per counselor and student per four minutes: the cache entry it writes lives at least five. */
const warmed = new TtlLru<true>(5_000, 4 * 60 * 1000);

export default async function axisRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.post(
    "/conversations/:id/messages",
    { preHandler: [...counselor, limit("ai:axis", 20, 60, "You're sending messages very fast. Give it a moment.")] },
    async (request, reply) => {
      const id = idParam(request);
      const body = messageSchema.parse(request.body);

      // Everything that can fail as plain JSON fails before the stream opens.
      const { data: conv, error } = await request.db.from("ai_conversations").select("id, student_id, title").eq("id", id).maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!conv) throw notFound("Conversation not found");
      const requested = body.studentId ?? (conv.student_id as string | null) ?? null;
      const studentId = requested ? await resolveStudentId(request, requested, "view") : null;

      // The fallback signal: no model key, or the AxIS migration not applied yet. Answered before
      // anything is written, so the app can send the same message to /chat/conversations/:id/messages.
      const ready = await axisReadiness({ hasKey: hasAnthropic, probe: () => probeAxisSchema(request.db), log: request.log });
      if (!ready.ok) {
        request.log.warn({ reason: ready.reason }, "axis unavailable; client should fall back to /chat");
        return reply.code(503).send(unavailableBody());
      }
      // The turn's first model call is charged here, so an exhausted daily quota is a plain 429.
      await chargeCall(request);

      const { error: insErr } = await request.db
        .from("ai_messages")
        .insert({ conversation_id: id, owner_id: request.auth.userId, role: "user", content: body.content });
      if (insErr) throw isSchemaMissing(insErr) ? axisUnavailable() : fromPostgrest(insErr);
      const { error: convErr } = await request.db
        .from("ai_conversations")
        .update({ student_id: studentId, module: "axis", ...(conv.title ? {} : { title: body.content.slice(0, 60) }) })
        .eq("id", id);
      if (convErr) request.log.warn({ code: convErr.code }, "axis conversation not updated");

      const sse = new PassThrough();
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");
      reply.send(sse);

      const stream = runSseTurn({
        sink: {
          write: (chunk) => void sse.write(chunk),
          end: () => void sse.end(),
          get ended() {
            return sse.writableEnded || sse.destroyed;
          },
        },
        log: request.log,
        onSettled: () => void foldIfLong(request, id).catch((err) => request.log.warn({ err }, "axis memory fold skipped")),
        work: async ({ signal, emit, markDone }) => {
          const turn = await runAxisTurn({ request, conversationId: id, studentId, content: body.content, emit, signal, prepaidCalls: 1 });
          const { data: saved, error: saveErr } = await request.db
            .from("ai_messages")
            .insert({
              conversation_id: id,
              owner_id: request.auth.userId,
              role: "assistant",
              content: turn.text,
              citations: turn.citations,
              trace: turn.trace,
              sources: turn.sources,
              ai_run_id: turn.runId,
            })
            .select("id")
            .single();
          if (saveErr) request.log.warn({ code: saveErr.code }, "axis answer not saved");
          const messageId = (saved?.id as string | undefined) ?? null;
          const linked = recordedIds(turn.actions.map((a) => a.id));
          if (messageId && linked.length) {
            await request.db.from("axis_actions").update({ message_id: messageId }).in("id", linked).then(logSkipped(request.log, "proposal link"));
          }
          emit("done", { messageId });
          markDone();

          // After done nothing may turn the answer into an error: each step is logged and skipped.
          try {
            await saveState(request, id, turn.state);
            // Only what the code couldn't confirm goes to the adjudicator.
            const { wanted, checks, material, ledger } = turn.verify;
            if (wanted && checks.some((c) => c.status !== "grounded")) {
              const v = await adjudicate({ request, studentId, checks, ledger, material, signal });
              if (v.checked) {
                emit("verification", v);
                if (messageId) await request.db.from("ai_messages").update({ verification: v }).eq("id", messageId).then(logSkipped(request.log, "verification"));
              }
            } else if (wanted && checks.length && messageId) {
              const v = { checked: true, figuresChecked: checks.reduce((n, c) => n + c.figures.length + c.citations.length, 0), unsupported: [] };
              emit("verification", v);
              await request.db.from("ai_messages").update({ verification: v }).eq("id", messageId).then(logSkipped(request.log, "verification"));
            }
          } catch (err) {
            request.log.warn({ err }, "axis after-answer step skipped");
          }
        },
      });
      // The counselor closing the panel stops the model and the tools mid-flight. The response's
      // close, not the request's: Node closes the request as soon as its body has been read.
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) stream.clientClosed();
      });
      return reply;
    }
  );

  // Opening the panel (or switching student) writes the prompt cache before the first question.
  app.post("/warm", { preHandler: [...counselor, limit("ai:axis-warm", 20, 60)] }, async (request, reply) => {
    const { studentId: requested } = warmSchema.parse(request.body ?? {});
    const studentId = requested ? await resolveStudentId(request, requested, "view") : null;
    if (!hasAnthropic) return reply.code(202).send({ warmed: false, reason: "unavailable" });
    const key = `${request.auth.userId}:${studentId ?? "roster"}`;
    if (warmed.get(key)) return reply.code(202).send({ warmed: false, reason: "recent" });
    warmed.set(key, true);
    try {
      const { system, tools } = await warmInputs(request, studentId);
      const r = await prewarm({ request, studentId, system, tools });
      return reply.code(202).send({ warmed: true, cacheWriteTokens: r.cacheWrite, cacheReadTokens: r.cacheRead });
    } catch (err) {
      // A pre-warm is an optimisation: whatever went wrong, the panel opens and the first question still works.
      const quota = err instanceof HttpError && err.statusCode === 429;
      if (!quota) warmed.delete(key);
      request.log.warn({ err }, "axis prewarm failed");
      return reply.code(202).send({ warmed: false, reason: quota ? "quota" : "unavailable" });
    }
  });

  // Proposals awaiting the counselor, newest first; with status=all, everything in a chat (to replay its cards).
  app.get("/actions", { preHandler: counselor }, async (request) => {
    const q = z.object({ conversationId: z.string().uuid().optional(), status: z.enum(["pending", "all"]).optional() }).parse(request.query ?? {});
    if (q.status === "all" && !q.conversationId) throw badRequest("status=all needs a conversationId");
    let query = request.db
      .from("axis_actions")
      .select("id, conversation_id, message_id, student_id, type, payload, status, result, created_at")
      .order("created_at", { ascending: false })
      .limit(q.status === "all" ? 200 : 50);
    if (q.status !== "all") query = query.eq("status", "pending");
    if (q.conversationId) query = query.eq("conversation_id", q.conversationId);
    const { data, error } = await query;
    if (error) throw actionsError(error);
    return (data ?? []).map(publicAction);
  });

  app.post("/actions/:id/confirm", { preHandler: counselor }, async (request) => {
    const id = idParam(request);
    const edits = confirmSchema.parse(request.body ?? {});
    // Claim first, so a double click can't create two work items.
    const { data: claimed, error } = await request.db
      .from("axis_actions")
      .update({ status: "confirmed", decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, student_id, type, payload")
      .maybeSingle();
    if (error) throw actionsError(error);
    if (!claimed) throw conflict("That proposal was already handled.");
    const payload = claimed.payload as Record<string, unknown>;
    const studentId = claimed.student_id as string | null;

    if (claimed.type === "operation") {
      let outcome;
      try {
        outcome = await confirmOperation(request, claimed);
      } catch (err) {
        // Nothing changed (an outage, a rate limit): release the claim so Confirm can be clicked again.
        await request.db.from("axis_actions").update({ status: "pending", decided_at: null }).eq("id", id);
        if (err instanceof TransientOperationError || err instanceof HttpError) throw err;
        request.log.error({ err }, "axis operation confirm failed");
        throw new HttpError(500, "That change couldn't be made right now. Try again.");
      }
      const { error: saveErr } = await request.db
        .from("axis_actions")
        .update({ status: outcome.status, result: outcome.result })
        .eq("id", id);
      if (saveErr) request.log.warn({ code: saveErr.code }, "axis operation result not saved");
      return {
        id,
        status: outcome.status,
        result: outcome.result.ok ? { ok: true, undoable: outcome.result.undoable } : { ok: false, message: outcome.result.message },
      };
    }

    try {
      if (claimed.type === "work_item") {
        if (studentId) await resolveStudentId(request, studentId, "view");
        const { data: item, error: wErr } = await request.db
          .from("counselor_work_items")
          .insert({
            student_id: studentId,
            kind: "task",
            title: edits.title ?? String(payload.title ?? ""),
            detail: edits.detail ?? (payload.detail as string | null) ?? null,
            due_date: edits.dueDate !== undefined ? edits.dueDate : ((payload.dueDate as string | null) ?? null),
            source: "AxIS",
          })
          .select("id")
          .single();
        if (wErr) throw fromPostgrest(wErr);
        const result = { workItemId: item.id };
        await request.db.from("axis_actions").update({ result }).eq("id", id);
        return { id, status: "confirmed", result };
      }
      // An email draft is never sent from here: the app opens the Communication composer with it,
      // where recipients, quiet hours and the throttle are decided.
      if (!studentId) throw forbidden("That draft has no student.");
      const result = {
        composer: { studentId, to: payload.to ?? "parents", subject: edits.title ?? payload.subject ?? "", body: edits.detail ?? payload.body ?? "" },
      };
      await request.db.from("axis_actions").update({ result }).eq("id", id);
      return { id, status: "confirmed", result };
    } catch (err) {
      // Release the claim so the counselor can try again.
      await request.db.from("axis_actions").update({ status: "pending", decided_at: null }).eq("id", id);
      throw err;
    }
  });

  app.post("/actions/:id/dismiss", { preHandler: counselor }, async (request) => {
    const id = idParam(request);
    const { data, error } = await request.db
      .from("axis_actions")
      .update({ status: "dismissed", decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw actionsError(error);
    if (!data) throw conflict("That proposal was already handled.");
    return { id, status: "dismissed" };
  });

  // Puts back a change AxIS made (at once, or on Confirm), using the reversal recorded with it.
  app.post("/actions/:id/undo", { preHandler: [...counselor, limit("ai:axis-undo", 60, 60)] }, async (request) => {
    const id = idParam(request);
    const { data: row, error } = await request.db
      .from("axis_actions")
      .select("id, type, status, result")
      .eq("id", id)
      .maybeSingle();
    if (error) throw actionsError(error);
    if (!row || row.type !== "operation") throw notFound("That change isn't AxIS's to undo.");
    const was = row.status as OperationStatus;
    if (was !== "executed" && was !== "confirmed") throw conflict(was === "undone" ? "That change was already undone." : "Only a change that went through can be undone.");
    // Claim, so two clicks can't run the reversal twice.
    const { data: claimed, error: claimErr } = await request.db
      .from("axis_actions")
      .update({ status: "undone", decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", was)
      .select("id")
      .maybeSingle();
    if (claimErr) throw actionsError(claimErr);
    if (!claimed) throw conflict("That change was already undone.");
    try {
      await undoOperation(request, row);
    } catch (err) {
      await request.db.from("axis_actions").update({ status: was }).eq("id", id);
      throw err;
    }
    return { id, status: "undone" };
  });
}

/**
 * A row as the app sees it. An operation's stored input stays on the server
 * (Confirm reads it back from the row); the app gets the card's text, the
 * status, and whether Undo is available.
 */
function publicAction(r: Record<string, unknown>) {
  if (r.type !== "operation") return r;
  const p = (r.payload ?? {}) as Record<string, unknown>;
  const res = (r.result ?? {}) as Record<string, unknown>;
  const status = String(r.status) as OperationStatus;
  const payload: OperationPayload = {
    op: String(p.op ?? ""),
    area: String(p.area ?? ""),
    summary: String(p.summary ?? ""),
    details: Array.isArray(p.details) ? p.details.map(String) : [],
    warning: typeof p.warning === "string" ? p.warning : null,
    reason: p.reason === "outside-content" || p.reason === "many-changes" ? p.reason : null,
    status,
    undoable: (status === "executed" || status === "confirmed") && !!res.undo,
    message: typeof res.message === "string" ? res.message : null,
  };
  return { id: r.id, conversation_id: r.conversation_id, message_id: r.message_id, student_id: r.student_id, type: r.type, payload, status, created_at: r.created_at };
}
