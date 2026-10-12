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
import { runAxisTurn, warmInputs, type Emit } from "../lib/axis/engine.js";
import { prewarm } from "../lib/axis/llm.js";
import { foldIfLong, saveState } from "../lib/axis/memory.js";
import { adjudicate } from "../lib/axis/verify.js";
import { conflict, forbidden, fromPostgrest, notFound, publicMessage } from "../lib/errors.js";
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

/** One pre-warm per counselor and student per four minutes: the cache entry it writes lives at least five. */
const warmed = new TtlLru<true>(5_000, 4 * 60 * 1000);

export default async function axisRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.post(
    "/conversations/:id/messages",
    { preHandler: [...counselor, limit("ai:axis", 30, 60, "You're sending messages very fast. Give it a moment.")] },
    async (request, reply) => {
      const id = idParam(request);
      const body = messageSchema.parse(request.body);

      // Everything that can fail as plain JSON fails before the stream opens.
      const { data: conv, error } = await request.db.from("ai_conversations").select("id, student_id, title").eq("id", id).maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!conv) throw notFound("Conversation not found");
      const requested = body.studentId ?? (conv.student_id as string | null) ?? null;
      const studentId = requested ? await resolveStudentId(request, requested, "view") : null;

      const { error: insErr } = await request.db
        .from("ai_messages")
        .insert({ conversation_id: id, owner_id: request.auth.userId, role: "user", content: body.content });
      if (insErr) throw fromPostgrest(insErr);
      await request.db
        .from("ai_conversations")
        .update({ student_id: studentId, module: "axis", ...(conv.title ? {} : { title: body.content.slice(0, 60) }) })
        .eq("id", id);

      const sse = new PassThrough();
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");
      reply.send(sse);

      // The counselor closing the panel stops the model and the tools mid-flight. The response's
      // close, not the request's: Node closes the request as soon as its body has been read.
      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const emit: Emit = (event, data) => {
        if (!sse.writableEnded) sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // Keeps proxies from closing a stream that is quiet while evidence is gathered.
      const ping = setInterval(() => {
        if (!sse.writableEnded) sse.write(": ping\n\n");
      }, 15_000);

      void (async () => {
        try {
          const turn = await runAxisTurn({ request, conversationId: id, studentId, content: body.content, emit, signal: abort.signal });
          const { data: saved } = await request.db
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
          const messageId = (saved?.id as string | undefined) ?? null;
          if (messageId && turn.actions.length) {
            await request.db.from("axis_actions").update({ message_id: messageId }).in("id", turn.actions.map((a) => a.id));
          }
          emit("done", { messageId });
          await saveState(request, id, turn.state).catch((err) => request.log.warn({ err }, "axis state not saved"));

          // After done: the counselor can already type. Only what the code couldn't confirm goes to the adjudicator.
          const { wanted, checks, material, ledger } = turn.verify;
          if (wanted && checks.some((c) => c.status !== "grounded")) {
            const v = await adjudicate({ request, studentId, checks, ledger, material });
            if (v.checked) {
              emit("verification", v);
              if (messageId) await request.db.from("ai_messages").update({ verification: v }).eq("id", messageId);
            }
          } else if (wanted && checks.length && messageId) {
            const v = { checked: true, figuresChecked: checks.reduce((n, c) => n + c.figures.length + c.citations.length, 0), unsupported: [] };
            emit("verification", v);
            await request.db.from("ai_messages").update({ verification: v }).eq("id", messageId);
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            request.log.error({ err, conversationId: id }, "axis stream failed");
            emit("error", { message: publicMessage(err, "AxIS is unavailable right now. Try again in a few minutes.").slice(0, 300) });
          }
        } finally {
          clearInterval(ping);
          sse.end();
          void foldIfLong(request, id).catch((err) => request.log.warn({ err }, "axis memory fold skipped"));
        }
      })();
      return reply;
    }
  );

  // Opening the panel (or switching student) writes the prompt cache before the first question.
  app.post("/warm", { preHandler: [...counselor, limit("ai:axis-warm", 20, 60)] }, async (request, reply) => {
    const { studentId: requested } = warmSchema.parse(request.body ?? {});
    const studentId = requested ? await resolveStudentId(request, requested, "view") : null;
    const key = `${request.auth.userId}:${studentId ?? "roster"}`;
    if (warmed.get(key)) return reply.code(202).send({ warmed: false, reason: "recent" });
    warmed.set(key, true);
    try {
      const { system, tools } = await warmInputs(request, studentId);
      const r = await prewarm({ request, studentId, system, tools });
      return reply.code(202).send({ warmed: true, cacheWriteTokens: r.cacheWrite, cacheReadTokens: r.cacheRead });
    } catch (err) {
      warmed.delete(key);
      request.log.warn({ err }, "axis prewarm failed");
      return reply.code(202).send({ warmed: false, reason: "unavailable" });
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
    if (error) throw fromPostgrest(error);
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
    if (error) throw fromPostgrest(error);
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
    if (error) throw fromPostgrest(error);
    if (!data) throw conflict("That proposal was already handled.");
    return { id, status: "dismissed" };
  });
}
