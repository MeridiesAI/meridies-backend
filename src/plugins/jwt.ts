import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import { env } from "../env.js";

export default fp(async (app) => {
  app.register(jwt, { secret: env.JWT_SECRET });

  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
});
