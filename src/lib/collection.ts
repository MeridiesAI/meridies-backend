/**
 * Factory for the student-scoped CRUD routes.
 *
 * Activities, awards, essays, colleges, courses and test scores are the same
 * endpoint five times over: list by student, insert, patch by id, delete by id,
 * with the caller's access to that student checked first. Writing each one by
 * hand is how one of them quietly ends up missing an authorization call, so
 * they are generated from a single description instead.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z, type ZodTypeAny } from "zod";
import { fromPostgrest, notFound } from "./errors.js";
import { resolveStudentId } from "./guards.js";
import { limit } from "./limits.js";

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ studentId: z.string().uuid().optional() });

/**
 * An extra equality filter the list route accepts, e.g.
 * `{ param: "deliverableId", column: "deliverable_id" }` so a task's stages can
 * be fetched without a second, hand-written route that has to repeat the
 * authorization dance.
 */
export type CollectionFilter = {
  param: string;
  column: string;
  /** Defaults to a uuid. Anything else must say so. */
  schema?: ZodTypeAny;
};

export type CollectionOptions<T extends ZodTypeAny> = {
  /** URL segment, e.g. "activities". */
  path: string;
  table: string;
  /** Zod schema for the writable columns, already in snake_case. */
  body: T;
  toDto: (row: Record<string, unknown>) => unknown;
  orderBy?: { column: string; ascending?: boolean };
  /** Optional `?param=` equality filters on the list route. */
  filters?: CollectionFilter[];
  /** Called after a successful insert/update, e.g. to log progress events. */
  afterWrite?: (
    request: FastifyRequest,
    studentId: string,
    row: Record<string, unknown>,
    action: "insert" | "update"
  ) => Promise<void>;
};

export function registerCollection<T extends ZodTypeAny>(
  app: FastifyInstance,
  opts: CollectionOptions<T>
): void {
  const { path, table, body, toDto } = opts;
  const order = opts.orderBy ?? { column: "sort_order", ascending: true };

  app.get(`/${path}`, { preHandler: app.authenticate }, async (request) => {
    const { studentId } = listQuery.parse(request.query);
    const student = await resolveStudentId(request, studentId, "view");

    let builder = request.db.from(table).select("*").eq("student_id", student);

    // Filters narrow within a student the caller has already been authorized
    // for, so they can never widen access — only the student_id eq above can.
    const query = (request.query ?? {}) as Record<string, unknown>;
    for (const filter of opts.filters ?? []) {
      const raw = query[filter.param];
      if (raw === undefined || raw === "") continue;
      const value = (filter.schema ?? z.string().uuid()).parse(raw);
      builder = builder.eq(filter.column, value);
    }

    const { data, error } = await builder
      .order(order.column, { ascending: order.ascending ?? true })
      .limit(500);

    if (error) throw fromPostgrest(error);
    return (data ?? []).map((row) => toDto(row as Record<string, unknown>));
  });

  app.post(
    `/${path}`,
    { preHandler: [app.authenticate, limit(`${path}:create`, 120, 60)] },
    async (request, reply) => {
      const parsed = (body as ZodTypeAny).parse(request.body) as Record<string, unknown>;
      const student = await resolveStudentId(
        request,
        (request.body as { studentId?: string })?.studentId,
        "edit"
      );

      const { data, error } = await request.db
        .from(table)
        .insert({ ...parsed, student_id: student })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      await opts.afterWrite?.(request, student, data as Record<string, unknown>, "insert");
      return reply.code(201).send(toDto(data as Record<string, unknown>));
    }
  );

  app.patch(
    `/${path}/:id`,
    { preHandler: [app.authenticate, limit(`${path}:update`, 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const parsed = (body as ZodTypeAny).parse(request.body) as Record<string, unknown>;

      // Read the row first so we authorize against its real owner rather than
      // a student id the client supplied.
      const { data: existing, error: readError } = await request.db
        .from(table)
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      if (!existing) throw notFound();

      await resolveStudentId(request, existing.student_id as string, "edit");

      const { data, error } = await request.db
        .from(table)
        .update(parsed)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();
      await opts.afterWrite?.(
        request,
        existing.student_id as string,
        data as Record<string, unknown>,
        "update"
      );
      return toDto(data as Record<string, unknown>);
    }
  );

  app.delete(
    `/${path}/:id`,
    { preHandler: [app.authenticate, limit(`${path}:delete`, 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);

      const { data: existing, error: readError } = await request.db
        .from(table)
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      if (!existing) throw notFound();

      await resolveStudentId(request, existing.student_id as string, "edit");

      const { error } = await request.db.from(table).delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}
