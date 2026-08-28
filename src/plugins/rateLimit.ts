/**
 * First-line flood protection. In-process and per-IP, so it soaks up bursts
 * before a handler (and therefore the database) ever runs. It resets on deploy
 * and doesn't span replicas — that's what `lib/limits.ts` is for; this is the
 * cheap gate, not the real budget.
 */

import rateLimit from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "../env.js";

export default fp(async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Prefer the authenticated user so shared-NAT clients aren't punished
    // together; fall back to IP for unauthenticated traffic.
    keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip,
    // Railway terminates TLS upstream, so trust the forwarded client address.
    enableDraftSpec: true,
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true },
    errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) => ({
      error: `Too many requests. Try again in ${context.after}.`,
    }),
    allowList: env.NODE_ENV === "test" ? () => true : undefined,
  });
});
