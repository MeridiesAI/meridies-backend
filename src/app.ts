import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { corsOrigins, env, hasAnthropic, hasServiceRole } from "./env.js";
import { HttpError } from "./lib/errors.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import supabaseAuth from "./plugins/supabaseAuth.js";
import accountabilityRoutes from "./routes/accountability.js";
import aidRoutes from "./routes/aid.js";
import aiRoutes from "./routes/ai.js";
import authRoutes from "./routes/auth.js";
import deadlineRoutes from "./routes/deadlines.js";
import healthRoutes from "./routes/health.js";
import intakeRoutes from "./routes/intake.js";
import inviteRoutes from "./routes/invites.js";
import opportunityRoutes from "./routes/opportunities.js";
import recordRoutes from "./routes/records.js";
import studentRoutes from "./routes/students.js";

export function buildApp() {
  const app = Fastify({
    logger: true,
    // Railway sits behind a proxy; without this every request looks like it
    // came from the same address and the per-IP limiter is useless.
    trustProxy: true,
    bodyLimit: 1_048_576,
    // A client whose base URL ends in "/" sends "//auth/me". Fastify treats
    // that as a distinct, unrouted path and 404s, which reads like the endpoint
    // is missing rather than like a config typo. Collapse them instead.
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
  });

  app.register(cors, { origin: corsOrigins, credentials: true });
  app.register(rateLimitPlugin);
  app.register(supabaseAuth);

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/auth" });
  app.register(inviteRoutes, { prefix: "/invites" });
  app.register(studentRoutes, { prefix: "/students" });
  app.register(deadlineRoutes, { prefix: "/deadlines" });
  app.register(recordRoutes);
  app.register(intakeRoutes, { prefix: "/intake" });
  app.register(aidRoutes, { prefix: "/aid" });
  app.register(accountabilityRoutes, { prefix: "/accountability" });
  app.register(opportunityRoutes, { prefix: "/opportunities" });
  app.register(aiRoutes, { prefix: "/ai" });

  app.addHook("onReady", async () => {
    if (!hasServiceRole) {
      app.log.warn(
        "SUPABASE_SERVICE_ROLE_KEY is not set: rate limits and AI quotas are " +
          "per-process only and reset on every deploy."
      );
    }
    if (!hasAnthropic) {
      app.log.warn("ANTHROPIC_API_KEY is not set: /ai/* will return 503.");
    }
  });

  app.setErrorHandler((err: FastifyError | ZodError | HttpError, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", details: err.flatten() });
    }
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) request.log.error(err);
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if ((err as FastifyError).validation) {
      return reply
        .code(400)
        .send({ error: "Invalid request", details: (err as FastifyError).validation });
    }

    const statusCode = (err as FastifyError).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(err);
      // Never leak internals — no stack traces, no key hints.
      return reply.code(500).send({ error: "Something went wrong on our end" });
    }
    return reply.code(statusCode).send({ error: err.message ?? "Request failed" });
  });

  return app;
}

export const isProduction = env.NODE_ENV === "production";
