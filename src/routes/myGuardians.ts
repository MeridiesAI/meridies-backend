/**
 * The signed-in student's parents and guardians, under /me/guardians (student-only; no route takes a student id).
 *
 *   GET    /me/guardians        the list, with what the student may change on each
 *   POST   /me/guardians        add one (up to 4 in all); emails them a notice once
 *   PATCH  /me/guardians/:id    change one the student added (email and phone only until the counselor switches
 *                               them on); a new address gets the notice
 *   DELETE /me/guardians/:id    remove one the student added that the counselor hasn't switched on
 *
 * The rules and the rows are lib/myGuardians.ts; the email is lib/parentNotice.ts. 503 `guardians_unavailable`
 * until migration 20261122000001 is applied.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  MAX_PARENTS,
  RELATIONSHIPS,
  addGuardianBody,
  addMine,
  editGuardianBody,
  editMine,
  listMine,
  removeMine,
  supabaseGuardianStore,
  type GuardianStore,
} from "../lib/myGuardians.js";
import { sendParentNotice, type NoticeOutcome } from "../lib/parentNotice.js";

export type MyGuardianRouteOptions = {
  /** Tests: a memory store and a stand-in notice sender. */
  store?: (request: FastifyRequest) => GuardianStore;
  notify?: typeof sendParentNotice;
};

const idParam = z.object({ id: z.string().uuid() });

export default async function myGuardianRoutes(app: FastifyInstance, opts: MyGuardianRouteOptions = {}) {
  const student = [app.authenticate, requireRole("student")];
  const storeOf = opts.store ?? ((request: FastifyRequest) => supabaseGuardianStore(request.db));
  const notify = opts.notify ?? sendParentNotice;

  async function noticeFor(request: FastifyRequest, guardianId: string, parentName: string, email: string | null): Promise<NoticeOutcome | null> {
    if (!email) return null;
    return notify({
      studentId: request.auth.userId,
      studentName: String(request.profile.full_name ?? ""),
      counselorId: request.profile.counselor_id ?? null,
      guardianId,
      parentName,
      email,
      log: request.log,
      db: request.db,
    });
  }

  app.get("/", { preHandler: [...student, limit("me:guardians", 120, 60)] }, async (request) => ({
    guardians: await listMine(storeOf(request), request.auth.userId),
    max: MAX_PARENTS,
    relationships: RELATIONSHIPS,
  }));

  app.post(
    "/",
    { preHandler: [...student, limit("me:guardians-add", 12, 3600, "That's a lot of parents added. Try again in an hour.")] },
    async (request, reply) => {
      const input = addGuardianBody.parse(request.body);
      const { guardian, notifyEmail } = await addMine(storeOf(request), request.auth.userId, input);
      const notice = await noticeFor(request, guardian.id, guardian.name, notifyEmail);
      return reply.code(201).send({ guardian, notice });
    }
  );

  app.patch(
    "/:id",
    { preHandler: [...student, limit("me:guardians-edit", 30, 3600, "That's a lot of changes. Try again in an hour.")] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const input = editGuardianBody.parse(request.body);
      const { guardian, notifyEmail } = await editMine(storeOf(request), request.auth.userId, id, input);
      const notice = await noticeFor(request, guardian.id, guardian.name, notifyEmail);
      return { guardian, notice };
    }
  );

  app.delete(
    "/:id",
    { preHandler: [...student, limit("me:guardians-remove", 30, 3600, "That's a lot of changes. Try again in an hour.")] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await removeMine(storeOf(request), request.auth.userId, id);
      return { deleted: true };
    }
  );
}
