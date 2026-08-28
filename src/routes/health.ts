import type { FastifyInstance } from "fastify";
import { hasAnthropic, hasServiceRole } from "../env.js";

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    // Config presence only — never the values.
    anthropic: hasAnthropic,
    serviceRole: hasServiceRole,
  }));
}
