/**
 * The Parent view (migration 20261123000002), for a parent account only. Read-only, apart from writing to the
 * counselor. No route takes anything but a student id, and every answer comes from the database's own checks on
 * the caller's client (`parent_children`, `parent_student_view`: the live guardian link, the counselor's
 * family-visibility switches, an approved counselor), so a parent removed a moment ago gets a 404 now.
 *
 *   GET  /parent/children                    the parent's students (a kid switcher when there are several)
 *   GET  /parent/children/:id                one student's Parent view: only the sections switched on
 *   POST /parent/children/:id/message        email the counselor (Reply-To the parent); shows as "From the family"
 *   GET  /parent/children/:id/messages       what this parent sent from here
 *
 * 503 `parent_accounts_unavailable` before the migration.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, fromPostgrest } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { PARENT_MESSAGE_MAX, parentSchemaMissing, toParentChild, toParentView } from "../lib/parentAccounts.js";
import { parentAccountsUnavailable } from "../lib/parentInvites.js";
import { listSentByParent, sendParentMessage } from "../lib/parentToCounselor.js";

const idParam = z.object({ id: z.string().uuid() });
const parentOnly = { allowParent: true } as const;

export default async function parentRoutes(app: FastifyInstance) {
  const parent = [app.authenticate, requireRole("parent")];

  app.get("/children", { preHandler: [...parent, limit("parent:children", 120, 60)], config: parentOnly }, async (request, reply) => {
    const { data, error } = await request.db.rpc("parent_children");
    if (error) {
      if (parentSchemaMissing(error)) throw parentAccountsUnavailable();
      throw fromPostgrest(error);
    }
    reply.header("Cache-Control", "no-store");
    return { children: ((data ?? []) as Record<string, unknown>[]).map(toParentChild) };
  });

  app.get("/children/:id", { preHandler: [...parent, limit("parent:view", 240, 60)], config: parentOnly }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db.rpc("parent_student_view", { p_student: id });
    if (error) {
      if (parentSchemaMissing(error)) throw parentAccountsUnavailable();
      // Not linked (removed, switched off, never linked, or no such student): one answer for all of them.
      if (error.code === "42501") throw new HttpError(404, "That student isn't on your parent view", "not_linked");
      throw fromPostgrest(error);
    }
    reply.header("Cache-Control", "no-store");
    return toParentView(data);
  });

  app.post(
    "/children/:id/message",
    {
      preHandler: [
        ...parent,
        limit("parent:message:hour", 10, 3600, "You've sent a lot of messages this hour. Try again later."),
        limit("parent:message:day", 30, 86400, "You've reached today's message limit. Try again tomorrow."),
      ],
      config: parentOnly,
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { body } = z.object({ body: z.string().max(PARENT_MESSAGE_MAX + 200) }).strict().parse(request.body);
      return reply.code(201).send(await sendParentMessage(request, id, body));
    }
  );

  app.get(
    "/children/:id/messages",
    { preHandler: [...parent, limit("parent:messages", 120, 60)], config: parentOnly },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return listSentByParent(request, id);
    }
  );
}
