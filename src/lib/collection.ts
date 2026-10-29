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
import { badRequest, fromPostgrest, notFound } from "./errors.js";
import { resolveStudentId } from "./guards.js";
import { limit } from "./limits.js";

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ studentId: z.string().uuid().optional() });

/**
 * `studentId` is routing, not a column.
 *
 * It tells the handler which student the caller means; the row's `student_id`
 * comes from `resolveStudentId` after authorization, never from the body. Every
 * collection body schema is `.strict()`, so leaving it in the object handed to
 * Zod makes a counselor's write fail validation — and omitting it makes
 * `resolveStudentId` throw 403, because a counselor has no implicit self.
 * Splitting it off before parsing is what lets a counselor write at all.
 */
function splitStudentId(raw: unknown): {
  studentId: string | undefined;
  rest: Record<string, unknown>;
} {
  if (raw === null || typeof raw !== "object") {
    return { studentId: undefined, rest: {} };
  }
  const { studentId, ...rest } = raw as { studentId?: string } & Record<string, unknown>;
  return { studentId, rest };
}

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
  /**
   * A column the insert sets to the caller's own id, for a table that records
   * who wrote the row (`meeting_notes.counselor_id`, NOT NULL). Never read
   * from the body, and never changed by a patch.
   */
  authorColumn?: string;
  /**
   * Called after authorization and before the write lands. The place to assert
   * a relationship the student_id check can't see — e.g. that a nested row's
   * parent really belongs to this student — or to narrow what a role may set.
   * Throw to reject.
   */
  beforeWrite?: (
    request: FastifyRequest,
    studentId: string,
    values: Record<string, unknown>,
    action: "insert" | "update"
  ) => Promise<void>;
  /**
   * Called after authorization and before a delete lands, with the row's
   * student. The place to narrow who may delete (e.g. a student may tick a
   * task's step done but not remove it). Throw to reject.
   */
  beforeDelete?: (request: FastifyRequest, studentId: string, id: string) => Promise<void>;
  /**
   * Honour an `Idempotency-Key` header (a uuid) on create: the key is stored
   * in `client_request_id` (unique per student), and a repeat with the same
   * key answers with the row it already made instead of adding another. A
   * table without the column yet is written as before, without the key.
   */
  idempotent?: boolean;
  /** Called after a successful insert/update, e.g. to log progress events. */
  afterWrite?: (
    request: FastifyRequest,
    studentId: string,
    row: Record<string, unknown>,
    action: "insert" | "update"
  ) => Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Idempotency-Key header as a uuid, or null when absent. Anything else is refused. */
export function idempotencyKey(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !UUID.test(value.trim())) throw badRequest("Idempotency-Key must be a uuid");
  return value.trim().toLowerCase();
}

/** How long a table without `client_request_id` is written without the key. */
export const MISSING_REQUEST_ID_TTL_MS = 5 * 60_000;
const missingUntil = new Map<string, number>();

function requestIdMissing(table: string): boolean {
  return (missingUntil.get(table) ?? 0) > Date.now();
}

function markRequestIdMissing(table: string): void {
  missingUntil.set(table, Date.now() + MISSING_REQUEST_ID_TTL_MS);
}

/** For tests. */
export function resetRequestIdCache(): void {
  missingUntil.clear();
}

/** Postgres "undefined column", or PostgREST's schema-cache miss, naming client_request_id. */
export function isMissingRequestId(error: { code?: string; message: string } | null): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204") && /client_request_id/.test(error.message);
}

async function rowForKey(
  request: FastifyRequest,
  table: string,
  student: string,
  key: string
): Promise<Record<string, unknown> | null | "no-column"> {
  const { data, error } = await request.db
    .from(table)
    .select("*")
    .eq("student_id", student)
    .eq("client_request_id", key)
    .maybeSingle();
  if (isMissingRequestId(error)) return "no-column";
  if (error) throw fromPostgrest(error);
  return (data as Record<string, unknown> | null) ?? null;
}

export function registerCollection<T extends ZodTypeAny>(
  app: FastifyInstance,
  opts: CollectionOptions<T>
): void {
  const { path, table, body, toDto } = opts;
  const order = opts.orderBy ?? { column: "sort_order", ascending: true };

  // Per-student lists the app fans out across a roster: 300, the in-process cap.
  app.get(`/${path}`, { preHandler: [app.authenticate, limit(`${path}:list`, 300, 60)] }, async (request) => {
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
      const { studentId, rest } = splitStudentId(request.body);
      const parsed = (body as ZodTypeAny).parse(rest) as Record<string, unknown>;
      const student = await resolveStudentId(request, studentId, "edit");
      const key = opts.idempotent ? idempotencyKey(request.headers["idempotency-key"]) : null;
      const keyed = key !== null && !requestIdMissing(table);

      if (keyed) {
        // A repeat of a create that already landed: answer with that row.
        const earlier = await rowForKey(request, table, student, key);
        if (earlier === "no-column") markRequestIdMissing(table);
        else if (earlier) return reply.code(200).send(toDto(earlier));
      }
      const withKey = keyed && !requestIdMissing(table);

      await opts.beforeWrite?.(request, student, parsed, "insert");

      const insert = (values: Record<string, unknown>) =>
        request.db.from(table).insert(values).select("*").single();
      const values = {
        ...parsed,
        ...(opts.authorColumn ? { [opts.authorColumn]: request.auth.userId } : {}),
        student_id: student,
      };
      let { data, error } = await insert(withKey ? { ...values, client_request_id: key } : values);
      if (withKey && isMissingRequestId(error)) {
        markRequestIdMissing(table);
        ({ data, error } = await insert(values));
      } else if (withKey && error?.code === "23505" && /client_request/.test(error.message)) {
        // Two requests with one key at the same moment: the other one won.
        const winner = await rowForKey(request, table, student, key);
        if (winner && winner !== "no-column") return reply.code(200).send(toDto(winner));
      }

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
      const { studentId: expected } = listQuery.parse(request.query ?? {});
      const { rest } = splitStudentId(request.body);
      const parsed = (body as ZodTypeAny).parse(rest) as Record<string, unknown>;

      // Read the row first so we authorize against its real owner rather than
      // a student id the client supplied.
      const { data: existing, error: readError } = await request.db
        .from(table)
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      // `?studentId=` names the student the caller means; a row of anyone else is "not found",
      // so a mixed-up id can't change another student's record.
      if (!existing || (expected && existing.student_id !== expected)) throw notFound();

      await resolveStudentId(request, existing.student_id as string, "edit");
      await opts.beforeWrite?.(request, existing.student_id as string, parsed, "update");

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
      const { studentId: expected } = listQuery.parse(request.query ?? {});

      const { data: existing, error: readError } = await request.db
        .from(table)
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      if (!existing || (expected && existing.student_id !== expected)) throw notFound();

      await resolveStudentId(request, existing.student_id as string, "edit");
      await opts.beforeDelete?.(request, existing.student_id as string, id);

      const { data: removed, error } = await request.db.from(table).delete().eq("id", id).select("id");
      if (error) throw fromPostgrest(error);
      // RLS filters a delete the caller may not make down to zero rows; that is not a success.
      if (!removed || removed.length === 0) throw notFound();
      return { deleted: true };
    }
  );
}
