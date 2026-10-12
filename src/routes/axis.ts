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
import { hasAnthropic } from "../env.js";
import { conflict, forbidden, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
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
          if (messageId && turn.actions.length) {
            await request.db.from("axis_actions").update({ message_id: messageId }).in("id", turn.actions.map((a) => a.id)).then(logSkipped(request.log, "proposal link"));
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

  // Proposals awaiting the counselor, newest first.
  app.get("/actions", { preHandler: counselor }, async (request) => {
    const q = z.object({ conversationId: z.string().uuid().optional() }).parse(request.query ?? {});
    let query = request.db
      .from("axis_actions")
      .select("id, conversation_id, message_id, student_id, type, payload, status, result, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);
    if (q.conversationId) query = query.eq("conversation_id", q.conversationId);
    const { data, error } = await query;
    if (error) throw actionsError(error);
    return data ?? [];
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
}
