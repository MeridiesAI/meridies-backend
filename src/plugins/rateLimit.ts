/**
 * First-line flood protection. In-process, per signed-in user (per address
 * for everything else), so it soaks up bursts
 * before a handler (and therefore the database) ever runs. It resets on deploy
 * and doesn't span replicas — that's what `lib/limits.ts` is for; this is the
 * cheap gate, not the real budget.
 */

import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "../env.js";
import { verifiedSubject } from "../lib/bearer.js";
import { tooManyRequests } from "../lib/errors.js";

/**
 * The bucket a request is counted in. This hook runs before any route's
 * `authenticate`, so `request.auth` is never set here: the token is verified
 * on the spot. A signed-in caller is counted on their own, so one busy account
 * (or one office behind one address) doesn't spend everyone's budget; no
 * token, a bad token, or a verifier error falls back to the address.
 */
export async function clientKey(
  request: Pick<FastifyRequest, "ip" | "headers">,
  verify: (header: string | undefined) => Promise<string | null> = verifiedSubject
): Promise<string> {
  try {
    const userId = await verify(request.headers.authorization);
    return userId ? `user:${userId}` : request.ip;
  } catch {
    return request.ip;
  }
}

export default fp(async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Prefer the authenticated user so shared-NAT clients aren't punished
    // together; fall back to IP for unauthenticated traffic.
    keyGenerator: (request: FastifyRequest) => clientKey(request),
    // Railway terminates TLS upstream, so trust the forwarded client address.
    enableDraftSpec: true,
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true },
    // The builder's return value is thrown. A plain object carries no status,
    // so the error handler answered 500; an HttpError answers 429.
    errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) =>
      tooManyRequests(`Too many requests. Try again in ${context.after}.`),
    allowList: env.NODE_ENV === "test" ? () => true : undefined,
  });
});
