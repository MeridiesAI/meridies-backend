import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "./errors.js";

/**
 * The `profiles.profile` jsonb (the onboarding questionnaire's answers and
 * other free-form fields, up to 300 KB) of one profile, read on the caller's
 * own client so RLS applies.
 *
 * `authenticate` deliberately leaves this column out of `request.profile`:
 * nearly every request needs the role and the ids, and almost none needs the
 * blob, which used to ride along on every call. Read it here where it is used.
 */
export async function loadProfileBlob(
  request: FastifyRequest,
  profileId: string = request.auth.userId
): Promise<Record<string, unknown> | null> {
  const { data, error } = await request.db.from("profiles").select("profile").eq("id", profileId).maybeSingle();
  if (error) throw fromPostgrest(error);
  return ((data as { profile?: Record<string, unknown> | null } | null)?.profile ?? null) as Record<
    string,
    unknown
  > | null;
}
