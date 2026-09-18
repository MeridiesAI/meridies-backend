/**
 * Notifications.
 *
 * The table has been written to since the first schema migration — by tasks,
 * red flags, opportunities and the policy tracker — and until now nothing could
 * read it back. There is no inbox in this product (students don't check them),
 * so this is the in-app bell only: the outbound copy goes through
 * `lib/email.ts` and `message_deliveries`.
 *
 * RLS already restricts every row to its recipient. The `recipient_id` filter
 * here is the code-level half of the same rule, so an empty list means "nothing
 * for you" rather than "nothing exists".
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { limit } from "../lib/limits.js";
import { toNotification } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  unread: z.coerce.boolean().optional(),
  kind: z
    .enum([
      "deadline", "red-flag", "report", "invite", "ai", "policy",
      "scholarship", "aid", "opportunity", "system",
    ])
    .optional(),
  studentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export default async function notificationRoutes(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [app.authenticate, limit("notifications:list", 240, 60)] },
    async (request) => {
      const q = listQuery.parse(request.query);

      let builder = request.db
        .from("notifications")
        .select("*")
        .eq("recipient_id", request.auth.userId);

      if (q.unread) builder = builder.is("read_at", null);
      if (q.kind) builder = builder.eq("kind", q.kind);
      if (q.studentId) builder = builder.eq("student_id", q.studentId);

      const { data, error } = await builder
        .order("created_at", { ascending: false })
        .limit(q.limit ?? 50);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => toNotification(r as Row));
    }
  );

  /** The bell's number, without paging the list to count it. */
  // The bell reads this on every mount, so the ceiling is generous.
  app.get(
    "/unread-count",
    { preHandler: [app.authenticate, limit("notifications:count", 600, 60)] },
    async (request) => {
      const { count, error } = await request.db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", request.auth.userId)
        .is("read_at", null);
      if (error) throw fromPostgrest(error);
      return { unread: count ?? 0 };
    }
  );

  app.post(
    "/:id/read",
    { preHandler: [app.authenticate, limit("notifications:read", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);

      const { data, error } = await request.db
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .eq("recipient_id", request.auth.userId)
        .select("*")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That notification doesn't exist");
      return toNotification(data as Row);
    }
  );

  app.post(
    "/read-all",
    { preHandler: [app.authenticate, limit("notifications:read-all", 30, 60)] },
    async (request) => {
      const { data, error } = await request.db
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("recipient_id", request.auth.userId)
        .is("read_at", null)
        .select("id");
      if (error) throw fromPostgrest(error);
      return { read: (data ?? []).length };
    }
  );
}
