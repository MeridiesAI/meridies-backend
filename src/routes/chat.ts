/**
 * The chat assistant. Conversations and messages live in the existing
 * ai_conversations / ai_messages tables (owner-scoped by RLS). The send-message
 * endpoint streams Server-Sent Events: a short, grounded reasoning plan, then
 * the answer token by token.
 *
 * The tool a message runs under selects a server-side system prompt (see
 * lib/chat.ts) — the client only ever sends the tool's key, never a prompt.
 */

import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { runStructured, streamChat, type ChatTurn } from "../lib/anthropic.js";
import {
  buildRosterContext,
  buildSystemPrompt,
  signerLine,
  chatToolCatalog,
  getChatTool,
  REASONING_SCHEMA,
} from "../lib/chat.js";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  attachmentUrl,
  claimAttachments,
  fileBlocks,
  listAttachments,
  MAX_FILES_PER_MESSAGE,
  removeChatFiles,
  startUpload,
  withFiles,
  type Attachment,
} from "../lib/axis/attachments.js";
import { buildStudentContext } from "../lib/context/index.js";
import type { ContextUsage } from "../lib/context/types.js";
import { forbidden, fromPostgrest, notFound, publicMessage } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

/** How the AxIS trace names a context section; two sections can share a label. */
const SOURCE_LABELS: Record<string, string> = {
  profile: "Student profile",
  activities: "Activities and awards",
  awards: "Activities and awards",
  essays: "Essays",
  colleges: "College list",
  meetingNotes: "Meeting notes",
  deadlines: "Calendar",
  upcomingMeetings: "Calendar",
  documents: "Documents",
  academics: "Grades and scores",
  testScores: "Grades and scores",
  courses: "Courses",
  personal: "Student profile",
  tasks: "Tasks",
  polygon: "Strength profile",
  intake: "Intake answers",
};

const AXIS_UNAVAILABLE = "AxIS is unavailable right now. Try again in a few minutes.";

const createConvSchema = z
  .object({
    studentId: z.string().uuid().optional(),
    tool: z.string().max(40).optional(),
    title: z.string().trim().max(200).optional(),
  })
  .strict();

const renameSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();

const messageSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    tool: z.string().max(40).optional(),
    studentId: z.string().uuid().optional(),
    /** Files uploaded through POST /conversations/:id/attachments for this message. */
    attachmentIds: z.array(z.string().uuid()).max(MAX_FILES_PER_MESSAGE).optional(),
  })
  .strict();

const attachmentSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(ATTACHMENT_TYPES),
    sizeBytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
  })
  .strict();

const MAX_HISTORY = 20;

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

function toConversation(r: Row) {
  return {
    id: s(r.id),
    studentId: r.student_id ? s(r.student_id) : null,
    tool: r.module ? s(r.module) : "general",
    title: r.title ? s(r.title) : null,
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

function toMessage(r: Row, files: Attachment[] = []) {
  const trace = Array.isArray(r.trace) ? (r.trace as Row[]) : [];
  return {
    id: s(r.id),
    role: s(r.role) as "user" | "assistant" | "system",
    content: s(r.content),
    citations: (r.citations as unknown[]) ?? [],
    /** The reasoning steps shown while it was written, replayed from history. */
    trace: trace.map((t) => ({ label: s(t.label) })).filter((t) => t.label),
    /** The record sections the answer was grounded in. */
    sources: Array.isArray(r.sources) ? (r.sources as unknown[]).map(s) : [],
    /** Files sent with this message (open one through GET /chat/attachments/:id/url). */
    attachments: files.map(({ id, fileName, mimeType, sizeBytes }) => ({ id, fileName, mimeType, sizeBytes })),
    createdAt: s(r.created_at),
  };
}

function paramId(request: FastifyRequest): string {
  return z.object({ id: z.string().uuid() }).parse(request.params).id;
}

export default async function chatRoutes(app: FastifyInstance) {
  const aiLimit = (name: string) =>
    limit(`ai:${name}`, 30, 60, "You're sending messages very fast. Give it a moment.");

  // The tool catalog (labels/descriptions only — prompts stay server-side).
  app.get("/tools", { preHandler: [app.authenticate] }, async () => chatToolCatalog());

  // List the caller's conversations, newest first; optional student filter.
  app.get("/conversations", { preHandler: [app.authenticate, limit("chat:conversations", 120, 60)] }, async (request) => {
    const q = z.object({ studentId: z.string().uuid().optional() }).parse(request.query ?? {});
    let query = request.db
      .from("ai_conversations")
      .select("id, student_id, module, title, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (q.studentId) query = query.eq("student_id", q.studentId);
    const { data, error } = await query;
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((row) => toConversation(row as Row));
  });

  // Create a conversation.
  app.post(
    "/conversations",
    { preHandler: [app.authenticate, aiLimit("chat")] },
    async (request, reply) => {
      const body = createConvSchema.parse(request.body ?? {});
      let studentId: string | null = null;
      if (body.studentId) studentId = await resolveStudentId(request, body.studentId, "view");

      const { data, error } = await request.db
        .from("ai_conversations")
        .insert({
          owner_id: request.auth.userId,
          student_id: studentId,
          module: body.tool ?? "general",
          title: body.title ?? null,
        })
        .select("id, student_id, module, title, created_at, updated_at")
        .single();
      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toConversation(data as Row));
    }
  );

  // One conversation with its messages.
  app.get("/conversations/:id", { preHandler: [app.authenticate] }, async (request) => {
    const id = paramId(request);
    const { data: conv, error } = await request.db
      .from("ai_conversations")
      .select("id, student_id, module, title, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!conv) throw notFound("Conversation not found");

    const { data: messages, error: mErr } = await request.db
      .from("ai_messages")
      .select("id, role, content, citations, trace, sources, created_at")
      .eq("conversation_id", id)
      .order("created_at")
      .limit(500);
    if (mErr) throw fromPostgrest(mErr);

    const byMessage = new Map<string, Attachment[]>();
    for (const a of await listAttachments(request, id)) {
      if (a.messageId) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
    }
    return {
      ...toConversation(conv as Row),
      messages: (messages ?? []).map((m) => toMessage(m as Row, byMessage.get(s((m as Row).id)) ?? [])),
    };
  });

  // Rename.
  app.patch("/conversations/:id", { preHandler: [app.authenticate] }, async (request) => {
    const id = paramId(request);
    const { title } = renameSchema.parse(request.body);
    const { data, error } = await request.db
      .from("ai_conversations")
      .update({ title })
      .eq("id", id)
      .select("id, student_id, module, title, created_at, updated_at")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("Conversation not found");
    return toConversation(data as Row);
  });

  // Delete.
  app.delete("/conversations/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const id = paramId(request);
    await removeChatFiles(request, id);
    const { error } = await request.db.from("ai_conversations").delete().eq("id", id);
    if (error) throw fromPostgrest(error);
    return reply.code(204).send();
  });

  // Attach a file: records it and returns a signed upload URL. The app uploads, then names it when it sends.
  app.post(
    "/conversations/:id/attachments",
    { preHandler: [app.authenticate, limit("chat:attachments", 30, 60, "That's a lot of files at once. Give it a moment.")] },
    async (request, reply) => {
      const id = paramId(request);
      const body = attachmentSchema.parse(request.body);
      return reply.code(201).send(await startUpload(request, id, body));
    }
  );

  // A short-lived link to open a file from the chat.
  app.get("/attachments/:id/url", { preHandler: [app.authenticate, limit("chat:attachment-url", 120, 60)] }, async (request) =>
    attachmentUrl(request, paramId(request))
  );

  // Send a message → SSE stream: reasoning steps, then the streamed answer.
  app.post(
    "/conversations/:id/messages",
    { preHandler: [app.authenticate, aiLimit("chat")] },
    async (request, reply) => {
      const id = paramId(request);
      const body = messageSchema.parse(request.body);

      // Ownership + student scope resolved BEFORE we start streaming, so failures
      // surface as normal JSON errors rather than mid-stream.
      const { data: conv, error: convErr } = await request.db
        .from("ai_conversations")
        .select("id, student_id, module, title")
        .eq("id", id)
        .maybeSingle();
      if (convErr) throw fromPostgrest(convErr);
      if (!conv) throw notFound("Conversation not found");

      const requestedStudent = body.studentId ?? (conv.student_id as string | null) ?? undefined;
      let studentId: string | null = null;
      // A student-scoped turn reads the record through the context layer, which is counselor-only. Refuse
      // before the message is saved or the stream opens.
      if (requestedStudent && request.profile.role !== "counselor") throw forbidden("Only counselors can do that");
      if (requestedStudent) studentId = await resolveStudentId(request, requestedStudent, "view");

      const tool = getChatTool(body.tool ?? (conv.module as string));

      // Persist the user's turn and keep the conversation's scope/title fresh.
      const { data: userMsg, error: umErr } = await request.db
        .from("ai_messages")
        .insert({
          conversation_id: id,
          owner_id: request.auth.userId,
          role: "user",
          content: body.content,
        })
        .select("id")
        .single();
      if (umErr) throw fromPostgrest(umErr);
      if (body.attachmentIds?.length) await claimAttachments(request, id, s(userMsg.id), body.attachmentIds);

      const convPatch: Record<string, unknown> = { student_id: studentId, module: tool.key };
      if (!conv.title) convPatch.title = body.content.slice(0, 60);
      await request.db.from("ai_conversations").update(convPatch).eq("id", id);

      // Prior turns (includes the message we just inserted, as the last one).
      const { data: history } = await request.db
        .from("ai_messages")
        .select("role, content, created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: false })
        .limit(MAX_HISTORY);
      const turns: ChatTurn[] = (history ?? [])
        .slice()
        .reverse()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: s(m.content) }));

      // ---- Server-Sent Events ----
      const sse = new PassThrough();
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");
      reply.send(sse);

      const send = (event: string, data: unknown) => {
        sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      void (async () => {
        try {
          let studentContext: string | null = null;
          let rosterContext: string | null = null;
          let sources: string[] = [];
          let contextUsage: ContextUsage | null = null;
          if (studentId) {
            const built = await buildStudentContext(request, studentId, "chat");
            studentContext = built.text;
            sources = [...new Set(built.used.map((u) => SOURCE_LABELS[u.section] ?? u.section))];
            contextUsage = { used: built.used, omitted: built.omitted };
          } else {
            const built = await buildRosterContext(request);
            rosterContext = built?.text ?? null;
            sources = built?.sources ?? [];
          }
          const system = buildSystemPrompt(tool, studentContext, rosterContext, signerLine(request.profile));
          // The chat's files, every turn: a reopened chat still knows what was in them.
          const files = await fileBlocks(request, id);
          const last = turns.at(-1);
          if (files.blocks.length && last?.role === "user" && typeof last.content === "string") {
            last.content = withFiles(last.content, files);
          }
          const trace: { label: string }[] = [];
          if (sources.length > 0) send("sources", { sources });
          if (contextUsage) send("context", contextUsage);

          // 1) Grounded reasoning plan, shown as the assistant "thinking".
          send("status", { phase: "thinking" });
          try {
            const plan = await runStructured<{ steps: string[] }>({
              request,
              module: "chat",
              studentId,
              system:
                system +
                "\n\nBefore answering, list the concrete steps you will take, grounded in this student's record.",
              prompt: `The counselor asked: "${body.content}"${
                files.names.length ? `\nFiles attached to the chat (you will read them when answering): ${files.names.join(", ")}.` : ""
              }\nReturn 2–4 short planning steps.`,
              schema: REASONING_SCHEMA as unknown as Record<string, unknown>,
              toolName: "plan",
              ...(contextUsage ? { contextUsage } : {}),
              maxTokens: 400,
            });
            for (const step of plan.steps) {
              trace.push({ label: String(step).slice(0, 200) });
              send("reasoning", { step });
            }
          } catch {
            // Reasoning is a nicety, never fatal to the answer.
          }

          // 2) The answer, streamed token by token.
          send("status", { phase: "answering" });
          const { text } = await streamChat({
            request,
            studentId,
            system,
            messages: turns,
            model: tool.model,
            maxTokens: 1400,
            onDelta: (t) => send("delta", { text: t }),
            contextUsage,
          });

          const { data: saved } = await request.db
            .from("ai_messages")
            .insert({
              conversation_id: id,
              owner_id: request.auth.userId,
              role: "assistant",
              content: text,
              trace,
              sources: sources.slice(0, 20),
            })
            .select("id")
            .single();

          send("done", { messageId: saved?.id ?? null });
        } catch (err) {
          request.log.error({ err, conversationId: id }, "chat stream failed");
          send("error", { message: publicMessage(err, AXIS_UNAVAILABLE).slice(0, 300) });
        } finally {
          sse.end();
        }
      })();

      return reply;
    }
  );
}
