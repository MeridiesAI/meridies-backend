import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { env } from "./env.js";
import jwtPlugin from "./plugins/jwt.js";
import authRoutes from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import inviteRoutes from "./routes/invites.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true,
  });

  app.register(jwtPlugin);
  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/auth" });
  app.register(inviteRoutes, { prefix: "/invites" });

  app.setErrorHandler((err: FastifyError | ZodError, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", details: err.flatten() });
    }
    if (err.validation) {
      return reply.code(400).send({ error: "Invalid request", details: err.validation });
    }

    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(err);
    }
    return reply.code(statusCode).send({ error: err.message ?? "Internal server error" });
  });

  return app;
}
